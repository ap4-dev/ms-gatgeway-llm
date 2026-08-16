/**
 * Provider-agnostic search surface.
 *
 * The gateway owns these types; a concrete provider (NaN today, another
 * tomorrow) implements {@link SearchProvider}. Controllers and clients only
 * ever talk to {@link SearchService}, so swapping the upstream never leaks
 * into the public API.
 */

export interface SearchOptions {
    query: string;
    /** Number of results, 1–20. Default 5. */
    count?: number;
    /**
     * Freshness window: `pd` | `pw` | `pm` | `py`, or an explicit
     * `YYYY-MM-DDtoYYYY-MM-DD` range.
     */
    freshness?: string;
    /** Fetch full page content alongside snippets. */
    fetchContent?: boolean;
}

export interface SearchResult {
    title: string;
    url: string;
    snippet: string;
    /** Full page text — present when `fetchContent` was requested. */
    content?: string;
    /** Provider-internal detail. Never exposed on the public surface. */
    source?: string;
}

export interface SearchResponse {
    results: SearchResult[];
    /** True when the provider served the results from its cache. */
    cached: boolean;
}

/** Any search provider must implement this. See `NanSearchProvider`. */
export interface SearchProvider {
    /** Stable provider id, persisted in `request_logs.resolved_provider`. */
    readonly id: string;
    search(opts: SearchOptions): Promise<SearchResponse>;
}

/** DI token for the active provider. SearchModule binds the concrete impl. */
export const SEARCH_PROVIDER = Symbol('SEARCH_PROVIDER');

/**
 * Error taxonomy for search failures. The REST controller maps these to
 * status codes + the `search_*` envelope; the MCP controller maps them to
 * `isError: true` tool results.
 */
export class SearchProviderError extends Error {
    constructor(
        message: string,
        readonly code:
            | 'search_unavailable'
            | 'search_rate_limited'
            | 'search_timeout' = 'search_unavailable',
        readonly retryAfterMs?: number,
    ) {
        super(message);
        this.name = 'SearchProviderError';
    }
}

export class SearchRateLimitedError extends SearchProviderError {
    constructor(message: string, retryAfterMs?: number) {
        super(message, 'search_rate_limited', retryAfterMs);
        this.name = 'SearchRateLimitedError';
    }
}

export class SearchTimeoutError extends SearchProviderError {
    constructor(message: string) {
        super(message, 'search_timeout');
        this.name = 'SearchTimeoutError';
    }
}
