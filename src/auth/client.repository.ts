import Database from 'better-sqlite3';

export interface ClientRow {
    id: string;
    name: string;
    api_key_hash: string;
    api_key_prefix: string;
    scopes: string;
    rate_limit_rpm: number;
    rate_limit_tpm: number | null;
    created_at: number;
    last_used_at: number | null;
    revoked_at: number | null;
}

export interface Client {
    id: string;
    name: string;
    apiKeyHash: string;
    apiKeyPrefix: string;
    scopes: string[];
    rateLimitRpm: number;
    rateLimitTpm: number | null;
    createdAt: number;
    lastUsedAt: number | null;
    revoked: boolean;
}

/**
 * Phase 5 thin repository for the clients table. Returns a strict shape
 * (snake_case → camelCase translation in `toClient`). The plaintext API
 * key never enters this class — only its scrypt hash.
 */
export class ClientRepository {
    private readonly insertStmt: Database.Statement;
    private readonly findByIdStmt: Database.Statement;
    private readonly findByPrefixStmt: Database.Statement;
    private readonly listAllStmt: Database.Statement;
    private readonly countAllStmt: Database.Statement;
    private readonly touchLastUsedStmt: Database.Statement;
    private readonly revokeStmt: Database.Statement;
    private readonly updateStmt: Database.Statement;
    private readonly deleteStmt: Database.Statement;
    private readonly rotateKeyStmt: Database.Statement;

    constructor(private readonly db: Database.Database) {
        this.insertStmt = this.db.prepare(`
            INSERT INTO clients (
                id, name, api_key_hash, api_key_prefix, scopes,
                rate_limit_rpm, rate_limit_tpm
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `);
        this.findByIdStmt = this.db.prepare(
            'SELECT * FROM clients WHERE id = ?',
        );
        this.findByPrefixStmt = this.db.prepare(
            'SELECT * FROM clients WHERE api_key_prefix = ? AND revoked_at IS NULL',
        );
        this.listAllStmt = this.db.prepare('SELECT * FROM clients ORDER BY created_at DESC');
        this.countAllStmt = this.db.prepare('SELECT COUNT(*) AS c FROM clients');
        this.touchLastUsedStmt = this.db.prepare(
            'UPDATE clients SET last_used_at = ? WHERE id = ?',
        );
        this.revokeStmt = this.db.prepare(
            'UPDATE clients SET revoked_at = ? WHERE id = ?',
        );
        this.updateStmt = this.db.prepare(`
            UPDATE clients SET
                name             = ?,
                scopes           = ?,
                rate_limit_rpm   = ?,
                rate_limit_tpm   = ?
            WHERE id = ?
        `);
        this.deleteStmt = this.db.prepare('DELETE FROM clients WHERE id = ?');
        this.rotateKeyStmt = this.db.prepare(
            'UPDATE clients SET api_key_hash = ?, api_key_prefix = ? WHERE id = ?',
        );
    }

    insert(input: {
        id: string;
        name: string;
        apiKeyHash: string;
        apiKeyPrefix: string;
        scopes?: string[];
        rateLimitRpm?: number;
        rateLimitTpm?: number | null;
    }): void {
        this.insertStmt.run(
            input.id,
            input.name,
            input.apiKeyHash,
            input.apiKeyPrefix,
            (input.scopes ?? ['chat.read', 'chat.write']).join(','),
            input.rateLimitRpm ?? 60,
            input.rateLimitTpm ?? null,
        );
    }

    /**
     * Phase 5.5 partial update. Always overwrites name/scopes/rate_limit_*;
     * pass `null` for `rateLimitTpm` to clear it.
     */
    update(
        id: string,
        fields: {
            name: string;
            scopes: string[];
            rateLimitRpm: number;
            rateLimitTpm: number | null;
        },
    ): void {
        this.updateStmt.run(
            fields.name,
            fields.scopes.join(','),
            fields.rateLimitRpm,
            fields.rateLimitTpm,
            id,
        );
    }

    /** Hard-deletes the row. Used by DELETE /admin/clients/:id. */
    delete(id: string): void {
        this.deleteStmt.run(id);
    }

    /** Phase 5.5 key rotation — replaces the hash and the prefix. */
    rotateKey(id: string, apiKeyHash: string, apiKeyPrefix: string): void {
        this.rotateKeyStmt.run(apiKeyHash, apiKeyPrefix, id);
    }

    findById(id: string): Client | undefined {
        const row = this.findByIdStmt.get(id) as ClientRow | undefined;
        return row ? toClient(row) : undefined;
    }

    /**
     * Look up by the public prefix only (cheap pre-filter on every
     * authenticated request). Returns at most one row — the hash column
     * finishes the discrimination via `verifyApiKey`.
     */
    findActiveByPrefix(prefix: string): Client | undefined {
        const row = this.findByPrefixStmt.get(prefix) as ClientRow | undefined;
        return row ? toClient(row) : undefined;
    }

    list(): Client[] {
        return (this.listAllStmt.all() as ClientRow[]).map(toClient);
    }

    count(): number {
        return (this.countAllStmt.get() as { c: number }).c;
    }

    touchLastUsed(id: string, whenSeconds: number): void {
        this.touchLastUsedStmt.run(whenSeconds, id);
    }

    revoke(id: string, whenSeconds: number): void {
        this.revokeStmt.run(whenSeconds, id);
    }
}

export function toClient(row: ClientRow): Client {
    return {
        id: row.id,
        name: row.name,
        apiKeyHash: row.api_key_hash,
        apiKeyPrefix: row.api_key_prefix,
        scopes: row.scopes.split(',').filter((s) => s.length > 0),
        rateLimitRpm: row.rate_limit_rpm,
        rateLimitTpm: row.rate_limit_tpm,
        createdAt: row.created_at,
        lastUsedAt: row.last_used_at,
        revoked: row.revoked_at !== null,
    };
}
