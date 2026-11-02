import Database from 'better-sqlite3';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
    ClientAliasAccessRepository,
    DuplicateAliasKeyError,
} from './client-alias-access.repository';

const MIGRATIONS_DIR = join(process.cwd(), 'migrations');

/**
 * Full migration chain, applied into a fresh `:memory:` DB.
 *
 * Same pattern as `quota.repository.spec.ts`: the access table lives in the
 * last migration and earlier migrations `ALTER TABLE request_logs`, so the only
 * way to get a schema shaped exactly like production is to run the whole
 * repo-root chain in lexical order. A hand-rolled schema subset would let a
 * broken migration pass the tests.
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

describe('ClientAliasAccessRepository', () => {
    let db: Database.Database;
    let repo: ClientAliasAccessRepository;

    beforeEach(() => {
        db = makeDb();
        repo = new ClientAliasAccessRepository(db);
    });

    afterEach(() => {
        db.close();
    });

    describe('listByClient', () => {
        it('returns an empty array for a client with no access rows', () => {
            // Absence of ANY row is what the service reads as "unrestricted";
            // the repository must report that absence plainly.
            expect(repo.listByClient('client-1')).toEqual([]);
        });

        it('maps rows to a typed shape, ordered by alias_key', () => {
            repo.replaceForClient('client-1', ['slave', 'atlas', 'codex']);

            const rows = repo.listByClient('client-1');

            expect(rows.map((r) => r.aliasKey)).toEqual(['atlas', 'codex', 'slave']);
            expect(rows[0]).toEqual({
                clientId: 'client-1',
                aliasKey: 'atlas',
                createdAt: expect.any(Number),
            });
            expect(rows.every((r) => r.clientId === 'client-1')).toBe(true);
        });

        it('is scoped to one client', () => {
            repo.replaceForClient('client-1', ['codex']);
            repo.replaceForClient('client-2', ['slave']);

            expect(repo.listByClient('client-1').map((r) => r.aliasKey)).toEqual(['codex']);
            expect(repo.listByClient('client-2').map((r) => r.aliasKey)).toEqual(['slave']);
            expect(repo.listByClient('client-3')).toEqual([]);
        });
    });

    describe('replaceForClient', () => {
        it('inserts the whole set for a client that had none', () => {
            repo.replaceForClient('client-1', ['codex', 'slave']);

            expect(repo.listByClient('client-1').map((r) => r.aliasKey)).toEqual([
                'codex',
                'slave',
            ]);
        });

        it('is a FULL replacement: rows not in the new set are gone', () => {
            repo.replaceForClient('client-1', ['codex', 'slave', 'atlas']);

            repo.replaceForClient('client-1', ['slave']);

            expect(repo.listByClient('client-1').map((r) => r.aliasKey)).toEqual(['slave']);
        });

        it('replacing with the same set leaves exactly one row per alias', () => {
            repo.replaceForClient('client-1', ['codex', 'slave']);
            repo.replaceForClient('client-1', ['codex', 'slave']);

            expect(repo.listByClient('client-1')).toHaveLength(2);
        });

        it('never touches another client', () => {
            repo.replaceForClient('client-2', ['atlas']);

            repo.replaceForClient('client-1', ['codex']);

            expect(repo.listByClient('client-2').map((r) => r.aliasKey)).toEqual(['atlas']);
        });

        it('allows the same alias for different clients', () => {
            // The primary key is the PAIR, so the allowlist is per client and
            // never global.
            repo.replaceForClient('client-1', ['codex']);
            repo.replaceForClient('client-2', ['codex']);

            expect(repo.listByClient('client-1').map((r) => r.aliasKey)).toEqual(['codex']);
            expect(repo.listByClient('client-2').map((r) => r.aliasKey)).toEqual(['codex']);
        });

        it('replacing with an empty list clears the client', () => {
            repo.replaceForClient('client-1', ['codex']);

            repo.replaceForClient('client-1', []);

            expect(repo.listByClient('client-1')).toEqual([]);
        });

        it('rejects a duplicate input BEFORE writing anything', () => {
            repo.replaceForClient('client-1', ['codex', 'slave']);

            expect(() => repo.replaceForClient('client-1', ['atlas', 'atlas'])).toThrow(
                DuplicateAliasKeyError,
            );

            // The rejection happens before the destructive step, so the
            // previous set survives untouched instead of being replaced by a
            // partial one.
            expect(repo.listByClient('client-1').map((r) => r.aliasKey)).toEqual([
                'codex',
                'slave',
            ]);
        });

        it('rolls the whole replacement back when a write fails midway', () => {
            repo.replaceForClient('client-1', ['codex', 'slave']);

            // `null` violates `alias_key TEXT NOT NULL` on the SECOND insert, so
            // this can only be safe if delete+insert run inside one transaction.
            expect(() =>
                repo.replaceForClient('client-1', ['atlas', null as unknown as string]),
            ).toThrow();

            expect(repo.listByClient('client-1').map((r) => r.aliasKey)).toEqual([
                'codex',
                'slave',
            ]);
        });
    });

    describe('deleteForClient', () => {
        it('removes every row of one client and reports how many went away', () => {
            repo.replaceForClient('client-1', ['codex', 'slave']);
            repo.replaceForClient('client-2', ['atlas']);

            expect(repo.deleteForClient('client-1')).toBe(2);

            expect(repo.listByClient('client-1')).toEqual([]);
            expect(repo.listByClient('client-2').map((r) => r.aliasKey)).toEqual(['atlas']);
        });

        it('returns 0 when the client had no rows', () => {
            expect(repo.deleteForClient('client-1')).toBe(0);
        });
    });
});
