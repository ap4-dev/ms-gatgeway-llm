import Database from 'better-sqlite3';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { QuotaRepository } from './quota.repository';

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

describe('QuotaRepository', () => {
    let db: Database.Database;
    let repo: QuotaRepository;

    beforeEach(() => {
        db = makeDb();
        repo = new QuotaRepository(db);
    });

    afterEach(() => {
        db.close();
    });

    describe('upsertQuota / getQuota', () => {
        it('inserts a quota row', () => {
            repo.upsertQuota({
                clientId: 'client-1',
                aliasKey: 'codex',
                monthlyTokenLimit: 20_000_000,
            });
            expect(repo.getQuota('client-1', 'codex')).toEqual({
                clientId: 'client-1',
                aliasKey: 'codex',
                monthlyTokenLimit: 20_000_000,
                divertAliasKey: null,
                createdAt: expect.any(Number),
                updatedAt: expect.any(Number),
            });
        });

        it('updates the limit and divert alias on a second call, bumping updated_at', () => {
            repo.upsertQuota({
                clientId: 'client-1',
                aliasKey: 'codex',
                monthlyTokenLimit: 20_000_000,
            });
            const before = repo.getQuota('client-1', 'codex')!;
            // Force a distinguishable updated_at even if both writes land in
            // the same unix second.
            db.prepare('UPDATE client_alias_quotas SET updated_at = ? WHERE client_id = ? AND alias_key = ?')
                .run(before.updatedAt - 500, 'client-1', 'codex');

            repo.upsertQuota({
                clientId: 'client-1',
                aliasKey: 'codex',
                monthlyTokenLimit: 30_000_000,
                divertAliasKey: 'slave',
            });

            const after = repo.getQuota('client-1', 'codex')!;
            // The raise-mid-month requirement: the new limit is visible on the
            // very next read, with no cache and no extra invalidation step.
            expect(after.monthlyTokenLimit).toBe(30_000_000);
            expect(after.divertAliasKey).toBe('slave');
            expect(after.createdAt).toBe(before.createdAt);
            expect(after.updatedAt).toBeGreaterThan(before.updatedAt - 500);
            expect(after.updatedAt).toBeGreaterThan(0);
        });

        it('keeps a single row per (client, alias) after repeated upserts', () => {
            repo.upsertQuota({ clientId: 'client-1', aliasKey: 'codex', monthlyTokenLimit: 1 });
            repo.upsertQuota({ clientId: 'client-1', aliasKey: 'codex', monthlyTokenLimit: 2 });
            repo.upsertQuota({ clientId: 'client-1', aliasKey: 'codex', monthlyTokenLimit: 3 });
            expect(repo.listQuotasByClient('client-1')).toHaveLength(1);
            expect(repo.getQuota('client-1', 'codex')!.monthlyTokenLimit).toBe(3);
        });

        it('returns null for an unknown pair', () => {
            expect(repo.getQuota('client-1', 'codex')).toBeNull();
            repo.upsertQuota({
                clientId: 'client-1',
                aliasKey: 'codex',
                monthlyTokenLimit: 20_000_000,
            });
            expect(repo.getQuota('client-2', 'codex')).toBeNull();
            expect(repo.getQuota('client-1', 'slave')).toBeNull();
        });

        it('surfaces the monthly_token_limit > 0 CHECK as a thrown error', () => {
            expect(() =>
                repo.upsertQuota({
                    clientId: 'client-1',
                    aliasKey: 'codex',
                    monthlyTokenLimit: 0,
                }),
            ).toThrow(/CHECK constraint failed/i);
            expect(() =>
                repo.upsertQuota({
                    clientId: 'client-1',
                    aliasKey: 'codex',
                    monthlyTokenLimit: -1,
                }),
            ).toThrow(/CHECK constraint failed/i);
        });
    });

    describe('deleteQuota', () => {
        it('returns true when a row was removed and false afterwards', () => {
            repo.upsertQuota({
                clientId: 'client-1',
                aliasKey: 'codex',
                monthlyTokenLimit: 20_000_000,
            });
            expect(repo.deleteQuota('client-1', 'codex')).toBe(true);
            expect(repo.getQuota('client-1', 'codex')).toBeNull();
            expect(repo.deleteQuota('client-1', 'codex')).toBe(false);
        });

        it('returns false for a pair that never existed', () => {
            expect(repo.deleteQuota('client-1', 'codex')).toBe(false);
        });
    });

    describe('listQuotasByClient', () => {
        it('is scoped to one client and ordered by alias_key', () => {
            repo.upsertQuota({ clientId: 'client-1', aliasKey: 'slave', monthlyTokenLimit: 10 });
            repo.upsertQuota({ clientId: 'client-1', aliasKey: 'codex', monthlyTokenLimit: 20 });
            repo.upsertQuota({ clientId: 'client-1', aliasKey: 'atlas', monthlyTokenLimit: 30 });
            repo.upsertQuota({ clientId: 'client-2', aliasKey: 'codex', monthlyTokenLimit: 40 });

            const rows = repo.listQuotasByClient('client-1');
            expect(rows.map((r) => r.aliasKey)).toEqual(['atlas', 'codex', 'slave']);
            expect(rows.map((r) => r.monthlyTokenLimit)).toEqual([30, 20, 10]);
            expect(rows.every((r) => r.clientId === 'client-1')).toBe(true);
        });

        it('returns an empty array when the client has no quotas', () => {
            expect(repo.listQuotasByClient('client-1')).toEqual([]);
        });
    });

    describe('getUsage / addUsage', () => {
        it('returns null before any usage is recorded', () => {
            expect(repo.getUsage('client-1', 'codex', '2026-11')).toBeNull();
        });

        it('creates the row with requests = 1 on the first call', () => {
            repo.addUsage({
                clientId: 'client-1',
                aliasKey: 'codex',
                periodKey: '2026-11',
                tokens: 1_500,
            });
            expect(repo.getUsage('client-1', 'codex', '2026-11')).toEqual({
                clientId: 'client-1',
                aliasKey: 'codex',
                periodKey: '2026-11',
                tokens: 1_500,
                requests: 1,
                updatedAt: expect.any(Number),
            });
        });

        it('accumulates tokens and increments requests on the second call', () => {
            repo.addUsage({ clientId: 'client-1', aliasKey: 'codex', periodKey: '2026-11', tokens: 1_000 });
            repo.addUsage({ clientId: 'client-1', aliasKey: 'codex', periodKey: '2026-11', tokens: 2_500 });
            const usage = repo.getUsage('client-1', 'codex', '2026-11')!;
            expect(usage.tokens).toBe(3_500);
            expect(usage.requests).toBe(2);
        });

        it('tolerates tokens = 0 by counting the request and adding nothing', () => {
            repo.addUsage({ clientId: 'client-1', aliasKey: 'codex', periodKey: '2026-11', tokens: 400 });
            repo.addUsage({ clientId: 'client-1', aliasKey: 'codex', periodKey: '2026-11', tokens: 0 });
            const usage = repo.getUsage('client-1', 'codex', '2026-11')!;
            expect(usage.tokens).toBe(400);
            expect(usage.requests).toBe(2);
        });

        it('keeps a separate row per period_key (month rollover)', () => {
            repo.addUsage({ clientId: 'client-1', aliasKey: 'codex', periodKey: '2026-11', tokens: 900 });
            repo.addUsage({ clientId: 'client-1', aliasKey: 'codex', periodKey: '2026-12', tokens: 100 });
            expect(repo.getUsage('client-1', 'codex', '2026-11')!.tokens).toBe(900);
            expect(repo.getUsage('client-1', 'codex', '2026-12')!.tokens).toBe(100);
            expect(repo.listUsageByPeriod('2026-11')).toHaveLength(1);
            expect(repo.listUsageByPeriod('2026-12')).toHaveLength(1);
        });

        it('never touches another alias or another client row', () => {
            repo.addUsage({ clientId: 'client-1', aliasKey: 'codex', periodKey: '2026-11', tokens: 500 });
            repo.addUsage({ clientId: 'client-1', aliasKey: 'slave', periodKey: '2026-11', tokens: 700 });
            repo.addUsage({ clientId: 'client-2', aliasKey: 'codex', periodKey: '2026-11', tokens: 300 });

            expect(repo.getUsage('client-1', 'codex', '2026-11')).toEqual({
                clientId: 'client-1',
                aliasKey: 'codex',
                periodKey: '2026-11',
                tokens: 500,
                requests: 1,
                updatedAt: expect.any(Number),
            });
            // A diverted request counted against `slave` must never inflate
            // the exhausted `codex` counter.
            repo.addUsage({ clientId: 'client-1', aliasKey: 'slave', periodKey: '2026-11', tokens: 50 });
            expect(repo.getUsage('client-1', 'codex', '2026-11')!.tokens).toBe(500);
            expect(repo.getUsage('client-1', 'slave', '2026-11')!.tokens).toBe(750);
            expect(repo.getUsage('client-2', 'codex', '2026-11')!.tokens).toBe(300);
        });

        it('lists usage across all clients for a period, ordered by client then alias', () => {
            repo.addUsage({ clientId: 'client-2', aliasKey: 'codex', periodKey: '2026-11', tokens: 5 });
            repo.addUsage({ clientId: 'client-1', aliasKey: 'slave', periodKey: '2026-11', tokens: 6 });
            repo.addUsage({ clientId: 'client-1', aliasKey: 'codex', periodKey: '2026-11', tokens: 7 });
            repo.addUsage({ clientId: 'client-1', aliasKey: 'codex', periodKey: '2026-12', tokens: 8 });

            const rows = repo.listUsageByPeriod('2026-11');
            expect(rows.map((r) => `${r.clientId}/${r.aliasKey}/${r.tokens}`)).toEqual([
                'client-1/codex/7',
                'client-1/slave/6',
                'client-2/codex/5',
            ]);
        });

        it('lists one client\'s usage for one period, ordered by alias', () => {
            repo.addUsage({ clientId: 'client-1', aliasKey: 'slave', periodKey: '2026-11', tokens: 6 });
            repo.addUsage({ clientId: 'client-1', aliasKey: 'codex', periodKey: '2026-11', tokens: 7 });
            repo.addUsage({ clientId: 'client-1', aliasKey: 'atlas', periodKey: '2026-11', tokens: 8 });
            // Same client, other period: must not leak into the November view.
            repo.addUsage({ clientId: 'client-1', aliasKey: 'codex', periodKey: '2026-12', tokens: 9 });
            // Other client, same period: must not leak either.
            repo.addUsage({ clientId: 'client-2', aliasKey: 'codex', periodKey: '2026-11', tokens: 10 });

            const rows = repo.listUsageByClientPeriod('client-1', '2026-11');

            expect(rows.map((r) => `${r.clientId}/${r.aliasKey}/${r.periodKey}/${r.tokens}`)).toEqual([
                'client-1/atlas/2026-11/8',
                'client-1/codex/2026-11/7',
                'client-1/slave/2026-11/6',
            ]);
            expect(rows.every((r) => r.requests === 1)).toBe(true);
        });

        it('returns an empty array when the client has no usage for that period', () => {
            expect(repo.listUsageByClientPeriod('client-1', '2026-11')).toEqual([]);

            repo.addUsage({ clientId: 'client-1', aliasKey: 'codex', periodKey: '2026-12', tokens: 5 });
            expect(repo.listUsageByClientPeriod('client-1', '2026-11')).toEqual([]);
        });

        it('rejects negative tokens through the CHECK', () => {
            expect(() =>
                repo.addUsage({
                    clientId: 'client-1',
                    aliasKey: 'codex',
                    periodKey: '2026-11',
                    tokens: -1,
                }),
            ).toThrow(/CHECK constraint failed/i);
        });
    });
});
