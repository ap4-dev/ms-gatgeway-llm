import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ClientRepository } from './client.repository';
import { ClientService } from './client.service';
import { extractPrefix as extractPrefixLocal, hashApiKey } from './api-key-hash.util';

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

    beforeEach(() => {
        db = makeDbWithSchema();
        repo = new ClientRepository(db);
        svc = new ClientService(repo);
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
            expect(client.apiKeyHash.startsWith('scrypt$')).toBe(true);
            // The plaintext never sits in the DB row.
            const row = db.prepare('SELECT api_key_hash FROM clients WHERE id = ?').get('admin') as { api_key_hash: string };
            expect(row.api_key_hash.includes(plaintextApiKey)).toBe(false);
        });

        it('exposes a stable prefix that matches extractPrefix(plaintext)', () => {
            const { plaintextApiKey, client } = svc.create({ id: 'admin', name: 'Admin' });
            expect(client.apiKeyPrefix).toBe(plaintextApiKey.slice(0, 8));
        });
    });

    describe('verifyApiKey', () => {
        it('returns the client when the plaintext matches', () => {
            const { plaintextApiKey, client } = svc.create({ id: 'admin', name: 'Admin' });
            const found = svc.verifyApiKey(plaintextApiKey);
            expect(found?.id).toBe(client.id);
        });

        it('returns undefined when the plaintext does not match', () => {
            const { plaintextApiKey } = svc.create({ id: 'admin', name: 'Admin' });
            // Same prefix (so the prefix scan hits the row), wrong tail.
            const wrong = plaintextApiKey.slice(0, 7) + 'X';
            expect(svc.verifyApiKey(wrong)).toBeUndefined();
        });

        it('returns undefined for an empty/invalid plaintext', () => {
            svc.create({ id: 'admin', name: 'Admin' });
            expect(svc.verifyApiKey('')).toBeUndefined();
        });

        it('returns undefined for a prefix that does not exist', () => {
            svc.create({ id: 'admin', name: 'Admin' });
            expect(svc.verifyApiKey('zz-zzzzzz')).toBeUndefined();
        });

        it('skips rows whose revoked_at is set', () => {
            const { plaintextApiKey } = svc.create({ id: 'admin', name: 'Admin' });
            svc.revoke('admin');
            expect(svc.verifyApiKey(plaintextApiKey)).toBeUndefined();
        });

        it('touches last_used_at on success', () => {
            const { plaintextApiKey } = svc.create({ id: 'admin', name: 'Admin' });
            const before = svc.findById('admin')?.lastUsedAt ?? null;
            expect(before).toBeNull();
            svc.verifyApiKey(plaintextApiKey);
            const after = svc.findById('admin')?.lastUsedAt ?? null;
            expect(after).not.toBeNull();
            expect(typeof after).toBe('number');
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
        it('returns a new plaintext key and updates the row', () => {
            const { plaintextApiKey: old } = svc.insertWithPlaintext(
                { id: 'a', name: 'A' },
                'sk-aaaaaaaaaaaaa',
            );
            const { client, plaintextApiKey: next } = svc.rotateKey('a');
            expect(next).not.toBe(old);
            expect(next.startsWith('sk-')).toBe(true);
            // The new key now verifies.
            expect(svc.verifyApiKey(next)?.id).toBe('a');
            // The old key no longer verifies.
            expect(svc.verifyApiKey(old)).toBeUndefined();
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

    describe('scrypt prefix discipline', () => {
        it('produces scrypt$ prefixed hashes', () => {
            const { client } = svc.create({ id: 'a', name: 'A' });
            expect(client.apiKeyHash.startsWith('scrypt$')).toBe(true);
            expect(client.apiKeyHash.split('$').length).toBe(3);
        });

        it('does not leak the plaintext into the apiKeyHash', () => {
            const { plaintextApiKey, client } = svc.create({ id: 'a', name: 'A' });
            expect(client.apiKeyHash.includes(plaintextApiKey)).toBe(false);
        });
    });

    describe('isolation under existing hash data', () => {
        it('verifyApiKey still works for a row whose hash was inserted externally', () => {
            const plaintext = 'sk-external12345';
            const apiKeyHash = hashApiKey(plaintext);
            db.prepare(
                'INSERT INTO clients (id, name, api_key_hash, api_key_prefix, scopes, rate_limit_rpm) VALUES (?, ?, ?, ?, ?, ?)',
            ).run('ext', 'Ext', apiKeyHash, plaintext.slice(0, 8), 'chat.read', 60);
            expect(svc.verifyApiKey(plaintext)?.id).toBe('ext');
        });
    });
});
