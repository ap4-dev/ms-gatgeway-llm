import { randomBytes, scryptSync } from 'node:crypto';

/**
 * Phase-5.6 operator CLI: generates an API-key credential pair and
 * outputs (a) the plaintext key the operator saves, plus (b) the SQL
 * statement to paste into `sqlite3` against the gateway DB.
 *
 * The script **never opens the DB** — the user runs the SQL themselves,
 * which is the operational escape hatch for the "I lost the admin key"
 * chicken-and-egg. Wired into `package.json` as `pnpm admin:reset`.
 *
 * Pure functions (parseArgs, generateCredentials, buildResetSql,
 * buildCreateSql, formatOutput) are exported and deterministically
 * driven by the spec via injected salt + plaintext.
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
        } else {
            out._.push(a);
        }
    }
    return out;
}

/**
 * Produce an `sk-...` plaintext, its 8-char public prefix, and the
 * `scrypt$<saltHex>$<hashHex>` value to store. Both `salt` and
 * `plain` can be injected for deterministic tests; production calls
 * this with no args.
 *
 * Format mirrors `src/auth/api-key-hash.util.hashApiKey` so anything
 * the gateway accepts later verifies cleanly here.
 */
export function generateCredentials(opts: {
    plain?: string;
    salt?: Buffer;
} = {}): Credentials {
    const salt = opts.salt ?? randomBytes(16);
    const plain =
        opts.plain ?? 'sk-' + randomBytes(32).toString('hex');
    const hash = scryptSync(plain, salt, 32);
    return {
        plain,
        prefix: plain.slice(0, 8),
        stored: `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`,
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
  node scripts/admin-reset.js --reset <client-id>

  # Create a new client row (prints plaintext key + SQL INSERT):
  node scripts/admin-reset.js --create --id <slug> --name "<label>" \\
       [--rpm <n>] [--scopes "<csv>"]

  # Show this help:
  node scripts/admin-reset.js --help

DEFAULT SCOPES (when --scopes is omitted on --create)
  ${DEFAULT_SCOPES}

DEFAULT NAME (on --create when --name is absent)
  the value of --id

The script NEVER opens the database. It only prints:
  • the plaintext key (save it NOW — never shown again), and
  • the SQL statement the operator runs against the gateway DB via
    sqlite3 (or any other DB tool).

EXAMPLES
  node scripts/admin-reset.js --reset admin
  node scripts/admin-reset.js --create --id tenant-acme --name "Acme Co." --rpm 300
`.trim();

/**
 * Build the output payload (kind, clientId, plain, stored, prefix, sql)
 * for a given args vector. Pure — used by both `main()` and tests.
 */
export function buildOutput(
    args: ParsedArgs,
    creds?: { plain?: string; salt?: Buffer },
): AdminResetOutput | 'HELP' | null {
    if (args.help || (!args.reset && !args.create)) return 'HELP';
    if (args.create && !args.id) return null;

    const c = generateCredentials(creds);
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

/** Entry point: parse argv, build the payload, render the banner. */
export function main(argv: readonly string[]): string {
    const args = parseArgs(argv);
    const out = buildOutput(args);
    if (out === 'HELP') return HELP;
    if (out === null) {
        return `ERROR: --create requires --id <slug>\n\n${HELP}`;
    }
    return formatOutput(out);
}
