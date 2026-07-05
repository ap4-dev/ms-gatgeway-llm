import { Logger } from '@nestjs/common';
import { RedisRateLimiterService } from './redis-rate-limiter.service';
import { WINDOW_MS } from './rate-limiter';

/**
 * No real Redis needed for these specs: the service uses a `runner`
 * closure injected per-call, so tests run the same logic against an
 * in-memory map that mimics the subset of Redis commands the limiter
 * uses (zremrangebyscore / zcard / zadd / expire).
 */

interface FakeRedisRange {
    score: number;
    member: string;
}

class FakeRedis {
    private store = new Map<string, FakeRedisRange[]>();

    zremrangebyscore(key: string, min: number, max: number): number {
        const list = this.store.get(key) ?? [];
        const before = list.length;
        const kept = list.filter((e) => e.score < min || e.score > max);
        const removed = before - kept.length;
        this.store.set(key, kept);
        return removed;
    }

    zcard(key: string): number {
        return (this.store.get(key) ?? []).length;
    }

    zadd(key: string, score: number, member: string): number {
        const list = this.store.get(key) ?? [];
        if (list.some((e) => e.member === member)) return 0;
        list.push({ score, member });
        this.store.set(key, list);
        return 1;
    }

    expire(_key: string, _ttlSeconds: number): number {
        // No-op for the limiter test. Returns 1 to look alive.
        return 1;
    }

    failNext: 'all' | 'none' = 'none';
}

function makeSvcWithFake(redis: FakeRedis): RedisRateLimiterService {
    return new RedisRateLimiterService((async (cmd: string, ...args: any[]) => {
        if (redis.failNext === 'all') throw new Error('redis-down');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (redis as any)[cmd](...args);
    }) as any);
}

describe('RedisRateLimiterService', () => {
    let redis: FakeRedis;
    let svc: RedisRateLimiterService;

    beforeEach(() => {
        redis = new FakeRedis();
        svc = makeSvcWithFake(redis);
    });

    it('allows the first call when current=0 and returns current=1', async () => {
        const out = await svc.allowRequest('admin', 60, 0);
        expect(out.allowed).toBe(true);
        expect(out.current).toBe(1);
        expect(out.limit).toBe(60);
        expect(out.retryAfterMs).toBeUndefined();
    });

    it('allows up to `limit` calls within the window', async () => {
        let now = 0;
        for (let i = 0; i < 5; i++) {
            const out = await svc.allowRequest('admin', 5, now);
            expect(out.allowed).toBe(true);
            now += 100;
        }
        const over = await svc.allowRequest('admin', 5, 600);
        expect(over.allowed).toBe(false);
        expect(over.current).toBeGreaterThanOrEqual(5);
        expect(typeof over.retryAfterMs).toBe('number');
    });

    it('drops entries that fall out of the window and frees slots', async () => {
        let now = 0;
        for (let i = 0; i < 3; i++) {
            await svc.allowRequest('admin', 3, now);
            now += 10_000;
        }
        // 3rd request landed at now=20_000. The 1st (now=0) is 40s ago
        // when we tick now=60_000. With a 60s window it's still inside,
        // but bumping past 60s frees it.
        const denied = await svc.allowRequest('admin', 3, 60_000);
        // 3 entries still in window (0s, 10s, 20s within 60s). Denied.
        expect(denied.allowed).toBe(false);

        // Jump well past the window so all three entries are stale.
        const allowed = await svc.allowRequest('admin', 3, 60_000 + WINDOW_MS + 1);
        expect(allowed.allowed).toBe(true);
    });

    it('keys requests per-client (one client’s traffic does not affect another)', async () => {
        for (let i = 0; i < 3; i++) await svc.allowRequest('alice', 3, i * 100);
        const aliceOver = await svc.allowRequest('alice', 3, 400);
        expect(aliceOver.allowed).toBe(false);
        // Bob has his own bucket.
        const bob = await svc.allowRequest('bob', 3, 400);
        expect(bob.allowed).toBe(true);
    });

    it('fails OPEN on Redis errors (allowed=true) and logs a warning', async () => {
        const warn = jest
            .spyOn(Logger.prototype, 'warn')
            .mockImplementation(() => undefined);
        redis.failNext = 'all';
        const out = await svc.allowRequest('admin', 5, 0);
        expect(out.allowed).toBe(true);
        expect(warn).toHaveBeenCalled();
        warn.mockRestore();
    });
});
