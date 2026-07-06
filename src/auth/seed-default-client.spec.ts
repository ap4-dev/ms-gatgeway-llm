import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import { ClientRepository } from './client.repository';
import { ClientService } from './client.service';
import { ClientAuthCache } from './client-auth-cache';
import { ensureDefaultAdminClient } from './seed-default-client';

const PEPPER = 'unit-test-pepper-' + 'a'.repeat(32);

function makeDbWithSchema(): Database.Database {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(readFileSync(join(process.cwd(), 'migrations/0002_request_logs.sql'), 'utf-8'));
    db.exec(readFileSync(join(process.cwd(), 'migrations/0003_request_logs_tokens.sql'), 'utf-8'));
    db.exec(readFileSync(join(process.cwd(), 'migrations/0004_clients.sql'), 'utf-8'));
    return db;
}

/**
 * Stub RedisService: `ensureDefaultAdminClient` only invokes
 * `create()`, which writes to SQLite — no cache reads happen on the
 * boot path. Return a no-op object with the methods ClientAuthCache
 * calls, in case future seeds touch the cache.
 */
function stubRedis(): any {
    return {
        get: async () => null,
        set: async () => undefined,
        getJson: async () => null,
        setJson: async () => undefined,
        del: async () => undefined,
    };
}

describe('ensureDefaultAdminClient', () => {
    let db: Database.Database;
    let svc: ClientService;
    let logSpy: jest.SpyInstance;

    beforeEach(() => {
        db = makeDbWithSchema();
        svc = new ClientService(new ClientRepository(db), new ClientAuthCache(stubRedis()), PEPPER);
        logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    });

    afterEach(() => {
        logSpy.mockRestore();
        db.close();
    });

    it('creates an admin client on an empty DB and prints the key once', () => {
        const out = ensureDefaultAdminClient(svc, new Logger('Test'));
        expect(out.created).toBe(true);
        expect(out.clientId).toBe('admin');
        expect(svc.count()).toBe(1);
        expect(svc.findById('admin')?.apiKeyPrefix.length).toBe(8);
        // Three log lines worth: 6 banner lines + 1 → assert >= 1.
        expect(logSpy).toHaveBeenCalled();
        const printed = logSpy.mock.calls.map((args) => args[0]).join('\n');
        expect(printed).toMatch(/First-boot/);
        expect(printed).toMatch(/Authorization: Bearer/);
    });

    it('grants the seeded admin client the admin scope so it can use admin endpoints', () => {
        ensureDefaultAdminClient(svc, new Logger('Test'));
        const admin = svc.findById('admin');
        expect(admin?.scopes).toContain('admin');
    });

    it('is a no-op on a DB that already has clients', () => {
        svc.create({ id: 'pre-existing', name: 'Existing' });
        const out = ensureDefaultAdminClient(svc, new Logger('Test'));
        expect(out.created).toBe(false);
        expect(svc.count()).toBe(1);
        expect(svc.findById('pre-existing')).toBeDefined();
        expect(svc.findById('admin')).toBeUndefined();
        expect(logSpy).not.toHaveBeenCalled();
    });

    it('honours custom id/name/rateLimitRpm', () => {
        const out = ensureDefaultAdminClient(svc, new Logger('Test'), {
            id: 'operator',
            name: 'Ops',
            rateLimitRpm: 12,
        });
        expect(out.clientId).toBe('operator');
        const created = svc.findById('operator');
        expect(created?.name).toBe('Ops');
        expect(created?.rateLimitRpm).toBe(12);
    });
});
