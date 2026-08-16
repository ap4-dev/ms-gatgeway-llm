import axios, { type AxiosInstance } from 'axios';
import {
    SearchProviderError,
    SearchRateLimitedError,
    SearchTimeoutError,
    type SearchOptions,
    type SearchProvider,
    type SearchResponse,
    type SearchResult,
} from './search-provider.interface';

/**
 * Last-resort search endpoint (fresh install / test default). Production
 * resolution lives in the composition root (SearchModule factory): it reads
 * the provider row from the DB and derives the endpoint from
 * `providers.base_url` — never a hardcoded id here.
 */
export const DEFAULT_BASE_URL = 'https://api.nan.builders/v1/search';
// NaN's search can take a while when `fetch_content` is requested — the
// upstream has to retrieve and normalize full pages. Snippet-only queries
// are much faster.
const TIMEOUT_WITH_CONTENT_MS = 120_000;
const TIMEOUT_SNIPPETS_MS = 30_000;

/** Minimal provider-row view needed to build a search adapter. */
export interface SearchProviderRow {
    id: string;
    baseURL?: string;
    apiKeyEnv: string;
}

/**
 * Derive the search endpoint from a DB provider row. NaN's search API
 * lives under the provider base URL at `/search`. A provider without
 * `base_url` falls back to {@link DEFAULT_BASE_URL}.
 */
export function searchEndpointFor(row: SearchProviderRow): string {
    return row.baseURL
        ? `${row.baseURL.replace(/\/+$/, '')}/search`
        : DEFAULT_BASE_URL;
}

export interface NanSearchProviderOptions {
    /** Provider id — persisted as `request_logs.resolved_provider`. */
    id?: string;
    /**
     * Full search endpoint. The composition root passes the DB-derived
     * endpoint; tests pass their own or rely on {@link DEFAULT_BASE_URL}.
     */
    baseUrl?: string;
    /**
     * Env var holding the API key — mirrors `providers.api_key_env`, so
     * the key name lives in the DB, not in this file.
     */
    apiKeyEnv?: string;
    /** Explicit API key. Wins over `apiKeyEnv`; used by tests. */
    apiKey?: string;
    /** HTTP client. Injected for tests; defaults to axios. */
    http?: AxiosInstance;
}

/**
 * Search wire-format adapter for NaN's search API. Holds no provider
 * identity: id, endpoint and key env are injected from the DB row, so
 * swapping the active search provider is a DB change — no code change.
 *
 * NaN's constraints (20 RPM / 3 concurrent / 500 req/day) are the reason
 * the gateway applies its own per-client rate limit (RateLimitGuard) on
 * top. A 429 from NaN surfaces as {@link SearchRateLimitedError} so the
 * REST layer can echo `Retry-After` to the caller.
 */
export class NanSearchProvider implements SearchProvider {
    readonly id: string;

    private readonly baseUrl: string;
    private readonly apiKeyEnv: string | undefined;
    private readonly apiKey: string | undefined;
    private readonly http: AxiosInstance;

    constructor(opts: NanSearchProviderOptions = {}) {
        this.id = opts.id ?? 'nan';
        this.baseUrl = opts.baseUrl ?? process.env.NAN_SEARCH_BASE_URL ?? DEFAULT_BASE_URL;
        this.apiKeyEnv = opts.apiKeyEnv;
        this.apiKey =
            opts.apiKey ??
            (opts.apiKeyEnv ? process.env[opts.apiKeyEnv] : undefined);
        this.http = opts.http ?? axios.create();
    }

    async search(opts: SearchOptions): Promise<SearchResponse> {
        if (!this.apiKey) {
            throw new SearchProviderError(
                `Provider "${this.id}" requires env var ${this.apiKeyEnv ?? 'API key'} but it is not set.`,
            );
        }
        const timeoutMs = opts.fetchContent
            ? TIMEOUT_WITH_CONTENT_MS
            : TIMEOUT_SNIPPETS_MS;

        let res;
        try {
            res = await this.http.post(
                this.baseUrl,
                {
                    query: opts.query,
                    ...(opts.count !== undefined ? { count: opts.count } : {}),
                    ...(opts.freshness !== undefined
                        ? { freshness: opts.freshness }
                        : {}),
                    ...(opts.fetchContent !== undefined
                        ? { fetch_content: opts.fetchContent }
                        : {}),
                },
                {
                    headers: {
                        Authorization: `Bearer ${this.apiKey}`,
                        'Content-Type': 'application/json',
                    },
                    timeout: timeoutMs,
                    // AbortSignal.timeout is unreliable under some axios
                    // versions; `timeout` covers socket + response idle.
                    validateStatus: (status) => status >= 200 && status < 300,
                },
            );
        } catch (err) {
            throw this.mapError(err, opts);
        }

        const data = (res as { data?: unknown }).data;
        return normalizeResponse(data);
    }

    private mapError(err: unknown, opts: SearchOptions): SearchProviderError {
        // Duck-typed check (isAxiosError) instead of `instanceof` so the
        // provider stays testable with plain error stubs.
        const isAxios =
            err !== null &&
            typeof err === 'object' &&
            (err as { isAxiosError?: unknown }).isAxiosError === true;
        if (isAxios) {
            const ax = err as {
                response?: { status?: number; headers?: unknown; data?: unknown };
                code?: string;
                message: string;
            };
            const status = ax.response?.status;
            if (status === 429) {
                const retryAfter = parseRetryAfter(ax.response?.headers);
                return new SearchRateLimitedError(
                    'Search provider rate limit exceeded. Retry after the indicated time.',
                    retryAfter,
                );
            }
            if (ax.code === 'ECONNABORTED' || ax.code === 'ETIMEDOUT') {
                return new SearchTimeoutError(
                    `Search provider timed out after ${opts.fetchContent ? TIMEOUT_WITH_CONTENT_MS : TIMEOUT_SNIPPETS_MS}ms.`,
                );
            }
            const data = ax.response?.data;
            const detail =
                typeof data === 'object' &&
                data !== null &&
                'error' in (data as Record<string, unknown>)
                    ? JSON.stringify((data as { error: unknown }).error)
                    : String(data ?? ax.message);
            return new SearchProviderError(
                `Search provider error (HTTP ${status ?? 'unknown'}): ${detail}`,
            );
        }
        if (err instanceof Error && err.name === 'TimeoutError') {
            return new SearchTimeoutError(
                `Search provider timed out after ${opts.fetchContent ? TIMEOUT_WITH_CONTENT_MS : TIMEOUT_SNIPPETS_MS}ms.`,
            );
        }
        return new SearchProviderError(
            err instanceof Error ? err.message : String(err),
        );
    }
}

/**
 * Normalize a raw provider payload into the gateway's `SearchResponse`
 * shape. Tolerant: unknown fields are dropped, missing snippets default to
 * empty strings, and entries without a usable `url` are skipped.
 *
 * The provider-internal `source` field is preserved here and stripped at
 * the REST/MCP boundary (`stripSource` in search.service.ts).
 */
export function normalizeResponse(data: unknown): SearchResponse {
    if (!data || typeof data !== 'object') {
        throw new SearchProviderError('Search provider returned an empty response.');
    }
    const raw = data as Record<string, unknown>;
    const rawResults = Array.isArray(raw.results) ? raw.results : [];

    const results: SearchResult[] = [];
    for (const item of rawResults) {
        if (!item || typeof item !== 'object') continue;
        const r = item as Record<string, unknown>;
        const url = typeof r.url === 'string' ? r.url.trim() : '';
        if (!url) continue;
        results.push({
            title: typeof r.title === 'string' ? r.title : '',
            url,
            snippet: typeof r.snippet === 'string' ? r.snippet : '',
            ...(typeof r.content === 'string' && r.content.length > 0
                ? { content: r.content }
                : {}),
            ...(typeof r.source === 'string' && r.source.length > 0
                ? { source: r.source }
                : {}),
        });
    }

    return {
        results,
        cached: raw.cached === true,
    };
}

function parseRetryAfter(headers: unknown): number | undefined {
    if (!headers || typeof headers !== 'object') return undefined;
    const h = headers as Record<string, unknown>;
    const ra = h['retry-after'] ?? h['Retry-After'];
    if (typeof ra !== 'string') return undefined;
    const secs = Number.parseInt(ra, 10);
    if (Number.isNaN(secs)) return undefined;
    return Math.max(0, secs) * 1000;
}
