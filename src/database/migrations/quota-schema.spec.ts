import Database from 'better-sqlite3';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATIONS_DIR = join(process.cwd(), 'migrations');

/**
 * Apply the real migration chain from the repo-root `migrations/` directory.
 *
 * This spec cannot load `0014_client_alias_quotas.sql` in isolation: it does
 * `ALTER TABLE request_logs`, so `0002_request_logs.sql` (and every later
 * `request_logs` migration) must have run first. Pattern follows
 * `migration-runner.spec.ts` (fresh `:memory:` DB, `foreign_keys = ON`).
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

function indexNames(db: Database.Database, table: string): string[] {
    return (db.pragma(`index_list('${table}')`) as Array<{ name: string }>).map((r) => r.name);
}

describe('quota schema (0014_client_alias_quotas.sql)', () => {
    let db: Database.Database;

    beforeEach(() => {
        db = applyMigrationChain();
    });

    afterEach(() => {
        db.close();
    });

    it('applies the full chain and adds request_logs.served_alias', () => {
        const columns = (db.pragma('table_info(request_logs)') as Array<{ name: string }>).map(
            (c) => c.name,
        );
        expect(columns).toContain('served_alias');
        expect(columns).toContain('model_requested');
        const quotaTables = (
            db
                .prepare(
                    "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('client_alias_quotas', 'client_alias_usage') ORDER BY name",
                )
                .all() as Array<{ name: string }>
        ).map((r) => r.name);
        expect(quotaTables).toEqual(['client_alias_quotas', 'client_alias_usage']);
    });

    it('inserts a valid quota and populates created_at / updated_at', () => {
        db.prepare(
            'INSERT INTO client_alias_quotas (client_id, alias_key, monthly_token_limit, divert_alias_key) VALUES (?, ?, ?, ?)',
        ).run('client-1', 'codex', 20_000_000, 'slave');
        const row = db
            .prepare(
                'SELECT client_id, alias_key, monthly_token_limit, divert_alias_key, created_at, updated_at FROM client_alias_quotas WHERE client_id = ? AND alias_key = ?',
            )
            .get('client-1', 'codex') as Record<string, unknown>;
        expect(row.monthly_token_limit).toBe(20_000_000);
        expect(row.divert_alias_key).toBe('slave');
        expect(typeof row.created_at).toBe('number');
        expect(typeof row.updated_at).toBe('number');
        expect(row.created_at).toBeGreaterThan(0);
        expect(row.updated_at).toBeGreaterThan(0);
    });

    it('accepts a NULL divert_alias_key', () => {
        db.prepare(
            'INSERT INTO client_alias_quotas (client_id, alias_key, monthly_token_limit) VALUES (?, ?, ?)',
        ).run('client-1', 'codex', 20_000_000);
        expect(
            db
                .prepare(
                    'SELECT divert_alias_key FROM client_alias_quotas WHERE client_id = ? AND alias_key = ?',
                )
                .get('client-1', 'codex'),
        ).toEqual({ divert_alias_key: null });
    });

    it('rejects monthly_token_limit = 0 and negative values', () => {
        const insert = db.prepare(
            'INSERT INTO client_alias_quotas (client_id, alias_key, monthly_token_limit) VALUES (?, ?, ?)',
        );
        expect(() => insert.run('client-1', 'codex', 0)).toThrow(/CHECK constraint failed/i);
        expect(() => insert.run('client-1', 'codex', -1)).toThrow(/CHECK constraint failed/i);
    });

    it('rejects divert_alias_key equal to alias_key', () => {
        expect(() =>
            db
                .prepare(
                    'INSERT INTO client_alias_quotas (client_id, alias_key, monthly_token_limit, divert_alias_key) VALUES (?, ?, ?, ?)',
                )
                .run('client-1', 'codex', 20_000_000, 'codex'),
        ).toThrow(/CHECK constraint failed/i);
    });

    it('rejects a duplicate (client_id, alias_key)', () => {
        const insert = db.prepare(
            'INSERT INTO client_alias_quotas (client_id, alias_key, monthly_token_limit) VALUES (?, ?, ?)',
        );
        insert.run('client-1', 'codex', 20_000_000);
        expect(() => insert.run('client-1', 'codex', 30_000_000)).toThrow(
            /UNIQUE constraint failed/i,
        );
        // Same alias, different client is a distinct row.
        expect(() => insert.run('client-2', 'codex', 30_000_000)).not.toThrow();
    });

    it('rejects client_alias_usage.tokens = -1', () => {
        expect(() =>
            db
                .prepare(
                    'INSERT INTO client_alias_usage (client_id, alias_key, period_key, tokens) VALUES (?, ?, ?, ?)',
                )
                .run('client-1', 'codex', '2026-11', -1),
        ).toThrow(/CHECK constraint failed/i);
    });

    it('rejects client_alias_usage.requests = -1', () => {
        expect(() =>
            db
                .prepare(
                    'INSERT INTO client_alias_usage (client_id, alias_key, period_key, requests) VALUES (?, ?, ?, ?)',
                )
                .run('client-1', 'codex', '2026-11', -1),
        ).toThrow(/CHECK constraint failed/i);
    });

    it('accepts a valid usage row with zero defaults', () => {
        db.prepare(
            'INSERT INTO client_alias_usage (client_id, alias_key, period_key) VALUES (?, ?, ?)',
        ).run('client-1', 'codex', '2026-11');
        const row = db
            .prepare(
                'SELECT tokens, requests, updated_at FROM client_alias_usage WHERE client_id = ? AND alias_key = ? AND period_key = ?',
            )
            .get('client-1', 'codex', '2026-11') as Record<string, unknown>;
        expect(row).toEqual({ tokens: 0, requests: 0, updated_at: expect.any(Number) });
    });

    it('rejects a duplicate (client_id, alias_key, period_key)', () => {
        const insert = db.prepare(
            'INSERT INTO client_alias_usage (client_id, alias_key, period_key, tokens) VALUES (?, ?, ?, ?)',
        );
        insert.run('client-1', 'codex', '2026-11', 100);
        expect(() => insert.run('client-1', 'codex', '2026-11', 200)).toThrow(
            /UNIQUE constraint failed/i,
        );
        // A different period is an independent row (month rollover).
        expect(() => insert.run('client-1', 'codex', '2026-12', 200)).not.toThrow();
    });

    it('creates the period and served_alias indexes', () => {
        expect(indexNames(db, 'client_alias_usage')).toContain('idx_client_alias_usage_period');
        expect(indexNames(db, 'request_logs')).toContain('idx_request_logs_served_alias');
    });

    it('leaves request_logs.served_alias NULL on a fresh insert', () => {
        db.prepare('INSERT INTO request_logs (model_requested, status) VALUES (?, ?)').run(
            'codex',
            'ok',
        );
        const row = db
            .prepare('SELECT model_requested, served_alias FROM request_logs ORDER BY id DESC LIMIT 1')
            .get() as Record<string, unknown>;
        expect(row.model_requested).toBe('codex');
        expect(row.served_alias).toBeNull();
    });
});
