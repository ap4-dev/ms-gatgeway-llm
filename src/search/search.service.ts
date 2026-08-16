import { Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import {
    SEARCH_PROVIDER,
    SearchProviderError,
    SearchRateLimitedError,
    type SearchOptions,
    type SearchProvider,
    type SearchResponse,
} from './search-provider.interface';
import { RequestLogService } from '../observability/request-log.service';
import {
    LlmLoggingService,
    type RequestLogEvent,
} from '../observability/llm-logging.service';
import { hashPrompt } from '../observability/prompt-hash.util';

/**
 * Request schema for `POST /v1/search`. Field names mirror NaN's wire
 * format (`fetch_content`) so the gateway is a drop-in surface for clients
 * already talking to NaN directly. `.passthrough()` keeps us lenient about
 * unknown fields — only the known ones are forwarded upstream.
 */
export const SearchBodySchema = z
    .object({
        query: z
            .string()
            .min(1, 'query must be at least 1 character')
            .max(500, 'query must be at most 500 characters'),
        count: z
            .number()
            .int('count must be an integer')
            .min(1, 'count must be at least 1')
            .max(20, 'count must be at most 20')
            .optional(),
        freshness: z
            .string()
            .regex(
                /^(pd|pw|pm|py)$|^\d{4}-\d{2}-\d{2}to\d{4}-\d{2}-\d{2}$/,
                "freshness must be one of pd|pw|pm|py or an explicit YYYY-MM-DDtoYYYY-MM-DD range",
            )
            .optional(),
        fetch_content: z.boolean().optional(),
    })
    .passthrough();

export type SearchBody = z.infer<typeof SearchBodySchema>;

/** Marker persisted in `request_logs.model_requested` for search calls. */
export const SEARCH_LOG_MODEL = '$search';

@Injectable()
export class SearchService {
    constructor(
        @Inject(SEARCH_PROVIDER) private readonly provider: SearchProvider,
        private readonly requestLog: RequestLogService,
        private readonly structuredLog: LlmLoggingService,
    ) {}

    /**
     * Validate, dispatch to the active provider, and record observability
     * for one search. Errors are re-thrown as {@link SearchProviderError}
     * (or an already-mapped instance) so controllers can translate them to
     * HTTP envelopes / MCP tool errors without re-interpreting.
     */
    async search(
        body: SearchBody,
        clientId: string | null = null,
    ): Promise<SearchResponse> {
        const requestedAt = nowSeconds();
        const options = toOptions(body);
        const promptHash = hashPrompt(
            [{ role: 'user', content: options.query }],
            SEARCH_LOG_MODEL,
        );

        try {
            const response = await this.provider.search(options);
            this.recordSuccess(
                requestedAt,
                options,
                response,
                promptHash,
                clientId,
            );
            return response;
        } catch (err) {
            const mapped =
                err instanceof SearchProviderError
                    ? err
                    : new SearchProviderError(
                          err instanceof Error ? err.message : String(err),
                      );
            this.recordFailure(requestedAt, options, mapped, promptHash, clientId);
            throw mapped;
        }
    }

    // --- observability ----------------------------------------------------

    private recordSuccess(
        requestedAt: number,
        opts: SearchOptions,
        response: SearchResponse,
        promptHash: string,
        clientId: string | null,
    ): void {
        const latencyMs = nowSeconds() - requestedAt;
        this.requestLog.recordSuccess({
            requestedAt,
            requestedModel: SEARCH_LOG_MODEL,
            resolvedProvider: this.provider.id,
            resolvedModel: null,
            attempts: 1,
            latencyMs,
            promptHash,
            clientKey: clientId,
        });
        this.structuredLog.logRequest(
            buildEvent({
                requestedAt,
                latencyMs,
                promptHash,
                status: 'ok',
                clientKey: clientId,
                resultCount: response.results.length,
                cached: response.cached,
            }),
        );
    }

    private recordFailure(
        requestedAt: number,
        opts: SearchOptions,
        err: SearchProviderError,
        promptHash: string,
        clientId: string | null,
    ): void {
        const latencyMs = nowSeconds() - requestedAt;
        this.requestLog.recordFailure({
            requestedAt,
            requestedModel: SEARCH_LOG_MODEL,
            attempts: 1,
            latencyMs,
            error: err,
            resolvedProvider: this.provider.id,
            resolvedModel: null,
            clientKey: clientId,
            promptHash,
        });
        this.structuredLog.logRequest(
            buildEvent({
                requestedAt,
                latencyMs,
                promptHash,
                status: 'error',
                clientKey: clientId,
                errorMessage: `${err.code}: ${err.message}`,
            }),
        );
    }
}

// ---------------------------------------------------------------------------
// Pure helpers — exported for unit tests.
// ---------------------------------------------------------------------------

function nowSeconds(): number {
    return Math.floor(Date.now() / 1000);
}

/** Drop the provider-internal `source` field before exposing results. */
export function stripSource(response: SearchResponse): SearchResponse {
    return {
        ...response,
        results: response.results.map((r) => {
            const { source: _source, ...rest } = r;
            return rest;
        }),
    };
}

/** Map the inbound wire shape (`fetch_content`) to provider options. */
export function toOptions(body: SearchBody): SearchOptions {
    const opts: SearchOptions = { query: body.query };
    if (body.count !== undefined) opts.count = body.count;
    if (body.freshness !== undefined) opts.freshness = body.freshness;
    if (body.fetch_content !== undefined) opts.fetchContent = body.fetch_content;
    return opts;
}

/**
 * Build the REST error envelope for a provider failure. Mirrors the OpenAI
 * style used elsewhere in the gateway, with the plan's `search_*` code.
 */
export function searchErrorEnvelope(err: SearchProviderError): {
    error: {
        message: string;
        type: string;
        code: string;
        retryAfterMs?: number;
    };
} {
    return {
        error: {
            message: err.message,
            type: err.code,
            code: err.code,
            ...(err.retryAfterMs !== undefined
                ? { retryAfterMs: err.retryAfterMs }
                : {}),
        },
    };
}

/** HTTP status for a provider failure (REST controller). */
export function searchErrorStatus(err: SearchProviderError): number {
    switch (err.code) {
        case 'search_rate_limited':
            return 429;
        case 'search_timeout':
            return 504;
        default:
            return 502;
    }
}

/** True when the error is a provider rate limit (REST maps to Retry-After). */
export function isSearchRateLimited(err: SearchProviderError): boolean {
    return err instanceof SearchRateLimitedError || err.code === 'search_rate_limited';
}

interface BuildEventArgs {
    requestedAt: number;
    latencyMs: number;
    promptHash: string;
    status: 'ok' | 'error';
    clientKey: string | null;
    resultCount?: number;
    cached?: boolean;
    errorMessage?: string;
}

function buildEvent(a: BuildEventArgs): RequestLogEvent {
    return {
        event: 'search.request',
        ts: a.requestedAt,
        model: SEARCH_LOG_MODEL,
        resolvedProvider: null,
        resolvedModel: null,
        promptHash: a.promptHash,
        latencyMs: a.latencyMs,
        attempts: 1,
        status: a.status,
        ...(a.resultCount !== undefined ? { resultCount: a.resultCount } : {}),
        ...(a.cached !== undefined ? { cached: a.cached } : {}),
        ...(a.errorMessage ? { error: a.errorMessage } : {}),
        ...(a.clientKey ? { clientKey: a.clientKey } : {}),
    };
}
