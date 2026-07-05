import Database from 'better-sqlite3';

export type MetricsWindow = '1h' | '24h' | '7d';

const WINDOW_SECONDS: Record<MetricsWindow, number> = {
    '1h': 3600,
    '24h': 86_400,
    '7d': 604_800,
};

export interface LatencyStats {
    p50: number;
    p95: number;
    p99: number;
    min: number;
    max: number;
}

export interface ModelSummary {
    model: string;
    provider: string | null;
    requests: number;
    errors: number;
    error_rate: number;
    latency_ms: LatencyStats;
}

export interface ProviderSummary {
    id: string;
    requests: number;
    errors: number;
    error_rate: number;
    latency_ms: LatencyStats;
}

export interface MetricsSummary {
    window: MetricsWindow;
    /** Unix-seconds timestamp at which the window starts. */
    since: number;
    /** Unix-seconds timestamp at which the window ends. */
    until: number;
    totals: {
        requests: number;
        errors: number;
        error_rate: number;
    };
    models: ModelSummary[];
    providers: ProviderSummary[];
}

interface RawRow {
    requested_at: number;
    model_requested: string;
    resolved_provider: string | null;
    resolved_model: string | null;
    latency_ms: number;
    status: 'ok' | 'error' | 'circuit_open';
}

/**
 * Phase 4 metrics aggregator. Reads `request_logs` once per call (rows are
 * bounded by window, typically < 100k for an hour at POC scale) and
 * computes count, error_rate, and latency p50/p95/p99 in JavaScript.
 *
 * Why JS over SQL? SQLite has no native PERCENTILE_CONT, and adding
 * window-function gymnastics to keep percentile math server-side would
 * outweigh the savings. The data is small enough that pulling it once
 * per call is fine; the `getMetricsSummary` endpoint is hit by humans,
 * not at request-time.
 *
 * If traffic grows, the move is: cache the summary in `metrics_snapshots`
 * (a table refreshed every N seconds by a Nest task) rather than
 * over-engineering the SQL.
 */
export class MetricsService {
    constructor(private readonly db: Database.Database) {}

    summary(window: MetricsWindow, nowSeconds: number): MetricsSummary {
        const until = nowSeconds;
        const since = nowSeconds - WINDOW_SECONDS[window];
        if (!(window in WINDOW_SECONDS)) {
            throw new Error(
                `Unsupported metrics window "${window}". Use one of: ${Object.keys(WINDOW_SECONDS).join(', ')}`,
            );
        }

        const rows = this.db
            .prepare(
                `SELECT requested_at, model_requested, resolved_provider, resolved_model,
                        latency_ms, status
                   FROM request_logs
                  WHERE requested_at >= ? AND requested_at <= ?
                  ORDER BY requested_at`,
            )
            .all(since, until) as RawRow[];

        const totals = computeTotals(rows);
        const models = groupBy(rows, (r) => r.model_requested, (model, group) => ({
            model,
            provider: pickProviderForModel(group),
            ...aggregate(group),
        })) as ModelSummary[];

        const providers = groupBy(
            rows.filter((r) => r.resolved_provider),
            (r) => r.resolved_provider as string,
            (id, group) => ({ id, ...aggregate(group) }),
        ) as ProviderSummary[];

        return {
            window,
            since,
            until,
            totals,
            models: orderByName(models),
            providers: orderByName(providers),
        };
    }
}

function isErrorStatus(status: RawRow['status']): boolean {
    return status === 'error' || status === 'circuit_open';
}

function computeTotals(rows: RawRow[]): MetricsSummary['totals'] {
    const requests = rows.length;
    const errors = rows.filter((r) => isErrorStatus(r.status)).length;
    return {
        requests,
        errors,
        error_rate: requests === 0 ? 0 : errors / requests,
    };
}

function aggregate(
    rows: RawRow[],
): Omit<ModelSummary, 'model' | 'provider'> {
    const latencies = rows.map((r) => r.latency_ms).sort((a, b) => a - b);
    const requests = rows.length;
    const errors = rows.filter((r) => isErrorStatus(r.status)).length;
    return {
        requests,
        errors,
        error_rate: requests === 0 ? 0 : errors / requests,
        latency_ms: latencies.length
            ? computeLatencyStats(latencies)
            : { p50: 0, p95: 0, p99: 0, min: 0, max: 0 },
    };
}

function computeLatencyStats(sortedAsc: number[]): LatencyStats {
    const n = sortedAsc.length;
    const pick = (q: number): number => sortedAsc[Math.min(n - 1, Math.ceil(q * n) - 1)];
    return {
        p50: pick(0.5),
        p95: pick(0.95),
        p99: pick(0.99),
        min: sortedAsc[0],
        max: sortedAsc[n - 1],
    };
}

function pickProviderForModel(group: RawRow[]): string | null {
    // The same alias can land on different upstreams depending on fallback;
    // we surface the provider that served the majority of rows, or the
    // first one we saw when tied.
    const counts = new Map<string, number>();
    for (const r of group) {
        if (!r.resolved_provider) continue;
        counts.set(r.resolved_provider, (counts.get(r.resolved_provider) ?? 0) + 1);
    }
    let best: string | null = null;
    let bestCount = -1;
    for (const [id, count] of counts) {
        if (count > bestCount) {
            best = id;
            bestCount = count;
        }
    }
    return best;
}

function groupBy<T, K extends string, V>(
    rows: T[],
    keyFn: (r: T) => K,
    reduce: (key: K, group: T[]) => V,
): V[] {
    const groups = new Map<K, T[]>();
    for (const r of rows) {
        const k = keyFn(r);
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k)!.push(r);
    }
    return Array.from(groups.entries()).map(([k, g]) => reduce(k, g));
}

function orderByName<T extends { model?: string; id?: string }>(arr: T[]): T[] {
    return [...arr].sort((a, b) => (a.model ?? a.id ?? '').localeCompare(b.model ?? b.id ?? ''));
}
