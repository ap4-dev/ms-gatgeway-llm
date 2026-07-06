import { Logger } from '@nestjs/common';
import { ClientAuthCache } from './client-auth-cache';
import type { Client } from './client.repository';

/**
 * Tiny in-memory backing store mirroring `redis-rate-limiter.service.spec.ts`'s
 * pattern: expose only the operations `ClientAuthCache` actually invokes.
 * Lives here (not in `src/`) so it isn't pulled into the runtime bundle.
 */
class FakeRedis {
    private store = new Map<string, { value: string; expiresAt?: number }>();
    failNext: 'get' | 'set' | 'del' | 'all' | 'none' = 'none';

    private prune(key: string): boolean {
        const e = this.store.get(key);
        if (!e) return false;
        if (e.expiresAt !== undefined && Date.now() >= e.expiresAt) {
            this.store.delete(key);
            return false;
        }
        return true;
    }

    async get(key: string): Promise<string | null> {
        if (this.failNext === 'all' || this.failNext === 'get') throw new Error('redis-down');
        return this.prune(key) ? this.store.get(key)!.value : null;
    }

    async set(key: string, value: string, ...rest: any[]): Promise<void> {
        if (this.failNext === 'all' || this.failNext === 'set') throw new Error('redis-down');
        let ttl: number | undefined;
        for (let i = 0; i < rest.length; i++) {
            if (rest[i] === 'EX' && i + 1 < rest.length) {
                ttl = Number(rest[i + 1]);
                break;
            }
        }
        this.store.set(key, {
            value,
            expiresAt: ttl ? Date.now() + ttl * 1000 : undefined,
        });
    }

    async del(key: string): Promise<void> {
        if (this.failNext === 'all' || this.failNext === 'del') throw new Error('redis-down');
        this.store.delete(key);
    }

    size(): number {
        return this.store.size;
    }

    raw(key: string): string | undefined {
        return this.store.get(key)?.value;
    }
}

function makeCache(): { cache: ClientAuthCache; redis: FakeRedis } {
    const redis = new FakeRedis();
    const svc: any = {
        get: redis.get.bind(redis),
        set: redis.set.bind(redis),
        getJson: async (key: string) => {
            const raw = await redis.get(key);
            return raw ? JSON.parse(raw) : null;
        },
        setJson: async (key: string, value: any, ttl?: number) => {
            await redis.set(key, JSON.stringify(value), ttl !== undefined ? 'EX' : undefined, ttl);
        },
        del: redis.del.bind(redis),
    };
    return { cache: new ClientAuthCache(svc), redis };
}

const sampleClient: Client = {
    id: 'tenant-acme',
    name: 'Acme Co.',
    apiKeyHash: 'hmac$ff'.repeat(16),
    apiKeyPrefix: 'sk-acme12',
    scopes: ['chat.read', 'chat.write'],
    rateLimitRpm: 60,
    rateLimitTpm: null,
    createdAt: 1_700_000_000,
    lastUsedAt: null,
    revoked: false,
};

describe('ClientAuthCache', () => {
    describe('key shape', () => {
        it('produces a deterministic ak:v1:<prefix>:<sha256(plaintext)> key', async () => {
            const { cache, redis } = makeCache();
            const plain = 'sk-testkey-1234567890abcdef-1234567890ab';
            // SHA-256 of the plaintext, hex.
            // Computed below implicitly — we just assert the shape.
            await cache.set(plain, sampleClient);
            const key = Array.from({ length: 0 }).constructor === Object ? null : null; // unused
            expect(redis.size()).toBe(1);
            const rawKey = Array.from((redis as any).store.keys())[0] as string;
            expect(rawKey.startsWith('ak:v1:sk-testk:')).toBe(true);
            // sha256 hex is 64 chars; split(':') → ['ak','v1','<prefix>','<sha256>']
            expect(rawKey.split(':')[3]).toMatch(/^[0-9a-f]{64}$/);
        });

        it('produces different keys for different plaintexts', async () => {
            const { cache, redis } = makeCache();
            await cache.set('sk-aaaaaaaaaa', sampleClient);
            await cache.set('sk-bbbbbbbbbb', sampleClient);
            expect(redis.size()).toBe(2);
        });

        it('produces the same key for the same plaintext across calls', async () => {
            const { cache, redis } = makeCache();
            const plain = 'sk-samekey1234567890abcdef-1234567890ab';
            await cache.set(plain, sampleClient);
            await cache.set(plain, { ...sampleClient, name: 'Other' });
            expect(redis.size()).toBe(1);
            const raw = redis.raw(Array.from((redis as any).store.keys())[0] as string)!;
            expect(JSON.parse(raw).name).toBe('Other');
        });
    });

    describe('get / set / invalidate', () => {
        it('get returns undefined on a miss', async () => {
            const { cache } = makeCache();
            expect(await cache.get('sk-never-seen')).toBeUndefined();
        });

        it('get returns the cached client on hit', async () => {
            const { cache } = makeCache();
            const plain = 'sk-roundtrip-abcdef0123456789-0123456789ab';
            await cache.set(plain, sampleClient);
            expect(await cache.get(plain)).toEqual(sampleClient);
        });

        it('invalidate removes the entry', async () => {
            const { cache } = makeCache();
            const plain = 'sk-invalidate-abcd-1234567890abcdef-0123456789';
            await cache.set(plain, sampleClient);
            await cache.invalidate(plain);
            expect(await cache.get(plain)).toBeUndefined();
        });
    });

    describe('fail-open behaviour', () => {
        it('get returns undefined on Redis get error and logs a warning', async () => {
            const warn = jest
                .spyOn(Logger.prototype, 'warn')
                .mockImplementation(() => undefined);
            const { cache, redis } = makeCache();
            redis.failNext = 'get';
            const result = await cache.get('sk-anything');
            expect(result).toBeUndefined();
            expect(warn).toHaveBeenCalled();
            warn.mockRestore();
        });

        it('set swallows Redis set errors (does not throw)', async () => {
            const warn = jest
                .spyOn(Logger.prototype, 'warn')
                .mockImplementation(() => undefined);
            const { cache, redis } = makeCache();
            redis.failNext = 'set';
            await expect(cache.set('sk-anything', sampleClient)).resolves.toBeUndefined();
            expect(warn).toHaveBeenCalled();
            warn.mockRestore();
        });

        it('invalidate swallows Redis del errors', async () => {
            const warn = jest
                .spyOn(Logger.prototype, 'warn')
                .mockImplementation(() => undefined);
            const { cache, redis } = makeCache();
            redis.failNext = 'del';
            await expect(cache.invalidate('sk-anything')).resolves.toBeUndefined();
            expect(warn).toHaveBeenCalled();
            warn.mockRestore();
        });
    });
});
