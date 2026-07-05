import { Inject, Injectable } from '@nestjs/common';
import type {
    ChatCompletion,
    ChatCompletionChunk,
    ChatCompletionCreateParams,
    ChatCompletionMessageParam,
} from 'openai/resources/chat/completions';
import { ENV_CONFIG } from '../config/env.token';
import type { Env } from '../config/env.schema';
import { ProviderService } from '../providers/provider.service';
import type { ResolvedModel } from '../providers/provider.model';
import { RoutingFailedError, RoutingService } from '../routing/routing.service';
import { RequestLogService } from '../observability/request-log.service';
import {
    LlmLoggingService,
    type RequestLogEvent,
} from '../observability/llm-logging.service';
import { hashPrompt } from '../observability/prompt-hash.util';

export type ChatMessage = {
    role: string;
    content: any;
    name?: string;
    [key: string]: any;
};

export type CompletionResult =
    | ChatCompletion
    | AsyncIterable<ChatCompletionChunk>;

/**
 * ChatService normalizes the inbound OpenAI-compatible payload and hands the
 * actual upstream call off to {@link RoutingService}, which expands the
 * model alias into a fallback chain and walks it under the supervision of
 * the circuit breaker.
 *
 * Phase 4: every call records a structured log entry (LlmLoggingService)
 * and a row in `request_logs` with prompt hash and, when present,
 * upstream token counts. Streaming responses skip the token capture
 * (upstream usage lands in a final chunk most clients ignore — we'd need
 * to buffer to extract it; deferred).
 */
@Injectable()
export class ChatService {
    constructor(
        @Inject(ENV_CONFIG) private readonly env: Env,
        private readonly providers: ProviderService,
        private readonly router: RoutingService,
        private readonly requestLog: RequestLogService,
        private readonly structuredLog: LlmLoggingService,
    ) {}

    /**
     * Resolve the model through the router (which walks the fallback chain
     * under the breaker), send the request on the first usable provider.
     * Returns the SDK result (a `ChatCompletion` or, for `stream=true`, an
     * async iterable of chunks) untouched so the controller can stream them
     * straight back to the client.
     *
     * Phase 4: every call lands one row in `request_logs` (DB) and one
     * structured log entry on stdout (JSON). Token counts only land for
     * non-streaming requests where the upstream surfaces `usage`.
     */
    async completions(
        body: ChatCompletionCreateParams,
    ): Promise<CompletionResult> {
        const requestedAt = Math.floor(Date.now() / 1000);
        const promptHash = hashPrompt(
            (body.messages ?? []) as any,
            body.model,
        );
        try {
            const r = await this.router.route(body.model, body, (resolved, signal) =>
                this.callUpstream(resolved, body, signal),
            );
            const resolvedModel = r.attempts.at(-1)?.upstreamModel ?? 'unknown';
            const tokens = extractTokens(r.result);
            this.requestLog.recordSuccess({
                requestedAt,
                requestedModel: body.model,
                resolvedProvider: r.providerId,
                resolvedModel,
                attempts: r.attempts.length,
                latencyMs: nowSeconds() - requestedAt,
                promptHash,
                ...tokens,
            });
            this.structuredLog.logRequest(
                buildEvent({
                    requestedAt,
                    body,
                    resolvedProvider: r.providerId,
                    resolvedModel,
                    attempts: r.attempts.length,
                    latencyMs: nowSeconds() - requestedAt,
                    promptHash,
                    status: 'ok',
                    tokens,
                    clientKey: null,
                }),
            );
            return r.result;
        } catch (err) {
            this.recordFailure(err, body, requestedAt, promptHash);
            throw err;
        }
    }

    private recordFailure(
        err: unknown,
        body: ChatCompletionCreateParams,
        requestedAt: number,
        promptHash: string,
    ): void {
        const argsBase = {
            requestedAt,
            latencyMs: nowSeconds() - requestedAt,
            promptHash,
            clientKey: null as string | null,
        };
        if (err instanceof RoutingFailedError) {
            this.requestLog.recordFailure({
                ...argsBase,
                requestedModel: err.requestedModel,
                attempts: err.attempts,
                error: err,
            });
            this.structuredLog.logRequest(
                buildEvent({
                    ...argsBase,
                    body: { model: err.requestedModel } as any,
                    resolvedProvider: null,
                    resolvedModel: null,
                    attempts: err.attempts.length,
                    status: chooseStatusForFailure(err),
                    tokens: undefined,
                    errorMessage: err.message,
                }),
            );
            return;
        }
        this.requestLog.recordFailure({
            ...argsBase,
            requestedModel: body.model,
            attempts: [],
            error: err,
        });
        this.structuredLog.logRequest(
            buildEvent({
                ...argsBase,
                body,
                resolvedProvider: null,
                resolvedModel: null,
                attempts: 0,
                status: 'error',
                tokens: undefined,
                errorMessage:
                    err instanceof Error ? err.message : String(err),
            }),
        );
    }

    /**
     * Build the outbound body (normalize, apply per-model overrides) and call
     * the OpenAI SDK. Exposed via the `executor` closure handed to
     * {@link RoutingService}.
     */
    private async callUpstream(
        resolved: ResolvedModel,
        body: ChatCompletionCreateParams,
        signal: AbortSignal,
    ): Promise<CompletionResult> {
        const client = this.providers.clientFor(resolved);
        const outbound = this.applyResolved(
            this.normalizeBody(body),
            resolved,
        );
        // Cast to any because the OpenAI SDK types don't currently reflect
        // the optional `signal` field on `chat.completions.create`. The SDK
        // forwards it to the underlying fetch when present.
        return (client.chat.completions as any).create(outbound, { signal }) as Promise<CompletionResult>;
    }

    /**
     * Merge all `system`-role messages into a single one at the front of the
     * list. Other roles keep their order. Free function — duplicated below
     * as `mergeSystemMessages` for direct unit testing.
     */
    private normalizeMessages(messages: ChatMessage[]): ChatMessage[] {
        if (!Array.isArray(messages) || messages.length === 0) return messages;

        const systems = messages.filter((m) => m?.role === 'system');
        const others = messages.filter((m) => m?.role !== 'system');

        if (systems.length === 0) return messages;

        const mergedContent = systems
            .map((m) => extractText(m.content))
            .filter((c) => c.length > 0)
            .join('\n\n');

        const mergedSystem: ChatMessage = {
            ...systems[0],
            role: 'system',
            content: mergedContent || systems[0].content,
        };

        return [mergedSystem, ...others];
    }

    private normalizeBody(
        body: ChatCompletionCreateParams,
    ): ChatCompletionCreateParams {
        if (!body || !Array.isArray(body.messages)) return body;
        return {
            ...body,
            messages: this.normalizeMessages(
                body.messages as unknown as ChatMessage[],
            ) as unknown as ChatCompletionMessageParam[],
        };
    }

    private applyResolved(
        body: ChatCompletionCreateParams,
        resolved: ResolvedModel,
    ): ChatCompletionCreateParams {
        const result: ChatCompletionCreateParams = {
            ...body,
            model: resolved.upstreamModel,
        };
        if (resolved.overrides.maxTokens && !('max_tokens' in body)) {
            (result as any).max_tokens = resolved.overrides.maxTokens;
        }
        return result;
    }
}

// ---------------------------------------------------------------------------
// Pure helpers — exported separately so unit tests can exercise them
// without spinning up Nest DI.
// ---------------------------------------------------------------------------

function nowSeconds(): number {
    return Math.floor(Date.now() / 1000);
}

/** Pull `usage` off a non-streaming `ChatCompletion`. Returns undefined
 *  for streams — the SDK surfaces usage on a final chunk which we would
 *  have to buffer to extract. Phase 4 v1 logs `ok` rows for streams
 *  without token counts. */
function extractTokens(result: CompletionResult):
    | { promptTokens: number; completionTokens: number; totalTokens: number }
    | undefined {
    if (!result || typeof (result as any).then === 'function') return undefined;
    // AsyncIterable<string> has Symbol.asyncIterator, ChatCompletion does not.
    if ((result as any)[Symbol.asyncIterator]) return undefined;
    const usage = (result as ChatCompletion).usage;
    if (!usage) return undefined;
    return {
        promptTokens: usage.prompt_tokens,
        completionTokens: usage.completion_tokens,
        totalTokens: usage.total_tokens,
    };
}

function chooseStatusForFailure(err: RoutingFailedError): 'error' | 'circuit_open' {
    if (err.attempts.length === 0) return 'circuit_open';
    if (err.attempts.every((a) => a.ok === false && a.circuitOpen === true)) {
        return 'circuit_open';
    }
    return 'error';
}

interface BuildEventArgs {
    requestedAt: number;
    body: { model: string };
    resolvedProvider: string | null;
    resolvedModel: string | null;
    attempts: number;
    latencyMs: number;
    promptHash: string;
    status: 'ok' | 'error' | 'circuit_open';
    tokens:
        | { promptTokens: number; completionTokens: number; totalTokens: number }
        | undefined;
    errorMessage?: string;
    clientKey: string | null;
}

function buildEvent(a: BuildEventArgs): RequestLogEvent {
    return {
        event: 'chat.request',
        ts: a.requestedAt,
        model: a.body.model,
        resolvedProvider: a.resolvedProvider,
        resolvedModel: a.resolvedModel,
        promptHash: a.promptHash,
        latencyMs: a.latencyMs,
        attempts: a.attempts,
        status: a.status,
        ...(a.tokens
            ? {
                  promptTokens: a.tokens.promptTokens,
                  completionTokens: a.tokens.completionTokens,
                  totalTokens: a.tokens.totalTokens,
              }
            : {}),
        ...(a.errorMessage ? { error: a.errorMessage } : {}),
        ...(a.clientKey ? { clientKey: a.clientKey } : {}),
    };
}

export function extractText(content: any): string {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content
            .map((part) => {
                if (typeof part === 'string') return part;
                if (part && typeof part === 'object' && 'text' in part) {
                    return String((part as any).text ?? '');
                }
                return '';
            })
            .join('');
    }
    return '';
}

export function mergeSystemMessages(messages: ChatMessage[]): ChatMessage[] {
    if (!Array.isArray(messages) || messages.length === 0) return messages;

    const systems = messages.filter((m) => m?.role === 'system');
    const others = messages.filter((m) => m?.role !== 'system');

    if (systems.length === 0) return messages;

    const mergedContent = systems
        .map((m) => extractText(m.content))
        .filter((c) => c.length > 0)
        .join('\n\n');

    const mergedSystem: ChatMessage = {
        ...systems[0],
        role: 'system',
        content: mergedContent || systems[0].content,
    };

    return [mergedSystem, ...others];
}
