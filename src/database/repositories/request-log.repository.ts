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
 * Phase 3.5+ request-log persistence. Wired into `RequestLogService` which
 * `ChatService.completions` calls on success and failure. Phase 4 added
 * prompt-hash + token-count columns (0003 migration); Phase 6+ added
 * composite indexes (0009 migration) plus this filtered list method used
 * by `GET /admin/logs`.
 */
export class RequestLogRepository {
    private readonly appendStmt: Database.Statement;
    private readonly recentStmt: Database.Statement;

    constructor(private readonly db: Database.Database) {
        this.appendStmt = this.db.prepare(`
            INSERT INTO request_logs (
                requested_at, model_requested, resolved_provider, resolved_model,
                attempts, latency_ms, status, error, client_key,
                prompt_hash, prompt_tokens, completion_tokens, total_tokens
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        this.recentStmt = this.db.prepare(
            'SELECT id, requested_at, model_requested, resolved_provider, resolved_model, attempts, latency_ms, status, error, client_key, prompt_hash, prompt_tokens, completion_tokens, total_tokens FROM request_logs ORDER BY requested_at DESC, id DESC LIMIT ?',
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
                   total_tokens
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
        }>;
        const hasMore = rows.length > opts.limit;
        const items = hasMore ? rows.slice(0, opts.limit) : rows;
        return { items: items.map(toRow), hasMore };
    }
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
    };
}
