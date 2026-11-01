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
 * One `(client, alias)` total recomputed from `request_logs` for a window.
 *
 * `aliasKey` is the alias ACTUALLY SERVED — `served_alias` when the row has
 * one, `model_requested` only as the fallback for rows written before
 * migration 0014. Requesting and serving are therefore separate facts, which
 * is what keeps a diverted request attributed to its divert target.
 */
export interface RequestLogUsageAggregate {
    clientId: string;
    aliasKey: string;
    tokens: number;
    requests: number;
}

/** Unix-second half-open window `[fromTs, toTs)` over `requested_at`. */
export interface RequestLogUsageRange {
    fromTs: number;
    toTs: number;
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
        setUsage: Database.Statement;
        listUsageByPeriod: Database.Statement;
        listUsageByClientPeriod: Database.Statement;
        listAllQuotas: Database.Statement;
        aggregateRequestLogUsage: Database.Statement;
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
            listUsageByClientPeriod: this.db.prepare(
                'SELECT client_id, alias_key, period_key, tokens, requests, updated_at FROM client_alias_usage WHERE client_id = ? AND period_key = ? ORDER BY alias_key',
            ),
            /**
             * Absolute-value write, the reconciliation counterpart of
             * `addUsage`: whatever the recomputation says the totals ARE, not a
             * delta on top of them. That is what makes running reconcile twice
             * a no-op instead of a double charge. `updated_at` is bumped either
             * way so the row records when it was last repaired.
             */
            setUsage: this.db.prepare(`
                INSERT INTO client_alias_usage (client_id, alias_key, period_key, tokens, requests, updated_at)
                VALUES (?, ?, ?, ?, ?, unixepoch())
                ON CONFLICT (client_id, alias_key, period_key)
                DO UPDATE SET tokens     = excluded.tokens,
                              requests   = excluded.requests,
                              updated_at = unixepoch()
            `),
            listAllQuotas: this.db.prepare(
                'SELECT client_id, alias_key, monthly_token_limit, divert_alias_key, created_at, updated_at FROM client_alias_quotas ORDER BY client_id, alias_key',
            ),
            /**
             * Per-`(client, served alias)` totals rebuilt from `request_logs`.
             *
             * `COALESCE(served_alias, model_requested)` is the whole point: the
             * alias that was ROUTED owns the tokens, so traffic diverted from
             * `codex` to `slave` lands on `slave` and never contaminates the
             * exhausted counter it was diverted away from. The fallback keeps
             * rows written before migration 0014 attributable at all.
             *
             * NULL `client_key` rows are unattributable and dropped here, and
             * the window is half-open `[from, to)` so two adjacent months can
             * never count the same boundary row twice. `SUM` is coalesced per
             * column because `total_tokens` is nullable (rows written before
             * migration 0003 added the column, and failed attempts) while
             * `COUNT(*)` is not.
             */
            aggregateRequestLogUsage: this.db.prepare(`
                SELECT client_key                              AS client_id,
                       COALESCE(served_alias, model_requested) AS alias_key,
                       COUNT(*)                                AS requests,
                       COALESCE(SUM(COALESCE(total_tokens, 0)), 0) AS tokens
                FROM request_logs
                WHERE requested_at >= ?
                  AND requested_at < ?
                  AND client_key IS NOT NULL
                GROUP BY client_key, COALESCE(served_alias, model_requested)
                ORDER BY client_id, alias_key
            `),
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

    /**
     * Every quota row in the database, ordered by `client_id` then `alias_key`.
     *
     * Reconciliation needs the full set rather than a per-client read: it
     * verifies any number of clients in one pass and must not issue N + 1
     * queries to do it.
     */
    listAllQuotas(): ClientAliasQuota[] {
        return (this.stmts.listAllQuotas.all() as QuotaDbRow[]).map(toQuota);
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

    /**
     * Overwrite the stored counter with the given totals (reconciliation only).
     *
     * Same row shape and same UPSERT as `addUsage`, but ABSOLUTE: the caller
     * passes what the recomputation found, so re-running it is idempotent.
     * `requests` is required, unlike `addUsage`'s implicit `+ 1`, because the
     * recomputation counts rows rather than observing a single request.
     */
    setUsage(input: {
        clientId: string;
        aliasKey: string;
        periodKey: string;
        tokens: number;
        requests: number;
    }): void {
        this.stmts.setUsage.run(
            input.clientId,
            input.aliasKey,
            input.periodKey,
            input.tokens,
            input.requests,
        );
    }

    /**
     * Recompute `(client, served alias)` totals from `request_logs`.
     *
     * Read-only and repository-scoped: the quota domain owns the interpretation
     * (which pairs actually count) while the SQL that projects `request_logs`
     * stays here next to the usage statements it feeds.
     */
    aggregateRequestLogUsage(range: RequestLogUsageRange): RequestLogUsageAggregate[] {
        const rows = this.stmts.aggregateRequestLogUsage.all(range.fromTs, range.toTs) as Array<{
            client_id: string;
            alias_key: string;
            requests: number;
            tokens: number;
        }>;

        return rows.map((r) => ({
            clientId: r.client_id,
            aliasKey: r.alias_key,
            tokens: r.tokens,
            requests: r.requests,
        }));
    }

    /**
     * One client's usage counters for one period, ordered by `alias_key`.
     *
     * This is the read the admin quota listing and the client balance endpoint
     * need: one query for the whole period instead of a per-alias lookup, so a
     * client with N quotas still costs exactly two queries total (quotas +
     * usage) rather than N + 1.
     */
    listUsageByClientPeriod(clientId: string, periodKey: string): ClientAliasUsage[] {
        return (
            this.stmts.listUsageByClientPeriod.all(clientId, periodKey) as UsageDbRow[]
        ).map(toUsage);
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
