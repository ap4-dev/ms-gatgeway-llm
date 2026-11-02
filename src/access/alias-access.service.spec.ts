import Database from 'better-sqlite3';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ClientAliasAccessRepository } from '../database/repositories/client-alias-access.repository';
import { AliasAccessService } from './alias-access.service';

const MIGRATIONS_DIR = join(process.cwd(), 'migrations');

/**
 * Apply the real migration chain from the repo-root `migrations/` directory.
 *
 * Same pattern as `quota.service.spec.ts`: the access table lives in the last
 * migration, so the whole chain runs in lexical order rather than one file in
 * isolation. The service is exercised against a REAL repository on purpose —
 * the "no caching" guarantee is about what reaches SQLite, and a mocked
 * repository cannot prove it.
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

describe('AliasAccessService', () => {
    let db: Database.Database;
    let repo: ClientAliasAccessRepository;
    let service: AliasAccessService;

    beforeEach(() => {
        db = applyMigrationChain();
        repo = new ClientAliasAccessRepository(db);
        service = new AliasAccessService(repo);
    });

    afterEach(() => {
        db.close();
    });

    describe('getAccess', () => {
        it('is unrestricted for a client with no access rows', () => {
            expect(service.getAccess('client-1')).toEqual({ mode: 'unrestricted' });
        });

        it('is unrestricted for a null client id', () => {
            // Mirrors `QuotaService.resolveTarget`: no authenticated client
            // means there is nobody to restrict.
            expect(service.getAccess(null)).toEqual({ mode: 'unrestricted' });
        });

        it('is restricted to the EXACT set once rows exist', () => {
            repo.replaceForClient('client-1', ['codex', 'slave']);

            const access = service.getAccess('client-1');

            expect(access.mode).toBe('restricted');
            if (access.mode !== 'restricted') {
                throw new Error('expected restricted access');
            }
            expect(access.aliases).toBeInstanceOf(Set);
            expect([...access.aliases].sort()).toEqual(['codex', 'slave']);
            expect(access.aliases.size).toBe(2);
        });

        it('does not leak another client\'s aliases', () => {
            repo.replaceForClient('client-2', ['atlas']);

            expect(service.getAccess('client-1')).toEqual({ mode: 'unrestricted' });
        });
    });

    describe('isPermitted', () => {
        it('allows a listed alias inside a restricted set', () => {
            repo.replaceForClient('client-1', ['codex', 'slave']);

            expect(service.isPermitted(service.getAccess('client-1'), 'codex')).toBe(true);
            expect(service.isPermitted(service.getAccess('client-1'), 'slave')).toBe(true);
        });

        it('forbids an unlisted alias inside a restricted set', () => {
            repo.replaceForClient('client-1', ['codex']);

            const access = service.getAccess('client-1');

            // The rule that makes the model coherent: inside a non-empty set,
            // a missing row means FORBIDDEN, not unrestricted.
            expect(service.isPermitted(access, 'slave')).toBe(false);
            expect(service.isPermitted(access, 'atlas')).toBe(false);
        });

        it('allows every alias when unrestricted', () => {
            const access = service.getAccess('client-1');

            for (const alias of ['codex', 'slave', 'atlas', 'does-not-exist']) {
                expect(service.isPermitted(access, alias)).toBe(true);
            }
        });

        it('forbids prototype-polluting names inside a restricted set', () => {
            repo.replaceForClient('client-1', ['codex']);

            const access = service.getAccess('client-1');

            // The set is a `Set`, never a plain object, so there is no
            // prototype chain to walk by accident.
            expect(service.isPermitted(access, 'constructor')).toBe(false);
            expect(service.isPermitted(access, '__proto__')).toBe(false);
            expect(service.isPermitted(access, 'toString')).toBe(false);
        });
    });

    describe('no caching', () => {
        it('sees a row written after the first getAccess call', () => {
            expect(service.getAccess('client-1')).toEqual({ mode: 'unrestricted' });

            // Written straight through the repository — a service holding a
            // cached answer would never notice this.
            repo.replaceForClient('client-1', ['codex']);

            const access = service.getAccess('client-1');
            expect(access.mode).toBe('restricted');
            expect(service.isPermitted(access, 'codex')).toBe(true);
        });

        it('sees a cleared row on the very next call', () => {
            repo.replaceForClient('client-1', ['codex']);
            expect(service.getAccess('client-1').mode).toBe('restricted');

            // Revocation must take effect immediately: no TTL window where the
            // row is gone but the client still gets in.
            repo.deleteForClient('client-1');

            expect(service.getAccess('client-1')).toEqual({ mode: 'unrestricted' });
        });
    });

    describe('describe', () => {
        it('reports unrestricted with an empty alias list', () => {
            expect(service.describe('client-1')).toEqual({
                clientId: 'client-1',
                mode: 'unrestricted',
                aliases: [],
            });
        });

        it('reports the restricted set sorted by alias key', () => {
            repo.replaceForClient('client-1', ['slave', 'atlas', 'codex']);

            expect(service.describe('client-1')).toEqual({
                clientId: 'client-1',
                mode: 'restricted',
                aliases: ['atlas', 'codex', 'slave'],
            });
        });
    });

    describe('replace', () => {
        it('replaces the whole set and returns the new state', () => {
            service.replace('client-1', ['codex', 'slave']);

            const view = service.replace('client-1', ['atlas']);

            expect(view).toEqual({
                clientId: 'client-1',
                mode: 'restricted',
                aliases: ['atlas'],
            });
            expect(service.describe('client-1').aliases).toEqual(['atlas']);
            expect(service.isPermitted(service.getAccess('client-1'), 'codex')).toBe(false);
        });

        it('leaves other clients alone', () => {
            service.replace('client-2', ['slave']);

            service.replace('client-1', ['codex']);

            expect(service.describe('client-2').aliases).toEqual(['slave']);
        });

        it('accepts an empty list as "clear": the admin layer is what forbids it', () => {
            service.replace('client-1', ['codex', 'slave']);

            // The service is a dumb writer on purpose. `[]` means "no rows",
            // which unambiguously means UNRESTRICTED to `getAccess`; refusing
            // it is an operator-safety rule that belongs to the HTTP surface,
            // because only there can the operator be told to use DELETE.
            expect(service.replace('client-1', [])).toEqual({
                clientId: 'client-1',
                mode: 'unrestricted',
                aliases: [],
            });
        });
    });

    describe('clear', () => {
        it('returns the client to unrestricted', () => {
            service.replace('client-1', ['codex', 'slave']);

            const view = service.clear('client-1');

            expect(view).toEqual({
                clientId: 'client-1',
                mode: 'unrestricted',
                aliases: [],
            });
            expect(service.getAccess('client-1')).toEqual({ mode: 'unrestricted' });
        });

        it('is a no-op for a client that was already unrestricted', () => {
            expect(service.clear('client-1')).toEqual({
                clientId: 'client-1',
                mode: 'unrestricted',
                aliases: [],
            });
        });
    });
});
