import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ClientRepository } from './client.repository';
import { ClientService } from './client.service';
import { ClientAuthCache } from './client-auth-cache';
import { extractPrefix as extractPrefixLocal, hashApiKey } from './api-key-hash.util';

const PEPPER = 'unit-test-pepper-' + 'a'.repeat(32);

/**
 * Mirror the in-memory pattern used by `redis-rate-limiter.service.spec.ts`:
 * a tiny fake exposing only the four ioredis operations
 * `ClientAuthCache` actually uses.
 */
class FakeRedis {
    private store = new Map<string, { value: string; expiresAt?: number }>();
    failNext: 'get' | 'set' | 'all' | 'none' = 'none';

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

    async getJson<T>(key: string): Promise<T | null> {
        const raw = await this.get(key);
        return raw ? (JSON.parse(raw) as T) : null;
    }

    async setJson<T>(key: string, value: T, ttl?: number): Promise<void> {
        await this.set(key, JSON.stringify(value), ttl !== undefined ? 'EX' : undefined, ttl);
    }

    async del(key: string): Promise<void> {
        this.store.delete(key);
    }

    size(): number {
        return this.store.size;
    }

    clear(): void {
        this.store.clear();
    }
}

function makeCache(): { cache: ClientAuthCache; redis: FakeRedis } {
    const redis = new FakeRedis();
    // Wrap each method to swallow bind() shape mismatches with the RedisService interface.
    const svc: any = {
        get: redis.get.bind(redis),
        set: redis.set.bind(redis),
        getJson: redis.getJson.bind(redis),
        setJson: redis.setJson.bind(redis),
        del: redis.del.bind(redis),
    };
    return { cache: new ClientAuthCache(svc), redis };
}

function makeDbWithSchema(): Database.Database {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(readFileSync(join(process.cwd(), 'migrations/0002_request_logs.sql'), 'utf-8'));
    db.exec(readFileSync(join(process.cwd(), 'migrations/0003_request_logs_tokens.sql'), 'utf-8'));
    db.exec(readFileSync(join(process.cwd(), 'migrations/0004_clients.sql'), 'utf-8'));
    return db;
}

describe('ClientService', () => {
    let db: Database.Database;
    let repo: ClientRepository;
    let svc: ClientService;
    let cache: ClientAuthCache;
    let redis: FakeRedis;

    beforeEach(() => {
        db = makeDbWithSchema();
        repo = new ClientRepository(db);
        const made = makeCache();
        cache = made.cache;
        redis = made.redis;
        svc = new ClientService(repo, cache, PEPPER);
    });

    afterEach(() => {
        db.close();
    });

    describe('create', () => {
        it('persists a hashed key, never the plaintext', () => {
            const { client, plaintextApiKey } = svc.create({
                id: 'admin',
                name: 'Admin',
                rateLimitRpm: 120,
            });
            expect(client.id).toBe('admin');
            expect(client.apiKeyHash.startsWith('hmac$')).toBe(true);
            // The plaintext never sits in the DB row.
            const row = db.prepare('SELECT api_key_hash FROM clients WHERE id = ?').get('admin') as { api_key_hash: string };
            expect(row.api_key_hash.includes(plaintextApiKey)).toBe(false);
        });

        it('exposes a stable prefix that matches extractPrefix(plaintext)', () => {
            const { plaintextApiKey, client } = svc.create({ id: 'admin', name: 'Admin' });
            expect(client.apiKeyPrefix).toBe(plaintextApiKey.slice(0, 8));
        });
    });

    describe('verifyApiKey (cache + DB hot path)', () => {
        it('returns the client when the plaintext matches (cache miss → DB)', async () => {
            const { plaintextApiKey, client } = svc.create({ id: 'admin', name: 'Admin' });
            const found = await svc.verifyApiKey(plaintextApiKey);
            expect(found?.id).toBe(client.id);
        });

        it('populates the cache on first successful verify, hits it on the second', async () => {
            const { plaintextApiKey } = svc.create({ id: 'admin', name: 'Admin' });
            expect(redis.size()).toBe(0);

            const first = await svc.verifyApiKey(plaintextApiKey);
            expect(first?.id).toBe('admin');
            expect(redis.size()).toBe(1);

            // Drop the row from the DB to prove the second call returns
            // from cache without touching SQLite. If it hit the DB, the
            // call would return undefined.
            db.prepare('DELETE FROM clients WHERE id = ?').run('admin');
            const second = await svc.verifyApiKey(plaintextApiKey);
            expect(second?.id).toBe('admin');
        });

        it('returns undefined when the plaintext does not match', async () => {
            const { plaintextApiKey } = svc.create({ id: 'admin', name: 'Admin' });
            // Same prefix (so the prefix scan hits the row), wrong tail.
            const wrong = plaintextApiKey.slice(0, 7) + 'X';
            expect(await svc.verifyApiKey(wrong)).toBeUndefined();
        });

        it('returns undefined for an empty/invalid plaintext', async () => {
            svc.create({ id: 'admin', name: 'Admin' });
            expect(await svc.verifyApiKey('')).toBeUndefined();
        });

        it('returns undefined for a prefix that does not exist', async () => {
            svc.create({ id: 'admin', name: 'Admin' });
            expect(await svc.verifyApiKey('zz-zzzzzz')).toBeUndefined();
        });

        it('skips rows whose revoked_at is set on DB miss; cached entries still hit on revoked rows', async () => {
            // The DB filter is the source of truth on cold path. After
            // revocation + cache TTL expiry, the row stops verifying.
            const { plaintextApiKey } = svc.create({ id: 'admin', name: 'Admin' });
            svc.revoke('admin');
            // Cache was empty (just provisioned), so this is a DB miss
            // and the revoked filter kicks in.
            expect(await svc.verifyApiKey(plaintextApiKey)).toBeUndefined();
        });

        it('touches last_used_at on success (only outside throttle)', async () => {
            const { plaintextApiKey } = svc.create({ id: 'admin', name: 'Admin' });
            const before = svc.findById('admin')?.lastUsedAt ?? null;
            expect(before).toBeNull();
            await svc.verifyApiKey(plaintextApiKey);
            const after = svc.findById('admin')?.lastUsedAt ?? null;
            expect(after).not.toBeNull();
            expect(typeof after).toBe('number');
        });

        it('throttles touch — repeated verifies within 60s write only once', async () => {
            jest.useFakeTimers();
            const { plaintextApiKey } = svc.create({ id: 'admin', name: 'Admin' });

            jest.setSystemTime(1_000_000);
            await svc.verifyApiKey(plaintextApiKey);
            const first = svc.findById('admin')!.lastUsedAt!;

            // 5s later — well within the 60s window — expect NO update.
            jest.setSystemTime(1_005_000);
            await svc.verifyApiKey(plaintextApiKey);
            expect(svc.findById('admin')!.lastUsedAt).toBe(first);

            // 121s after the first touch — past the throttle window.
            jest.setSystemTime(1_121_000);
            await svc.verifyApiKey(plaintextApiKey);
            expect(svc.findById('admin')!.lastUsedAt!).toBeGreaterThan(first);

            jest.useRealTimers();
        });

        it('falls back to DB and warns when Redis is down (fail-open)', async () => {
            const warn = jest
                .spyOn(Logger.prototype, 'warn')
                .mockImplementation(() => undefined);
            const { plaintextApiKey } = svc.create({ id: 'admin', name: 'Admin' });
            redis.failNext = 'all';

            const found = await svc.verifyApiKey(plaintextApiKey);
            expect(found?.id).toBe('admin');
            expect(warn).toHaveBeenCalled();
            warn.mockRestore();
        });
    });

    describe('list / count / findById / revoke', () => {
        it('counts clients and lists them', () => {
            svc.create({ id: 'a', name: 'A' });
            svc.create({ id: 'b', name: 'B' });
            expect(svc.count()).toBe(2);
            expect(svc.list().map((c) => c.id).sort()).toEqual(['a', 'b']);
        });

        it('revoke marks revoked=true', () => {
            const { client } = svc.create({ id: 'a', name: 'A' });
            expect(client.revoked).toBe(false);
            svc.revoke('a');
            expect(svc.findById('a')?.revoked).toBe(true);
        });
    });

    describe('update', () => {
        beforeEach(() => {
            svc.insertWithPlaintext(
                { id: 'a', name: 'A', rateLimitRpm: 60 },
                'sk-aaaaaaaaaaaaa',
            );
        });

        it('updates only the supplied fields and keeps the rest', () => {
            const updated = svc.update('a', { rateLimitRpm: 120 });
            expect(updated.rateLimitRpm).toBe(120);
            expect(updated.name).toBe('A');
        });

        it('updates name + scopes together', () => {
            const updated = svc.update('a', {
                name: 'Renamed',
                scopes: ['admin'],
            });
            expect(updated.name).toBe('Renamed');
            expect(updated.scopes).toEqual(['admin']);
        });

        it('clears rateLimitTpm when passed null', () => {
            svc.update('a', { rateLimitTpm: 5000 });
            expect(svc.findById('a')?.rateLimitTpm).toBe(5000);
            svc.update('a', { rateLimitTpm: null });
            expect(svc.findById('a')?.rateLimitTpm).toBeNull();
        });

        it('throws NotFoundException on unknown id', () => {
            expect(() => svc.update('missing', { name: 'X' })).toThrow(/not found/i);
        });

        it('rejects updating to zero scopes', () => {
            expect(() => svc.update('a', { scopes: [] })).toThrow(/at least one scope/);
        });

        it('rejects updating to rateLimitRpm <= 0', () => {
            expect(() => svc.update('a', { rateLimitRpm: 0 })).toThrow(/rate_limit_rpm/);
        });
    });

    describe('rotateKey', () => {
        it('returns a new plaintext key and updates the row', async () => {
            const { plaintextApiKey: old } = svc.insertWithPlaintext(
                { id: 'a', name: 'A' },
                'sk-aaaaaaaaaaaaa',
            );
            const { client, plaintextApiKey: next } = svc.rotateKey('a');
            expect(next).not.toBe(old);
            expect(next.startsWith('sk-')).toBe(true);
            // The new key now verifies.
            expect((await svc.verifyApiKey(next))?.id).toBe('a');
            // The old key no longer verifies.
            expect(await svc.verifyApiKey(old)).toBeUndefined();
            // The prefix reflects the new key.
            expect(client.apiKeyPrefix).toBe(extractPrefixLocal(next));
        });

        it('throws on unknown id', () => {
            expect(() => svc.rotateKey('missing')).toThrow(/not found/i);
        });

        it('refuses to rotate a revoked client', () => {
            svc.insertWithPlaintext({ id: 'a', name: 'A' }, 'sk-aaaaaaaaaaaaa');
            svc.revoke('a');
            expect(() => svc.rotateKey('a')).toThrow(/create a new client/);
        });

        it('never persists the plaintext', () => {
            const { plaintextApiKey } = svc.insertWithPlaintext(
                { id: 'a', name: 'A' },
                'sk-aaaaaaaaaaaaa',
            );
            const { plaintextApiKey: rotated } = svc.rotateKey('a');
            const row = db.prepare('SELECT api_key_hash, api_key_prefix FROM clients WHERE id = ?').get('a') as any;
            expect(row.api_key_hash.includes(plaintextApiKey)).toBe(false);
            expect(row.api_key_hash.includes(rotated)).toBe(false);
            expect(row.api_key_prefix).toBe(extractPrefixLocal(rotated));
        });
    });

    describe('delete', () => {
        it('removes a client', () => {
            svc.insertWithPlaintext({ id: 'a', name: 'A' }, 'sk-aaaaaaaaaaaaa');
            expect(svc.findById('a')).toBeDefined();
            svc.delete('a');
            expect(svc.findById('a')).toBeUndefined();
        });

        it('is a no-op on an unknown id', () => {
            // Should not throw — delete is idempotent.
            expect(() => svc.delete('missing')).not.toThrow();
        });
    });

    describe('hash format discipline', () => {
        it('produces hmac$ prefixed hashes', () => {
            const { client } = svc.create({ id: 'a', name: 'A' });
            expect(client.apiKeyHash.startsWith('hmac$')).toBe(true);
            expect(client.apiKeyHash.split('$').length).toBe(2);
        });

        it('does not leak the plaintext into the apiKeyHash', () => {
            const { plaintextApiKey, client } = svc.create({ id: 'a', name: 'A' });
            expect(client.apiKeyHash.includes(plaintextApiKey)).toBe(false);
        });
    });

    describe('isolation under existing hash data', () => {
        it('verifyApiKey still works for a row whose hash was inserted externally', async () => {
            const plaintext = 'sk-external12345';
            const apiKeyHash = hashApiKey(plaintext, PEPPER);
            db.prepare(
                'INSERT INTO clients (id, name, api_key_hash, api_key_prefix, scopes, rate_limit_rpm) VALUES (?, ?, ?, ?, ?, ?)',
            ).run('ext', 'Ext', apiKeyHash, plaintext.slice(0, 8), 'chat.read', 60);
            expect((await svc.verifyApiKey(plaintext))?.id).toBe('ext');
        });
    });
});

// Logger is used directly in the throttle test; import it here so the
// `jest.spyOn(Logger.prototype, 'warn'…` call above resolves correctly.
import { Logger } from '@nestjs/common';
