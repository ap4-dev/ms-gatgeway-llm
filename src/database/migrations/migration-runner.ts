import Database from 'better-sqlite3';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type MigrationKind = 'schema' | 'seed';

export interface MigrationRecord {
    name: string;
    appliedAt: number;
    kind: MigrationKind;
}

export interface MigrationRunResult {
    applied: string[];
    skipped: string[];
}

/**
 * Apply pending `*.sql` files from a migrations directory in lexical order.
 * Tracks applied migrations in a `_migrations(name PRIMARY KEY, applied_at
 * INTEGER, kind CHECK IN ('schema','seed'))` table so re-running is a no-op.
 *
 * Seed JSON files are NOT handled here — see `seed-on-first-boot.ts`, which
 * records its own `kind='seed'` row against the same table.
 *
 * Each SQL file is executed inside a single `better-sqlite3` transaction;
 * a failed migration rolls back cleanly and is NOT recorded, so the file
 * can be fixed and the runner re-attempted.
 */
export class MigrationRunner {
    private readonly ensureSchema: Database.Statement;

    constructor(
        private readonly db: Database.Database,
        private readonly migrationsDir: string,
        /** Reserved for future use; the runner currently only handles SQL. */
        private readonly _seedsDir: string,
    ) {
        this.ensureSchema = this.db.prepare(`
            CREATE TABLE IF NOT EXISTS _migrations (
                name        TEXT PRIMARY KEY,
                applied_at  INTEGER NOT NULL,
                kind        TEXT NOT NULL CHECK (kind IN ('schema','seed'))
            );
        `);
    }

    /** Apply any unapplied *.sql files in `migrationsDir`. */
    run(): MigrationRunResult {
        this.ensureSchema.run();

        const known = new Set(this.listKnownNames());
        const files = this.listMigrationFiles();
        const applied: string[] = [];
        const skipped: string[] = [];

        const insertRecord = this.db.prepare(
            'INSERT INTO _migrations (name, applied_at, kind) VALUES (?, ?, ?)',
        );

        const recordedAt = Math.floor(Date.now() / 1000);

        for (const name of files) {
            if (known.has(name)) {
                skipped.push(name);
                continue;
            }
            const content = readFileSync(join(this.migrationsDir, name), 'utf-8');
            const apply = this.db.transaction(() => {
                this.db.exec(content);
                insertRecord.run(name, recordedAt, 'schema');
            });
            try {
                apply();
                applied.push(name);
            } catch (err: any) {
                throw new Error(
                    `Migration ${name} failed: ${err?.message ?? err}`,
                );
            }
        }
        return { applied, skipped };
    }

    /** List every applied migration record, sorted by name. */
    appliedMigrations(): MigrationRecord[] {
        this.ensureSchema.run();
        const rows = this.db
            .prepare(
                'SELECT name, applied_at, kind FROM _migrations ORDER BY name',
            )
            .all() as Array<{ name: string; applied_at: number; kind: MigrationKind }>;
        return rows.map((r) => ({
            name: r.name,
            appliedAt: r.applied_at,
            kind: r.kind,
        }));
    }

    // --- internals -------------------------------------------------------

    private listKnownNames(): string[] {
        if (!this.tableExists('_migrations')) return [];
        return (
            this.db.prepare('SELECT name FROM _migrations').all() as Array<{
                name: string;
            }>
        ).map((r) => r.name);
    }

    private listMigrationFiles(): string[] {
        let entries: string[];
        try {
            entries = readdirSync(this.migrationsDir);
        } catch (err: any) {
            throw new Error(
                `Cannot read migrations directory ${this.migrationsDir}: ${err?.message ?? err}`,
            );
        }
        return entries.filter((f) => f.endsWith('.sql')).sort();
    }

    private tableExists(name: string): boolean {
        const row = this.db
            .prepare(
                "SELECT name FROM sqlite_master WHERE type='table' AND name = ?",
            )
            .get(name);
        return Boolean(row);
    }
}
