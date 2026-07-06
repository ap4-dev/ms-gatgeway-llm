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
     * Phase 5: `clientId` (verified by ApiKeyAuthGuard) is persisted on
     * the log row and the structured event.
     */
    async completions(
        body: ChatCompletionCreateParams,
        clientId: string | null = null,
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

            // Non-streaming: SDK already returned the full ChatCompletion
            // synchronously. Pull `usage` and log right now — latency is
            // measured from requestedAt to "upstream returned", which is the
            // wall-clock cost the client paid.
            if (!isAsyncIterable(r.result)) {
                const tokens = extractTokens(r.result);
                this.recordSuccess(
                    requestedAt,
                    body.model,
                    r.providerId,
                    resolvedModel,
                    r.attempts.length,
                    promptHash,
                    clientId,
                    tokens,
                );
                return r.result;
            }

            // Streaming: tee the SDK iterable so the controller sees each
            // chunk live (TTFT preserved) while we accumulate a copy for
            // post-iteration logging. `stream` is forwarded untouched;
            // `logged` resolves with the token capture once the controller
            // finishes iterating. Latency is measured end-to-end — from
            // requestedAt to the last byte the client received.
            const messagesForEstimation = (body.messages ?? []) as unknown[];
            const { stream, logged } = teeStream(r.result);
            logged
                .then((chunks) => {
                    const tokens = extractStreamTokens(
                        chunks,
                        messagesForEstimation,
                    );
                    this.recordSuccess(
                        requestedAt,
                        body.model,
                        r.providerId,
                        resolvedModel,
                        r.attempts.length,
                        promptHash,
                        clientId,
                        tokens,
                    );
                })
                .catch(() => {
                    // Stream aborted mid-flight or threw before completing.
                    // Log a best-effort partial row — `extractStreamTokens`
                    // will fall back to the local estimator on whatever the
                    // tap captured.
                    this.recordSuccess(
                        requestedAt,
                        body.model,
                        r.providerId,
                        resolvedModel,
                        r.attempts.length,
                        promptHash,
                        clientId,
                        undefined,
                    );
                });
            return stream;
        } catch (err) {
            this.recordFailure(err, body, requestedAt, promptHash, clientId);
            throw err;
        }
    }

    /** Build the success-log row + structured event from captured token
     *  data. Shared between the sync (non-streaming) and async (streaming)
     *  paths so the columns and the JSON shape stay aligned. */
    private recordSuccess(
        requestedAt: number,
        requestedModel: string,
        providerId: string,
        resolvedModel: string,
        attempts: number,
        promptHash: string,
        clientId: string | null,
        tokens: ReturnType<typeof extractTokens>,
    ): void {
        const latencyMs = nowSeconds() - requestedAt;
        const body = { model: requestedModel } as ChatCompletionCreateParams;
        this.requestLog.recordSuccess({
            requestedAt,
            requestedModel,
            resolvedProvider: providerId,
            resolvedModel,
            attempts,
            latencyMs,
            promptHash,
            clientKey: clientId,
            ...(tokens ?? {}),
        });
        this.structuredLog.logRequest(
            buildEvent({
                requestedAt,
                body,
                resolvedProvider: providerId,
                resolvedModel,
                attempts,
                latencyMs,
                promptHash,
                status: 'ok',
                tokens,
                clientKey: clientId,
            }),
        );
    }

    private recordFailure(
        err: unknown,
        body: ChatCompletionCreateParams,
        requestedAt: number,
        promptHash: string,
        clientId: string | null,
    ): void {
        const argsBase = {
            requestedAt,
            latencyMs: nowSeconds() - requestedAt,
            promptHash,
            clientKey: clientId,
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
        // For streamed requests, ask the upstream to surface a final
        // `usage` chunk so the gateway can persist token counts alongside
        // the response (Phase 4 v1 logged NULLs for streams). Caller-supplied
        // `stream_options` wins — operators who want to disable it can pass
        // `{ include_usage: false }` and we'll forward that as-is.
        if (body.stream && !('stream_options' in body)) {
            (result as any).stream_options = { include_usage: true };
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
 *  for streams — the SDK surfaces usage on a final chunk which the caller
 *  has to drain and inspect via `extractStreamTokens`. */
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

/** True for anything that quacks like `AsyncIterable<T>` — used by
 *  `completions` to decide whether to tee the upstream response. */
function isAsyncIterable(
    x: unknown,
): x is AsyncIterable<ChatCompletionChunk> {
    return (
        x != null &&
        typeof (x as { [Symbol.asyncIterator]?: unknown })[
            Symbol.asyncIterator
        ] === 'function'
    );
}

/**
 * Wrap an upstream `AsyncIterable<ChatCompletionChunk>` so that:
 *  - the caller iterates a `stream` that forwards chunks **live** (TTFT
 *    unchanged — the controller writes the first SSE byte as soon as the
 *    upstream yields it, no front-buffer in the gateway);
 *  - a side `logged` promise resolves once iteration ends (normally or
 *    via throw), carrying the accumulated chunk buffer for token capture.
 *
 * Implementation: the wrapped iterator pulls from the source's iterator
 * and pushes each value into a tap buffer. The buffer is closed exactly
 * once — first `done` wins, errors reject so callers can distinguish
 * "stream finished cleanly" from "aborted before completing".
 */
function teeStream(
    source: AsyncIterable<ChatCompletionChunk>,
): {
    stream: AsyncIterable<ChatCompletionChunk>;
    logged: Promise<ChatCompletionChunk[]>;
} {
    const chunks: ChatCompletionChunk[] = [];
    let resolveDone!: (buf: ChatCompletionChunk[]) => void;
    let rejectDone!: (err: unknown) => void;
    const logged = new Promise<ChatCompletionChunk[]>((resolve, reject) => {
        resolveDone = resolve;
        rejectDone = reject;
    });

    const stream: AsyncIterable<ChatCompletionChunk> = {
        [Symbol.asyncIterator]() {
            const inner = source[Symbol.asyncIterator]();
            let closed = false;
            const close = (err?: unknown): void => {
                if (closed) return;
                closed = true;
                if (err !== undefined) rejectDone(err);
                else resolveDone(chunks);
            };
            return {
                async next(): Promise<IteratorResult<ChatCompletionChunk>> {
                    try {
                        const r = await inner.next();
                        if (r.done) {
                            close();
                            return r;
                        }
                        chunks.push(r.value);
                        return r;
                    } catch (err) {
                        close(err);
                        throw err;
                    }
                },
                async return(
                    value?: ChatCompletionChunk,
                ): Promise<IteratorResult<ChatCompletionChunk>> {
                    // Mirror `AsyncIterator` cleanup so early `break;` in the
                    // controller's for-await still flushes the tap.
                    close();
                    return inner.return
                        ? inner.return(value)
                        : { value: undefined as unknown as ChatCompletionChunk, done: true };
                },
            };
        },
    };
    return { stream, logged };
}

/** Estimate token counts from a chunk buffer when the upstream didn't
 *  surface a `usage` chunk. Used as a fallback so we always log *some*
 *  number — accuracy is secondary to having data for cost dashboards.
 *
 *  Heuristic: 1 token ≈ 4 characters of English/code text. Real tokenizer
 *  ratios vary (1.5–5 depending on language + symbol density); 4 is a
 *  conservative midpoint that errs slightly high. */
function estimateTokens(
    chunks: ReadonlyArray<ChatCompletionChunk>,
    promptBody: ReadonlyArray<unknown>,
): { promptTokens: number; completionTokens: number; totalTokens: number } {
    const completionChars = chunks.reduce((acc, c) => {
        const deltas = c.choices ?? [];
        for (const d of deltas) {
            const content = (d.delta as { content?: string | null } | undefined)?.content;
            if (typeof content === 'string') acc += content.length;
        }
        return acc;
    }, 0);
    // Prompt estimation: JSON.stringify the message array — close enough
    // for proportional reporting; tiktoken would be overkill at POC scale.
    const promptChars = JSON.stringify(promptBody ?? []).length;
    const completionTokens = Math.max(1, Math.ceil(completionChars / 4));
    const promptTokens = Math.max(1, Math.ceil(promptChars / 4));
    return {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
    };
}

/** Try to recover real `usage` from a drained stream. OpenAI-compatible
 *  upstreams surface `usage` on a final chunk only when the request set
 *  `stream_options.include_usage: true` (see `ChatService.applyResolved`).
 *  When no `usage` chunk arrived, fall back to the local estimator — that
 *  way we never write a row with NULL tokens when the response had *any*
 *  bytes in it. */
function extractStreamTokens(
    chunks: ReadonlyArray<ChatCompletionChunk>,
    promptBody: ReadonlyArray<unknown>,
):
    | {
          promptTokens: number;
          completionTokens: number;
          totalTokens: number;
      }
    | undefined {
    let found:
        | {
              promptTokens: number;
              completionTokens: number;
              totalTokens: number;
          }
        | undefined;
    for (const chunk of chunks) {
        const usage = chunk.usage;
        if (!usage) continue;
        found = {
            promptTokens: usage.prompt_tokens,
            completionTokens: usage.completion_tokens,
            totalTokens: usage.total_tokens,
        };
    }
    return found ?? estimateTokens(chunks, promptBody);
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
