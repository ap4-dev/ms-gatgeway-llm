import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { RedisService } from '../redis.service';
import { extractPrefix } from './api-key-hash.util';
import type { Client } from './client.repository';

/**
 * Redis-backed verification cache for the auth path.
 *
 * Why cache the *verification result* and not just the prefix → row lookup:
 *   - The expensive part of `verifyApiKey` is now the HMAC (~1 µs, trivial),
 *     but the round-trip to SQLite for the row is several ms even on a
 *     warm cache. Caching the verification result shaves off both.
 *   - Hot tenants (LLM traffic is bursty) hit the same key dozens of
 *     times per second. A short TTL absorbs those bursts without making
 *     key revocation slow to propagate (cap at 5 minutes).
 *
 * Cache key shape:
 *   `ak:v1:${prefix}:${sha256(plaintext)}`
 *
 *   - The `prefix` is the public 8-char hint. It is a debug-only scope
 *     hint so `redis-cli KEYS` output is readable; the `sha256(plaintext)`
 *     suffix makes the key unique per actual key.
 *   - The plaintext is never sent to Redis (only its sha256 is). The
 *     sha256 is a non-secret identifier — anyone who already has the
 *     plaintext also has the sha256, so this leaks nothing.
 *
 * Negative results are NOT cached. That prevents an attacker who spams
 * random keys from filling Redis. Misses go through the normal
 * SQLite-lookup path.
 *
 * Failure mode is fail-open. If Redis is down, we return `undefined`
 * and the caller falls back to the database path. We log a warning so
 * operators see the degradation but never fail the request.
 */

const KEY_VERSION = 'ak:v1';
const TTL_SECONDS = 300;

@Injectable()
export class ClientAuthCache {
    private readonly logger = new Logger(ClientAuthCache.name);

    constructor(private readonly redis: RedisService) {
        // Fail loud if DI is broken — better than a silent runtime
        // warning per request. Reflect metadata generation depends
        // on `@Injectable()` being present; without it NestJS injects
        // `undefined` (we learned this the hard way).
        if (!redis) {
            throw new Error(
                'ClientAuthCache: RedisService not injected. ' +
                    'Check that RedisModule is imported and RedisService is exported.',
            );
        }
    }

    /**
     * Returns a cached `Client` for a plaintext key, or `undefined` on
     * miss / cache-down. Never throws.
     */
    async get(plaintext: string): Promise<Client | undefined> {
        const key = this.cacheKey(plaintext);
        try {
            const cached = await this.redis.getJson<Client>(key);
            return cached ?? undefined;
        } catch (err) {
            this.logger.warn(
                `auth cache get failed (key=${this.cacheKeyForLog(plaintext)}): ${(err as Error)?.message ?? err}`,
            );
            return undefined;
        }
    }

    /**
     * Populate the cache with a successful verification. TTL is fixed
     * at module level. No-ops on error so the caller can stay sync.
     */
    async set(plaintext: string, client: Client): Promise<void> {
        const key = this.cacheKey(plaintext);
        try {
            await this.redis.setJson(key, client, TTL_SECONDS);
        } catch (err) {
            this.logger.warn(
                `auth cache set failed (key=${this.cacheKeyForLog(plaintext)}): ${(err as Error)?.message ?? err}`,
            );
        }
    }

    /**
     * Best-effort invalidation. Use after a key rotate or revoke when
     * the old plaintext's sha256 is known. Errors are logged, not raised.
     */
    async invalidate(plaintext: string): Promise<void> {
        const key = this.cacheKey(plaintext);
        try {
            await this.redis.del(key);
        } catch (err) {
            this.logger.warn(
                `auth cache del failed (key=${this.cacheKeyForLog(plaintext)}): ${(err as Error)?.message ?? err}`,
            );
        }
    }

    private cacheKey(plaintext: string): string {
        const prefix = extractPrefix(plaintext);
        const hash = createHash('sha256').update(plaintext).digest('hex');
        return `${KEY_VERSION}:${prefix}:${hash}`;
    }

    /**
     * Mask the cache key when logging so we don't accidentally log
     * the sha256 alongside the prefix (operators can read the prefix
     * back out of their DB if they need it). Format: `ak:v1:<prefix>:***`.
     */
    private cacheKeyForLog(plaintext: string): string {
        return `${KEY_VERSION}:${extractPrefix(plaintext)}:***`;
    }
}
