import Database from 'better-sqlite3';

/** One `(client, alias)` monthly allowance row, camelCased. */
export interface ClientAliasQuota {
    clientId: string;
    aliasKey: string;
    monthlyTokenLimit: number;
    /** Alias served once the limit is exceeded; `null` means no degradation path. */
    divertAliasKey: string | null;
    createdAt: number;
    updatedAt: number;
}

/** One `(client, served alias, period)` usage counter row, camelCased. */
export interface ClientAliasUsage {
    clientId: string;
    /** The alias ACTUALLY served — not the one the client requested. */
    aliasKey: string;
    /** UTC `YYYY-MM` calendar month. */
    periodKey: string;
    tokens: number;
    requests: number;
    updatedAt: number;
}

interface QuotaDbRow {
    client_id: string;
    alias_key: string;
    monthly_token_limit: number;
    divert_alias_key: string | null;
    created_at: number;
    updated_at: number;
}

interface UsageDbRow {
    client_id: string;
    alias_key: string;
    period_key: string;
    tokens: number;
    requests: number;
    updated_at: number;
}

/**
 * SQLite-backed repository for the per-(client × alias) monthly token quota
 * (migration `0014_client_alias_quotas.sql`).
 *
 * Deliberately cache-free: the gate must see a raised `monthly_token_limit`
 * on the very next request, so every read goes straight to the DB. Both
 * lookups are primary-key lookups and better-sqlite3 is synchronous, so the
 * "no cache" decision costs microseconds and removes a whole staleness mode.
 *
 * `addUsage` is a single atomic UPSERT (never a JS read-modify-write) so
 * concurrent requests cannot lose tokens; the same statement is the one
 * documented in the feature plan §5.
 */
export class QuotaRepository {
    /** Pre-prepared statements, reused for every call. */
    private readonly stmts: {
        upsertQuota: Database.Statement;
        deleteQuota: Database.Statement;
        getQuota: Database.Statement;
        listQuotasByClient: Database.Statement;
        getUsage: Database.Statement;
        addUsage: Database.Statement;
        listUsageByPeriod: Database.Statement;
    };

    constructor(private readonly db: Database.Database) {
        this.stmts = {
            upsertQuota: this.db.prepare(`
                INSERT INTO client_alias_quotas (
                    client_id, alias_key, monthly_token_limit, divert_alias_key
                ) VALUES (?, ?, ?, ?)
                ON CONFLICT (client_id, alias_key)
                DO UPDATE SET monthly_token_limit = excluded.monthly_token_limit,
                              divert_alias_key    = excluded.divert_alias_key,
                              updated_at          = unixepoch()
            `),
            deleteQuota: this.db.prepare(
                'DELETE FROM client_alias_quotas WHERE client_id = ? AND alias_key = ?',
            ),
            getQuota: this.db.prepare(
                'SELECT client_id, alias_key, monthly_token_limit, divert_alias_key, created_at, updated_at FROM client_alias_quotas WHERE client_id = ? AND alias_key = ?',
            ),
            listQuotasByClient: this.db.prepare(
                'SELECT client_id, alias_key, monthly_token_limit, divert_alias_key, created_at, updated_at FROM client_alias_quotas WHERE client_id = ? ORDER BY alias_key',
            ),
            getUsage: this.db.prepare(
                'SELECT client_id, alias_key, period_key, tokens, requests, updated_at FROM client_alias_usage WHERE client_id = ? AND alias_key = ? AND period_key = ?',
            ),
            addUsage: this.db.prepare(`
                INSERT INTO client_alias_usage (client_id, alias_key, period_key, tokens, requests)
                VALUES (?, ?, ?, ?, 1)
                ON CONFLICT (client_id, alias_key, period_key)
                DO UPDATE SET tokens     = tokens + excluded.tokens,
                              requests   = requests + 1,
                              updated_at = unixepoch()
            `),
            listUsageByPeriod: this.db.prepare(
                'SELECT client_id, alias_key, period_key, tokens, requests, updated_at FROM client_alias_usage WHERE period_key = ? ORDER BY client_id, alias_key',
            ),
        };
    }

    // --- quota rows -----------------------------------------------------

    /**
     * Insert or update one `(client, alias)` allowance. A single statement, so
     * a changed limit is visible to the next read with no invalidation step;
     * `created_at` is preserved across updates while `updated_at` is bumped.
     *
     * The DB CHECKs (`monthly_token_limit > 0`, `divert_alias_key <> alias_key`)
     * throw on violation and are intentionally not re-validated here — the
     * admin API is the layer that renders them as a 4xx.
     */
    upsertQuota(input: {
        clientId: string;
        aliasKey: string;
        monthlyTokenLimit: number;
        divertAliasKey?: string | null;
    }): void {
        this.stmts.upsertQuota.run(
            input.clientId,
            input.aliasKey,
            input.monthlyTokenLimit,
            input.divertAliasKey ?? null,
        );
    }

    /** `true` only when a row was actually removed. */
    deleteQuota(clientId: string, aliasKey: string): boolean {
        return this.stmts.deleteQuota.run(clientId, aliasKey).changes > 0;
    }

    /** `null` when the pair has no row — i.e. that alias is unlimited for this client. */
    getQuota(clientId: string, aliasKey: string): ClientAliasQuota | null {
        const row = this.stmts.getQuota.get(clientId, aliasKey) as QuotaDbRow | undefined;
        return row ? toQuota(row) : null;
    }

    /** All quota rows for one client, ordered by `alias_key`. */
    listQuotasByClient(clientId: string): ClientAliasQuota[] {
        return (this.stmts.listQuotasByClient.all(clientId) as QuotaDbRow[]).map(toQuota);
    }

    // --- usage counters -------------------------------------------------

    /** `null` when nothing has been recorded for `(client, alias, period)` yet. */
    getUsage(clientId: string, aliasKey: string, periodKey: string): ClientAliasUsage | null {
        const row = this.stmts.getUsage.get(clientId, aliasKey, periodKey) as
            | UsageDbRow
            | undefined;
        return row ? toUsage(row) : null;
    }

    /**
     * Record one served request. Atomic UPSERT: the first call creates the row
     * with `requests = 1`, later calls add `tokens` and increment `requests`.
     *
     * `tokens = 0` is valid and meaningful — it still counts the request
     * (usage billing is not the only purpose; the gate also wants request
     * counts) and adds nothing.
     */
    addUsage(input: {
        clientId: string;
        aliasKey: string;
        periodKey: string;
        tokens: number;
    }): void {
        this.stmts.addUsage.run(
            input.clientId,
            input.aliasKey,
            input.periodKey,
            input.tokens,
        );
    }

    /** Every usage counter for one period, ordered by client then alias. */
    listUsageByPeriod(periodKey: string): ClientAliasUsage[] {
        return (this.stmts.listUsageByPeriod.all(periodKey) as UsageDbRow[]).map(toUsage);
    }
}

function toQuota(r: QuotaDbRow): ClientAliasQuota {
    return {
        clientId: r.client_id,
        aliasKey: r.alias_key,
        monthlyTokenLimit: r.monthly_token_limit,
        divertAliasKey: r.divert_alias_key,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
    };
}

function toUsage(r: UsageDbRow): ClientAliasUsage {
    return {
        clientId: r.client_id,
        aliasKey: r.alias_key,
        periodKey: r.period_key,
        tokens: r.tokens,
        requests: r.requests,
        updatedAt: r.updated_at,
    };
}
