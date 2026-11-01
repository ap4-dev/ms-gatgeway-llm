import Database from 'better-sqlite3';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { config as loadDotenvFile } from 'dotenv';
import { MigrationRunner, type MigrationRecord } from './migration-runner';

/**
 * `pnpm db:migrate` — operator CLI that applies pending SQL migrations to the
 * gateway database, out of band, and reports exactly what it did.
 *
 * The CLI **never** applies DDL itself. It constructs the same
 * {@link MigrationRunner} the server uses at boot, so `_migrations` stays the
 * single source of truth: a file applied here is skipped at the next boot and
 * vice versa. Applying DDL any other way would make the server re-run the file
 * and fail on `table already exists`.
 *
 * Shape mirrors `src/admin/admin-reset-cli.ts`: an exported argument parser,
 * exported pure/reporting helpers, and a `main(argv, deps?)` entry that returns
 * `{ text, exitCode }` and never calls `process.exit` itself. The thin runtime
 * shim is `scripts/db-migrate.js`, which runs the compiled `dist/` output.
 */

/** Path used by `env.schema.ts` when `DATABASE_PATH` is unset. */
export const DEFAULT_DATABASE_PATH = './data/ms-gateway.db';

/** First SQLite release that supports `VACUUM INTO`. */
export const VACUUM_INTO_MIN_VERSION = '3.27.0';

export type Mode = 'apply' | 'status' | 'dry-run';

export interface CliResult {
    text: string;
    exitCode: number;
}

export interface ParsedArgs {
    _: string[];
    unknown: string[];
    help?: boolean;
    status?: boolean;
    dryRun?: boolean;
    backup?: boolean;
    db?: string;
}

export interface MainDeps {
    /** Directory used for `.env` and for resolving relative paths. */
    cwd?: string;
    /** Environment to read `DATABASE_PATH` from (defaults to `process.env`). */
    env?: NodeJS.ProcessEnv;
    /** Set to `false` to skip loading `<cwd>/.env` (tests). */
    loadEnv?: boolean;
    /** Clock seam for backup file names (tests). */
    now?: () => Date;
    /** Version seam; when it reports < 3.27 the async backup fallback is used. */
    sqliteVersion?: string;
}

export class CliError extends Error {
    constructor(
        public readonly code: number,
        message: string,
    ) {
        super(message);
        this.name = 'CliError';
    }
}

// --- args ---------------------------------------------------------------

/** Flags that consume the next argv entry as their value. */
const VALUE_FLAGS = new Set(['--db']);

export function parseArgs(argv: readonly string[]): ParsedArgs {
    const out: ParsedArgs = { _: [], unknown: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--') {
            // `pnpm run <script> -- <args>` forwards the separator as a literal
            // argv entry AHEAD of the real arguments, so a bare `--` is a
            // passthrough marker, not an unknown flag and not a stop-parsing
            // token. Skipping it (rather than treating the rest as positional)
            // is what makes the documented invocations work verbatim.
            continue;
        }
        if (a === '--help' || a === '-h') {
            out.help = true;
        } else if (a === '--status') {
            out.status = true;
        } else if (a === '--dry-run') {
            out.dryRun = true;
        } else if (a === '--backup') {
            out.backup = true;
        } else if (VALUE_FLAGS.has(a)) {
            const value = argv[++i];
            if (value === undefined || value.startsWith('-')) {
                // Missing value: reported as an unknown/incomplete option so
                // the operator gets the usage text and exit 2.
                out.unknown.push(a);
                if (value !== undefined) out.unknown.push(value);
            } else {
                out.db = value;
            }
        } else if (a.startsWith('-')) {
            out.unknown.push(a);
        } else {
            out._.push(a);
        }
    }
    return out;
}

// --- path resolution ----------------------------------------------------

/**
 * Resolve the database path exactly like the app does: `--db`, else
 * `DATABASE_PATH`, else `./data/ms-gateway.db`, relative to `cwd`.
 */
export function resolveDatabasePath(opts: {
    db?: string;
    env: NodeJS.ProcessEnv;
    cwd: string;
}): string {
    const raw = opts.db ?? opts.env.DATABASE_PATH ?? DEFAULT_DATABASE_PATH;
    if (raw === ':memory:') return ':memory:';
    return isAbsolute(raw) ? raw : resolve(opts.cwd, raw);
}

/**
 * `resolve(cwd, 'migrations')` — the same expression `database.module.ts`
 * evaluates against `process.cwd()` at boot. Deliberately no fallback: a
 * fallback here would let the CLI succeed where the server then fails.
 */
export function resolveMigrationsDir(cwd: string): string {
    return resolve(cwd, 'migrations');
}

// --- database helpers ---------------------------------------------------

/**
 * Turn SQLITE_BUSY / "database is locked" into an operational message, or
 * return `null` for unrelated errors. Mirrors the advice an operator needs:
 * migrations take the write lock, so a running gateway must be stopped first.
 */
export function describeDbError(err: unknown): string | null {
    const code = (err as { code?: unknown } | null)?.code;
    const message = String(
        (err as { message?: unknown } | null)?.message ?? err ?? '',
    );
    const busy =
        code === 'SQLITE_BUSY' ||
        code === 'SQLITE_LOCKED' ||
        /database is locked|database table is locked/i.test(message);
    if (!busy) return null;
    return [
        `the database is locked (${typeof code === 'string' ? code : 'SQLITE_BUSY'}) — the gateway is probably running.`,
        'Stop it first: migrations take the write lock and will block while the gateway serves traffic.',
        "This command does not retry (only better-sqlite3's default 5s busy timeout applies); nothing was changed.",
    ].join('\n');
}

/**
 * List applied records **without** creating `_migrations`.
 *
 * `MigrationRunner.appliedMigrations()` would `CREATE TABLE IF NOT EXISTS`
 * first, which would make `--status`/`--dry-run` write to the database. The
 * apply path still goes exclusively through the runner.
 */
export function listAppliedRecords(db: Database.Database): MigrationRecord[] {
    const table = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='_migrations'")
        .get();
    if (!table) return [];
    const rows = db
        .prepare('SELECT name, applied_at, kind FROM _migrations ORDER BY name')
        .all() as Array<{ name: string; applied_at: number; kind: MigrationRecord['kind'] }>;
    return rows.map((r) => ({
        name: r.name,
        appliedAt: r.applied_at,
        kind: r.kind,
    }));
}

/**
 * Pending `*.sql` files, in the same lexical order the runner applies them.
 * Mirrors `MigrationRunner`'s private listing; a missing directory is a hard
 * error that names the absolute path that was checked.
 */
export function listMigrationFiles(migrationsDir: string): string[] {
    let entries: string[];
    try {
        entries = readdirSync(migrationsDir);
    } catch (err) {
        const code = (err as { code?: string } | null)?.code;
        if (code === 'ENOENT') {
            throw new CliError(
                1,
                [
                    `migrations directory does not exist: ${migrationsDir}`,
                    'The gateway resolves the same path at boot (resolve(cwd, \'migrations\')),',
                    'so this command will not guess a different one. Run it from the project',
                    'root (or the directory the server is started from). Nothing was written.',
                ].join('\n'),
            );
        }
        throw new CliError(
            1,
            `cannot read migrations directory ${migrationsDir}: ${errorMessage(err)}`,
        );
    }
    return entries.filter((f) => f.endsWith('.sql')).sort();
}

// --- backup -------------------------------------------------------------

export interface BackupOutcome {
    path: string;
    version: string;
    mechanism: 'VACUUM INTO' | 'db.backup()';
}

/** Compact UTC timestamp, e.g. `20260102T030405Z`. */
export function utcStamp(at: Date): string {
    return at
        .toISOString()
        .replace(/[-:]/g, '')
        .replace(/\.\d{3}Z$/, 'Z');
}

/**
 * `<db-path-without-extension>.backup-<UTC-timestamp>.db`
 * (e.g. `data/ms-gateway.backup-20260102T030405Z.db`).
 */
export function backupPathFor(dbPath: string, at: Date): string {
    const base = basename(dbPath).replace(/\.db$/i, '');
    return join(dirname(dbPath), `${base}.backup-${utcStamp(at)}.db`);
}

/** True when `version` is at least {@link VACUUM_INTO_MIN_VERSION}. */
export function supportsVacuumInto(version: string): boolean {
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
    if (!m) return false;
    const major = Number(m[1]);
    const minor = Number(m[2]);
    return major > 3 || (major === 3 && minor >= 27);
}

function escapeSqlString(value: string): string {
    return value.replace(/'/g, "''");
}

function readSqliteVersion(db: Database.Database): string {
    try {
        const row = db.prepare('SELECT sqlite_version() AS v').get() as { v?: string };
        return row?.v ?? 'unknown';
    } catch {
        return 'unknown';
    }
}

// --- rendering ----------------------------------------------------------

function targetHeader(mode: Mode, dbPath: string, migrationsDir: string): string[] {
    return [
        `db-migrate · ${mode}`,
        `  database:   ${dbPath}`,
        `  migrations: ${migrationsDir}`,
    ];
}

function listBlock(label: string, names: readonly string[]): string[] {
    const head = `${label} (${names.length}):`;
    if (names.length === 0) return [head, '  (none)'];
    return [head, ...names.map((n) => `  - ${n}`)];
}

function renderApply(o: {
    header: string[];
    backup?: BackupOutcome;
    applied: readonly string[];
    skipped: readonly string[];
    elapsedMs: number;
}): string {
    const lines = [...o.header];
    if (o.backup) {
        lines.push(`  sqlite:     ${o.backup.version}`);
        lines.push(`  backup:     ${o.backup.path}`);
        lines.push(`  backup via: ${o.backup.mechanism}`);
        if (o.backup.mechanism !== 'VACUUM INTO') {
            lines.push(
                `  note:       VACUUM INTO needs SQLite ${VACUUM_INTO_MIN_VERSION}+; used the async db.backup() fallback.`,
            );
        }
    }
    lines.push('');
    lines.push(...listBlock('applied', o.applied));
    lines.push(...listBlock('skipped', o.skipped));
    lines.push('');
    lines.push(`elapsed: ${o.elapsedMs} ms`);
    return `${lines.join('\n')}\n`;
}

function renderStatus(o: {
    header: string[];
    applied: readonly string[];
    pending: readonly string[];
    mode: Extract<Mode, 'status' | 'dry-run'>;
}): string {
    const pendingLabel = o.mode === 'dry-run' ? 'would apply' : 'pending';
    const lines = [
        ...o.header,
        '',
        ...listBlock('applied', o.applied),
        ...listBlock(pendingLabel, o.pending),
        '',
        `nothing written (--${o.mode})`,
    ];
    return `${lines.join('\n')}\n`;
}

function errorMessage(err: unknown): string {
    if (err instanceof Error) return err.message;
    return String(err);
}

function failureResult(err: unknown): CliResult {
    const busy = describeDbError(err);
    if (busy) {
        return { text: `ERROR (exit 1): ${busy}\n`, exitCode: 1 };
    }
    if (err instanceof CliError) {
        return { text: `ERROR (exit ${err.code}): ${err.message}\n`, exitCode: err.code };
    }
    return {
        text:
            `ERROR (exit 1): ${errorMessage(err)}\n\n` +
            'Each migration runs inside its own transaction, so the failing file was rolled\n' +
            'back and the database was left unchanged. Fix the SQL and run `pnpm db:migrate` again.\n',
        exitCode: 1,
    };
}

// --- execution ----------------------------------------------------------

function ensureParentDir(dbPath: string): void {
    if (dbPath === ':memory:') return;
    // Same behaviour as `DatabaseService`: first boot in a fresh checkout works.
    mkdirSync(dirname(dbPath), { recursive: true });
}

function openDatabase(
    dbPath: string,
    opts: { readonly?: boolean } = {},
): Database.Database {
    try {
        return opts.readonly
            ? new Database(dbPath, { readonly: true, fileMustExist: true })
            : new Database(dbPath);
    } catch (err) {
        throw new CliError(1, describeDbError(err) ?? errorMessage(err));
    }
}

function closeQuietly(db: Database.Database): void {
    try {
        if (db.open) db.close();
    } catch {
        // Nothing useful to do while exiting.
    }
}

function isPromise<T>(value: T | Promise<T>): value is Promise<T> {
    return typeof (value as Promise<T>)?.then === 'function';
}

interface ApplyOptions {
    dbPath: string;
    migrationsDir: string;
    backup: boolean;
    now: () => Date;
    sqliteVersion?: string;
}

/**
 * Backup before applying: `VACUUM INTO` is synchronous and produces a
 * consistent, compacted copy. It refuses to write over an existing file, so
 * the destination is verified free first (and a `-2`, `-3`, … suffix is used
 * when the same second is hit twice — a backup is never overwritten).
 */
function createBackup(
    db: Database.Database,
    dbPath: string,
    o: ApplyOptions,
): BackupOutcome | Promise<BackupOutcome> {
    const version = o.sqliteVersion ?? readSqliteVersion(db);
    const path = reserveBackupPath(dbPath, o.now());
    if (supportsVacuumInto(version)) {
        db.exec(`VACUUM INTO '${escapeSqlString(path)}'`);
        return { path, version, mechanism: 'VACUUM INTO' };
    }
    // Older SQLite: asynchronous better-sqlite3 API (same consistent copy).
    return db.backup(path).then(() => ({
        path,
        version,
        mechanism: 'db.backup()' as const,
    }));
}

function reserveBackupPath(dbPath: string, at: Date): string {
    const first = backupPathFor(dbPath, at);
    if (!existsSync(first)) return first;
    const stem = first.replace(/\.db$/i, '');
    for (let n = 2; n < 1000; n++) {
        const candidate = `${stem}-${n}.db`;
        if (!existsSync(candidate)) return candidate;
    }
    throw new CliError(
        1,
        `cannot find a free backup file name next to ${first} (is the clock stuck?)`,
    );
}

function runApply(o: ApplyOptions): CliResult | Promise<CliResult> {
    try {
        // Validate the directory before creating anything on disk. The runner
        // re-lists the files itself; this call only fails fast with the
        // absolute path that was checked.
        listMigrationFiles(o.migrationsDir);
        ensureParentDir(o.dbPath);
    } catch (err) {
        return failureResult(err);
    }

    let db: Database.Database;
    try {
        db = openDatabase(o.dbPath);
    } catch (err) {
        return failureResult(err);
    }

    const header = targetHeader('apply', o.dbPath, o.migrationsDir);

    const finish = (backup?: BackupOutcome): CliResult => {
        try {
            const started = Date.now();
            // The ONE mechanism allowed to apply migrations.
            const runner = new MigrationRunner(
                db,
                o.migrationsDir,
                join(o.migrationsDir, 'seeds'),
            );
            const result = runner.run();
            return {
                text: renderApply({
                    header,
                    backup,
                    applied: result.applied,
                    skipped: result.skipped,
                    elapsedMs: Date.now() - started,
                }),
                exitCode: 0,
            };
        } catch (err) {
            return failureResult(err);
        } finally {
            closeQuietly(db);
        }
    };

    if (!o.backup) return finish();

    let step: BackupOutcome | Promise<BackupOutcome>;
    try {
        step = createBackup(db, o.dbPath, o);
    } catch (err) {
        closeQuietly(db);
        return failureResult(err);
    }

    if (isPromise(step)) {
        return step
            .then((backup) => finish(backup))
            .catch((err) => {
                closeQuietly(db);
                return failureResult(err);
            });
    }
    return finish(step);
}

function runStatus(o: {
    dbPath: string;
    migrationsDir: string;
    mode: Extract<Mode, 'status' | 'dry-run'>;
}): CliResult {
    let files: string[];
    try {
        files = listMigrationFiles(o.migrationsDir);
    } catch (err) {
        return failureResult(err);
    }

    let applied: MigrationRecord[] = [];
    // A missing database file means "nothing applied yet": do not create it.
    if (o.dbPath === ':memory:' || existsSync(o.dbPath)) {
        let db: Database.Database | undefined;
        try {
            db = openDatabase(o.dbPath, { readonly: true });
            applied = listAppliedRecords(db);
        } catch (err) {
            return failureResult(err);
        } finally {
            if (db) closeQuietly(db);
        }
    }

    const appliedNames = applied.map((r) => r.name);
    const known = new Set(appliedNames);
    return {
        text: renderStatus({
            header: targetHeader(o.mode, o.dbPath, o.migrationsDir),
            applied: appliedNames,
            pending: files.filter((f) => !known.has(f)),
            mode: o.mode,
        }),
        exitCode: 0,
    };
}

/** Load `<cwd>/.env` so `DATABASE_PATH` matches what `@nestjs/config` reads. */
function loadDotenv(cwd: string): void {
    try {
        loadDotenvFile({ path: resolve(cwd, '.env'), quiet: true });
    } catch {
        // No .env (or dotenv unavailable) — fall back to the shell environment.
    }
}

export const HELP = `
db-migrate — apply pending SQL migrations to the gateway database.

Runs the COMPILED output in dist/ (run \`pnpm build\` first) through the same
MigrationRunner the server uses at boot, so the row recorded in _migrations is
exactly the one the built server expects to find. Do not apply DDL any other
way: the server would re-run the file and fail on "table already exists".

USAGE
  pnpm build                     # once, so dist/ matches the source
  pnpm db:migrate                # apply pending migrations
  pnpm db:migrate -- --status    # show applied + pending, write nothing
  pnpm db:migrate -- --dry-run   # same report, worded as "would apply"
  pnpm db:migrate -- --backup    # consistent DB copy before applying
  pnpm db:migrate -- --db <path> # override DATABASE_PATH for this run
  pnpm db:migrate -- --help

TARGET
  database:   --db, else DATABASE_PATH from <cwd>/.env, else ./data/ms-gateway.db
  migrations: resolve(cwd, 'migrations') — the same path the gateway resolves
  Both are printed on every run so there is no ambiguity about what was touched.

BACKUP
  --backup writes <db-without-extension>.backup-<UTC-timestamp>.db using
  SQLite's \`VACUUM INTO\` (synchronous, consistent, compacted; needs 3.27+).
  An existing file is never overwritten: a -2, -3, … suffix is appended.

EXIT CODES
  0  success / nothing to do
  1  failure (migration error, missing migrations dir, locked database)
  2  unknown or incomplete flag (usage is printed)

STOP THE GATEWAY FIRST
  Migrations take SQLite's write lock. If the database is locked this command
  fails immediately with SQLITE_BUSY instead of retrying — the message tells you
  to stop the gateway, because a blocked migration holds a lock requests need.
`.trim();

/**
 * Entry point. Returns text + exit code (never calls `process.exit`).
 *
 * Synchronous for the normal paths. When `--backup` runs against a SQLite older
 * than 3.27 the copy falls back to better-sqlite3's async `db.backup()` API and
 * the returned value is a promise, so callers should `await`/`Promise.resolve`.
 */
export function main(
    argv: readonly string[],
    deps: MainDeps = {},
): CliResult | Promise<CliResult> {
    const args = parseArgs(argv);

    if (args.help) return { text: HELP, exitCode: 0 };
    if (args.unknown.length > 0) {
        return {
            text:
                `ERROR (exit 2): unrecognised or incomplete option(s): ${args.unknown.join(', ')}\n\n` +
                HELP,
            exitCode: 2,
        };
    }

    const cwd = deps.cwd ?? process.cwd();
    try {
        if (deps.loadEnv !== false) loadDotenv(cwd);
        const env = deps.env ?? process.env;
        const dbPath = resolveDatabasePath({ db: args.db, env, cwd });
        const migrationsDir = resolveMigrationsDir(cwd);

        if (args.status || args.dryRun) {
            return runStatus({
                dbPath,
                migrationsDir,
                mode: args.dryRun ? 'dry-run' : 'status',
            });
        }

        return runApply({
            dbPath,
            migrationsDir,
            backup: Boolean(args.backup),
            now: deps.now ?? (() => new Date()),
            sqliteVersion: deps.sqliteVersion,
        });
    } catch (err) {
        return failureResult(err);
    }
}
