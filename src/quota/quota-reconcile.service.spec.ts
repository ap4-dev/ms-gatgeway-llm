import Database from 'better-sqlite3';
import { BadRequestException, Logger } from '@nestjs/common';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { QuotaRepository } from '../database/repositories/quota.repository';
import { QuotaReconcileService } from './quota-reconcile.service';

const MIGRATIONS_DIR = join(process.cwd(), 'migrations');

/**
 * Full migration chain, applied into a fresh `:memory:` DB.
 *
 * `0014_client_alias_quotas.sql` does `ALTER TABLE request_logs`, so the
 * `request_logs` migrations must run first; loading the whole repo-root chain
 * is the only way to get a schema shaped exactly like production.
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

/** Mid-month instant, so the default period is never near a boundary. */
const FIXED_MS = Date.parse('2026-11-15T12:00:00Z');
const NOV_2026 = '2026-11';
const DEC_2026 = '2026-12';

/** Unix seconds of the November 2026 half-open window `[start, end)`. */
const NOV_START_S = Date.UTC(2026, 10, 1) / 1000;
const DEC_START_S = Date.UTC(2026, 11, 1) / 1000;

const LIMIT_20M = 20_000_000;

/**
 * Minimal `request_logs` insert: the NOT NULL columns plus the three facts
 * reconciliation reads. `servedAlias: null` reproduces the older-rows shape the
 * `COALESCE(served_alias, model_requested)` fallback exists for.
 */
function insertLog(
    db: Database.Database,
    row: {
        requestedAt: number;
        modelRequested: string;
        servedAlias?: string | null;
        clientKey?: string | null;
        totalTokens?: number | null;
    },
): void {
    db.prepare(
        `INSERT INTO request_logs (
            requested_at, model_requested, served_alias, status, client_key, total_tokens
        ) VALUES (?, ?, ?, 'ok', ?, ?)`,
    ).run(
        row.requestedAt,
        row.modelRequested,
        row.servedAlias ?? null,
        row.clientKey === undefined ? 'client-1' : row.clientKey,
        row.totalTokens === undefined ? 1_000 : row.totalTokens,
    );
}

describe('QuotaReconcileService', () => {
    let db: Database.Database;
    let repo: QuotaRepository;
    let service: QuotaReconcileService;
    /** Mutable clock so the default period is driven by the test, not the wall clock. */
    let clockMs: number;
    /** Silences the repair lines AND is the spy the logging assertions read. */
    let logSpy: jest.SpyInstance;

    beforeEach(() => {
        db = makeDb();
        repo = new QuotaRepository(db);
        clockMs = FIXED_MS;
        service = new QuotaReconcileService(repo, () => clockMs);
        logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    });

    afterEach(() => {
        jest.restoreAllMocks();
        db.close();
    });

    describe('periodKey validation', () => {
        it('defaults to the UTC month of the clock', () => {
            const report = service.reconcile({});

            expect(report.periodKey).toBe(NOV_2026);
            expect(report.dryRun).toBe(false);
        });

        it('follows the clock across a month rollover', () => {
            clockMs = Date.parse('2026-12-01T00:00:00Z');

            expect(service.reconcile({}).periodKey).toBe(DEC_2026);
        });

        it.each(['2026-13', '2026-00', '26-11', '2026-1', '2026-11-01', 'abc', ''])(
            'rejects the malformed period key "%s"',
            (periodKey) => {
                const attempt = () => service.reconcile({ periodKey });

                expect(attempt).toThrow(BadRequestException);
                expect(attempt).toThrow(/periodKey/);
            },
        );

        it('accepts both single-digit-padded months', () => {
            expect(service.reconcile({ periodKey: '2026-01' }).periodKey).toBe('2026-01');
            expect(service.reconcile({ periodKey: '2026-10' }).periodKey).toBe('2026-10');
        });

        it('rejects an invalid period key before scanning anything', () => {
            const aggregate = jest.spyOn(repo, 'aggregateRequestLogUsage');
            const listAll = jest.spyOn(repo, 'listAllQuotas');

            expect(() => service.reconcile({ periodKey: '2026-13' })).toThrow(
                BadRequestException,
            );

            expect(aggregate).not.toHaveBeenCalled();
            expect(listAll).not.toHaveBeenCalled();
        });
    });

    describe('reconcile', () => {
        it('reports zero drift when the stored counters match the logs', () => {
            repo.upsertQuota({
                clientId: 'client-1',
                aliasKey: 'codex',
                monthlyTokenLimit: LIMIT_20M,
                divertAliasKey: 'slave',
            });
            repo.addUsage({
                clientId: 'client-1',
                aliasKey: 'codex',
                periodKey: NOV_2026,
                tokens: 400,
            });
            repo.addUsage({
                clientId: 'client-1',
                aliasKey: 'codex',
                periodKey: NOV_2026,
                tokens: 600,
            });

            insertLog(db, { requestedAt: NOV_START_S + 60, modelRequested: 'codex', servedAlias: 'codex', totalTokens: 400 });
            insertLog(db, { requestedAt: NOV_START_S + 61, modelRequested: 'codex', servedAlias: 'codex', totalTokens: 600 });

            const report = service.reconcile({ periodKey: NOV_2026 });

            expect(report).toEqual({
                periodKey: NOV_2026,
                dryRun: false,
                rowsScanned: 2,
                pairsConsidered: 1,
                drift: [],
                repaired: 0,
            });
        });

        it('detects drift and corrects it to the computed value', () => {
            repo.upsertQuota({ clientId: 'client-1', aliasKey: 'codex', monthlyTokenLimit: LIMIT_20M });
            // Stored counter lost a few requests; the logs are the truth.
            repo.addUsage({ clientId: 'client-1', aliasKey: 'codex', periodKey: NOV_2026, tokens: 100 });

            insertLog(db, { requestedAt: NOV_START_S + 60, modelRequested: 'codex', servedAlias: 'codex', totalTokens: 400 });
            insertLog(db, { requestedAt: NOV_START_S + 61, modelRequested: 'codex', servedAlias: 'codex', totalTokens: 600 });

            const report = service.reconcile({ periodKey: NOV_2026 });

            expect(report.rowsScanned).toBe(2);
            expect(report.pairsConsidered).toBe(1);
            expect(report.drift).toEqual([
                {
                    clientId: 'client-1',
                    aliasKey: 'codex',
                    storedTokens: 100,
                    computedTokens: 1_000,
                    storedRequests: 1,
                    computedRequests: 2,
                },
            ]);
            expect(report.repaired).toBe(1);

            const repaired = repo.getUsage('client-1', 'codex', NOV_2026)!;
            // The repaired value IS the computed one — not stored + computed.
            expect(repaired.tokens).toBe(1_000);
            expect(repaired.requests).toBe(2);
        });

        it('treats a quota pair with no usage row as drift from zero', () => {
            repo.upsertQuota({ clientId: 'client-1', aliasKey: 'codex', monthlyTokenLimit: LIMIT_20M });
            insertLog(db, { requestedAt: NOV_START_S + 60, modelRequested: 'codex', servedAlias: 'codex', totalTokens: 42 });

            const report = service.reconcile({ periodKey: NOV_2026 });

            expect(report.drift).toEqual([
                {
                    clientId: 'client-1',
                    aliasKey: 'codex',
                    storedTokens: 0,
                    computedTokens: 42,
                    storedRequests: 0,
                    computedRequests: 1,
                },
            ]);
            expect(report.repaired).toBe(1);
            expect(repo.getUsage('client-1', 'codex', NOV_2026)!.tokens).toBe(42);
        });

        it('does not report a quota pair whose only difference is a missing row with zero traffic', () => {
            repo.upsertQuota({ clientId: 'client-1', aliasKey: 'codex', monthlyTokenLimit: LIMIT_20M });

            const report = service.reconcile({ periodKey: NOV_2026 });

            expect(report.pairsConsidered).toBe(1);
            expect(report.rowsScanned).toBe(0);
            expect(report.drift).toEqual([]);
            expect(report.repaired).toBe(0);
        });

        it('charges a diverted request to the divert target, never to the requested alias', () => {
            // The anti-contamination case: `codex` was exhausted, so two of its
            // three requests were actually served by `slave`. Aggregating on
            // `model_requested` alone would compute codex = 1_500 / 3 and report
            // permanent phantom drift on every run.
            repo.upsertQuota({
                clientId: 'client-1',
                aliasKey: 'codex',
                monthlyTokenLimit: LIMIT_20M,
                divertAliasKey: 'slave',
            });
            repo.upsertQuota({ clientId: 'client-1', aliasKey: 'slave', monthlyTokenLimit: LIMIT_20M });

            insertLog(db, { requestedAt: NOV_START_S + 60, modelRequested: 'codex', servedAlias: 'codex', totalTokens: 500 });
            insertLog(db, { requestedAt: NOV_START_S + 61, modelRequested: 'codex', servedAlias: 'slave', totalTokens: 700 });
            insertLog(db, { requestedAt: NOV_START_S + 62, modelRequested: 'codex', servedAlias: 'slave', totalTokens: 800 });

            repo.addUsage({ clientId: 'client-1', aliasKey: 'codex', periodKey: NOV_2026, tokens: 500 });
            repo.addUsage({ clientId: 'client-1', aliasKey: 'slave', periodKey: NOV_2026, tokens: 700 });
            repo.addUsage({ clientId: 'client-1', aliasKey: 'slave', periodKey: NOV_2026, tokens: 800 });

            const report = service.reconcile({ periodKey: NOV_2026 });

            expect(report.drift).toEqual([]);
            expect(report.repaired).toBe(0);
            expect(repo.getUsage('client-1', 'codex', NOV_2026)!.tokens).toBe(500);
            expect(repo.getUsage('client-1', 'slave', NOV_2026)!.tokens).toBe(1_500);
        });

        it('ignores an alias with no quota row even when request_logs has traffic for it', () => {
            // Mirrors `QuotaService.recordUsage`, which returns early without a
            // `client_alias_quotas` row. Attributing every alias here would
            // fabricate rows the live path never creates.
            repo.upsertQuota({ clientId: 'client-1', aliasKey: 'codex', monthlyTokenLimit: LIMIT_20M });
            insertLog(db, { requestedAt: NOV_START_S + 60, modelRequested: 'codex', servedAlias: 'codex', totalTokens: 500 });
            insertLog(db, { requestedAt: NOV_START_S + 61, modelRequested: 'slave', servedAlias: 'slave', totalTokens: 900 });
            repo.addUsage({ clientId: 'client-1', aliasKey: 'codex', periodKey: NOV_2026, tokens: 500 });

            const report = service.reconcile({ periodKey: NOV_2026 });

            expect(report.pairsConsidered).toBe(1);
            expect(report.drift).toEqual([]);
            expect(report.repaired).toBe(0);
            expect(repo.getUsage('client-1', 'slave', NOV_2026)).toBeNull();
            expect(repo.listUsageByPeriod(NOV_2026).map((r) => r.aliasKey)).toEqual(['codex']);
        });

        it('ignores traffic from a client that has no quota at all', () => {
            repo.upsertQuota({ clientId: 'client-1', aliasKey: 'codex', monthlyTokenLimit: LIMIT_20M });
            insertLog(db, { requestedAt: NOV_START_S + 60, modelRequested: 'codex', servedAlias: 'codex', clientKey: 'client-2', totalTokens: 900 });

            const report = service.reconcile({ periodKey: NOV_2026 });

            expect(report.pairsConsidered).toBe(1);
            expect(report.drift).toEqual([]);
            expect(report.repaired).toBe(0);
            expect(repo.getUsage('client-2', 'codex', NOV_2026)).toBeNull();
        });

        it('attributes pre-0014 rows through the model_requested fallback', () => {
            repo.upsertQuota({ clientId: 'client-1', aliasKey: 'codex', monthlyTokenLimit: LIMIT_20M });
            insertLog(db, { requestedAt: NOV_START_S + 60, modelRequested: 'codex', servedAlias: null, totalTokens: 300 });

            const report = service.reconcile({ periodKey: NOV_2026 });

            expect(report.repaired).toBe(1);
            expect(repo.getUsage('client-1', 'codex', NOV_2026)!.tokens).toBe(300);
        });

        it('counts several clients and aliases independently', () => {
            repo.upsertQuota({ clientId: 'client-1', aliasKey: 'codex', monthlyTokenLimit: LIMIT_20M });
            repo.upsertQuota({ clientId: 'client-2', aliasKey: 'codex', monthlyTokenLimit: LIMIT_20M });

            insertLog(db, { requestedAt: NOV_START_S + 60, modelRequested: 'codex', servedAlias: 'codex', clientKey: 'client-1', totalTokens: 100 });
            insertLog(db, { requestedAt: NOV_START_S + 61, modelRequested: 'codex', servedAlias: 'codex', clientKey: 'client-2', totalTokens: 200 });

            const report = service.reconcile({ periodKey: NOV_2026 });

            expect(report.pairsConsidered).toBe(2);
            expect(report.rowsScanned).toBe(2);
            expect(report.repaired).toBe(2);
            expect(repo.getUsage('client-1', 'codex', NOV_2026)!.tokens).toBe(100);
            expect(repo.getUsage('client-2', 'codex', NOV_2026)!.tokens).toBe(200);
        });

        it('dryRun reports the drift but writes nothing', () => {
            repo.upsertQuota({ clientId: 'client-1', aliasKey: 'codex', monthlyTokenLimit: LIMIT_20M });
            repo.addUsage({ clientId: 'client-1', aliasKey: 'codex', periodKey: NOV_2026, tokens: 100 });
            insertLog(db, { requestedAt: NOV_START_S + 60, modelRequested: 'codex', servedAlias: 'codex', totalTokens: 1_000 });

            const report = service.reconcile({ periodKey: NOV_2026, dryRun: true });

            expect(report.dryRun).toBe(true);
            expect(report.rowsScanned).toBe(1);
            expect(report.drift).toHaveLength(1);
            expect(report.drift[0]).toMatchObject({
                storedTokens: 100,
                computedTokens: 1_000,
            });
            expect(report.repaired).toBe(0);
            expect(repo.getUsage('client-1', 'codex', NOV_2026)!.tokens).toBe(100);
        });

        it('is idempotent: the second run reports nothing left to repair', () => {
            repo.upsertQuota({ clientId: 'client-1', aliasKey: 'codex', monthlyTokenLimit: LIMIT_20M });
            repo.addUsage({ clientId: 'client-1', aliasKey: 'codex', periodKey: NOV_2026, tokens: 100 });
            insertLog(db, { requestedAt: NOV_START_S + 60, modelRequested: 'codex', servedAlias: 'codex', totalTokens: 1_000 });

            const first = service.reconcile({ periodKey: NOV_2026 });
            const second = service.reconcile({ periodKey: NOV_2026 });

            expect(first.repaired).toBe(1);
            expect(second.drift).toEqual([]);
            expect(second.repaired).toBe(0);
            expect(repo.getUsage('client-1', 'codex', NOV_2026)!.tokens).toBe(1_000);
        });

        it('accepts requested_at exactly at the month start and excludes the next month start', () => {
            repo.upsertQuota({ clientId: 'client-1', aliasKey: 'codex', monthlyTokenLimit: LIMIT_20M });
            insertLog(db, { requestedAt: NOV_START_S - 1, modelRequested: 'codex', servedAlias: 'codex', totalTokens: 100 });
            insertLog(db, { requestedAt: NOV_START_S, modelRequested: 'codex', servedAlias: 'codex', totalTokens: 200 });
            insertLog(db, { requestedAt: DEC_START_S - 1, modelRequested: 'codex', servedAlias: 'codex', totalTokens: 300 });
            insertLog(db, { requestedAt: DEC_START_S, modelRequested: 'codex', servedAlias: 'codex', totalTokens: 400 });

            const report = service.reconcile({ periodKey: NOV_2026 });

            expect(report.rowsScanned).toBe(2);
            expect(report.repaired).toBe(1);
            expect(repo.getUsage('client-1', 'codex', NOV_2026)!.tokens).toBe(500);
            expect(repo.getUsage('client-1', 'codex', NOV_2026)!.requests).toBe(2);
        });

        it('leaves other months untouched', () => {
            repo.upsertQuota({ clientId: 'client-1', aliasKey: 'codex', monthlyTokenLimit: LIMIT_20M });
            repo.addUsage({ clientId: 'client-1', aliasKey: 'codex', periodKey: DEC_2026, tokens: 900 });
            insertLog(db, { requestedAt: NOV_START_S + 60, modelRequested: 'codex', servedAlias: 'codex', totalTokens: 1_000 });

            service.reconcile({ periodKey: NOV_2026 });

            expect(repo.getUsage('client-1', 'codex', DEC_2026)!.tokens).toBe(900);
        });

        it('logs one line per repaired pair plus a summary line', () => {
            repo.upsertQuota({ clientId: 'client-1', aliasKey: 'codex', monthlyTokenLimit: LIMIT_20M });
            insertLog(db, { requestedAt: NOV_START_S + 60, modelRequested: 'codex', servedAlias: 'codex', totalTokens: 1_000 });

            service.reconcile({ periodKey: NOV_2026 });

            expect(logSpy).toHaveBeenCalledTimes(2);
            expect(logSpy.mock.calls[0][0]).toContain('client-1');
            expect(logSpy.mock.calls[0][0]).toContain('codex');
            expect(logSpy.mock.calls[0][0]).toContain('0 -> 1000');
            expect(logSpy.mock.calls[1][0]).toContain(NOV_2026);
        });

        it('logs only the summary line on a clean run', () => {
            repo.upsertQuota({ clientId: 'client-1', aliasKey: 'codex', monthlyTokenLimit: LIMIT_20M });

            service.reconcile({ periodKey: NOV_2026 });

            expect(logSpy).toHaveBeenCalledTimes(1);
            expect(logSpy.mock.calls[0][0]).toContain('0 drifted');
        });
    });
});
