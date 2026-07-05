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
import { RoutingService } from '../routing/routing.service';

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
 * Phase 3: this service no longer touches `ProviderService.resolve` directly.
 * It composes the body and offers an `executor` closure to the router. The
 * router picks the provider (one that isn't open in the breaker), hands us
 * back the resolved model plus an `AbortSignal` derived from the provider's
 * timeout, and we drive the official OpenAI SDK with that signal plumbed in.
 */
@Injectable()
export class ChatService {
    constructor(
        @Inject(ENV_CONFIG) private readonly env: Env,
        private readonly providers: ProviderService,
        private readonly router: RoutingService,
    ) {}

    /**
     * Resolve the model through the router (which walks the fallback chain
     * under the breaker), send the request on the first usable provider.
     * Returns the SDK result (a `ChatCompletion` or, for `stream=true`, an
     * async iterable of chunks) untouched so the controller can stream them
     * straight back to the client.
     */
    async completions(
        body: ChatCompletionCreateParams,
    ): Promise<CompletionResult> {
        return this.router.route(body.model, body, (resolved, signal) =>
            this.callUpstream(resolved, body, signal),
        ).then((r) => r.result);
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
