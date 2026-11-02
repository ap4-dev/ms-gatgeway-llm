import Database from 'better-sqlite3';
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
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

// --- Doppler test double -------------------------------------------------
// `inyectEnv` (src/app.enviroment.ts) constructs a DopplerSDK and calls
// `secrets.download`. Mocking the SDK module keeps these tests off the network:
// the double delegates to whatever the current case installs on globalThis.
jest.mock('@dopplerhq/node-sdk', () => {
    class MockDopplerSDK {
        public secrets: { download: (...args: unknown[]) => Promise<unknown> };
        constructor() {
            this.secrets = {
                download: (...args: unknown[]) => {
                    const impl = (
                        globalThis as unknown as {
                            __dopplerDownload?: (...a: unknown[]) => Promise<unknown>;
                        }
                    ).__dopplerDownload;
                    if (!impl) throw new Error('no Doppler test double installed');
                    return impl(...args);
                },
            };
        }
    }
    return { DopplerSDK: MockDopplerSDK };
});

interface Project {
    root: string;
    migrationsDir: string;
    dbPath: string;
    deps: MainDeps;
    cleanup: () => void;
}

function makeProject(overrides: MainDeps = {}): Project {
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
        deps: {
            ...{ cwd: root, env: { DATABASE_PATH: dbPath }, loadEnv: false },
            ...overrides,
        },
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
    it('--help exits 0 with the usage text', async () => {
        const r = await main(['--help']);
        expect(r).toEqual({ text: HELP, exitCode: 0 });
        expect(HELP).toContain('--status');
        expect(HELP).toContain('--dry-run');
        expect(HELP).toContain('--backup');
        expect(HELP).toContain('--db');
    });

    it('an unknown flag exits 2 and prints usage', async () => {
        const r = await main(['--nope']);
        expect(r.exitCode).toBe(2);
        expect(r.text).toContain('--nope');
        expect(r.text).toContain('USAGE');
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

    it('does not open a database for --help', async () => {
        const project = makeProject();
        try {
            await main(['--help'], { ...project.deps, env: { DATABASE_PATH: project.dbPath } });
            expect(existsSync(project.dbPath)).toBe(false);
        } finally {
            project.cleanup();
        }
    });
});

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

// --- provenance ---------------------------------------------------------
// `pnpm db:migrate` must resolve the database the SERVER reads. The server
// calls `inyectEnv()` (Doppler) before `getEnv()`, so a CLI that only reads
// `.env` can migrate one file while the gateway serves another. Every run
// therefore prints where the path came from, and a failed Doppler lookup
// aborts instead of silently falling back to the schema default.

const DOPPLER_PRJ = { project: 'ms-proxy-llm', config: 'prd' };

describe('main provenance — local resolution', () => {
    it('labels the schema default when DATABASE_PATH is unset', async () => {
        const project = makeProject({ env: {} });
        try {
            const r = await run(['--status'], project.deps);
            expect(r.exitCode).toBe(0);
            expect(r.text).toContain(resolve(project.root, 'data', 'ms-gateway.db'));
            expect(r.text).toMatch(/database:\s+\S+.*\(from default\)/);
        } finally {
            project.cleanup();
        }
    });

    it('labels --db when the operator overrides the path', async () => {
        const project = makeProject();
        try {
            const override = join(project.root, 'elsewhere', 'override.db');
            const r = await run(['--status', '--db', override], project.deps);
            expect(r.text).toContain(resolve(override));
            expect(r.text).toMatch(/\(from --db\)/);
        } finally {
            project.cleanup();
        }
    });

    it('labels the shell when DATABASE_PATH is already in the environment', async () => {
        const project = makeProject();
        try {
            const r = await run(['--status'], project.deps);
            expect(r.text).toMatch(/\(from shell\)/);
        } finally {
            project.cleanup();
        }
    });

    it('labels .env when DATABASE_PATH comes from the project .env file', async () => {
        const project = makeProject({ env: {}, loadEnv: true });
        try {
            const envDb = join(project.root, 'data', 'from-env.db');
            writeFileSync(join(project.root, '.env'), `DATABASE_PATH=${envDb}\n`);
            const r = await run(['--status'], project.deps);
            expect(r.exitCode).toBe(0);
            expect(r.text).toContain(envDb);
            expect(r.text).toMatch(/\(from \.env\)/);
        } finally {
            project.cleanup();
        }
    });
});

describe('main provenance — Doppler (START_TOKEN)', () => {
    it('the Doppler DATABASE_PATH wins over .env and the schema default', async () => {
        const project = makeProject({ env: { START_TOKEN: 'doppler-token' }, loadEnv: true });
        try {
            const envDb = join(project.root, 'data', 'from-env.db');
            writeFileSync(join(project.root, '.env'), `DATABASE_PATH=${envDb}\n`);
            const dopplerDb = join(project.root, 'data', 'doppler.db');
            const calls: Array<{ quiet?: boolean }> = [];

            const r = await run(['--status'], {
                ...project.deps,
                loadSecrets: async (opts) => {
                    calls.push(opts);
                    opts.env.DATABASE_PATH = dopplerDb;
                    return DOPPLER_PRJ;
                },
            });

            expect(r.exitCode).toBe(0);
            // Doppler wins over .env (and over ./data/ms-gateway.db).
            expect(r.text).toContain(dopplerDb);
            expect(r.text).not.toContain(envDb);
            expect(r.text).not.toContain('ms-gateway.db');
            // ...and the label names the Doppler project + config.
            expect(r.text).toContain('Doppler ms-proxy-llm/prd');
            // Exactly one lookup, with the per-key value logging suppressed.
            expect(calls).toHaveLength(1);
            expect(calls[0].quiet).toBe(true);
        } finally {
            project.cleanup();
        }
    });

    it('aborts with exit 1 when the secrets loader fails, mentions --db, writes nothing', async () => {
        const project = makeProject({ env: { START_TOKEN: 'doppler-token' } });
        try {
            const r = await run([], {
                ...project.deps,
                loadSecrets: async () => {
                    throw new Error('doppler 401 unauthorized');
                },
            });

            expect(r.exitCode).toBe(1);
            expect(r.text).toMatch(/could not be resolved safely/i);
            expect(r.text).toContain('--db');
            // Not a silent fallback to the schema default.
            expect(r.text).not.toContain('ms-gateway.db');
            expect(existsSync(project.dbPath)).toBe(false);
            expect(existsSync(join(project.root, 'data'))).toBe(false);
        } finally {
            project.cleanup();
        }
    });

    it('summarises the SDK rejection without dumping the error payload', async () => {
        const project = makeProject({ env: { START_TOKEN: 'doppler-token' } });
        try {
            const sdkError = {
                title: 'Unauthorized',
                statusCode: 401,
                detail: { messages: ['Invalid Auth token'], success: false },
            };
            const r = await run(['--status'], {
                ...project.deps,
                loadSecrets: () => Promise.reject(sdkError),
            });

            expect(r.exitCode).toBe(1);
            // Readable reason instead of `[object Object]`...
            expect(r.text).toContain('401 Unauthorized');
            // ...and no raw payload next to the operator-facing message.
            expect(r.text).not.toContain('Invalid Auth token');
            expect(existsSync(project.dbPath)).toBe(false);
        } finally {
            project.cleanup();
        }
    });

    it('survives the SDK error shape (`Error` with `[object Object]` message)', async () => {
        // Observed in practice: the SDK rejects with an Error whose enumerable
        // fields carry the payload, so `String(err)` / `err.message` is the
        // useless `[object Object]`.
        const project = makeProject({ env: { START_TOKEN: 'doppler-token' } });
        try {
            const wrapped = Object.assign(new Error('[object Object]'), {
                title: 'Unauthorized',
                statusCode: 401,
                detail: { messages: ['Invalid Auth token'], success: false },
            });
            const r = await run(['--status'], {
                ...project.deps,
                loadSecrets: () => Promise.reject(wrapped),
            });

            expect(r.exitCode).toBe(1);
            expect(r.text).toContain('401 Unauthorized');
            expect(r.text).not.toContain('[object Object]');
            expect(existsSync(project.dbPath)).toBe(false);
        } finally {
            project.cleanup();
        }
    });

    it('aborts before touching an existing database when the loader fails', async () => {
        const project = makeProject({ env: { START_TOKEN: 'doppler-token' } });
        try {
            // Pre-existing database with everything applied.
            await run([], { ...project.deps, env: { DATABASE_PATH: project.dbPath } });
            const before = readFileSync(project.dbPath);
            writeFileSync(
                join(project.migrationsDir, '0003_gamma.sql'),
                'CREATE TABLE gamma (id INTEGER PRIMARY KEY);\n',
            );

            const r = await run([], {
                ...project.deps,
                loadSecrets: async () => {
                    throw new Error('doppler unreachable');
                },
            });

            expect(r.exitCode).toBe(1);
            expect(existsSync(project.dbPath)).toBe(true);
            expect(readFileSync(project.dbPath).equals(before)).toBe(true);
            const db = new Database(project.dbPath, { readonly: true });
            expect(tableNames(db)).not.toContain('gamma');
            db.close();
        } finally {
            project.cleanup();
        }
    });

    it('--db skips the secrets loader entirely and still applies', async () => {
        const project = makeProject({ env: { START_TOKEN: 'doppler-token' } });
        try {
            const override = join(project.root, 'elsewhere', 'override.db');
            const loader = jest.fn(async () => DOPPLER_PRJ);

            const r = await run(['--db', override], {
                ...project.deps,
                loadSecrets: loader as unknown as MainDeps['loadSecrets'],
            });

            expect(loader).not.toHaveBeenCalled();
            expect(r.exitCode).toBe(0);
            expect(r.text).toMatch(/\(from --db\)/);
            expect(existsSync(override)).toBe(true);
            expect(existsSync(project.dbPath)).toBe(false);
        } finally {
            project.cleanup();
        }
    });

    it('without START_TOKEN the loader is not called and .env resolution still works', async () => {
        const project = makeProject({ env: {}, loadEnv: true });
        try {
            const envDb = join(project.root, 'data', 'from-env.db');
            writeFileSync(join(project.root, '.env'), `DATABASE_PATH=${envDb}\n`);
            const loader = jest.fn(async () => DOPPLER_PRJ);

            const r = await run(['--status'], {
                ...project.deps,
                loadSecrets: loader as unknown as MainDeps['loadSecrets'],
            });

            expect(loader).not.toHaveBeenCalled();
            expect(r.exitCode).toBe(0);
            expect(r.text).toContain(envDb);
        } finally {
            project.cleanup();
        }
    });

    it('without START_TOKEN the loader is not called and the default still resolves', async () => {
        const project = makeProject({ env: {} });
        try {
            const loader = jest.fn(async () => DOPPLER_PRJ);
            const r = await run(['--status'], {
                ...project.deps,
                loadSecrets: loader as unknown as MainDeps['loadSecrets'],
            });
            expect(loader).not.toHaveBeenCalled();
            expect(r.text).toContain(resolve(project.root, 'data', 'ms-gateway.db'));
        } finally {
            project.cleanup();
        }
    });
});

describe('main provenance — --status stays read-only', () => {
    it('writes nothing and creates no database file with a secrets loader', async () => {
        const project = makeProject({ env: { START_TOKEN: 'doppler-token' } });
        try {
            const dopplerDb = join(project.root, 'data', 'doppler.db');
            const before = readdirSync(project.root).sort();

            const r = await run(['--status'], {
                ...project.deps,
                loadSecrets: async (opts) => {
                    opts.env.DATABASE_PATH = dopplerDb;
                    return DOPPLER_PRJ;
                },
            });

            expect(r.exitCode).toBe(0);
            expect(r.text).toMatch(/nothing written/i);
            expect(existsSync(dopplerDb)).toBe(false);
            expect(existsSync(join(project.root, 'data'))).toBe(false);
            expect(readdirSync(project.root).sort()).toEqual(before);
        } finally {
            project.cleanup();
        }
    });
});

// --- shim ---------------------------------------------------------------

const SCRIPTS_DIR = resolve(__dirname, '..', '..', '..', 'scripts');
const SHIM = join(SCRIPTS_DIR, 'db-migrate.js');
const DIST_CLI = resolve(__dirname, '..', '..', '..', 'dist', 'database', 'migrations', 'migrate-cli.js');

/** Runs the real shim; returns exit code + streams. */
function runShim(argv: string[], cwd: string): { status: number; stdout: string; stderr: string } {
    try {
        const stdout = execFileSync(process.execPath, [SHIM, ...argv], {
            cwd,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        return { status: 0, stdout, stderr: '' };
    } catch (err) {
        const e = err as { status?: number; stdout?: string; stderr?: string };
        return { status: e.status ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
    }
}

// The shim runs the COMPILED output, so these cases need `pnpm build` first.
// `main` is now unconditionally async; the shim's Promise.resolve(...).then
// must still propagate the reported exit code (0 ok, 1 failure, 2 bad flags).
const shimDescribe = existsSync(DIST_CLI) ? describe : describe.skip;

shimDescribe('scripts/db-migrate.js exit-code contract', () => {
    it('propagates exit 2 for an unknown flag', () => {
        const project = makeProject();
        try {
            const r = runShim(['--nope'], project.root);
            expect(r.stdout).not.toMatch(/Build first/i);
            expect(r.status).toBe(2);
            expect(`${r.stdout}${r.stderr}`).toContain('USAGE');
        } finally {
            project.cleanup();
        }
    });

    it('propagates exit 1 when main reports a failure', () => {
        const project = makeProject();
        try {
            rmSync(project.migrationsDir, { recursive: true, force: true });
            const r = runShim(['--status', '--db', join(project.root, 'data', 'shim.db')], project.root);
            expect(r.stdout).not.toMatch(/Build first/i);
            expect(r.status).toBe(1);
            expect(`${r.stdout}${r.stderr}`).toMatch(/migrations directory does not exist/i);
        } finally {
            project.cleanup();
        }
    });

    it('propagates exit 0 and prints the provenance for a read-only status', () => {
        const project = makeProject();
        try {
            const r = runShim(['--status', '--db', join(project.root, 'data', 'shim.db')], project.root);
            expect(r.status).toBe(0);
            expect(r.stdout).toContain('(from --db)');
        } finally {
            project.cleanup();
        }
    });
});

// --- inyectEnv quiet option ---------------------------------------------
// `app.enviroment.ts` has no spec of its own; its quiet option exists
// exclusively for this CLI, so it is covered here rather than in a new file.
// The Doppler SDK is mocked above; nothing here touches the network.

describe('inyectEnv quiet option', () => {
    const originalEnv = { ...process.env };

    afterEach(() => {
        process.env = { ...originalEnv };
        delete (globalThis as unknown as { __dopplerDownload?: unknown }).__dopplerDownload;
        jest.restoreAllMocks();
    });

    /**
     * Load a FRESH `app.enviroment` (+ its `@nestjs/common`) inside an isolated
     * registry, with NODE_ENV fixed to `development` so the per-key debug
     * logging path is deterministic, and with `Logger#log` spied on that same
     * instance.
     */
    function loadEnviroment(): {
        inyectEnv: typeof import('../../app.enviroment').inyectEnv;
        logged: jest.SpyInstance;
        warned: jest.SpyInstance;
    } {
        process.env.NODE_ENV = 'development';
        let inyectEnv!: typeof import('../../app.enviroment').inyectEnv;
        let logged!: jest.SpyInstance;
        let warned!: jest.SpyInstance;
        jest.isolateModules(() => {
            const common = require('@nestjs/common') as typeof import('@nestjs/common');
            logged = jest.spyOn(common.Logger.prototype, 'log').mockImplementation(() => undefined);
            warned = jest.spyOn(common.Logger.prototype, 'warn').mockImplementation(() => undefined);
            const mod = require('../../app.enviroment') as typeof import('../../app.enviroment');
            inyectEnv = mod.inyectEnv;
        });
        return { inyectEnv, logged, warned };
    }

    it('suppresses the per-key value logging when quiet is requested', async () => {
        process.env.START_TOKEN = 'token';
        delete process.env.DATABASE_PATH;
        (globalThis as unknown as { __dopplerDownload?: unknown }).__dopplerDownload = async () => ({
            API_KEY_PEPPER: 'secret-pepper-value',
            DATABASE_PATH: '/var/db/doppler.db',
        });

        const { inyectEnv, logged } = loadEnviroment();
        const result = await inyectEnv({ quiet: true });

        const lines = logged.mock.calls.map((c) => String(c[0])).join('\n');
        expect(result.loaded).toBe(true);
        // No secret VALUE anywhere in the log...
        expect(lines).not.toContain('secret-pepper-value');
        expect(lines).not.toMatch(/API_KEY_PEPPER:/);
        // ...but the final success line is kept.
        expect(lines).toMatch(/Secretos cargados/i);
        // The secrets themselves were still applied to the environment.
        expect(process.env.DATABASE_PATH).toBe('/var/db/doppler.db');
    });

    it('still logs every key by default, so the server boot log is unchanged', async () => {
        process.env.START_TOKEN = 'token';
        delete process.env.DATABASE_PATH;
        (globalThis as unknown as { __dopplerDownload?: unknown }).__dopplerDownload = async () => ({
            API_KEY_PEPPER: 'secret-pepper-value',
            DATABASE_PATH: '/var/db/doppler.db',
        });

        const { inyectEnv, logged } = loadEnviroment();
        const result = await inyectEnv();

        const lines = logged.mock.calls.map((c) => String(c[0])).join('\n');
        expect(result.loaded).toBe(true);
        expect(lines).toContain('API_KEY_PEPPER: secret-pepper-value');
        expect(lines).toContain('DATABASE_PATH: /var/db/doppler.db');
        expect(lines).toMatch(/Secretos cargados/i);
    });

    it('reports the Doppler project/config it derived and no secrets when START_TOKEN is absent', async () => {
        // Empty string, not `delete`: `app.enviroment` runs `dotenv.config()`
        // on load, and dotenv only skips keys that are already PRESENT. An
        // explicit empty value keeps the repo's own `.env` out of this case
        // (dotenv never overrides) and `!token` still takes the skip branch.
        process.env.START_TOKEN = '';
        const download = jest.fn();
        (globalThis as unknown as { __dopplerDownload?: unknown }).__dopplerDownload = download;

        const { inyectEnv, logged, warned } = loadEnviroment();
        const result = await inyectEnv({ quiet: true });

        expect(download).not.toHaveBeenCalled();
        expect(result.loaded).toBe(false);
        expect(typeof result.project).toBe('string');
        expect(['dev', 'stg', 'prd']).toContain(result.config);
        expect(warned.mock.calls.map((c) => String(c[0])).join('\n')).toMatch(/START_TOKEN/i);
        expect(logged).not.toHaveBeenCalled();
    });
});
