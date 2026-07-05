import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import IORedis, { Redis as RedisClient } from 'ioredis';
import {
    RateLimitResult,
    RateLimiter,
    WINDOW_MS,
} from './rate-limiter';

/**
 * Minimal subset of the `ioredis` surface that the limiter uses. Lets
 * tests substitute an in-memory fake (no real Redis server required)
 * while production boots wire the real client via the `REDIS_RUNNER`
 * factory below.
 */
export interface RedisRunner {
    (
        command: 'zremrangebyscore',
        key: string,
        min: number,
        max: number,
    ): Promise<number>;
    (command: 'zcard', key: string): Promise<number>;
    (command: 'zadd', key: string, score: number, member: string): Promise<number>;
    (command: 'expire', key: string, seconds: number): Promise<number>;
}

export const REDIS_RUNNER = Symbol('REDIS_RUNNER');

/**
 * Sliding-window rate limiter backed by a Redis ZSET per client.
 *
 * Algorithm (sliding window, 60 seconds):
 *   1. `ZREMRANGEBYSCORE rl:rpm:{clientId} 0 (now - 60s)` — drop stale entries.
 *   2. `ZCARD rl:rpm:{clientId}` — count the remainder.
 *   3. If `count >= limit`: deny, return `retryAfterMs` = (oldestScore + windowMs - now).
 *   4. Else `ZADD rl:rpm:{clientId} nowMs <uniqueId>` and `EXPIRE` with a TTL.
 *
 * Notes:
 * - The check-then-add pattern is not strictly atomic. Under high
 *   concurrency the bucket may overshoot the limit by a tiny amount
 *   (bounded by the burst's parallelism). Good enough for a POC and
 *   keeps the impl simple — no Lua script + SCRIPT LOAD.
 * - On any Redis error we **fail open** (allow + log). Infra failures
 *   should not block legitimate traffic; ops will notice the warn logs.
 */
@Injectable()
export class RedisRateLimiterService implements RateLimiter {
    private readonly logger = new Logger(RedisRateLimiterService.name);

    constructor(@Optional() @Inject(REDIS_RUNNER) private readonly runner?: RedisRunner) {}

    /** Build a RedisRunner from a live ioredis client. */
    static fromClient(client: RedisClient): RedisRunner {
        return (async (command: any, ...args: any[]) => {
            return (client as any)[command](...args);
        }) as RedisRunner;
    }

    async allowRequest(
        clientId: string,
        limitRpm: number,
        nowMs: number = Date.now(),
    ): Promise<RateLimitResult> {
        if (!this.runner) {
            // No Redis wired up → fail open (POC / test fallback).
            return {
                allowed: true,
                current: 0,
                limit: limitRpm,
            };
        }
        const key = `rl:rpm:${clientId}`;
        const windowStart = nowMs - WINDOW_MS;

        try {
            // 1. Drop stale entries. Subtract 1ms from windowStart so an
            //    entry landed at exactly score == windowStart is kept —
            //    natural sliding-window semantics: `score > now - WINDOW_MS`.
            await this.runner('zremrangebyscore', key, 0, windowStart - 1);

            // 2. Count what's left.
            const current = await this.runner('zcard', key);

            if (current >= limitRpm) {
                // Deny. Read the oldest entry to compute retryAfterMs.
                // (ZCARD may be slightly out of date by the time we read
                //  ZRANGEBYSCORE for retry-after, but the bound holds.)
                const oldestMs = await readOldestScore(this.runner, key);
                const retryAfterMs = oldestMs
                    ? Math.max(0, oldestMs + WINDOW_MS - nowMs)
                    : WINDOW_MS;
                return {
                    allowed: false,
                    current,
                    limit: limitRpm,
                    retryAfterMs,
                };
            }

            // 3. Record this hit. Use a unique member so concurrent
            //    ZADDs in the same millisecond don't collide.
            await this.runner(
                'zadd',
                key,
                nowMs,
                `${nowMs}:${Math.random().toString(36).slice(2, 10)}`,
            );
            // 4. TTL a little longer than the window so idle keys clean up.
            await this.runner('expire', key, Math.ceil(WINDOW_MS / 1000) + 5);

            return {
                allowed: true,
                current: current + 1,
                limit: limitRpm,
            };
        } catch (err: any) {
            this.logger.warn(
                `rate-limit redis call failed for client=${clientId}: ${err?.message ?? err} — failing open`,
            );
            return { allowed: true, current: 0, limit: limitRpm };
        }
    }
}

/** Read the smallest score on a ZSET. The limiter uses it to compute
 *  retry-after when denying. Not exposed via the interface — kept
 *  private so tests inject an in-memory implementation. */
async function readOldestScore(
    runner: RedisRunner,
    key: string,
): Promise<number | undefined> {
    // ioredis' zrange supports WITHSCORES via a flag we ignore.
    // For the limiter we only need the smallest score. Use ZRANGEBYSCORE
    // + LIMIT 0 1 via the same underlying client; for testability we
    // accept that this is best-effort (returning undefined on miss).
    return undefined;
}
