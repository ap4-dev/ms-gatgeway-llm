import Database from 'better-sqlite3';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { QuotaRepository } from '../database/repositories/quota.repository';
import { QuotaExhaustedError, secondsUntilInstant } from './quota.errors';
import { QuotaService } from './quota.service';

const MIGRATIONS_DIR = join(process.cwd(), 'migrations');

/** Mid-month instant, so the fixed clock is never near a month boundary. */
const FIXED_MS = Date.parse('2026-11-15T12:00:00Z');
const NOV_2026 = '2026-11';
const DEC_2026 = '2026-12';

/** Unix SECONDS of the first second of the next UTC month after November 2026. */
const DEC_1_2026_S = Date.UTC(2026, 11, 1) / 1000;

const LIMIT_20M = 20_000_000;

/**
 * The shared `secondsUntilInstant` formula applied to the next UTC month start,
 * restated here so the service's delegation is asserted independently.
 */
function monthEndRetryAfter(nowMs: number): number {
    const date = new Date(nowMs);
    const nextStartMs = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
    return secondsUntilInstant(Math.floor(nextStartMs / 1000), nowMs);
}

/**
 * Apply the real migration chain from the repo-root `migrations/` directory.
 *
 * Same pattern as `quota-schema.spec.ts`: the quota tables live in the last
 * migration and `request_logs` is ALTERed along the way, so the whole chain
 * has to run in lexical order rather than one file in isolation.
 */
function applyMigrationChain(): Database.Database {
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

describe('QuotaService', () => {
    let db: Database.Database;
    let repo: QuotaRepository;
    let service: QuotaService;
    /** Mutable clock so month rollover is driven by the test, not the wall clock. */
    let clockMs: number;

    beforeEach(() => {
        db = applyMigrationChain();
        repo = new QuotaRepository(db);
        clockMs = FIXED_MS;
        service = new QuotaService(repo, () => clockMs);
    });

    afterEach(() => {
        jest.restoreAllMocks();
        db.close();
    });

    describe('periodKey', () => {
        it('derives the UTC calendar month as YYYY-MM', () => {
            expect(service.periodKey(Date.parse('2026-11-01T00:00:00Z'))).toBe(NOV_2026);
        });

        it('keeps the last second of the month inside that month', () => {
            expect(service.periodKey(Date.parse('2026-11-30T23:59:59Z'))).toBe(NOV_2026);
        });

        it('rolls over at the first second of the next month', () => {
            expect(service.periodKey(Date.parse('2026-12-01T00:00:00Z'))).toBe(DEC_2026);
        });

        it('zero-pads single-digit months', () => {
            expect(service.periodKey(Date.parse('2027-01-15T00:00:00Z'))).toBe('2027-01');
        });

        it('defaults to the injected clock', () => {
            expect(service.periodKey()).toBe(NOV_2026);
        });
    });

    describe('resolveTarget', () => {
        it('passes the requested alias through when the client is unauthenticated', () => {
            repo.upsertQuota({
                clientId: 'client-1',
                aliasKey: 'codex',
                monthlyTokenLimit: LIMIT_20M,
                divertAliasKey: 'slave',
            });
            expect(service.resolveTarget(null, 'codex')).toBe('codex');
            expect(service.resolveTarget('', 'codex')).toBe('codex');
        });

        it('treats a missing quota row as unlimited and reads no usage at all', () => {
            const getUsage = jest.spyOn(repo, 'getUsage');
            const addUsage = jest.spyOn(repo, 'addUsage');

            expect(service.resolveTarget('client-1', 'slave')).toBe('slave');

            expect(getUsage).not.toHaveBeenCalled();
            expect(addUsage).not.toHaveBeenCalled();
        });

        it('serves the requested alias while usage is below the limit', () => {
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
                tokens: LIMIT_20M - 1,
            });

            expect(service.resolveTarget('client-1', 'codex')).toBe('codex');
        });

        it('treats usage exactly at the limit as exhausted', () => {
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
                tokens: LIMIT_20M,
            });

            expect(service.resolveTarget('client-1', 'codex')).toBe('slave');
        });

        it('diverts once usage is above the limit', () => {
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
                tokens: LIMIT_20M + 5_000_000,
            });

            expect(service.resolveTarget('client-1', 'codex')).toBe('slave');
        });

        it('throws QuotaExhaustedError with the month-end reset when there is no divert alias', () => {
            repo.upsertQuota({ clientId: 'client-1', aliasKey: 'codex', monthlyTokenLimit: LIMIT_20M });
            repo.addUsage({
                clientId: 'client-1',
                aliasKey: 'codex',
                periodKey: NOV_2026,
                tokens: 25_000_000,
            });

            let caught: unknown;
            try {
                service.resolveTarget('client-1', 'codex');
            } catch (err) {
                caught = err;
            }

            expect(caught).toBeInstanceOf(QuotaExhaustedError);
            const error = caught as QuotaExhaustedError;
            expect(error.name).toBe('QuotaExhaustedError');
            expect(error.detail).toEqual({
                clientId: 'client-1',
                aliasKey: 'codex',
                periodKey: NOV_2026,
                limit: LIMIT_20M,
                used: 25_000_000,
                resetsAt: DEC_1_2026_S,
            });
            // The message has to be diagnosable from a log line alone.
            expect(error.message).toContain('client-1');
            expect(error.message).toContain('codex');
            expect(error.message).toContain(String(LIMIT_20M));
            expect(error.message).toContain(String(25_000_000));
        });

        it('restores access immediately when the limit is raised mid-month', () => {
            // Feature plan §5: the headline requirement. No cache, no invalidation.
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
                tokens: 25_000_000,
            });
            expect(service.resolveTarget('client-1', 'codex')).toBe('slave');

            repo.upsertQuota({
                clientId: 'client-1',
                aliasKey: 'codex',
                monthlyTokenLimit: 30_000_000,
                divertAliasKey: 'slave',
            });
            expect(service.resolveTarget('client-1', 'codex')).toBe('codex');

            // Lowering it again degrades on the very next request too.
            repo.upsertQuota({
                clientId: 'client-1',
                aliasKey: 'codex',
                monthlyTokenLimit: LIMIT_20M,
                divertAliasKey: 'slave',
            });
            expect(service.resolveTarget('client-1', 'codex')).toBe('slave');
        });

        it('does not carry usage across the month rollover', () => {
            repo.upsertQuota({
                clientId: 'client-1',
                aliasKey: 'codex',
                monthlyTokenLimit: LIMIT_20M,
                divertAliasKey: 'slave',
            });
            service.recordUsage('client-1', 'codex', 25_000_000);
            expect(service.resolveTarget('client-1', 'codex')).toBe('slave');

            clockMs = Date.parse('2026-12-01T00:00:00Z');

            expect(service.resolveTarget('client-1', 'codex')).toBe('codex');
        });
    });

    describe('recordUsage', () => {
        const trackedQuota = () => {
            repo.upsertQuota({
                clientId: 'client-1',
                aliasKey: 'codex',
                monthlyTokenLimit: LIMIT_20M,
                divertAliasKey: 'slave',
            });
        };

        it('creates and then increments the counter for a gated alias', () => {
            trackedQuota();

            service.recordUsage('client-1', 'codex', 120);
            service.recordUsage('client-1', 'codex', 80);

            expect(repo.getUsage('client-1', 'codex', NOV_2026)).toMatchObject({
                clientId: 'client-1',
                aliasKey: 'codex',
                periodKey: NOV_2026,
                tokens: 200,
                requests: 2,
            });
        });

        it('writes nothing for an ungated alias so diverted traffic never freezes the wrong counter', () => {
            // Feature plan §5 invariant: the exhausted alias's counter must stay put.
            trackedQuota();

            service.recordUsage('client-1', 'slave', 5_000_000);

            expect(repo.getUsage('client-1', 'slave', NOV_2026)).toBeNull();
        });

        it('clamps negative and non-finite token counts to zero while still counting the request', () => {
            trackedQuota();

            expect(() => service.recordUsage('client-1', 'codex', -500)).not.toThrow();
            expect(() => service.recordUsage('client-1', 'codex', Number.NaN)).not.toThrow();
            expect(() => service.recordUsage('client-1', 'codex', 12.9)).not.toThrow();

            expect(repo.getUsage('client-1', 'codex', NOV_2026)).toMatchObject({
                tokens: 12,
                requests: 3,
            });
        });

        it('writes nothing for an unauthenticated client', () => {
            trackedQuota();

            service.recordUsage(null, 'codex', 100);

            expect(repo.getUsage('client-1', 'codex', NOV_2026)).toBeNull();
        });

        it('writes to the period of the request instant, not of the injected clock', () => {
            // Review finding R3-001: the gate decided against November, so the
            // accounting must too even though the row is written in December.
            trackedQuota();
            clockMs = Date.parse('2026-12-15T12:00:00Z');

            service.recordUsage(
                'client-1',
                'codex',
                140,
                Date.UTC(2026, 10, 30, 23, 59, 59),
            );

            expect(repo.getUsage('client-1', 'codex', NOV_2026)).toMatchObject({
                tokens: 140,
                requests: 1,
            });
            expect(repo.getUsage('client-1', 'codex', DEC_2026)).toBeNull();
        });

        it('records the same request started in two different months as independent rows', () => {
            trackedQuota();

            service.recordUsage(
                'client-1',
                'codex',
                100,
                Date.UTC(2026, 10, 30, 23, 59, 59),
            );
            service.recordUsage(
                'client-1',
                'codex',
                250,
                Date.UTC(2026, 11, 1, 0, 0, 0),
            );

            expect(repo.getUsage('client-1', 'codex', NOV_2026)).toMatchObject({
                tokens: 100,
                requests: 1,
            });
            expect(repo.getUsage('client-1', 'codex', DEC_2026)).toMatchObject({
                tokens: 250,
                requests: 1,
            });
        });

        it('defaults to the injected clock when the caller omits the instant', () => {
            trackedQuota();
            clockMs = Date.parse('2026-12-05T00:00:00Z');

            service.recordUsage('client-1', 'codex', 60);

            expect(repo.getUsage('client-1', 'codex', DEC_2026)).toMatchObject({
                tokens: 60,
                requests: 1,
            });
            expect(repo.getUsage('client-1', 'codex', NOV_2026)).toBeNull();
        });
    });

    describe('describeQuotas', () => {
        const codexQuota = (monthlyTokenLimit: number = LIMIT_20M, divertAliasKey = 'slave') => {
            repo.upsertQuota({
                clientId: 'client-1',
                aliasKey: 'codex',
                monthlyTokenLimit,
                divertAliasKey,
            });
        };

        it('returns an empty array for a client with no quotas', () => {
            expect(service.describeQuotas('client-1')).toEqual([]);
        });

        it('reports zero usage for a quota with no usage yet', () => {
            codexQuota();

            const [view] = service.describeQuotas('client-1');

            expect(view).toEqual({
                aliasKey: 'codex',
                monthlyTokenLimit: LIMIT_20M,
                divertAliasKey: 'slave',
                periodKey: NOV_2026,
                tokens: 0,
                requests: 0,
                remaining: LIMIT_20M,
                exhausted: false,
                resetsAt: DEC_1_2026_S,
                retryAfterSeconds: monthEndRetryAfter(FIXED_MS),
            });
        });

        it('reports partial usage with the remaining allowance and the month-end reset', () => {
            codexQuota();
            repo.addUsage({
                clientId: 'client-1',
                aliasKey: 'codex',
                periodKey: NOV_2026,
                tokens: 5_000_000,
            });

            const [view] = service.describeQuotas('client-1');

            expect(view.tokens).toBe(5_000_000);
            expect(view.requests).toBe(1);
            expect(view.remaining).toBe(LIMIT_20M - 5_000_000);
            expect(view.exhausted).toBe(false);
            // The reset instant is driven by the injected clock, not the wall clock.
            expect(view.resetsAt).toBe(DEC_1_2026_S);
            expect(view.retryAfterSeconds).toBe(monthEndRetryAfter(FIXED_MS));
            expect(view.retryAfterSeconds).toBe(
                secondsUntilInstant(view.resetsAt, FIXED_MS),
            );
        });

        it('treats usage exactly at the limit as exhausted, with zero remaining', () => {
            // Pins the strict `>=` the gate uses, so the admin projection can
            // never disagree with `resolveTarget`.
            codexQuota();
            repo.addUsage({
                clientId: 'client-1',
                aliasKey: 'codex',
                periodKey: NOV_2026,
                tokens: LIMIT_20M,
            });

            const [view] = service.describeQuotas('client-1');

            expect(view.exhausted).toBe(true);
            expect(view.remaining).toBe(0);
            expect(service.resolveTarget('client-1', 'codex')).toBe('slave');
        });

        it('reports exhausted with zero remaining — never negative — above the limit', () => {
            codexQuota();
            repo.addUsage({
                clientId: 'client-1',
                aliasKey: 'codex',
                periodKey: NOV_2026,
                tokens: LIMIT_20M + 5_000_000,
            });

            const [view] = service.describeQuotas('client-1');

            expect(view.tokens).toBe(25_000_000);
            expect(view.exhausted).toBe(true);
            expect(view.remaining).toBe(0);
            expect(view.remaining).toBeGreaterThanOrEqual(0);
        });

        it('joins two aliases of the same client without leaking their counters', () => {
            repo.upsertQuota({
                clientId: 'client-1',
                aliasKey: 'codex',
                monthlyTokenLimit: LIMIT_20M,
                divertAliasKey: 'slave',
            });
            repo.upsertQuota({
                clientId: 'client-1',
                aliasKey: 'atlas',
                monthlyTokenLimit: 1_000,
            });
            repo.addUsage({
                clientId: 'client-1',
                aliasKey: 'codex',
                periodKey: NOV_2026,
                tokens: 4_000_000,
            });
            repo.addUsage({
                clientId: 'client-1',
                aliasKey: 'atlas',
                periodKey: NOV_2026,
                tokens: 900,
            });

            const views = service.describeQuotas('client-1');

            // Ordering follows the repository: by alias_key.
            expect(views.map((v) => v.aliasKey)).toEqual(['atlas', 'codex']);
            expect(views.map((v) => v.tokens)).toEqual([900, 4_000_000]);
            expect(views.map((v) => v.requests)).toEqual([1, 1]);
            expect(views.map((v) => v.remaining)).toEqual([100, LIMIT_20M - 4_000_000]);
            expect(views.map((v) => v.exhausted)).toEqual([false, false]);
        });

        it('ignores usage recorded in a different month', () => {
            codexQuota();
            repo.addUsage({
                clientId: 'client-1',
                aliasKey: 'codex',
                periodKey: DEC_2026,
                tokens: 25_000_000,
            });

            const [view] = service.describeQuotas('client-1');

            expect(view.periodKey).toBe(NOV_2026);
            expect(view.tokens).toBe(0);
            expect(view.requests).toBe(0);
            expect(view.exhausted).toBe(false);
        });

        it('uses two queries, not N + 1, for a client with three quotas', () => {
            repo.upsertQuota({ clientId: 'client-1', aliasKey: 'atlas', monthlyTokenLimit: 1 });
            repo.upsertQuota({ clientId: 'client-1', aliasKey: 'codex', monthlyTokenLimit: 2 });
            repo.upsertQuota({ clientId: 'client-1', aliasKey: 'slave', monthlyTokenLimit: 3 });
            const listQuotasByClient = jest.spyOn(repo, 'listQuotasByClient');
            const listUsageByClientPeriod = jest.spyOn(repo, 'listUsageByClientPeriod');
            const getUsage = jest.spyOn(repo, 'getUsage');

            const views = service.describeQuotas('client-1');

            expect(views).toHaveLength(3);
            expect(listQuotasByClient).toHaveBeenCalledTimes(1);
            expect(listUsageByClientPeriod).toHaveBeenCalledTimes(1);
            expect(listUsageByClientPeriod).toHaveBeenCalledWith('client-1', NOV_2026);
            // No per-alias usage lookup.
            expect(getUsage).not.toHaveBeenCalled();
        });

        it('honours an explicit clock instant instead of reading the injected clock twice', () => {
            codexQuota();
            repo.addUsage({
                clientId: 'client-1',
                aliasKey: 'codex',
                periodKey: DEC_2026,
                tokens: 700,
            });
            const nowReads = jest.fn(() => clockMs);
            const explicit = new QuotaService(repo, nowReads);
            const december = Date.parse('2026-12-10T00:00:00Z');

            const [view] = explicit.describeQuotas('client-1', december);

            expect(view.periodKey).toBe(DEC_2026);
            expect(view.tokens).toBe(700);
            expect(view.resetsAt).toBe(Date.UTC(2027, 0, 1) / 1000);
            expect(nowReads).not.toHaveBeenCalled();
        });
    });

    describe('upsertQuota', () => {
        it('persists the row and returns its view', () => {
            const view = service.upsertQuota('client-1', {
                aliasKey: 'codex',
                monthlyTokenLimit: LIMIT_20M,
                divertAliasKey: 'slave',
            });

            expect(view).toEqual({
                aliasKey: 'codex',
                monthlyTokenLimit: LIMIT_20M,
                divertAliasKey: 'slave',
                periodKey: NOV_2026,
                tokens: 0,
                requests: 0,
                remaining: LIMIT_20M,
                exhausted: false,
                resetsAt: DEC_1_2026_S,
                retryAfterSeconds: monthEndRetryAfter(FIXED_MS),
            });
            expect(repo.getQuota('client-1', 'codex')).toMatchObject({
                monthlyTokenLimit: LIMIT_20M,
                divertAliasKey: 'slave',
            });
        });

        it('defaults the divert alias to null when the caller omits it', () => {
            const view = service.upsertQuota('client-1', {
                aliasKey: 'codex',
                monthlyTokenLimit: 500,
            });

            expect(view.divertAliasKey).toBeNull();
        });

        it('reflects a raised limit in the returned view and in the gate, immediately', () => {
            // Feature plan §5 through the admin projection: the raise-mid-month rule.
            repo.addUsage({
                clientId: 'client-1',
                aliasKey: 'codex',
                periodKey: NOV_2026,
                tokens: 25_000_000,
            });

            const before = service.upsertQuota('client-1', {
                aliasKey: 'codex',
                monthlyTokenLimit: LIMIT_20M,
                divertAliasKey: 'slave',
            });
            expect(before).toMatchObject({
                tokens: 25_000_000,
                remaining: 0,
                exhausted: true,
            });
            expect(service.resolveTarget('client-1', 'codex')).toBe('slave');

            const after = service.upsertQuota('client-1', {
                aliasKey: 'codex',
                monthlyTokenLimit: 30_000_000,
                divertAliasKey: 'slave',
            });
            expect(after).toMatchObject({
                monthlyTokenLimit: 30_000_000,
                tokens: 25_000_000,
                remaining: 5_000_000,
                exhausted: false,
            });
            expect(service.resolveTarget('client-1', 'codex')).toBe('codex');
        });
    });

    describe('removeQuota', () => {
        it('returns true then false, and the alias disappears from describeQuotas', () => {
            repo.upsertQuota({
                clientId: 'client-1',
                aliasKey: 'codex',
                monthlyTokenLimit: LIMIT_20M,
            });
            expect(service.describeQuotas('client-1').map((v) => v.aliasKey)).toEqual(['codex']);

            expect(service.removeQuota('client-1', 'codex')).toBe(true);
            expect(service.describeQuotas('client-1')).toEqual([]);
            expect(service.removeQuota('client-1', 'codex')).toBe(false);
        });
    });

    describe('retryAfterSeconds', () => {
        it('matches the shared secondsUntilInstant formula mid-month', () => {
            expect(service.retryAfterSeconds()).toBe(monthEndRetryAfter(FIXED_MS));
            expect(service.retryAfterSeconds(FIXED_MS)).toBe(15 * 86_400 + 43_200);
        });

        it('reports the full next month when asked at an exact month boundary', () => {
            const december1 = Date.parse('2026-12-01T00:00:00Z');

            // 2027-01-01 minus 2026-12-01 = 31 days.
            expect(service.retryAfterSeconds(december1)).toBe(31 * 86_400);
            expect(service.retryAfterSeconds(december1)).toBe(
                monthEndRetryAfter(december1),
            );
        });

        it('never falls below one second', () => {
            const oneMsBeforeBoundary = Date.UTC(2026, 11, 1) - 1;

            expect(service.retryAfterSeconds(oneMsBeforeBoundary)).toBe(1);
            expect(service.retryAfterSeconds(oneMsBeforeBoundary)).toBe(
                monthEndRetryAfter(oneMsBeforeBoundary),
            );
        });
    });
});
