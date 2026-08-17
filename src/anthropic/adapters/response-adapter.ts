import type { ChatCompletion } from 'openai/resources/chat/completions';
import type {
    AnthropicMessageResponse,
    AnthropicResponseBlock,
    ReasoningChatMessage,
} from '../types';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

function generateMessageId(): string {
    let id = 'msg_';
    for (let i = 0; i < 24; i++) {
        id += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    }
    return id;
}

export function translateResponse(
    response: ChatCompletion,
    requestedModel: string,
): AnthropicMessageResponse {
    const choice = response.choices?.[0];
    const message = choice?.message;
    const content: AnthropicResponseBlock[] = [];

    // Reasoning models (DeepSeek, Qwen…) surface chain-of-thought in
    // `reasoning_content` — expose it as an Anthropic thinking block.
    const reasoning = (message as ReasoningChatMessage)?.reasoning_content;
    if (typeof reasoning === 'string' && reasoning.length > 0) {
        content.push({ type: 'thinking', thinking: reasoning, signature: '' });
    }

    if (message?.content) {
        content.push({ type: 'text', text: message.content });
    }

    if (message?.tool_calls) {
        for (const tc of message.tool_calls) {
            if (!('function' in tc)) continue;
            let input: Record<string, unknown> = {};
            try {
                input = JSON.parse(tc.function.arguments);
            } catch {
                input = {};
            }
            content.push({
                type: 'tool_use',
                id: tc.id,
                name: tc.function.name,
                input,
            });
        }
    }

    return {
        id: generateMessageId(),
        type: 'message',
        role: 'assistant',
        content,
        model: requestedModel,
        stop_reason: mapStopReason(choice?.finish_reason),
        stop_sequence: null,
        usage: {
            input_tokens: response.usage?.prompt_tokens ?? 0,
            output_tokens: response.usage?.completion_tokens ?? 0,
        },
    };
}

function mapStopReason(
    reason: string | null | undefined,
): 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' | null {
    switch (reason) {
        case 'stop':
            return 'end_turn';
        case 'length':
            return 'max_tokens';
        case 'tool_calls':
            return 'tool_use';
        case 'content_filter':
            return 'end_turn';
        default:
            return reason ? 'end_turn' : null;
    }
}
