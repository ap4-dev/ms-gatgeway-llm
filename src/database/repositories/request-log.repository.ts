import Database from 'better-sqlite3';

export type RequestLogStatus = 'ok' | 'error' | 'circuit_open';

export interface RequestLogRow {
    /** Caller-supplied unix-seconds timestamp (default now() in SQL). */
    requestedAt: number;
    /** The model id the client sent (alias or `provider/model` path). */
    modelRequested: string;
    /** Resolved upstream provider, or null when resolution/route failed before any attempt. */
    resolvedProvider: string | null;
    resolvedModel: string | null;
    /** Number of chain entries attempted before the route settled. */
    attempts: number;
    latencyMs: number;
    status: RequestLogStatus;
    error?: string | null;
    clientKey?: string | null;
    /** Phase 4 observability additions — all optional, see 0003 migration. */
    promptHash?: string | null;
    promptTokens?: number | null;
    completionTokens?: number | null;
    totalTokens?: number | null;
    /**
     * Phase 10: JSON-serialised per-attempt details for multi-attempt
     * requests. Each entry: { providerId, upstreamModel, ok, circuitOpen,
     * durationMs, error? }. Populated by RequestLogService when a
     * fallback chain had >1 attempt.
     */
    attemptDetails?: string | null;
    /**
     * Diagnostic snapshot of the outbound request (scalar params plus a
     * truncated first user message) for failure debugging. Populated only
     * for failed rows; see migration 0013.
     */
    requestParams?: string | null;
}

/** Filter options for `RequestLogRepository.list`. All fields are AND-combined. */
export interface ListRequestLogsOptions {
    clientKey?: string;
    modelRequested?: string;
    resolvedProvider?: string;
    status?: RequestLogStatus;
    /** unix-seconds lower bound on `requested_at` (inclusive). */
    fromTs?: number;
    /** unix-seconds upper bound on `requested_at` (inclusive). */
    toTs?: number;
    /**
     * Maximum rows to return. Caller-enforced ceiling (e.g. controller
     * caps at 500). The repository fetches `limit + 1` so the caller
     * knows if more rows are available.
     */
    limit: number;
}

export interface RequestLogPage {
    items: RequestLogRow[];
    /** True iff at least one more row exists beyond `items`. */
    hasMore: boolean;
}

/**
 * Optional AND-combined filters shared by every summary aggregation.
 * `model` matches `model_requested`, `client` matches `client_key` and
 * `provider` matches `resolved_provider`.
 */
export interface SummaryFilters {
    model?: string;
    client?: string;
    provider?: string;
}

/** Shared count fields present in every summary bucket. */
export interface SummaryCountFields {
    requests: number;
    ok: number;
    errors: number;
    circuitOpen: number;
    totalTokens: number;
    avgLatencyMs: number;
}

/** Grand totals for a requested range, plus token sums. */
export interface SummaryTotals extends SummaryCountFields {
    promptTokens: number;
    completionTokens: number;
}

/** One UTC-day bucket. */
export type SummaryDayBucket = { day: string } & SummaryCountFields;

/** One `model_requested` bucket. */
export type SummaryModelBucket = { model: string } & SummaryCountFields;

/** One `client_key` bucket (`null` for unattributed rows). */
export type SummaryClientBucket = { client: string | null } & SummaryCountFields;

/**
 * Count/latency projection shared by every summary query. `COUNT(*)` never
 * returns NULL, but the `SUM(...)` columns can when the range is empty, so
 * they are coalesced to 0 in SQL. `AVG` of an empty set is NULL -- coalesced
 * to 0 as well.
 */
const SUMMARY_COUNT_AGGREGATES = `
            COUNT(*) AS requests,
            COALESCE(SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END), 0) AS ok,
            COALESCE(SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END), 0) AS errors,
            COALESCE(SUM(CASE WHEN status = 'circuit_open' THEN 1 ELSE 0 END), 0) AS circuit_open,
            COALESCE(SUM(total_tokens), 0) AS total_tokens,
            COALESCE(ROUND(AVG(latency_ms)), 0) AS avg_latency_ms`;

interface SummaryAggRow {
    requests: number;
    ok: number;
    errors: number;
    circuit_open: number;
    total_tokens: number;
    avg_latency_ms: number;
}

/**
 * Phase 3.5+ request-log persistence. Wired into `RequestLogService` which
 * `ChatService.completions` calls on success and failure. Phase 4 added
 * prompt-hash + token-count columns (0003 migration); Phase 6+ added
 * composite indexes (0009 migration) plus this filtered list method used
 * by `GET /admin/logs`.
 */
export class RequestLogRepository {
    private readonly appendStmt: Database.Statement;
    private readonly recentStmt: Database.Statement;
    private readonly stmtCache = new Map<string, Database.Statement>();

    private stmt(sql: string): Database.Statement {
        let s = this.stmtCache.get(sql);
        if (!s) {
            s = this.db.prepare(sql);
            this.stmtCache.set(sql, s);
        }
        return s;
    }

    constructor(private readonly db: Database.Database) {
        this.appendStmt = this.db.prepare(`
            INSERT INTO request_logs (
                requested_at, model_requested, resolved_provider, resolved_model,
                attempts, latency_ms, status, error, client_key,
                prompt_hash, prompt_tokens, completion_tokens, total_tokens,
                attempt_details, request_params
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        this.recentStmt = this.db.prepare(
            'SELECT id, requested_at, model_requested, resolved_provider, resolved_model, attempts, latency_ms, status, error, client_key, prompt_hash, prompt_tokens, completion_tokens, total_tokens, attempt_details FROM request_logs ORDER BY requested_at DESC, id DESC LIMIT ?',
        );
    }

    append(row: RequestLogRow): number {
        const info = this.appendStmt.run(
            row.requestedAt,
            row.modelRequested,
            row.resolvedProvider,
            row.resolvedModel,
            row.attempts,
            row.latencyMs,
            row.status,
            row.error ?? null,
            row.clientKey ?? null,
            row.promptHash ?? null,
            row.promptTokens ?? null,
            row.completionTokens ?? null,
            row.totalTokens ?? null,
            row.attemptDetails ?? null,
            row.requestParams ?? null,
        );
        return Number(info.lastInsertRowid);
    }

    recent(limit: number): RequestLogRow[] {
        const rows = this.recentStmt.all(limit) as Array<{
            id: number;
            requested_at: number;
            model_requested: string;
            resolved_provider: string | null;
            resolved_model: string | null;
            attempts: number;
            latency_ms: number;
            status: RequestLogStatus;
            error: string | null;
            client_key: string | null;
            prompt_hash: string | null;
            prompt_tokens: number | null;
            completion_tokens: number | null;
            total_tokens: number | null;
            attempt_details: string | null;
        }>;
        return rows.map((r) => ({
            requestedAt: r.requested_at,
            modelRequested: r.model_requested,
            resolvedProvider: r.resolved_provider,
            resolvedModel: r.resolved_model,
            attempts: r.attempts,
            latencyMs: r.latency_ms,
            status: r.status,
            error: r.error,
            clientKey: r.client_key,
            promptHash: r.prompt_hash,
            promptTokens: r.prompt_tokens,
            completionTokens: r.completion_tokens,
            totalTokens: r.total_tokens,
            attemptDetails: r.attempt_details,
        }));
    }

    /**
     * Filtered, time-sorted listing of request_logs. Returns up to
     * `limit` rows ordered newest-first, plus a `hasMore` flag so the
     * controller can render "showing latest N" without doing a second
     * COUNT(*) (which would have to scan the whole index).
     *
     * Strategy: fetch `limit + 1` rows; if we got more than `limit`,
     * trim and report `hasMore: true`. Cheap — the extra row is one
     * index step.
     */
    list(opts: ListRequestLogsOptions): RequestLogPage {
        const where: string[] = [];
        const params: any[] = [];

        if (opts.clientKey !== undefined) {
            where.push('client_key = ?');
            params.push(opts.clientKey);
        }
        if (opts.modelRequested !== undefined) {
            where.push('model_requested = ?');
            params.push(opts.modelRequested);
        }
        if (opts.resolvedProvider !== undefined) {
            where.push('resolved_provider = ?');
            params.push(opts.resolvedProvider);
        }
        if (opts.status !== undefined) {
            where.push('status = ?');
            params.push(opts.status);
        }
        if (opts.fromTs !== undefined) {
            where.push('requested_at >= ?');
            params.push(opts.fromTs);
        }
        if (opts.toTs !== undefined) {
            where.push('requested_at <= ?');
            params.push(opts.toTs);
        }

        const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
        const fetchLimit = opts.limit + 1;

        const sql = `
            SELECT id, requested_at, model_requested, resolved_provider,
                   resolved_model, attempts, latency_ms, status, error,
                   client_key, prompt_hash, prompt_tokens, completion_tokens,
                   total_tokens, attempt_details, request_params
            FROM request_logs
            ${whereClause}
            ORDER BY requested_at DESC, id DESC
            LIMIT ?
        `;
        const rows = this.db.prepare(sql).all(...params, fetchLimit) as Array<{
            id: number;
            requested_at: number;
            model_requested: string;
            resolved_provider: string | null;
            resolved_model: string | null;
            attempts: number;
            latency_ms: number;
            status: RequestLogStatus;
            error: string | null;
            client_key: string | null;
            prompt_hash: string | null;
            prompt_tokens: number | null;
            completion_tokens: number | null;
            total_tokens: number | null;
            attempt_details: string | null;
            request_params: string | null;
        }>;
        const hasMore = rows.length > opts.limit;
        const items = hasMore ? rows.slice(0, opts.limit) : rows;
        return { items: items.map(toRow), hasMore };
    }

    /**
     * Aggregate totals for `[fromTs, toTs]` (inclusive, unix seconds)
     * plus the optional filters.
     *
     * NOTE: failed attempts are persisted as their own `request_logs`
     * rows with `status = 'error'`; this aggregation counts rows as-is
     * and does NOT deduplicate attempts. A request that exhausted a
     * multi-provider fallback chain therefore contributes one row per
     * attempt to `requests`.
     */
    summaryTotals(
        fromTs: number,
        toTs: number,
        filters: SummaryFilters = {},
    ): SummaryTotals {
        const { clause, params } = this.summaryWhere(fromTs, toTs, filters);
        const stmt = this.stmt(
                `
            SELECT
                COUNT(*) AS requests,
                COALESCE(SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END), 0) AS ok,
                COALESCE(SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END), 0) AS errors,
                COALESCE(SUM(CASE WHEN status = 'circuit_open' THEN 1 ELSE 0 END), 0) AS circuit_open,
                COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
                COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
                COALESCE(SUM(total_tokens), 0) AS total_tokens,
                COALESCE(ROUND(AVG(latency_ms)), 0) AS avg_latency_ms
            FROM request_logs
            ${clause}
        `,
            );
        const row = stmt.get(...params) as SummaryAggRow & {
            prompt_tokens: number;
            completion_tokens: number;
        };
        const counts = toSummaryCounts(row);
        return {
            requests: counts.requests,
            ok: counts.ok,
            errors: counts.errors,
            circuitOpen: counts.circuitOpen,
            promptTokens: row.prompt_tokens,
            completionTokens: row.completion_tokens,
            totalTokens: counts.totalTokens,
            avgLatencyMs: counts.avgLatencyMs,
        };
    }

    /** One bucket per UTC calendar day, ordered ascending. */
    summaryByDay(
        fromTs: number,
        toTs: number,
        filters: SummaryFilters = {},
    ): SummaryDayBucket[] {
        const { clause, params } = this.summaryWhere(fromTs, toTs, filters);
        const stmt = this.stmt(
                `
            SELECT
                strftime('%Y-%m-%d', datetime(requested_at, 'unixepoch')) AS day,
                ${SUMMARY_COUNT_AGGREGATES}
            FROM request_logs
            ${clause}
            GROUP BY day
            ORDER BY day ASC
        `,
            );
        const rows = stmt.all(...params) as Array<SummaryAggRow & { day: string }>;
        return rows.map((r) => ({ day: r.day, ...toSummaryCounts(r) }));
    }

    /** One bucket per `model_requested`, ordered by request count DESC. */
    summaryByModel(
        fromTs: number,
        toTs: number,
        filters: SummaryFilters = {},
    ): SummaryModelBucket[] {
        const { clause, params } = this.summaryWhere(fromTs, toTs, filters);
        const stmt = this.stmt(
                `
            SELECT
                model_requested AS model,
                ${SUMMARY_COUNT_AGGREGATES}
            FROM request_logs
            ${clause}
            GROUP BY model_requested
            ORDER BY requests DESC
        `,
            );
        const rows = stmt.all(...params) as Array<SummaryAggRow & { model: string }>;
        return rows.map((r) => ({ model: r.model, ...toSummaryCounts(r) }));
    }

    /**
     * One bucket per `client_key`, ordered by request count DESC. Rows
     * with a NULL `client_key` collapse into a single bucket whose
     * `client` is null.
     */
    summaryByClient(
        fromTs: number,
        toTs: number,
        filters: SummaryFilters = {},
    ): SummaryClientBucket[] {
        const { clause, params } = this.summaryWhere(fromTs, toTs, filters);
        const stmt = this.stmt(
                `
            SELECT
                client_key AS client,
                ${SUMMARY_COUNT_AGGREGATES}
            FROM request_logs
            ${clause}
            GROUP BY client_key
            ORDER BY requests DESC
        `,
            );
        const rows = stmt.all(...params) as Array<SummaryAggRow & { client: string | null }>;
        return rows.map((r) => ({ client: r.client, ...toSummaryCounts(r) }));
    }

    /**
     * Build the shared `WHERE requested_at >= ? AND requested_at <= ?`
     * clause plus any optional filter predicates, in parameter order.
     */
    private summaryWhere(
        fromTs: number,
        toTs: number,
        filters: SummaryFilters,
    ): { clause: string; params: any[] } {
        const where: string[] = ['requested_at >= ?', 'requested_at <= ?'];
        const params: any[] = [fromTs, toTs];
        if (filters.model !== undefined) {
            where.push('model_requested = ?');
            params.push(filters.model);
        }
        if (filters.client !== undefined) {
            where.push('client_key = ?');
            params.push(filters.client);
        }
        if (filters.provider !== undefined) {
            where.push('resolved_provider = ?');
            params.push(filters.provider);
        }
        return { clause: `WHERE ${where.join(' AND ')}`, params };
    }
}

/** Map a raw aggregate row into the shared camelCase count fields. */
function toSummaryCounts(r: SummaryAggRow): SummaryCountFields {
    return {
        requests: r.requests,
        ok: r.ok,
        errors: r.errors,
        circuitOpen: r.circuit_open,
        totalTokens: r.total_tokens,
        avgLatencyMs: Math.round(r.avg_latency_ms),
    };
}

function toRow(r: {
    id: number;
    requested_at: number;
    model_requested: string;
    resolved_provider: string | null;
    resolved_model: string | null;
    attempts: number;
    latency_ms: number;
    status: RequestLogStatus;
    error: string | null;
    client_key: string | null;
    prompt_hash: string | null;
    prompt_tokens: number | null;
    completion_tokens: number | null;
    total_tokens: number | null;
    attempt_details: string | null;
    request_params: string | null;
}): RequestLogRow {
    return {
        requestedAt: r.requested_at,
        modelRequested: r.model_requested,
        resolvedProvider: r.resolved_provider,
        resolvedModel: r.resolved_model,
        attempts: r.attempts,
        latencyMs: r.latency_ms,
        status: r.status,
        error: r.error,
        clientKey: r.client_key,
        promptHash: r.prompt_hash,
        promptTokens: r.prompt_tokens,
        completionTokens: r.completion_tokens,
        totalTokens: r.total_tokens,
        attemptDetails: r.attempt_details,
        requestParams: r.request_params,
    };
}
