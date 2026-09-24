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
    db.exec('ALTER TABLE request_logs ADD COLUMN attempt_details TEXT');
    db.exec(
        readFileSync(join(process.cwd(), 'migrations/0013_request_params.sql'), 'utf-8'),
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

    describe('request_params diagnostics (0013)', () => {
        it('persists request_params when provided', () => {
            const repo = new RequestLogRepository(db);
            repo.append({
                requestedAt: 6_000_000,
                modelRequested: 'fast',
                resolvedProvider: 'openai',
                resolvedModel: 'gpt-4o-mini',
                attempts: 1,
                latencyMs: 12,
                status: 'error',
                error: 'upstream 400',
                requestParams: '{"model":"fast","max_tokens":512}',
            });
            const row = db
                .prepare('SELECT request_params FROM request_logs ORDER BY id DESC LIMIT 1')
                .get() as Record<string, unknown>;
            expect(row.request_params).toBe('{"model":"fast","max_tokens":512}');
        });

        it('persists NULL request_params when omitted', () => {
            const repo = new RequestLogRepository(db);
            repo.append({
                requestedAt: 6_000_000,
                modelRequested: 'fast',
                resolvedProvider: 'openai',
                resolvedModel: 'gpt-4o-mini',
                attempts: 1,
                latencyMs: 12,
                status: 'error',
                error: 'upstream 400',
            });
            const row = db
                .prepare('SELECT request_params FROM request_logs ORDER BY id DESC LIMIT 1')
                .get() as Record<string, unknown>;
            expect(row.request_params).toBeNull();
        });

        it('persists request_params on attempt-failure rows', () => {
            const repo = new RequestLogRepository(db);
            repo.append({
                requestedAt: 6_000_000,
                modelRequested: 'fast',
                resolvedProvider: 'openai',
                resolvedModel: 'gpt-4o-mini',
                attempts: 2,
                latencyMs: 30,
                status: 'error',
                error: 'attempt 1 failed',
                requestParams: '{"first_user_message":"hi"}',
            });
            const row = db
                .prepare('SELECT request_params FROM request_logs ORDER BY id DESC LIMIT 1')
                .get() as Record<string, unknown>;
            expect(row.request_params).toBe('{"first_user_message":"hi"}');
        });

        it('keeps request_params NULL on success rows', () => {
            const repo = new RequestLogRepository(db);
            repo.append({
                requestedAt: 6_000_000,
                modelRequested: 'fast',
                resolvedProvider: 'openai',
                resolvedModel: 'gpt-4o-mini',
                attempts: 1,
                latencyMs: 12,
                status: 'ok',
            });
            const row = db
                .prepare('SELECT request_params FROM request_logs ORDER BY id DESC LIMIT 1')
                .get() as Record<string, unknown>;
            expect(row.request_params).toBeNull();
        });

        it('exposes request_params through list() as requestParams', () => {
            const repo = new RequestLogRepository(db);
            repo.append({
                requestedAt: 6_000_000,
                modelRequested: 'fast',
                resolvedProvider: 'openai',
                resolvedModel: 'gpt-4o-mini',
                attempts: 1,
                latencyMs: 12,
                status: 'error',
                error: 'upstream 400',
                requestParams: '{"model":"fast"}',
            });
            const page = repo.list({ limit: 10 });
            expect(page.items[0].requestParams).toBe('{"model":"fast"}');
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

describe('RequestLogRepository summary aggregations', () => {
    /**
     * This block shares ONE in-memory DB across all tests instead of the
     * per-test `makeDb()` pattern used above. The summary methods read
     * aggregates; they do not mutate persistence state, so a fresh DB per
     * test adds nothing but churn (and many better-sqlite3 instances alive
     * at process exit are flaky under Node 24 — SIGABRT in the native
     * cleanup hook). `beforeEach` clears the table so every test starts
     * from an empty `request_logs`.
     */
    let db: Database.Database;
    let repo: RequestLogRepository;

    const DAY1 = Math.floor(Date.parse('2026-09-21T00:00:00Z') / 1000);
    const DAY2 = Math.floor(Date.parse('2026-09-22T00:00:00Z') / 1000);

    const appendRow = (
        overrides: Partial<Parameters<RequestLogRepository['append']>[0]>,
    ) =>
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

    beforeAll(() => {
        db = makeDb();
    });

    afterAll(() => {
        db.close();
        // Drop the last reference and force a GC so better-sqlite3 Database
        // objects are finalized while the Node environment is still alive.
        // Under Node 24 the native cleanup hook can otherwise run during
        // worker teardown and abort the process (SIGABRT).
        db = null as unknown as Database.Database;
        forceGc();
    });

    beforeEach(() => {
        db.exec('DELETE FROM request_logs');
        repo = new RequestLogRepository(db);
    });

    it('summaryTotals aggregates counts, tokens and rounded latency', () => {
        appendRow({ requestedAt: DAY1 + 10, status: 'ok', latencyMs: 1000, promptTokens: 10, completionTokens: 5, totalTokens: 15 });
        appendRow({ requestedAt: DAY1 + 20, status: 'error', latencyMs: 3000 });
        appendRow({ requestedAt: DAY1 + 30, status: 'circuit_open', latencyMs: 2000, promptTokens: 100, completionTokens: 50, totalTokens: 150 });

        const totals = repo.summaryTotals(DAY1, DAY2, {});
        expect(totals).toEqual({
            requests: 3,
            ok: 1,
            errors: 1,
            circuitOpen: 1,
            promptTokens: 110,
            completionTokens: 55,
            totalTokens: 165,
            avgLatencyMs: 2000,
        });
    });

    it('summaryTotals returns zeros for an empty range', () => {
        const totals = repo.summaryTotals(DAY1, DAY2, {});
        expect(totals).toEqual({
            requests: 0,
            ok: 0,
            errors: 0,
            circuitOpen: 0,
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
            avgLatencyMs: 0,
        });
    });

    it('summaryTotals applies optional model/client/provider filters', () => {
        appendRow({ requestedAt: DAY1 + 10, modelRequested: 'code', resolvedProvider: 'nan', clientKey: 'alex' });
        appendRow({ requestedAt: DAY1 + 20, modelRequested: 'chat', resolvedProvider: 'openai', clientKey: 'bob' });
        appendRow({ requestedAt: DAY1 + 30, modelRequested: 'code', resolvedProvider: 'openai', clientKey: 'alex' });

        expect(repo.summaryTotals(DAY1, DAY2, { model: 'code' }).requests).toBe(2);
        expect(repo.summaryTotals(DAY1, DAY2, { client: 'bob' }).requests).toBe(1);
        expect(repo.summaryTotals(DAY1, DAY2, { provider: 'openai' }).requests).toBe(2);
        expect(repo.summaryTotals(DAY1, DAY2, { model: 'code', client: 'alex', provider: 'nan' }).requests).toBe(1);
    });

    it('summaryTotals respects the inclusive [from, to] range', () => {
        appendRow({ requestedAt: DAY1 });
        appendRow({ requestedAt: DAY1 + 10 });
        appendRow({ requestedAt: DAY2 });
        expect(repo.summaryTotals(DAY1, DAY1 + 10, {}).requests).toBe(2);
    });

    it('summaryByDay groups by UTC day in ascending order', () => {
        appendRow({ requestedAt: DAY1 + 10, status: 'ok', latencyMs: 1000, totalTokens: 100 });
        appendRow({ requestedAt: DAY1 + 20, status: 'error', latencyMs: 2000 });
        appendRow({ requestedAt: DAY2, status: 'ok', latencyMs: 4000, totalTokens: 400 });

        const byDay = repo.summaryByDay(DAY1, DAY2, {});
        expect(byDay).toEqual([
            { day: '2026-09-21', requests: 2, ok: 1, errors: 1, circuitOpen: 0, totalTokens: 100, avgLatencyMs: 1500 },
            { day: '2026-09-22', requests: 1, ok: 1, errors: 0, circuitOpen: 0, totalTokens: 400, avgLatencyMs: 4000 },
        ]);
    });

    it('summaryByModel groups by model and orders by requests DESC', () => {
        appendRow({ requestedAt: DAY1 + 10, modelRequested: 'code' });
        appendRow({ requestedAt: DAY1 + 20, modelRequested: 'code' });
        appendRow({ requestedAt: DAY1 + 30, modelRequested: 'chat' });

        const byModel = repo.summaryByModel(DAY1, DAY2, {});
        expect(byModel.map((m) => m.model)).toEqual(['code', 'chat']);
        expect(byModel[0].requests).toBe(2);
    });

    it('summaryByClient groups by client_key and orders by requests DESC', () => {
        appendRow({ requestedAt: DAY1 + 10, clientKey: 'bob' });
        appendRow({ requestedAt: DAY1 + 20, clientKey: 'alex' });
        appendRow({ requestedAt: DAY1 + 30, clientKey: 'alex' });

        const byClient = repo.summaryByClient(DAY1, DAY2, {});
        expect(byClient.map((c) => c.client)).toEqual(['alex', 'bob']);
        expect(byClient[0].requests).toBe(2);
    });

    it('summaryByClient surfaces a NULL client_key as JSON null', () => {
        appendRow({ requestedAt: DAY1 + 10, clientKey: null });

        const byClient = repo.summaryByClient(DAY1, DAY2, {});
        expect(byClient).toHaveLength(1);
        expect(byClient[0].client).toBeNull();
        expect(byClient[0].requests).toBe(1);
    });
});

/**
 * Best-effort synchronous GC trigger. better-sqlite3 registers a Node
 * environment cleanup hook per `Database`; forcing a GC before the worker
 * exits lets those native objects finalize while the environment is alive.
 */
function forceGc(): void {
    try {
        const v8 = require('node:v8') as typeof import('node:v8');
        v8.setFlagsFromString('--expose-gc');
        const gc = require('node:vm').runInNewContext('gc') as () => void;
        gc();
    } catch {
        // GC is best-effort; skip when the runtime does not expose it.
    }
}
