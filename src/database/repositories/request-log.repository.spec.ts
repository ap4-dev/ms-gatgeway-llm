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
});
