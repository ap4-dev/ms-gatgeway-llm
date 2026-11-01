import Database from 'better-sqlite3';
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
    HELP,
    describeDbError,
    main,
    parseArgs,
    resolveDatabasePath,
    resolveMigrationsDir,
    type CliResult,
    type MainDeps,
} from './migrate-cli';

interface Project {
    root: string;
    migrationsDir: string;
    dbPath: string;
    deps: MainDeps;
    cleanup: () => void;
}

function makeProject(): Project {
    const root = mkdtempSync(join(tmpdir(), 'ms-migrate-cli-'));
    const migrationsDir = join(root, 'migrations');
    mkdirSync(migrationsDir, { recursive: true });
    writeFileSync(
        join(migrationsDir, '0001_alpha.sql'),
        'CREATE TABLE alpha (id INTEGER PRIMARY KEY);\n',
    );
    writeFileSync(
        join(migrationsDir, '0002_beta.sql'),
        'CREATE TABLE beta (id INTEGER PRIMARY KEY);\n',
    );
    const dbPath = join(root, 'data', 'test.db');
    return {
        root,
        migrationsDir,
        dbPath,
        deps: { cwd: root, env: { DATABASE_PATH: dbPath }, loadEnv: false },
        cleanup: () => rmSync(root, { recursive: true, force: true }),
    };
}

/** `main` is sync for the VACUUM INTO path and async for the backup fallback. */
async function run(argv: string[], deps: MainDeps): Promise<CliResult> {
    return await main(argv, deps);
}

function tableNames(db: Database.Database): string[] {
    return (
        db
            .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
            .all() as Array<{ name: string }>
    ).map((r) => r.name);
}

function appliedNames(db: Database.Database): string[] {
    const hasTable = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='_migrations'")
        .get();
    if (!hasTable) return [];
    return (
        db.prepare('SELECT name FROM _migrations ORDER BY name').all() as Array<{
            name: string;
        }>
    ).map((r) => r.name);
}

describe('parseArgs', () => {
    it('defaults to apply mode with nothing set', () => {
        expect(parseArgs([])).toEqual({ _: [], unknown: [] });
    });

    it('captures --help and -h', () => {
        expect(parseArgs(['--help'])).toEqual({ _: [], unknown: [], help: true });
        expect(parseArgs(['-h'])).toEqual({ _: [], unknown: [], help: true });
    });

    it('captures --status, --dry-run and --backup', () => {
        expect(parseArgs(['--status'])).toEqual({ _: [], unknown: [], status: true });
        expect(parseArgs(['--dry-run'])).toEqual({ _: [], unknown: [], dryRun: true });
        expect(parseArgs(['--backup'])).toEqual({ _: [], unknown: [], backup: true });
    });

    it('captures --db <path>', () => {
        expect(parseArgs(['--db', '/tmp/x.db'])).toEqual({
            _: [],
            unknown: [],
            db: '/tmp/x.db',
        });
    });

    it('collects unknown flags instead of silently ignoring them', () => {
        const out = parseArgs(['--nope', '--backup', '-x']);
        expect(out.unknown).toEqual(['--nope', '-x']);
        expect(out.backup).toBe(true);
    });

    // `pnpm run db:migrate -- --status` forwards the literal `--` separator to
    // the script, so the parser must tolerate it. Without this the documented
    // invocation exits 2 as an unknown flag, and the command looks broken
    // exactly when an operator is trying to inspect a database.
    it('ignores the `--` separator pnpm forwards', () => {
        expect(parseArgs(['--', '--status'])).toEqual({
            _: [],
            unknown: [],
            status: true,
        });
        expect(parseArgs(['--', '--db', '/tmp/x.db', '--backup'])).toEqual({
            _: [],
            unknown: [],
            db: '/tmp/x.db',
            backup: true,
        });
    });

    it('preserves positional args in `_`', () => {
        expect(parseArgs(['extra', 'args'])._).toEqual(['extra', 'args']);
    });
});

describe('resolveDatabasePath', () => {
    it('defaults to ./data/ms-gateway.db relative to cwd, like env.schema.ts', () => {
        expect(resolveDatabasePath({ env: {}, cwd: '/srv/app' })).toBe(
            '/srv/app/data/ms-gateway.db',
        );
    });

    it('reads DATABASE_PATH from the environment', () => {
        expect(
            resolveDatabasePath({ env: { DATABASE_PATH: './data/other.db' }, cwd: '/srv/app' }),
        ).toBe('/srv/app/data/other.db');
    });

    it('honours an absolute DATABASE_PATH unchanged', () => {
        expect(
            resolveDatabasePath({ env: { DATABASE_PATH: '/var/db/gw.db' }, cwd: '/srv/app' }),
        ).toBe('/var/db/gw.db');
    });

    it('--db overrides DATABASE_PATH', () => {
        expect(
            resolveDatabasePath({
                db: '/tmp/override.db',
                env: { DATABASE_PATH: '/var/db/gw.db' },
                cwd: '/srv/app',
            }),
        ).toBe('/tmp/override.db');
    });

    it('resolves a relative --db against cwd', () => {
        expect(resolveDatabasePath({ db: './tmp/x.db', env: {}, cwd: '/srv/app' })).toBe(
            '/srv/app/tmp/x.db',
        );
    });

    it('keeps :memory: verbatim', () => {
        expect(resolveDatabasePath({ db: ':memory:', env: {}, cwd: '/srv/app' })).toBe(
            ':memory:',
        );
    });
});

describe('resolveMigrationsDir', () => {
    it('resolves to <cwd>/migrations — exactly what database.module.ts uses', () => {
        expect(resolveMigrationsDir('/srv/app')).toBe('/srv/app/migrations');
    });
});

describe('describeDbError', () => {
    it('explains SQLITE_BUSY as "the gateway is probably running"', () => {
        const msg = describeDbError({ code: 'SQLITE_BUSY' });
        expect(msg).toMatch(/gateway is probably running/i);
        expect(msg).toMatch(/stop it first/i);
    });

    it('recognises the "database is locked" message even without a code', () => {
        expect(describeDbError(new Error('database is locked'))).toMatch(
            /gateway is probably running/i,
        );
    });

    it('returns null for unrelated errors', () => {
        expect(describeDbError(new Error('no such table: nope'))).toBeNull();
    });
});

describe('main --help / unknown flag', () => {
    it('--help exits 0 with the usage text', () => {
        const r = main(['--help']);
        expect(r).toEqual({ text: HELP, exitCode: 0 });
        expect(HELP).toContain('--status');
        expect(HELP).toContain('--dry-run');
        expect(HELP).toContain('--backup');
    });

    it('an unknown flag exits 2 and prints usage', () => {
        const r = main(['--nope']);
        expect(syncResult(r).exitCode).toBe(2);
        expect(syncResult(r).text).toContain('--nope');
        expect(syncResult(r).text).toContain('USAGE');
    });

    it('an unknown flag never touches the database', async () => {
        const project = makeProject();
        try {
            const r = await run(['--nope'], project.deps);
            expect(r.exitCode).toBe(2);
            expect(existsSync(project.dbPath)).toBe(false);
        } finally {
            project.cleanup();
        }
    });

    it('a --db without a value is rejected with exit 2', async () => {
        const project = makeProject();
        try {
            const r = await run(['--db'], project.deps);
            expect(r.exitCode).toBe(2);
            expect(r.text).toContain('--db');
            expect(existsSync(project.dbPath)).toBe(false);
        } finally {
            project.cleanup();
        }
    });

    it('does not open a database for --help', () => {
        const project = makeProject();
        try {
            main(['--help'], { ...project.deps, env: { DATABASE_PATH: project.dbPath } });
            expect(existsSync(project.dbPath)).toBe(false);
        } finally {
            project.cleanup();
        }
    });
});

/** Narrow the sync/async union in a synchronous test body. */
function syncResult(r: CliResult | Promise<CliResult>): CliResult {
    if (typeof (r as Promise<CliResult>).then === 'function') {
        throw new Error('expected a synchronous result');
    }
    return r as CliResult;
}

describe('main --status', () => {
    it('lists every file as pending on a fresh database and writes nothing', async () => {
        const project = makeProject();
        try {
            const r = await run(['--status'], project.deps);
            expect(r.exitCode).toBe(0);
            expect(r.text).toContain('0001_alpha.sql');
            expect(r.text).toContain('0002_beta.sql');
            expect(r.text).toMatch(/pending/i);
            // No file, no table, no _migrations row.
            expect(existsSync(project.dbPath)).toBe(false);
        } finally {
            project.cleanup();
        }
    });

    it('prints the resolved database path and migrations dir on every run', async () => {
        const project = makeProject();
        try {
            const r = await run(['--status'], project.deps);
            expect(r.text).toContain(resolve(project.dbPath));
            expect(r.text).toContain(resolve(project.migrationsDir));
        } finally {
            project.cleanup();
        }
    });

    it('reports applied vs pending without touching the database', async () => {
        const project = makeProject();
        try {
            await run([], project.deps);
            writeFileSync(
                join(project.migrationsDir, '0003_gamma.sql'),
                'CREATE TABLE gamma (id INTEGER PRIMARY KEY);\n',
            );
            const before = readFileSync(project.dbPath);

            const r = await run(['--status'], project.deps);
            expect(r.exitCode).toBe(0);
            expect(r.text).toMatch(/applied[\s\S]*0001_alpha\.sql/);
            expect(r.text).toMatch(/pending[\s\S]*0003_gamma\.sql/);

            expect(readFileSync(project.dbPath).equals(before)).toBe(true);
            const db = new Database(project.dbPath, { readonly: true });
            expect(tableNames(db)).not.toContain('gamma');
            expect(appliedNames(db)).toEqual(['0001_alpha.sql', '0002_beta.sql']);
            db.close();
        } finally {
            project.cleanup();
        }
    });
});

describe('main --dry-run', () => {
    it('reports but does not create tables or _migrations records', async () => {
        const project = makeProject();
        try {
            const r = await run(['--dry-run'], project.deps);
            expect(r.exitCode).toBe(0);
            expect(r.text).toMatch(/would apply/i);
            expect(r.text).toContain('0001_alpha.sql');
            expect(r.text).toContain('0002_beta.sql');
            expect(existsSync(project.dbPath)).toBe(false);
        } finally {
            project.cleanup();
        }
    });

    it('says nothing would be applied when everything is already recorded', async () => {
        const project = makeProject();
        try {
            await run([], project.deps);
            const before = readFileSync(project.dbPath);
            const r = await run(['--dry-run'], project.deps);
            expect(r.exitCode).toBe(0);
            expect(r.text).toMatch(/would apply \(0\)/i);
            expect(readFileSync(project.dbPath).equals(before)).toBe(true);
        } finally {
            project.cleanup();
        }
    });
});

describe('main (apply)', () => {
    it('--db overrides DATABASE_PATH, so the env-configured database is untouched', async () => {
        const project = makeProject();
        try {
            const override = join(project.root, 'elsewhere', 'override.db');
            const r = await run(['--db', override], project.deps);
            expect(r.exitCode).toBe(0);
            expect(r.text).toContain(resolve(override));
            expect(existsSync(override)).toBe(true);
            expect(existsSync(project.dbPath)).toBe(false);
        } finally {
            project.cleanup();
        }
    });

    it('applies pending files through MigrationRunner and records them', async () => {
        const project = makeProject();
        try {
            const r = await run([], project.deps);
            expect(r.exitCode).toBe(0);
            expect(r.text).toMatch(/applied \(2\)/);
            expect(r.text).toContain('0001_alpha.sql');
            expect(r.text).toContain('0002_beta.sql');
            expect(r.text).toMatch(/elapsed|ms/);

            const db = new Database(project.dbPath, { readonly: true });
            expect(tableNames(db)).toEqual(['_migrations', 'alpha', 'beta']);
            expect(appliedNames(db)).toEqual(['0001_alpha.sql', '0002_beta.sql']);
            const kinds = db.prepare('SELECT DISTINCT kind FROM _migrations').all() as Array<{
                kind: string;
            }>;
            expect(kinds).toEqual([{ kind: 'schema' }]);
            db.close();
        } finally {
            project.cleanup();
        }
    });

    it('a second apply reports the files as skipped and is a no-op', async () => {
        const project = makeProject();
        try {
            await run([], project.deps);
            const before = readFileSync(project.dbPath);

            const r = await run([], project.deps);
            expect(r.exitCode).toBe(0);
            expect(r.text).toMatch(/applied \(0\)/);
            expect(r.text).toMatch(/skipped \(2\)/);

            expect(readFileSync(project.dbPath).equals(before)).toBe(true);
            const db = new Database(project.dbPath, { readonly: true });
            expect(appliedNames(db)).toEqual(['0001_alpha.sql', '0002_beta.sql']);
            db.close();
        } finally {
            project.cleanup();
        }
    });
});

describe('main --backup', () => {
    const FROZEN = new Date('2026-01-02T03:04:05.000Z');
    const STAMP = '20260102T030405Z';

    it('copies the database before applying, so the copy holds the previous schema', async () => {
        const project = makeProject();
        try {
            await run([], project.deps);
            writeFileSync(
                join(project.migrationsDir, '0003_gamma.sql'),
                'CREATE TABLE gamma (id INTEGER PRIMARY KEY);\n',
            );

            const r = await run(['--backup'], {
                ...project.deps,
                now: () => FROZEN,
            });
            expect(r.exitCode).toBe(0);

            const backupPath = join(project.root, 'data', `test.backup-${STAMP}.db`);
            expect(r.text).toContain(backupPath);
            expect(existsSync(backupPath)).toBe(true);

            const copy = new Database(backupPath, { readonly: true });
            expect(tableNames(copy)).toEqual(['_migrations', 'alpha', 'beta']);
            expect(appliedNames(copy)).toEqual(['0001_alpha.sql', '0002_beta.sql']);
            copy.close();

            const live = new Database(project.dbPath, { readonly: true });
            expect(tableNames(live)).toEqual(['_migrations', 'alpha', 'beta', 'gamma']);
            live.close();
        } finally {
            project.cleanup();
        }
    });

    it('never overwrites: a second backup in the same second picks a new name', async () => {
        const project = makeProject();
        try {
            await run([], project.deps);
            const first = await run(['--backup'], { ...project.deps, now: () => FROZEN });
            const firstPath = join(project.root, 'data', `test.backup-${STAMP}.db`);
            const firstBytes = readFileSync(firstPath);

            const second = await run(['--backup'], { ...project.deps, now: () => FROZEN });
            const secondPath = join(project.root, 'data', `test.backup-${STAMP}-2.db`);
            expect(second.text).toContain(secondPath);
            expect(existsSync(secondPath)).toBe(true);
            expect(second.exitCode).toBe(0);
            // The first backup is untouched.
            expect(readFileSync(firstPath).equals(firstBytes)).toBe(true);
            expect(first.text).toContain(firstPath);
        } finally {
            project.cleanup();
        }
    });

    it('reports the SQLite version so the operator can confirm VACUUM INTO support', async () => {
        const project = makeProject();
        try {
            const r = await run(['--backup'], { ...project.deps, now: () => FROZEN });
            expect(r.exitCode).toBe(0);
            expect(r.text).toMatch(/sqlite:\s+\d+\.\d+\.\d+/);
        } finally {
            project.cleanup();
        }
    });

    it('falls back to the async db.backup() API when VACUUM INTO is unsupported', async () => {
        const project = makeProject();
        try {
            const r = await run(['--backup'], {
                ...project.deps,
                now: () => FROZEN,
                sqliteVersion: '3.22.0',
            });
            expect(r.exitCode).toBe(0);
            expect(r.text).toMatch(/3\.22\.0/);
            expect(r.text).toMatch(/backup\(\)|fallback/i);
            const backupPath = join(project.root, 'data', `test.backup-${STAMP}.db`);
            expect(existsSync(backupPath)).toBe(true);
            const copy = new Database(backupPath, { readonly: true });
            // Empty database at backup time — but the file is a valid SQLite DB.
            expect(tableNames(copy)).toEqual([]);
            copy.close();
            // The migration still ran afterwards.
            const live = new Database(project.dbPath, { readonly: true });
            expect(appliedNames(live)).toEqual(['0001_alpha.sql', '0002_beta.sql']);
            live.close();
        } finally {
            project.cleanup();
        }
    });
});

describe('main error paths', () => {
    it('fails with exit 1 and prints the resolved path when migrations/ is missing', async () => {
        const project = makeProject();
        try {
            rmSync(project.migrationsDir, { recursive: true, force: true });
            const r = await run([], project.deps);
            expect(r.exitCode).toBe(1);
            expect(r.text).toContain(resolve(project.migrationsDir));
            expect(r.text).toMatch(/does not exist|not found/i);
            expect(existsSync(project.dbPath)).toBe(false);
        } finally {
            project.cleanup();
        }
    });

    it('fails with exit 1 on a broken migration, leaves it unrecorded and rolls back', async () => {
        const project = makeProject();
        try {
            writeFileSync(
                join(project.migrationsDir, '0003_bad.sql'),
                'CREATE TABLE gamma (id INTEGER PRIMARY KEY);\n' +
                    'INSERT INTO missing_table VALUES (1);\n',
            );
            const r = await run([], project.deps);
            expect(r.exitCode).toBe(1);
            expect(r.text).toContain('0003_bad.sql');
            expect(r.text).toMatch(/database was left unchanged/i);

            const db = new Database(project.dbPath, { readonly: true });
            expect(appliedNames(db)).toEqual(['0001_alpha.sql', '0002_beta.sql']);
            expect(tableNames(db)).not.toContain('gamma');
            db.close();
        } finally {
            project.cleanup();
        }
    });

    it('--status on a missing migrations dir also exits 1', async () => {
        const project = makeProject();
        try {
            rmSync(project.migrationsDir, { recursive: true, force: true });
            const r = await run(['--status'], project.deps);
            expect(r.exitCode).toBe(1);
            expect(r.text).toContain(resolve(project.migrationsDir));
        } finally {
            project.cleanup();
        }
    });
});
