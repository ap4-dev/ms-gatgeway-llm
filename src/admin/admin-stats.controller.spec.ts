import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BadRequestException } from '@nestjs/common';
import { AdminStatsController } from './admin-stats.controller';
import { RequestLogRepository } from '../database/repositories/request-log.repository';

function makeDb(): Database.Database {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(readFileSync(join(process.cwd(), 'migrations/0002_request_logs.sql'), 'utf-8'));
    db.exec(readFileSync(join(process.cwd(), 'migrations/0003_request_logs_tokens.sql'), 'utf-8'));
    db.exec('ALTER TABLE request_logs ADD COLUMN attempt_details TEXT');
    db.exec(readFileSync(join(process.cwd(), 'migrations/0013_request_params.sql'), 'utf-8'));
    return db;
}

const DAY1 = Math.floor(Date.parse('2026-09-21T00:00:00Z') / 1000);
const DAY2 = Math.floor(Date.parse('2026-09-22T00:00:00Z') / 1000);
const FULL_FROM = '2026-09-21T00:00:00Z';
const FULL_TO = '2026-09-22T23:59:59Z';

describe('AdminStatsController', () => {
    let db: Database.Database;
    let repo: RequestLogRepository;
    let controller: AdminStatsController;

    /**
     * Seeds seven rows spanning two UTC days, two models, two clients and
     * the three status values, with some NULL token counts. Exact totals
     * are asserted below so any regression in the aggregation math fails.
     */
    const seed = (r: RequestLogRepository) => {
        const rows: Array<Partial<Parameters<RequestLogRepository['append']>[0]>> = [
            // 2026-09-21
            { requestedAt: DAY1 + 100, modelRequested: 'code', resolvedProvider: 'nan', clientKey: 'alex', status: 'ok', latencyMs: 1000, promptTokens: 100, completionTokens: 20, totalTokens: 120 },
            { requestedAt: DAY1 + 200, modelRequested: 'code', resolvedProvider: 'nan', clientKey: 'bob', status: 'ok', latencyMs: 2000, promptTokens: 200, completionTokens: 40, totalTokens: 240 },
            { requestedAt: DAY1 + 300, modelRequested: 'chat', resolvedProvider: 'openai', clientKey: 'alex', status: 'error', latencyMs: 3000, error: 'upstream 500' },
            { requestedAt: DAY1 + 400, modelRequested: 'code', resolvedProvider: 'nan', clientKey: 'alex', status: 'circuit_open', latencyMs: 4000, error: 'breaker open' },
            // Last second of 2026-09-21 (UTC day boundary)
            { requestedAt: DAY2 - 1, modelRequested: 'chat', resolvedProvider: 'openai', clientKey: 'bob', status: 'ok', latencyMs: 7000, promptTokens: 700, completionTokens: 140, totalTokens: 840 },
            // 2026-09-22 (exactly at midnight UTC)
            { requestedAt: DAY2, modelRequested: 'code', resolvedProvider: 'nan', clientKey: 'alex', status: 'ok', latencyMs: 5000, promptTokens: 500, completionTokens: 100, totalTokens: 600 },
            { requestedAt: DAY2 + 100, modelRequested: 'chat', resolvedProvider: 'openai', clientKey: 'bob', status: 'error', latencyMs: 6000, promptTokens: 600, completionTokens: 120, totalTokens: 720 },
        ];
        for (const row of rows) {
            r.append({
                requestedAt: 0,
                modelRequested: 'code',
                resolvedProvider: 'nan',
                resolvedModel: 'qwen3-coder',
                attempts: 1,
                latencyMs: 0,
                status: 'ok',
                ...row,
            });
        }
    };

    beforeEach(() => {
        db = makeDb();
        repo = new RequestLogRepository(db);
        seed(repo);
        controller = new AdminStatsController(repo);
    });

    afterEach(() => {
        db.close();
    });

    describe('totals', () => {
        it('aggregates the full range with the documented shape', () => {
            const out = controller.summary({ from: FULL_FROM, to: FULL_TO });
            expect(out.from).toBe(DAY1);
            expect(out.to).toBe(Math.floor(Date.parse(FULL_TO) / 1000));
            expect(out.totals).toEqual({
                requests: 7,
                ok: 4,
                errors: 2,
                circuitOpen: 1,
                promptTokens: 2100,
                completionTokens: 420,
                totalTokens: 2520,
                avgLatencyMs: 4000,
            });
        });

        it('counts failed attempts as their own rows (no dedup)', () => {
            // Two status='error' rows exist; both must be counted.
            const out = controller.summary({ from: FULL_FROM, to: FULL_TO });
            expect(out.totals.errors).toBe(2);
            expect(out.totals.requests).toBe(7);
        });

        it('echoes the applied filters (null when absent)', () => {
            const out = controller.summary({ from: FULL_FROM, to: FULL_TO });
            expect(out.filters).toEqual({ model: null, client: null, provider: null });
        });
    });

    describe('byDay', () => {
        it('groups by UTC day, ascending, with a correct day boundary', () => {
            const out = controller.summary({ from: FULL_FROM, to: FULL_TO });
            expect(out.byDay).toEqual([
                { day: '2026-09-21', requests: 5, ok: 3, errors: 1, circuitOpen: 1, totalTokens: 1200, avgLatencyMs: 3400 },
                { day: '2026-09-22', requests: 2, ok: 1, errors: 1, circuitOpen: 0, totalTokens: 1320, avgLatencyMs: 5500 },
            ]);
        });
    });

    describe('byModel', () => {
        it('groups by model_requested, ordered by requests DESC', () => {
            const out = controller.summary({ from: FULL_FROM, to: FULL_TO });
            expect(out.byModel.map((m) => m.model)).toEqual(['code', 'chat']);
            // Rows 1, 2 and 6 are 'ok'; row 4 is 'circuit_open'.
            expect(out.byModel[0]).toEqual({
                model: 'code',
                requests: 4,
                ok: 3,
                errors: 0,
                circuitOpen: 1,
                totalTokens: 960,
                avgLatencyMs: 3000,
            });
            expect(out.byModel[1]).toEqual({
                model: 'chat',
                requests: 3,
                ok: 1,
                errors: 2,
                circuitOpen: 0,
                totalTokens: 1560,
                avgLatencyMs: 5333,
            });
        });
    });

    describe('byClient', () => {
        it('groups by client_key, ordered by requests DESC', () => {
            const out = controller.summary({ from: FULL_FROM, to: FULL_TO });
            expect(out.byClient.map((c) => c.client)).toEqual(['alex', 'bob']);
            expect(out.byClient[0]).toEqual({
                client: 'alex',
                requests: 4,
                ok: 2,
                errors: 1,
                circuitOpen: 1,
                totalTokens: 720,
                avgLatencyMs: 3250,
            });
            expect(out.byClient[1]).toEqual({
                client: 'bob',
                requests: 3,
                ok: 2,
                errors: 1,
                circuitOpen: 0,
                totalTokens: 1800,
                avgLatencyMs: 5000,
            });
        });
    });

    describe('filters', () => {
        it('filters by model', () => {
            const out = controller.summary({ from: FULL_FROM, to: FULL_TO, model: 'code' });
            expect(out.totals.requests).toBe(4);
            expect(out.totals.totalTokens).toBe(960);
            expect(out.filters).toEqual({ model: 'code', client: null, provider: null });
            expect(out.byModel.map((m) => m.model)).toEqual(['code']);
        });

        it('filters by client', () => {
            const out = controller.summary({ from: FULL_FROM, to: FULL_TO, client: 'alex' });
            expect(out.totals.requests).toBe(4);
            expect(out.filters).toEqual({ model: null, client: 'alex', provider: null });
            expect(out.byClient.map((c) => c.client)).toEqual(['alex']);
        });

        it('filters by provider', () => {
            const out = controller.summary({ from: FULL_FROM, to: FULL_TO, provider: 'openai' });
            expect(out.totals.requests).toBe(3);
            expect(out.totals.ok).toBe(1);
            expect(out.totals.errors).toBe(2);
            expect(out.filters).toEqual({ model: null, client: null, provider: 'openai' });
        });

        it('combines filters with AND', () => {
            const out = controller.summary({
                from: FULL_FROM,
                to: FULL_TO,
                model: 'code',
                client: 'alex',
                provider: 'nan',
            });
            expect(out.totals.requests).toBe(3); // rows 1, 4, 6
        });
    });

    describe('validation', () => {
        it('rejects a missing `from`', () => {
            expect(() => controller.summary({ to: FULL_TO })).toThrow(BadRequestException);
        });

        it('rejects a missing `to`', () => {
            expect(() => controller.summary({ from: FULL_FROM })).toThrow(BadRequestException);
        });

        it('rejects a malformed ISO `from`', () => {
            expect(() => controller.summary({ from: 'not-a-date', to: FULL_TO })).toThrow(BadRequestException);
        });

        it('rejects `from > to` with the same range error shape', () => {
            expect(() =>
                controller.summary({ from: '2026-09-22T00:00:00Z', to: '2026-09-21T00:00:00Z' }),
            ).toThrow(/Invalid range/);
        });

        it('rejects unknown query parameters (strict schema)', () => {
            expect(() =>
                controller.summary({ from: FULL_FROM, to: FULL_TO, whatever: 'x' } as any),
            ).toThrow(BadRequestException);
        });
    });

    describe('empty range', () => {
        it('returns zeros (not nulls) when nothing matches', () => {
            const out = controller.summary({ from: '2020-01-01T00:00:00Z', to: '2020-01-02T00:00:00Z' });
            expect(out.totals).toEqual({
                requests: 0,
                ok: 0,
                errors: 0,
                circuitOpen: 0,
                promptTokens: 0,
                completionTokens: 0,
                totalTokens: 0,
                avgLatencyMs: 0,
            });
            expect(out.byDay).toEqual([]);
            expect(out.byModel).toEqual([]);
            expect(out.byClient).toEqual([]);
        });
    });

    describe('latency rounding', () => {
        it('returns an integer avgLatencyMs', () => {
            const out = controller.summary({ from: FULL_FROM, to: FULL_TO });
            expect(Number.isInteger(out.totals.avgLatencyMs)).toBe(true);
            expect(Number.isInteger(out.byDay[0].avgLatencyMs)).toBe(true);
            expect(Number.isInteger(out.byModel[0].avgLatencyMs)).toBe(true);
            expect(Number.isInteger(out.byClient[0].avgLatencyMs)).toBe(true);
        });
    });
});
