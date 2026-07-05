import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MigrationRunner } from './migration-runner';

function freshDirs(): { migrationsDir: string; seedsDir: string; cleanup: () => void } {
    const root = mkdtempSync(join(tmpdir(), 'ms-migrations-'));
    const migrationsDir = join(root, 'migrations');
    const seedsDir = join(root, 'seeds');
    require('node:fs').mkdirSync(migrationsDir, { recursive: true });
    require('node:fs').mkdirSync(seedsDir, { recursive: true });
    return {
        migrationsDir,
        seedsDir,
        cleanup: () => rmSync(root, { recursive: true, force: true }),
    };
}

function writeMigration(dir: string, name: string, sql: string): void {
    writeFileSync(join(dir, name), sql);
}

function openDb(): Database.Database {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    return db;
}

describe('MigrationRunner', () => {
    let dirs: ReturnType<typeof freshDirs>;

    beforeEach(() => {
        dirs = freshDirs();
    });

    afterEach(() => {
        dirs.cleanup();
    });

    it('returns zero applied when the migrations dir is empty', () => {
        const db = openDb();
        const runner = new MigrationRunner(db, dirs.migrationsDir, dirs.seedsDir);
        const result = runner.run();
        expect(result.applied).toEqual([]);
        expect(result.skipped).toEqual([]);
        // _migrations table created but empty.
        expect(runner.appliedMigrations()).toEqual([]);
        db.close();
    });

    it('applies every *.sql file in lexical order and records kind=schema', () => {
        const db = openDb();
        writeMigration(
            dirs.migrationsDir,
            '0002_add_b.sql',
            'CREATE TABLE b (id INTEGER PRIMARY KEY);',
        );
        writeMigration(
            dirs.migrationsDir,
            '0001_add_a.sql',
            'CREATE TABLE a (id INTEGER PRIMARY KEY);',
        );
        writeMigration(
            dirs.migrationsDir,
            '0003_add_c.sql',
            'CREATE TABLE c (id INTEGER PRIMARY KEY);',
        );

        const runner = new MigrationRunner(db, dirs.migrationsDir, dirs.seedsDir);
        const result = runner.run();

        expect(result.applied).toEqual(['0001_add_a.sql', '0002_add_b.sql', '0003_add_c.sql']);
        expect(runner.appliedMigrations().map((r) => r.name)).toEqual([
            '0001_add_a.sql',
            '0002_add_b.sql',
            '0003_add_c.sql',
        ]);
        expect(runner.appliedMigrations().every((r) => r.kind === 'schema')).toBe(true);
        // Tables are present.
        const tableNames = db
            .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('a','b','c') ORDER BY name")
            .all()
            .map((r: any) => r.name);
        expect(tableNames).toEqual(['a', 'b', 'c']);
        db.close();
    });

    it('is idempotent — re-running does not reapply', () => {
        const db = openDb();
        writeMigration(
            dirs.migrationsDir,
            '0001_init.sql',
            'CREATE TABLE t (id INTEGER PRIMARY KEY);',
        );

        const runner = new MigrationRunner(db, dirs.migrationsDir, dirs.seedsDir);
        expect(runner.run().applied).toEqual(['0001_init.sql']);
        const second = runner.run();
        expect(second.applied).toEqual([]);
        // Schema SQL was NOT re-executed; the file would have failed with a
        // "table t already exists" if it had been re-run against an in-memory
        // DB without IF NOT EXISTS, which we deliberately omit to prove the
        // runner skipped the file.
        expect(runner.appliedMigrations()).toHaveLength(1);
        db.close();
    });

    it('only skips known files in _migrations (and runs new ones)', () => {
        const db = openDb();
        writeMigration(dirs.migrationsDir, '0001_first.sql', 'CREATE TABLE a (x INTEGER);');
        writeMigration(dirs.migrationsDir, '0002_second.sql', 'CREATE TABLE b (x INTEGER);');

        const runner = new MigrationRunner(db, dirs.migrationsDir, dirs.seedsDir);
        runner.run();

        // Add a new file at runtime.
        writeMigration(dirs.migrationsDir, '0003_third.sql', 'CREATE TABLE c (x INTEGER);');
        const second = runner.run();

        expect(second.applied).toEqual(['0003_third.sql']);
        expect(second.skipped).toEqual(['0001_first.sql', '0002_second.sql']);
        db.close();
    });

    it('throws a descriptive error when an SQL file is invalid', () => {
        const db = openDb();
        writeMigration(dirs.migrationsDir, '0001_broken.sql', 'THIS IS NOT VALID SQL;');
        const runner = new MigrationRunner(db, dirs.migrationsDir, dirs.seedsDir);

        expect(() => runner.run()).toThrow(/0001_broken\.sql/);
        // Failed migrations must NOT be recorded, so a retry can succeed once
        // the file is corrected.
        expect(runner.appliedMigrations()).toEqual([]);
        db.close();
    });

    it('appliedMigrations returns records sorted by name', () => {
        const db = openDb();
        writeMigration(dirs.migrationsDir, '0002_b.sql', 'CREATE TABLE b (x INTEGER);');
        writeMigration(dirs.migrationsDir, '0001_a.sql', 'CREATE TABLE a (x INTEGER);');
        const runner = new MigrationRunner(db, dirs.migrationsDir, dirs.seedsDir);
        runner.run();

        const records = runner.appliedMigrations();
        expect(records.map((r) => r.name)).toEqual(['0001_a.sql', '0002_b.sql']);
        expect(records[0].appliedAt).toBeGreaterThan(0);
        expect(records[0].kind).toBe('schema');
        db.close();
    });

    it('ignores non-.sql files in the migrations dir', () => {
        const db = openDb();
        writeMigration(dirs.migrationsDir, '0001_real.sql', 'CREATE TABLE r (x INTEGER);');
        writeMigration(dirs.migrationsDir, 'README.md', '# not a migration');
        writeMigration(dirs.migrationsDir, '0002_other.txt', 'ignored');
        const runner = new MigrationRunner(db, dirs.migrationsDir, dirs.seedsDir);
        expect(runner.run().applied).toEqual(['0001_real.sql']);
        db.close();
    });
});
