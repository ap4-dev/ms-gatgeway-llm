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
 *
 * **It resolves the target exactly like the server does.** `main.ts` calls
 * `inyectEnv()` (Doppler) BEFORE `getEnv()`, so Doppler's `DATABASE_PATH` is
 * the one the gateway opens. A CLI that only read `.env` could migrate one
 * file while the gateway served another, so:
 *
 *   - `--db <path>` is the explicit operator escape hatch (no network).
 *   - with `START_TOKEN` set the secrets are loaded through the SAME
 *     `inyectEnv()` the server uses, with the per-key value logging muted.
 *   - if that lookup fails the command aborts with exit 1. Falling back to the
 *     schema default would silently migrate the wrong database.
 *   - without `START_TOKEN` nothing changes: `.env`, then the shell, then the
 *     default.
 *
 * Every run prints where the path came from (`database: … (from …)`) so an
 * operator can see why that file was chosen before confirming anything.
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
    /**
     * Loads the secrets the server loads at boot (Doppler) and must populate
     * `opts.env` with them, exactly like `inyectEnv` populates `process.env`.
     * Defaults to the real `inyectEnv`; tests inject a double instead of
     * touching the network.
     */
    loadSecrets?: SecretsLoader;
}

export interface SecretsLoaderOptions {
    /** The environment object the loader must write the loaded secrets into. */
    env: NodeJS.ProcessEnv;
    /** True when per-key value logging must be suppressed. */
    quiet: boolean;
}

export interface SecretsProvenance {
    /** Doppler project (`MS`). */
    project: string;
    /** Doppler config (`dev` | `stg` | `prd`). */
    config: string;
}

export type SecretsLoader = (opts: SecretsLoaderOptions) => Promise<SecretsProvenance>;

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

/** Provenance labels printed next to the resolved path. */
export const PROVENANCE_FLAG = '--db';
export const PROVENANCE_ENV_FILE = '.env';
export const PROVENANCE_SHELL = 'shell';
export const PROVENANCE_DEFAULT = 'default';

/** `Doppler <project>/<config>` — the values `inyectEnv` derives. */
export function dopplerProvenanceLabel(p: SecretsProvenance): string {
    return `Doppler ${p.project}/${p.config}`;
}

/**
 * Resolve the database path exactly like the app does: `--db`, else
 * `DATABASE_PATH`, else `./data/ms-gateway.db`, relative to `cwd`.
 *
 * Resolution assumes the caller has already merged the sources in the same
 * order the server does (`.env`, then Doppler, then the process environment).
 * `resolveTarget` below is the entry point that guarantees that.
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

function targetHeader(
    mode: Mode,
    dbPath: string,
    migrationsDir: string,
    provenance: string,
): string[] {
    return [
        `db-migrate · ${mode}`,
        `  database:   ${dbPath}  (from ${provenance})`,
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
    provenance: string;
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

    const header = targetHeader('apply', o.dbPath, o.migrationsDir, o.provenance);

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
    provenance: string;
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
            header: targetHeader(o.mode, o.dbPath, o.migrationsDir, o.provenance),
            applied: appliedNames,
            pending: files.filter((f) => !known.has(f)),
            mode: o.mode,
        }),
        exitCode: 0,
    };
}

/**
 * Load `<cwd>/.env` into `env` so `DATABASE_PATH` matches what `dotenv/config`
 * seeds before Doppler (and before `@nestjs/config`) reads it. `env` defaults
 * to `process.env`, but an injected environment (tests) is honoured so the
 * merge is observable.
 */
function loadDotenv(cwd: string, env: NodeJS.ProcessEnv): void {
    try {
        loadDotenvFile({ path: resolve(cwd, '.env'), quiet: true, processEnv: env });
    } catch {
        // No .env (or dotenv unavailable) — fall back to the shell environment.
    }
}

/**
 * The real secrets loader: the SAME `inyectEnv` the server calls at boot
 * (`main.ts`), with per-key value logging muted. Loaded lazily so the CLI does
 * not drag `@nestjs/common` / the Doppler SDK into every invocation (and so
 * `--db` really is an offline path).
 *
 * `inyectEnv` writes into `process.env`; when the caller injected a different
 * `env` object (tests), that object is the one resolution reads, so the loaded
 * `DATABASE_PATH` is mirrored onto it.
 */
async function loadSecretsWithDoppler(
    opts: SecretsLoaderOptions,
): Promise<SecretsProvenance> {
    const { inyectEnv } = await import('../../app.enviroment.js');
    const result = await inyectEnv({ quiet: opts.quiet });
    if (opts.env !== process.env && process.env.DATABASE_PATH !== undefined) {
        opts.env.DATABASE_PATH = process.env.DATABASE_PATH;
    }
    return { project: result.project, config: result.config };
}

/**
 * A short reason for a failed Doppler lookup.
 *
 * The SDK rejects with a plain object (`{ title, statusCode, detail }`), and
 * `String(err)` would print `[object Object]`. Summarise status + title only:
 * never dump the payload, because an error body is untrusted text that can end
 * up in a ticket next to real secrets.
 */
function describeSecretsError(err: unknown): string {
    if (err === null || err === undefined) return 'unknown error';
    const o = err as { title?: unknown; message?: unknown; statusCode?: unknown };
    const parts: Array<string | number> = [];
    if (typeof o.statusCode === 'number') parts.push(o.statusCode);
    if (typeof o.title === 'string' && o.title.trim() !== '') {
        parts.push(o.title.trim());
    } else if (
        typeof o.message === 'string' &&
        o.message.trim() !== '' &&
        o.message.trim() !== '[object Object]'
    ) {
        parts.push(o.message.trim());
    }
    if (parts.length > 0) return parts.join(' ');
    if (typeof err === 'string' && err.trim() !== '') return err.trim();
    return 'unknown error';
}

/**
 * Abort rather than guess. A silent fallback to `./data/ms-gateway.db` here is
 * exactly how the wrong database gets migrated: the server would have read
 * `DATABASE_PATH` from Doppler and opened a different file.
 */
function secretsFailure(err: unknown): CliError {
    return new CliError(
        1,
        [
            'the database path could not be resolved safely: the Doppler secrets the',
            `server loads at boot could not be loaded (${describeSecretsError(err)}).`,
            '',
            'The gateway takes DATABASE_PATH from Doppler, so continuing with the .env or',
            'schema default here could migrate a DIFFERENT file than the one the gateway',
            'will read. Nothing was written and no migration was applied.',
            '',
            'Fix START_TOKEN / MS / NODE_ENV so the lookup succeeds, or pass --db <path>',
            'to target a database deliberately (--db never contacts Doppler).',
        ].join('\n'),
    );
}

export interface ResolvedTarget {
    dbPath: string;
    /** Human label explaining why that path was chosen. */
    provenance: string;
}

/**
 * Resolve the database the way the server does, and label the provenance.
 *
 * Priority: `--db` (offline) → Doppler `DATABASE_PATH` (when `START_TOKEN` is
 * set) → `.env` → shell → schema default. Note that `.env` is loaded FIRST and
 * Doppler second, which is the order `dotenv/config` + `inyectEnv` produce at
 * boot: Doppler wins because it is applied later.
 */
export async function resolveTarget(
    opts: {
        db?: string;
        env: NodeJS.ProcessEnv;
        cwd: string;
        loadEnv: boolean;
        loadSecrets?: SecretsLoader;
    },
): Promise<ResolvedTarget> {
    const { db, env, cwd } = opts;

    // The explicit override: no Doppler, no network, no guessing.
    if (db !== undefined) {
        if (opts.loadEnv) loadDotenv(cwd, env);
        return {
            dbPath: resolveDatabasePath({ db, env, cwd }),
            provenance: PROVENANCE_FLAG,
        };
    }

    // Capture the shell value before `.env` is merged: dotenv never overrides
    // an existing variable, so a pre-existing value is the shell's.
    const shellHasPath = env.DATABASE_PATH !== undefined && env.DATABASE_PATH !== '';
    if (opts.loadEnv) loadDotenv(cwd, env);
    const localProvenance = shellHasPath
        ? PROVENANCE_SHELL
        : env.DATABASE_PATH !== undefined && env.DATABASE_PATH !== ''
          ? PROVENANCE_ENV_FILE
          : PROVENANCE_DEFAULT;

    const startToken = env.START_TOKEN;
    if (!startToken) {
        // Local-development path: no network, no Doppler, unchanged behaviour.
        return { dbPath: resolveDatabasePath({ env, cwd }), provenance: localProvenance };
    }

    const beforeDoppler = env.DATABASE_PATH;
    let secrets: SecretsProvenance;
    try {
        secrets = await (opts.loadSecrets ?? loadSecretsWithDoppler)({
            env,
            quiet: true,
        });
    } catch (err) {
        throw secretsFailure(err);
    }

    const dopplerLabel = dopplerProvenanceLabel(secrets);
    const suppliedByDoppler =
        env.DATABASE_PATH !== undefined && env.DATABASE_PATH !== beforeDoppler;

    return {
        dbPath: resolveDatabasePath({ env, cwd }),
        provenance: suppliedByDoppler
            ? dopplerLabel
            : // Doppler was consulted but did not carry the path: say both,
              // so the label never claims more than it knows.
              `${dopplerLabel} + ${localProvenance}`,
    };
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
  database:   --db, else resolved EXACTLY like the server does.
              main.ts calls inyectEnv() (Doppler) before getEnv(), so with
              START_TOKEN set this command loads the same secrets first and
              DATABASE_PATH is the file the gateway will actually open.
              If that lookup fails the command aborts (exit 1) instead of
              falling back to the default: guessing is how the wrong database
              gets migrated.
              Without START_TOKEN: <cwd>/.env, then the shell, then the default.
  migrations: resolve(cwd, 'migrations') — the same path the gateway resolves

  Every run prints the resolved path AND where it came from, so read that line
  before confirming:
    database:   /srv/app/data/gateway.db  (from Doppler ms-proxy-llm/prd)
    database:   /srv/app/data/ms-gateway.db  (from .env)
    database:   /tmp/other.db  (from --db)

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
 * Unconditionally async: resolving the target may require the Doppler lookup
 * the server performs at boot. `scripts/db-migrate.js` normalises with
 * `Promise.resolve(...).then(...)`, which awaits it and propagates the exit
 * code; the apply path keeps its own async backup fallback.
 */
export async function main(
    argv: readonly string[],
    deps: MainDeps = {},
): Promise<CliResult> {
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
        const target = await resolveTarget({
            db: args.db,
            env: deps.env ?? process.env,
            cwd,
            loadEnv: deps.loadEnv !== false,
            loadSecrets: deps.loadSecrets,
        });
        const migrationsDir = resolveMigrationsDir(cwd);

        if (args.status || args.dryRun) {
            return runStatus({
                dbPath: target.dbPath,
                migrationsDir,
                provenance: target.provenance,
                mode: args.dryRun ? 'dry-run' : 'status',
            });
        }

        return await runApply({
            dbPath: target.dbPath,
            migrationsDir,
            provenance: target.provenance,
            backup: Boolean(args.backup),
            now: deps.now ?? (() => new Date()),
            sqliteVersion: deps.sqliteVersion,
        });
    } catch (err) {
        return failureResult(err);
    }
}
