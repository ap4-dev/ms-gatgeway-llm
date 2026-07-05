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
}

/**
 * Phase 3.5 request-log persistence. Wired into `RequestLogService` which
 * `ChatService.completions` calls on success and failure. The wider
 * observability work (metrics, OpenTelemetry) is Phase 4.
 */
export class RequestLogRepository {
    private readonly appendStmt: Database.Statement;
    private readonly recentStmt: Database.Statement;

    constructor(private readonly db: Database.Database) {
        this.appendStmt = this.db.prepare(`
            INSERT INTO request_logs (
                requested_at, model_requested, resolved_provider, resolved_model,
                attempts, latency_ms, status, error, client_key
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        this.recentStmt = this.db.prepare(
            'SELECT id, requested_at, model_requested, resolved_provider, resolved_model, attempts, latency_ms, status, error, client_key FROM request_logs ORDER BY requested_at DESC, id DESC LIMIT ?',
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
        }));
    }
}
