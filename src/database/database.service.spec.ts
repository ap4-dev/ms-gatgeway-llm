import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import Database from 'better-sqlite3';
import { DatabaseService } from './database.service';

describe('DatabaseService', () => {
    it('opens an in-memory database, exposes the handle, and sets pragmas', () => {
        const svc = new DatabaseService(':memory:');
        try {
            expect(svc.db).toBeInstanceOf(Database);
            // WAL is a no-op for in-memory databases (SQLite returns the
            // current mode); foreign_keys should be ON.
            expect(svc.db.pragma('foreign_keys', { simple: true })).toBe(1);
            // The connection is usable: a trivial query runs without error.
            const row = svc.db.prepare('SELECT 1 AS one').get() as { one: number };
            expect(row.one).toBe(1);
        } finally {
            svc.close();
        }
    });

    it('persists a file-backed database to the path it was opened from', () => {
        const dir = mkdtempSync(join(tmpdir(), 'ms-db-svc-'));
        try {
            const path = join(dir, 'gateway.db');
            const svc = new DatabaseService(path);
            svc.db
                .prepare('CREATE TABLE t (x INTEGER)')
                .run();
            svc.db.prepare('INSERT INTO t (x) VALUES (42)').run();
            svc.close();

            // Reopen and confirm the data persisted across the close.
            const svc2 = new DatabaseService(path);
            try {
                const row = svc2.db.prepare('SELECT x FROM t').get() as { x: number };
                expect(row.x).toBe(42);
            } finally {
                svc2.close();
            }
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('creates parent directories for the database file if missing', () => {
        const dir = mkdtempSync(join(tmpdir(), 'ms-db-deep-'));
        try {
            // Three-level deep path that does not exist yet.
            const path = join(dir, 'a', 'b', 'c', 'gateway.db');
            expect(existsSync(dirnamePath(path))).toBe(false);

            const svc = new DatabaseService(path);
            try {
                svc.db.prepare('CREATE TABLE t (x INTEGER)').run();
                expect(existsSync(dirnamePath(path))).toBe(true);
            } finally {
                svc.close();
            }
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('close() releases the underlying handle so a second one can take over', () => {
        const svc = new DatabaseService(':memory:');
        svc.close();
        // A second open on the same in-memory handle is OK because we
        // construct a fresh service — verifies the close path didn't leak
        // any state that would prevent reuse.
        const svc2 = new DatabaseService(':memory:');
        expect(svc2.db.prepare('SELECT 1').get()).toEqual({ 1: 1 });
        svc2.close();
    });
});

/** Tiny dirname() helper that walks one level up — avoids importing path. */
function dirnamePath(p: string): string {
    const idx = p.lastIndexOf('/');
    return idx === -1 ? '.' : p.slice(0, idx);
}
