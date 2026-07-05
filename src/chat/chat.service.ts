import { Inject, Injectable } from '@nestjs/common';
import OpenAI from 'openai';
import type {
    ChatCompletion,
    ChatCompletionChunk,
    ChatCompletionCreateParams,
    ChatCompletionMessageParam,
} from 'openai/resources/chat/completions';
import { ENV_CONFIG } from '../config/env.token';
import type { Env } from '../config/env.schema';

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
 * ChatService normalizes the inbound OpenAI-compatible payload and forwards
 * it to the upstream provider via the official OpenAI SDK.
 *
 * Today it talks to a single provider (resolved from LLM_PROVIDER_* env vars).
 * Phase 2 will introduce a ProviderService that selects among the entries in
 * config/providers.json.
 */
@Injectable()
export class ChatService {
    private readonly client: OpenAI;

    constructor(@Inject(ENV_CONFIG) env: Env) {
        this.client = new OpenAI({
            apiKey: env.LLM_PROVIDER_API_KEY,
            baseURL: env.LLM_PROVIDER_BASE_URL,
        });
    }

    /**
     * Merge consecutive `system`-role messages at the start of the list into a
     * single system message. Other roles keep their order.
     *
     * Exposed for testing — kept as a free function below for unit tests.
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

    async completions(
        body: ChatCompletionCreateParams,
    ): Promise<CompletionResult> {
        const normalized = this.normalizeBody(body);
        return this.client.chat.completions.create(normalized);
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
