import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BadRequestException } from '@nestjs/common';
import { AdminLogsController } from './admin-logs.controller';
import { RequestLogRepository } from '../database/repositories/request-log.repository';

function makeDb(): Database.Database {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(readFileSync(join(process.cwd(), 'migrations/0002_request_logs.sql'), 'utf-8'));
    db.exec(readFileSync(join(process.cwd(), 'migrations/0003_request_logs_tokens.sql'), 'utf-8'));
    return db;
}

describe('AdminLogsController', () => {
    let db: Database.Database;
    let repo: RequestLogRepository;
    let controller: AdminLogsController;

    beforeEach(() => {
        db = makeDb();
        repo = new RequestLogRepository(db);
        controller = new AdminLogsController(repo);
        // Seed four representative rows.
        repo.append({
            requestedAt: 1_700_000_000,
            modelRequested: 'fast',
            resolvedProvider: 'openai',
            resolvedModel: 'gpt-4o-mini',
            attempts: 1,
            latencyMs: 200,
            status: 'ok',
            clientKey: 'admin',
        });
        repo.append({
            requestedAt: 1_700_001_000,
            modelRequested: 'slow',
            resolvedProvider: 'anthropic',
            resolvedModel: 'claude-3',
            attempts: 1,
            latencyMs: 4_000,
            status: 'error',
            error: 'rate limit',
            clientKey: 'admin',
        });
        repo.append({
            requestedAt: 1_700_002_000,
            modelRequested: 'fast',
            resolvedProvider: 'openai',
            resolvedModel: 'gpt-4o-mini',
            attempts: 1,
            latencyMs: 350,
            status: 'ok',
            clientKey: 'tenant-acme',
        });
        repo.append({
            requestedAt: 1_700_003_000,
            modelRequested: 'mystery',
            resolvedProvider: null,
            resolvedModel: null,
            attempts: 2,
            latencyMs: 4_100,
            status: 'circuit_open',
            error: 'primary breaker open',
            clientKey: 'tenant-acme',
        });
    });

    afterEach(() => {
        db.close();
    });

    describe('default shape', () => {
        it('returns all rows newest-first with default limit=100', () => {
            const out = controller.list({});
            expect(out.limit).toBe(100);
            expect(out.count).toBe(4);
            expect(out.hasMore).toBe(false);
            expect(out.items.map((r) => r.requestedAt)).toEqual([
                1_700_003_000, 1_700_002_000, 1_700_001_000, 1_700_000_000,
            ]);
        });

        it('does NOT include the stored api_key_hash or any auth secret', () => {
            const out = controller.list({});
            for (const item of out.items) {
                expect(JSON.stringify(item)).not.toMatch(/api_key_hash|plaintext|secret/i);
            }
        });
    });

    describe('alias-only exposure (no real-model leak)', () => {
        it('omits resolvedProvider and resolvedModel from every returned item', () => {
            const out = controller.list({});
            for (const item of out.items) {
                expect(item).not.toHaveProperty('resolvedProvider');
                expect(item).not.toHaveProperty('resolvedModel');
            }
        });

        it('exposes only the alias the client requested', () => {
            const out = controller.list({});
            // Confirm the alias IS visible (otherwise we just hid it, not replaced it).
            expect(out.items[0].modelRequested).toBe('mystery');
            expect(out.items.map((r) => r.modelRequested).sort()).toEqual([
                'fast', 'fast', 'mystery', 'slow',
            ]);
        });

        it('does not accept a `provider` query parameter (would be inert)', () => {
            expect(() => controller.list({ provider: 'openai' })).toThrow(BadRequestException);
        });

        it('never leaks the real upstream provider in the JSON payload', () => {
            const out = controller.list({});
            const payload = JSON.stringify(out);
            // Real providers used in the seed data — make sure none leaked.
            expect(payload).not.toContain('openai');
            expect(payload).not.toContain('anthropic');
            expect(payload).not.toContain('claude-3');
            expect(payload).not.toContain('gpt-4o-mini');
        });
    });

    describe('limit', () => {
        it('caps returned rows at the requested limit', () => {
            const out = controller.list({ limit: '2' });
            expect(out.limit).toBe(2);
            expect(out.count).toBe(2);
            expect(out.items).toHaveLength(2);
            expect(out.hasMore).toBe(true);
            expect(out.items.map((r) => r.requestedAt)).toEqual([
                1_700_003_000, 1_700_002_000,
            ]);
        });

        it('rejects limit > 500', () => {
            expect(() => controller.list({ limit: '501' })).toThrow(BadRequestException);
            expect(() => controller.list({ limit: '10000' })).toThrow(BadRequestException);
        });

        it('rejects non-positive limit', () => {
            expect(() => controller.list({ limit: '0' })).toThrow(BadRequestException);
            expect(() => controller.list({ limit: '-5' })).toThrow(BadRequestException);
        });

        it('rejects non-numeric limit', () => {
            expect(() => controller.list({ limit: 'foo' })).toThrow(BadRequestException);
        });
    });

    describe('filters', () => {
        it('filters by client_id', () => {
            const out = controller.list({ client_id: 'tenant-acme' });
            expect(out.count).toBe(2);
            expect(out.items.map((r) => r.clientKey)).toEqual(['tenant-acme', 'tenant-acme']);
        });

        it('filters by model (alias, not real model)', () => {
            const out = controller.list({ model: 'fast' });
            expect(out.items.every((r) => r.modelRequested === 'fast')).toBe(true);
            expect(out.count).toBe(2);
        });

        it('filters by status', () => {
            const out = controller.list({ status: 'error' });
            expect(out.count).toBe(1);
            expect(out.items[0].error).toBe('rate limit');
        });

        it('accepts every legal status value', () => {
            expect(() => controller.list({ status: 'ok' })).not.toThrow();
            expect(() => controller.list({ status: 'error' })).not.toThrow();
            expect(() => controller.list({ status: 'circuit_open' })).not.toThrow();
        });

        it('rejects unknown status values', () => {
            expect(() => controller.list({ status: 'pending' })).toThrow(BadRequestException);
            expect(() => controller.list({ status: 'OK' })).toThrow(BadRequestException);
        });

        it('filters by ISO `from` (inclusive)', () => {
            const out = controller.list({ from: '2023-11-14T22:20:30Z' });
            // ts=1_700_003_000s is later than 2023-11-14T22:20:30 (≈1_700_001_630),
            // ts=1_700_001_000 is earlier (just before) → expect 3 rows.
            expect(out.count).toBe(3);
            expect(out.items.map((r) => r.requestedAt)).toEqual([
                1_700_003_000, 1_700_002_000, 1_700_001_000,
            ]);
        });

        it('filters by ISO `to` (inclusive)', () => {
            const out = controller.list({ to: '2023-11-14T22:20:30Z' });
            expect(out.count).toBe(1);
            expect(out.items[0].requestedAt).toBe(1_700_000_000);
        });

        it('rejects malformed ISO timestamps', () => {
            expect(() => controller.list({ from: 'not-a-date' })).toThrow(BadRequestException);
            expect(() => controller.list({ to: '2023/11/14' })).toThrow(BadRequestException);
        });

        it('rejects `from > to`', () => {
            expect(() =>
                controller.list({
                    from: '2024-01-01T00:00:00Z',
                    to: '2023-01-01T00:00:00Z',
                }),
            ).toThrow(/Invalid range/);
        });

        it('combines multiple filters with AND', () => {
            const out = controller.list({
                client_id: 'admin',
                status: 'error',
            });
            expect(out.count).toBe(1);
            expect(out.items[0].clientKey).toBe('admin');
            expect(out.items[0].status).toBe('error');
        });
    });

    describe('unknown query parameters', () => {
        it('rejects unknown keys (strict schema)', () => {
            expect(() =>
                controller.list({ whatever: 'value' } as any),
            ).toThrow(BadRequestException);
        });
    });
});
