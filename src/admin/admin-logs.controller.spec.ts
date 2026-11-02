import Database from 'better-sqlite3';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BadRequestException } from '@nestjs/common';
import { AdminLogsController } from './admin-logs.controller';
import { RequestLogRepository } from '../database/repositories/request-log.repository';

const MIGRATIONS_DIR = join(process.cwd(), 'migrations');

/**
 * Full migration chain, applied into a fresh `:memory:` DB — the same pattern
 * as `quota.repository.spec.ts`.
 *
 * The hand-rolled subset this replaced hard-coded `0002` + `0003` + an inline
 * `ALTER ... attempt_details` + `0013`, so it lagged production every time a
 * column was added (`request_logs.served_alias` in 0014 among them). The real
 * chain keeps the fixture shaped exactly like the deployed schema.
 */
function makeDb(): Database.Database {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    const files = readdirSync(MIGRATIONS_DIR)
        .filter((name) => /^\d{4}_.*\.sql$/.test(name))
        .sort();
    for (const file of files) {
        db.exec(readFileSync(join(MIGRATIONS_DIR, file), 'utf-8'));
    }
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

    describe('admin-only resolution (resolved fields present)', () => {
        it('exposes resolvedProvider and resolvedModel on every returned item', () => {
            const out = controller.list({});
            for (const item of out.items) {
                expect(item).toHaveProperty('resolvedProvider');
                expect(item).toHaveProperty('resolvedModel');
            }
        });

        it('returns the actual upstream provider / model that served each request', () => {
            const out = controller.list({});
            // Walk the rows newest-first (seed order is reversed for ts desc).
            // ts=1_700_003_000 ('mystery'): no upstream → nulls.
            // ts=1_700_002_000 ('fast' / tenant-acme): openai / gpt-4o-mini.
            // ts=1_700_001_000 ('slow'): anthropic / claude-3.
            // ts=1_700_000_000 ('fast' / admin): openai / gpt-4o-mini.
            expect(out.items[0]).toMatchObject({ modelRequested: 'mystery', resolvedProvider: null, resolvedModel: null });
            expect(out.items[1]).toMatchObject({ modelRequested: 'fast', resolvedProvider: 'openai', resolvedModel: 'gpt-4o-mini' });
            expect(out.items[2]).toMatchObject({ modelRequested: 'slow', resolvedProvider: 'anthropic', resolvedModel: 'claude-3' });
            expect(out.items[3]).toMatchObject({ modelRequested: 'fast', resolvedProvider: 'openai', resolvedModel: 'gpt-4o-mini' });
        });

        it('still exposes the alias the client requested', () => {
            const out = controller.list({});
            expect(out.items.map((r) => r.modelRequested).sort()).toEqual([
                'fast', 'fast', 'mystery', 'slow',
            ]);
        });

        it('real upstream identity IS present in the JSON payload (this is admin-only)', () => {
            const out = controller.list({});
            const payload = JSON.stringify(out);
            // Operators rely on these for incident triage; the endpoint
            // is privilege-gated (admin scope) so the exposure is by design.
            expect(payload).toContain('openai');
            expect(payload).toContain('anthropic');
            expect(payload).toContain('claude-3');
            expect(payload).toContain('gpt-4o-mini');
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

        it('filters by model (alias)', () => {
            const out = controller.list({ model: 'fast' });
            expect(out.items.every((r) => r.modelRequested === 'fast')).toBe(true);
            expect(out.count).toBe(2);
        });

        it('filters by provider (resolved_provider)', () => {
            const out = controller.list({ provider: 'openai' });
            expect(out.items.every((r) => r.resolvedProvider === 'openai')).toBe(true);
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

    /**
     * `servedAlias` is what makes a silent quota diversion auditable: the
     * client asked for `codex`, the gate routed `slave`, and `modelRequested`
     * alone cannot show that. The column already exists and is already
     * populated by the chat path (migration 0014 / T7); the controller simply
     * has to project it.
     */
    describe('served alias (quota degradation)', () => {
        it('projects servedAlias as null when the stored column is NULL', () => {
            const out = controller.list({});
            for (const item of out.items) {
                expect(item).toHaveProperty('servedAlias');
                expect(item.servedAlias).toBeNull();
            }
        });

        it('reports the alias actually served on a diverted row', () => {
            repo.append({
                requestedAt: 1_700_004_000,
                modelRequested: 'codex',
                servedAlias: 'slave',
                resolvedProvider: 'qwen',
                resolvedModel: 'qwen-3.6',
                attempts: 1,
                latencyMs: 900,
                status: 'ok',
                clientKey: 'tenant-acme',
            });

            const out = controller.list({});
            expect(out.items[0]).toMatchObject({
                modelRequested: 'codex',
                servedAlias: 'slave',
                resolvedModel: 'qwen-3.6',
            });
            // Diverted rows are exactly the ones where the two aliases disagree.
            expect(out.items[0].servedAlias).not.toBe(out.items[0].modelRequested);
        });

        it('reports the requested alias as servedAlias on a normal row', () => {
            repo.append({
                requestedAt: 1_700_004_500,
                modelRequested: 'codex',
                servedAlias: 'codex',
                resolvedProvider: 'deepseek',
                resolvedModel: 'deepseek-v4-flash',
                attempts: 1,
                latencyMs: 1_200,
                status: 'ok',
                clientKey: 'tenant-acme',
            });

            const out = controller.list({});
            expect(out.items[0]).toMatchObject({
                modelRequested: 'codex',
                servedAlias: 'codex',
            });
            expect(out.items[0].servedAlias).toBe(out.items[0].modelRequested);
        });

        /**
         * The trap this field exists to close: an alias's OWN fallback chain can
         * land on the same upstream model as the divert target's primary, so
         * `resolvedModel` equality proves nothing. Only the alias pair does.
         */
        it('distinguishes a diversion from a same-upstream fallback', () => {
            repo.append({
                // Diverted: codex exhausted -> slave -> its primary qwen-3.6.
                requestedAt: 1_700_005_000,
                modelRequested: 'codex',
                servedAlias: 'slave',
                resolvedProvider: 'qwen',
                resolvedModel: 'qwen-3.6',
                attempts: 1,
                latencyMs: 800,
                status: 'ok',
                clientKey: 'tenant-acme',
            });
            repo.append({
                // Not diverted: codex served, its own fallback also qwen-3.6.
                requestedAt: 1_700_005_500,
                modelRequested: 'codex',
                servedAlias: 'codex',
                resolvedProvider: 'qwen',
                resolvedModel: 'qwen-3.6',
                attempts: 2,
                latencyMs: 2_400,
                status: 'ok',
                clientKey: 'tenant-acme',
            });

            const out = controller.list({});
            const diverted = out.items.find((r) => r.servedAlias === 'slave');
            const normal = out.items.find(
                (r) => r.servedAlias === 'codex' && r.resolvedModel === 'qwen-3.6',
            );
            expect(diverted).toBeDefined();
            expect(normal).toBeDefined();
            // Same upstream model, different served alias: resolvedModel alone
            // cannot tell them apart, servedAlias can.
            expect(diverted?.resolvedModel).toBe(normal?.resolvedModel);
            expect(diverted?.servedAlias).not.toBe(normal?.servedAlias);
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
