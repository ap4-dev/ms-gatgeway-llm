import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RequestLogRepository } from './request-log.repository';

function makeDb(): Database.Database {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(
        readFileSync(join(process.cwd(), 'migrations/0002_request_logs.sql'), 'utf-8'),
    );
    db.exec(
        readFileSync(join(process.cwd(), 'migrations/0003_request_logs_tokens.sql'), 'utf-8'),
    );
    return db;
}

describe('RequestLogRepository', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = makeDb();
    });

    afterEach(() => {
        db.close();
    });

    describe('append', () => {
        it('inserts a row with the given fields and returns the new id', () => {
            const repo = new RequestLogRepository(db);
            const id = repo.append({
                requestedAt: 1_000_000,
                modelRequested: 'fast',
                resolvedProvider: 'openai',
                resolvedModel: 'gpt-4o-mini',
                attempts: 1,
                latencyMs: 250,
                status: 'ok',
            });
            expect(id).toBe(1);
            const row = db
                .prepare(
                    'SELECT requested_at, model_requested, resolved_provider, resolved_model, attempts, latency_ms, status FROM request_logs WHERE id = ?',
                )
                .get(id) as Record<string, unknown>;
            expect(row.requested_at).toBe(1_000_000);
            expect(row.model_requested).toBe('fast');
            expect(row.resolved_provider).toBe('openai');
            expect(row.attempts).toBe(1);
            expect(row.latency_ms).toBe(250);
            expect(row.status).toBe('ok');
        });

        it('persists error and client_key alongside status=error', () => {
            const repo = new RequestLogRepository(db);
            repo.append({
                requestedAt: 2_000_000,
                modelRequested: 'mystery',
                resolvedProvider: null,
                resolvedModel: null,
                attempts: 2,
                latencyMs: 4_000,
                status: 'error',
                error: 'All 2 provider(s) failed for model "mystery"',
                clientKey: 'demo-key',
            });
            const row = db
                .prepare('SELECT status, error, client_key FROM request_logs ORDER BY id DESC LIMIT 1')
                .get() as Record<string, unknown>;
            expect(row.status).toBe('error');
            expect(row.error).toBe('All 2 provider(s) failed for model "mystery"');
            expect(row.client_key).toBe('demo-key');
        });

        it('leaves error null when not provided', () => {
            const repo = new RequestLogRepository(db);
            repo.append({
                requestedAt: 0,
                modelRequested: 'fast',
                resolvedProvider: 'openai',
                resolvedModel: 'gpt-4o-mini',
                attempts: 1,
                latencyMs: 10,
                status: 'ok',
            });
            const row = db.prepare('SELECT error FROM request_logs ORDER BY id DESC LIMIT 1').get() as Record<string, unknown>;
            expect(row.error).toBeNull();
        });

        it('persists prompt_hash and token counts when provided (Phase 4)', () => {
            const repo = new RequestLogRepository(db);
            repo.append({
                requestedAt: 5_000_000,
                modelRequested: 'fast',
                resolvedProvider: 'openai',
                resolvedModel: 'gpt-4o-mini',
                attempts: 1,
                latencyMs: 250,
                status: 'ok',
                promptHash: 'abc123def4567890',
                promptTokens: 42,
                completionTokens: 17,
                totalTokens: 59,
            });
            const row = db
                .prepare(
                    'SELECT prompt_hash, prompt_tokens, completion_tokens, total_tokens FROM request_logs ORDER BY id DESC LIMIT 1',
                )
                .get() as Record<string, unknown>;
            expect(row.prompt_hash).toBe('abc123def4567890');
            expect(row.prompt_tokens).toBe(42);
            expect(row.completion_tokens).toBe(17);
            expect(row.total_tokens).toBe(59);
        });
    });

    describe('recent', () => {
        it('returns rows in descending requested_at order, capped at the limit', () => {
            const repo = new RequestLogRepository(db);
            repo.append({ requestedAt: 100, modelRequested: 'a', resolvedProvider: 'x', resolvedModel: 'y', attempts: 1, latencyMs: 1, status: 'ok' });
            repo.append({ requestedAt: 300, modelRequested: 'b', resolvedProvider: 'x', resolvedModel: 'y', attempts: 1, latencyMs: 1, status: 'ok' });
            repo.append({ requestedAt: 200, modelRequested: 'c', resolvedProvider: 'x', resolvedModel: 'y', attempts: 1, latencyMs: 1, status: 'ok' });

            const recent = repo.recent(2);
            expect(recent.map((r) => r.requestedAt)).toEqual([300, 200]);
        });

        it('returns an empty array when no rows exist', () => {
            const repo = new RequestLogRepository(db);
            expect(repo.recent(10)).toEqual([]);
        });
    });

    describe('list', () => {
        const repoFactory = () => {
            const repo = new RequestLogRepository(db);
            const row = (overrides: Partial<Parameters<typeof repo.append>[0]>) =>
                repo.append({
                    requestedAt: 0,
                    modelRequested: 'fast',
                    resolvedProvider: 'openai',
                    resolvedModel: 'gpt-4o-mini',
                    attempts: 1,
                    latencyMs: 100,
                    status: 'ok',
                    clientKey: 'admin',
                    ...overrides,
                });
            return { repo, row };
        };

        it('returns rows newest-first by default', () => {
            const { repo, row } = repoFactory();
            row({ requestedAt: 100 });
            row({ requestedAt: 300 });
            row({ requestedAt: 200 });

            const page = repo.list({ limit: 10 });
            expect(page.items.map((r) => r.requestedAt)).toEqual([300, 200, 100]);
            expect(page.hasMore).toBe(false);
        });

        it('reports hasMore when there is at least one more row past the limit', () => {
            const { repo, row } = repoFactory();
            for (let i = 0; i < 5; i++) row({ requestedAt: 1_000 + i });

            const page = repo.list({ limit: 2 });
            expect(page.items).toHaveLength(2);
            expect(page.hasMore).toBe(true);
        });

        it('does not set hasMore when the row count exactly equals limit', () => {
            const { repo, row } = repoFactory();
            for (let i = 0; i < 3; i++) row({ requestedAt: 1_000 + i });

            const page = repo.list({ limit: 3 });
            expect(page.items).toHaveLength(3);
            expect(page.hasMore).toBe(false);
        });

        it('filters by clientKey', () => {
            const { repo, row } = repoFactory();
            row({ requestedAt: 100, clientKey: 'admin' });
            row({ requestedAt: 200, clientKey: 'tenant-acme' });
            row({ requestedAt: 300, clientKey: 'admin' });
            row({ requestedAt: 400, clientKey: 'tenant-other' });

            const page = repo.list({ limit: 10, clientKey: 'admin' });
            expect(page.items.map((r) => r.requestedAt)).toEqual([300, 100]);
            expect(page.items.every((r) => r.clientKey === 'admin')).toBe(true);
        });

        it('filters by status', () => {
            const { repo, row } = repoFactory();
            row({ requestedAt: 100, status: 'ok' });
            row({ requestedAt: 200, status: 'error' });
            row({ requestedAt: 300, status: 'ok' });
            row({ requestedAt: 400, status: 'circuit_open' });

            const page = repo.list({ limit: 10, status: 'error' });
            expect(page.items.map((r) => r.requestedAt)).toEqual([200]);
        });

        it('filters by resolvedProvider', () => {
            const { repo, row } = repoFactory();
            row({ requestedAt: 100, resolvedProvider: 'openai' });
            row({ requestedAt: 200, resolvedProvider: 'anthropic' });
            row({ requestedAt: 300, resolvedProvider: 'openai' });

            const page = repo.list({ limit: 10, resolvedProvider: 'openai' });
            expect(page.items.map((r) => r.requestedAt)).toEqual([300, 100]);
        });

        it('filters by modelRequested', () => {
            const { repo, row } = repoFactory();
            row({ requestedAt: 100, modelRequested: 'fast' });
            row({ requestedAt: 200, modelRequested: 'slow' });
            row({ requestedAt: 300, modelRequested: 'fast' });

            const page = repo.list({ limit: 10, modelRequested: 'fast' });
            expect(page.items.map((r) => r.requestedAt)).toEqual([300, 100]);
        });

        it('filters by [fromTs, toTs] inclusive range', () => {
            const { repo, row } = repoFactory();
            row({ requestedAt: 100 });
            row({ requestedAt: 150 });
            row({ requestedAt: 200 });
            row({ requestedAt: 250 });

            const page = repo.list({ limit: 10, fromTs: 150, toTs: 200 });
            expect(page.items.map((r) => r.requestedAt)).toEqual([200, 150]);
        });

        it('combines all filters with AND', () => {
            const { repo, row } = repoFactory();
            row({ requestedAt: 100, clientKey: 'admin', status: 'ok' });
            row({ requestedAt: 200, clientKey: 'admin', status: 'error' });
            row({ requestedAt: 300, clientKey: 'admin', status: 'ok', resolvedProvider: 'anthropic' });
            row({ requestedAt: 400, clientKey: 'tenant', status: 'ok' });

            const page = repo.list({
                limit: 10,
                clientKey: 'admin',
                status: 'ok',
                resolvedProvider: 'openai',
            });
            expect(page.items.map((r) => r.requestedAt)).toEqual([100]);
        });

        it('returns empty page when filters match nothing', () => {
            const { repo, row } = repoFactory();
            row({ requestedAt: 100, clientKey: 'admin' });
            const page = repo.list({ limit: 10, clientKey: 'no-such-tenant' });
            expect(page.items).toEqual([]);
            expect(page.hasMore).toBe(false);
        });
    });
});
