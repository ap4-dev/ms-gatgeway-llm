import {
    Inject,
    Injectable,
    OnModuleDestroy,
} from '@nestjs/common';
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { DATABASE_PATH } from './database.constants';

/**
 * Owns the singleton `better-sqlite3` connection for the process.
 *
 * On construction it:
 *  - resolves the file path (defaults to a project-relative path);
 *  - creates the parent directory tree when missing (so first boots in
 *    a fresh checkout just work);
 *  - opens the connection in WAL mode for file-backed DBs;
 *  - enables foreign-key enforcement (off by default in SQLite).
 *
 * On shutdown (`OnModuleDestroy`) it closes the connection.
 *
 * Why synchronous? `better-sqlite3` runs sync, which is faster than an
 * event-loop hop and matches a single-instance POC load profile. The
 * module exports synchronously too — no need to `await` anything.
 */
@Injectable()
export class DatabaseService implements OnModuleDestroy {
    public readonly db: Database.Database;

    constructor(
        @Inject(DATABASE_PATH) rawPath: string = './data/ms-gateway.db',
    ) {
        const path = resolveDatabasePath(rawPath);
        ensureDir(path);
        this.db = new Database(path);
        if (path !== ':memory:') {
            this.db.pragma('journal_mode = WAL');
        }
        this.db.pragma('foreign_keys = ON');
    }

    /** Called by Nest on shutdown. Safe to call twice. */
    onModuleDestroy(): void {
        this.close();
    }

    close(): void {
        if (this.db.open && this.db.open) {
            this.db.close();
        }
    }
}

function resolveDatabasePath(raw: string): string {
    if (raw === ':memory:') return ':memory:';
    return isAbsolute(raw) ? raw : resolve(process.cwd(), raw);
}

function ensureDir(path: string): void {
    if (path === ':memory:') return;
    mkdirSync(dirname(path), { recursive: true });
}
