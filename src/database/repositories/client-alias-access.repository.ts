import Database from 'better-sqlite3';

/** One `(client, alias)` allowlist row, camelCased. */
export interface ClientAliasAccessRow {
    clientId: string;
    aliasKey: string;
    createdAt: number;
}

interface AccessDbRow {
    client_id: string;
    alias_key: string;
    created_at: number;
}

/**
 * Raised when a caller hands `replaceForClient` the same alias twice.
 *
 * A duplicate cannot be stored (the primary key forbids it), so it is a caller
 * bug rather than data to repair. It is rejected BEFORE the delete step on
 * purpose: rejecting after the delete but before the insert would leave the
 * client with nothing, which for this table means full access — the exact
 * opposite of the intent.
 */
export class DuplicateAliasKeyError extends Error {
    constructor(
        readonly clientId: string,
        readonly aliasKey: string,
    ) {
        super(
            `Client "${clientId}" was given alias "${aliasKey}" more than once`,
        );
        this.name = 'DuplicateAliasKeyError';
    }
}

/**
 * SQLite-backed repository for the per-client alias allowlist (migration
 * `0015_client_alias_access.sql`).
 *
 * Deliberately cache-free: revoking access must take effect on the very next
 * request, so every read goes straight to the DB. Reading one client's rows is
 * a single index/primary-key lookup and better-sqlite3 is synchronous, so the
 * "no cache" decision costs microseconds and removes a whole staleness mode.
 *
 * The repository stores and returns ROWS, nothing more. What an absent row
 * MEANS is the service's single decision (`AliasAccessService.getAccess`), so
 * the "empty means unrestricted, missing inside a non-empty set means
 * forbidden" rule cannot be restated — and contradicted — here.
 */
export class ClientAliasAccessRepository {
    /** Pre-prepared statements, reused for every call. */
    private readonly stmts: {
        listByClient: Database.Statement;
        insert: Database.Statement;
        deleteByClient: Database.Statement;
    };

    /**
     * Delete-then-insert of one client's whole set, as ONE transaction.
     *
     * Both halves have to be atomic together: a crash or a constraint failure
     * between them would leave the client with a partial set, and a partial set
     * is not a degraded version of the intended one — it silently forbids
     * everything that was dropped mid-write. better-sqlite3 runs the function
     * synchronously inside `BEGIN`/`COMMIT` and rolls back on throw.
     */
    private readonly replaceTxn: (clientId: string, aliasKeys: readonly string[]) => void;

    constructor(private readonly db: Database.Database) {
        this.stmts = {
            listByClient: this.db.prepare(
                'SELECT client_id, alias_key, created_at FROM client_alias_access WHERE client_id = ? ORDER BY alias_key',
            ),
            insert: this.db.prepare(
                'INSERT INTO client_alias_access (client_id, alias_key) VALUES (?, ?)',
            ),
            deleteByClient: this.db.prepare(
                'DELETE FROM client_alias_access WHERE client_id = ?',
            ),
        };

        this.replaceTxn = this.db.transaction(
            (clientId: string, aliasKeys: readonly string[]) => {
                this.stmts.deleteByClient.run(clientId);
                for (const aliasKey of aliasKeys) {
                    this.stmts.insert.run(clientId, aliasKey);
                }
            },
        );
    }

    // --- reads ----------------------------------------------------------

    /**
     * Every access row of one client, ordered by `alias_key`.
     *
     * An EMPTY array is a meaningful answer, not an error: it is what the
     * service turns into `{ mode: 'unrestricted' }`.
     */
    listByClient(clientId: string): ClientAliasAccessRow[] {
        return (this.stmts.listByClient.all(clientId) as AccessDbRow[]).map(toRow);
    }

    // --- writes ---------------------------------------------------------

    /**
     * Replace the whole allowlist of one client with `aliasKeys`.
     *
     * Full replacement rather than a merge: the caller states the set it wants,
     * so removing an alias needs no second endpoint and cannot be forgotten.
     * An empty list is accepted here and simply clears the client — the "empty
     * means unrestricted" ambiguity is an ADMIN concern, rejected at that layer
     * with a pointer at DELETE, not something this dumb writer should hide.
     *
     * Duplicates are rejected before any write (see {@link DuplicateAliasKeyError}).
     * Registry membership is the admin layer's job, exactly as the quota
     * repository leaves alias validity to `AdminQuotaController`.
     */
    replaceForClient(clientId: string, aliasKeys: readonly string[]): void {
        assertNoDuplicates(clientId, aliasKeys);
        this.replaceTxn(clientId, aliasKeys);
    }

    /**
     * Remove every access row of one client and report how many were removed.
     *
     * The client becomes UNRESTRICTED, which is why the admin surface talks
     * about clearing an allowlist instead of "deleting all access".
     */
    deleteForClient(clientId: string): number {
        return this.stmts.deleteByClient.run(clientId).changes;
    }
}

/** Throw on the first repeated alias, before anything is written. */
function assertNoDuplicates(clientId: string, aliasKeys: readonly string[]): void {
    const seen = new Set<string>();
    for (const aliasKey of aliasKeys) {
        if (seen.has(aliasKey)) {
            throw new DuplicateAliasKeyError(clientId, aliasKey);
        }
        seen.add(aliasKey);
    }
}

function toRow(r: AccessDbRow): ClientAliasAccessRow {
    return {
        clientId: r.client_id,
        aliasKey: r.alias_key,
        createdAt: r.created_at,
    };
}
