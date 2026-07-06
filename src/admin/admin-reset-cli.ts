import { generateApiKey, hashApiKey } from '../auth/api-key-hash.util';

/**
 * Phase-6 operator CLI: generates an API-key credential pair and outputs
 * (a) the plaintext key the operator saves, plus (b) the SQL statement
 * to paste into `sqlite3` against the gateway DB.
 *
 * The script **never opens the DB** — the user runs the SQL themselves,
 * which is the operational escape hatch for the "I lost the admin key"
 * chicken-and-egg. Wired into `package.json` as `pnpm admin:reset`.
 *
 * Hashing delegates to `hashApiKey` in `src/auth/api-key-hash.util.ts`
 * so the runtime and the CLI share a single source of truth for the
 * algorithm. The pepper is read from `process.env.API_KEY_PEPPER` —
 * the operator must export the same secret the gateway uses.
 */

export interface ParsedArgs {
    _: string[];
    help?: boolean;
    reset?: string;
    create?: boolean;
    id?: string;
    name?: string;
    rpm?: number;
    scopes?: string;
    plain?: string;
}

export interface Credentials {
    plain: string;
    prefix: string;
    stored: string;
}

export interface AdminResetOutput {
    kind: 'RESET' | 'CREATE';
    clientId: string;
    plain: string;
    stored: string;
    prefix: string;
    sql: string;
}

/** Default scope list for new clients (call them `--scopes=` to override). */
export const DEFAULT_SCOPES = 'chat.read,chat.write';

/**
 * Minimum pepper length. Mirror of the env-schema constraint. The CLI
 * checks this so operators get a clear message instead of a `null`
 * signature error mid-write.
 */
export const PEPPER_MIN_LENGTH = 32;

export class CliError extends Error {
    constructor(public readonly code: number, message: string) {
        super(message);
    }
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
    const out: ParsedArgs = { _: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--help' || a === '-h') {
            out.help = true;
        } else if (a === '--reset') {
            out.reset = argv[++i];
        } else if (a === '--create') {
            out.create = true;
        } else if (a === '--id') {
            out.id = argv[++i];
        } else if (a === '--name') {
            out.name = argv[++i];
        } else if (a === '--rpm') {
            const v = parseInt(argv[++i], 10);
            out.rpm = Number.isFinite(v) ? v : undefined;
        } else if (a === '--scopes') {
            out.scopes = argv[++i];
        } else if (a === '--plain') {
            out.plain = argv[++i];
        } else {
            out._.push(a);
        }
    }
    return out;
}

/**
 * Produce an `sk-...` plaintext, its 8-char public prefix, and the
 * `hmac$<hex>` value to store. Same algorithm as the runtime verifier.
 *
 * Format mirrors `src/auth/api-key-hash.util.hashApiKey` so anything
 * the gateway accepts later verifies cleanly here. Both `plain` and
 * `pepper` are required (one exception: `plain` defaults to a fresh
 * random key — that path is for new client provisioning only).
 */
export function generateCredentials(opts: {
    plain?: string;
    pepper: string;
}): Credentials {
    if (!opts.pepper || opts.pepper.length < PEPPER_MIN_LENGTH) {
        throw new CliError(
            2,
            `API_KEY_PEPPER must be set and at least ${PEPPER_MIN_LENGTH} chars ` +
                '(generate with `openssl rand -hex 32`).',
        );
    }
    const plain = opts.plain ?? generateApiKey();
    const stored = hashApiKey(plain, opts.pepper);
    return {
        plain,
        prefix: plain.slice(0, 8),
        stored,
    };
}

/** Escape a single quote per ANSI SQL (''). */
export function sqlQuote(s: string): string {
    return s.replace(/'/g, "''");
}

/** Single-line UPDATE for rotating the stored hash of an existing client. */
export function buildResetSql(opts: {
    clientId: string;
    stored: string;
    prefix: string;
}): string {
    return (
        `UPDATE clients SET ` +
        `api_key_hash = '${sqlQuote(opts.stored)}', ` +
        `api_key_prefix = '${sqlQuote(opts.prefix)}', ` +
        `last_used_at = NULL ` +
        `WHERE id = '${sqlQuote(opts.clientId)}'`
    );
}

/** Single-line INSERT for a brand-new client. */
export function buildCreateSql(opts: {
    id: string;
    name: string;
    scopes: string;
    rpm: number;
    stored: string;
    prefix: string;
}): string {
    return (
        `INSERT INTO clients (id, name, api_key_hash, api_key_prefix, scopes, rate_limit_rpm) VALUES (` +
        `'${sqlQuote(opts.id)}', ` +
        `'${sqlQuote(opts.name)}', ` +
        `'${sqlQuote(opts.stored)}', ` +
        `'${sqlQuote(opts.prefix)}', ` +
        `'${sqlQuote(opts.scopes)}', ` +
        `${opts.rpm}` +
        `)`
    );
}

/** Banner text the CLI writes to stdout. Tests assert against this string. */
export function formatOutput(o: AdminResetOutput): string {
    const bar = '─'.repeat(64);
    return [
        bar,
        `admin-reset · ${o.kind} · client '${o.clientId}'`,
        bar,
        '',
        'PLAIN API KEY (save NOW — never shown again):',
        `  ${o.plain}`,
        '',
        'SQL to apply (paste into sqlite3 against the gateway DB):',
        '',
        `  ${o.sql};`,
        '',
        bar,
        '',
    ].join('\n');
}

export const HELP = `
admin-reset.js — operator helper for the clients table.

USAGE
  # Rotate the API key for an existing client (most common: admin):
  API_KEY_PEPPER=$YOUR_PEPPER node scripts/admin-reset.js --reset <client-id>

  # Create a new client row (prints plaintext key + SQL INSERT):
  API_KEY_PEPPER=$YOUR_PEPPER node scripts/admin-reset.js --create --id <slug> \\
       --name "<label>" [--rpm <n>] [--scopes "<csv>"]

  # Hash an existing API key (use when you already have the key):
  API_KEY_PEPPER=$YOUR_PEPPER node scripts/admin-reset.js \\
       --reset <client-id> --plain "<api-key>"

  # Show this help:
  node scripts/admin-reset.js --help

ENV
  The CLI hashes keys with HMAC-SHA256 (pepper = API_KEY_PEPPER). The pepper
  must match what the gateway runtime uses, otherwise freshly-hashed rows will
  401. Default if unset or too short: an error message + non-zero exit code.
  Generate with:   openssl rand -hex 32

DEFAULT SCOPES (when --scopes is omitted on --create)
  ${DEFAULT_SCOPES}

DEFAULT NAME (on --create when --name is absent)
  the value of --id

The --plain flag overrides the random key generation: the CLI uses the
exact API key you provide and only hashes it for the DB. Useful when you
already have a key and only need the DB-ready hash (e.g. operators who
rotated keys in another tool, or developers who already have a key assigned
and only need the proxy's DB to recognise it).

The script NEVER opens the database. It only prints:
  • the plaintext key (save it NOW — never shown again), and
  • the SQL statement the operator runs against the gateway DB via
    sqlite3 (or any other DB tool).

EXAMPLES
  API_KEY_PEPPER=$YOUR_PEPPER node scripts/admin-reset.js --reset admin
  API_KEY_PEPPER=$YOUR_PEPPER node scripts/admin-reset.js \\
       --create --id tenant-acme --name "Acme Co." --rpm 300
  API_KEY_PEPPER=$YOUR_PEPPER node scripts/admin-reset.js \\
       --reset admin --plain "sk-your-existing-key-here"
`.trim();

/**
 * Build the output payload (kind, clientId, plain, stored, prefix, sql)
 * for a given args vector. Pure — used by both `main()` and tests.
 *
 * `pepper` is required; pass it through unchanged from the env. When
 * `main()` is the caller, it reads from process.env and throws on miss.
 */
export function buildOutput(
    args: ParsedArgs,
    pepper: string,
    creds?: { plain?: string },
): AdminResetOutput | 'HELP' | null {
    if (args.help || (!args.reset && !args.create)) return 'HELP';
    if (args.create && !args.id) return null;

    if (args.plain !== undefined && args.plain.trim().length === 0) {
        throw new CliError(2, '--plain requires a non-empty key.');
    }

    const c = generateCredentials({
        plain: args.plain ?? creds?.plain,
        pepper,
    });
    let kind: 'RESET' | 'CREATE';
    let clientId: string;
    let sql: string;
    if (args.reset) {
        kind = 'RESET';
        clientId = args.reset;
        sql = buildResetSql({ clientId, stored: c.stored, prefix: c.prefix });
    } else {
        kind = 'CREATE';
        clientId = args.id!;
        sql = buildCreateSql({
            id: clientId,
            name: args.name ?? clientId,
            scopes: args.scopes ?? DEFAULT_SCOPES,
            rpm: args.rpm ?? 60,
            stored: c.stored,
            prefix: c.prefix,
        });
    }
    return { kind, clientId, plain: c.plain, stored: c.stored, prefix: c.prefix, sql };
}

/**
 * Read the API_KEY_PEPPER env var, throwing a CliError with a non-zero
 * exit code on miss. Public so tests can exercise it.
 */
export function readPepper(env: NodeJS.ProcessEnv = process.env): string {
    const pepper = env.API_KEY_PEPPER;
    if (!pepper || pepper.length < PEPPER_MIN_LENGTH) {
        throw new CliError(
            2,
            `API_KEY_PEPPER missing or shorter than ${PEPPER_MIN_LENGTH} chars. ` +
                'Generate with `openssl rand -hex 32` and export it before invoking this CLI.',
        );
    }
    return pepper;
}

/**
 * Lazily try to load `.env` from cwd. No-ops if dotenv isn't installed
 * or if the file is missing — the operator can still supply the pepper
 * via the shell. Kept in `main()` so unit tests (which run the source
 * directly) don't accidentally mutate test process state.
 *
 * Note: dotenv v17 prints a `◇ injected env (N) from .env` line to
 * stdout on every successful load. That clutters the operator's CLI
 * output (which we want to be copy-pasteable). Silent through `quiet`
 * when supported; fall through to a swallow-all on older versions.
 */
function tryLoadDotenv(): void {
    try {
        const de = require('dotenv');
        const opts =
            typeof de.config === 'function'
                ? { quiet: true, silent: true }
                : undefined;
        de.config?.(opts);
    } catch {
        // dotenv missing — fine, rely on shell-exported env.
    }
}

/** Entry point: parse argv, build the payload, render the banner. */
export function main(argv: readonly string[]): string {
    tryLoadDotenv();
    const args = parseArgs(argv);
    // Help should never depend on the pepper being set — operators
    // discovering the CLI shouldn't get an env error.
    if (args.help) return HELP;
    try {
        const pepper = readPepper();
        const out = buildOutput(args, pepper);
        if (out === 'HELP') return HELP;
        if (out === null) {
            return `ERROR: --create requires --id <slug>\n\n${HELP}`;
        }
        return formatOutput(out);
    } catch (err) {
        if (err instanceof CliError) {
            return `ERROR (exit ${err.code}): ${err.message}\n\n${HELP}`;
        }
        throw err;
    }
}

// Keep this re-export path stable; future modules might re-export helpers
// from here. (No additional exports are needed today.)
