import type { ChatCompletionCreateParams } from 'openai/resources/chat/completions';
import type { AnthropicMessagesBody } from '../schemas/messages.schema';
import type {
    AnthropicContentBlock,
    AnthropicMessage,
    AnthropicToolChoice,
} from '../types';

export function translateRequest(body: AnthropicMessagesBody): ChatCompletionCreateParams {
    const messages = translateMessages(body.messages, body.system);
    const tools = translateTools(body.tools);
    const toolChoice = translateToolChoice(body.tool_choice);

    const out: Record<string, unknown> = {
        model: body.model,
        messages,
        max_tokens: body.max_tokens,
    };

    if (tools) out.tools = tools;
    if (toolChoice !== undefined) out.tool_choice = toolChoice;
    if (body.temperature !== undefined) out.temperature = body.temperature;
    if (body.top_p !== undefined) out.top_p = body.top_p;
    if (body.stop_sequences) out.stop = body.stop_sequences;
    // `top_k` is intentionally NOT forwarded: OpenAI Chat Completions has no
    // equivalent param, and sending it would break strict providers that
    // reject unknown fields. Some upstreams (e.g. Qwen) support it, but the
    // gateway keeps the wire format conservative — top_k is accepted and
    // ignored for Anthropic-client compatibility.
    // Extended thinking is forwarded verbatim (Anthropic and DeepSeek share
    // the `{type, budget_tokens}` shape). `ChatService.applyResolved` honors
    // caller-supplied `thinking` over the per-model `disableThinking` flag.
    if (body.thinking) out.thinking = body.thinking;
    if (body.stream) out.stream = body.stream;
    if (body.metadata?.user_id) out.user = body.metadata.user_id;

    return out as unknown as ChatCompletionCreateParams;
}

function translateMessages(
    messages: AnthropicMessage[],
    system?: string | AnthropicContentBlock[],
): Record<string, unknown>[] {
    const result: Record<string, unknown>[] = [];

    if (system) {
        const text = typeof system === 'string'
            ? system
            : system
                  .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
                  .map((b) => b.text)
                  .join('\n\n');
        if (text) {
            result.push({ role: 'system', content: text });
        }
    }

    for (const msg of messages) {
        if (!msg.content || typeof msg.content === 'string') {
            result.push({ role: msg.role, content: msg.content ?? null });
            continue;
        }

        if (msg.role === 'user') {
            const toolResults = msg.content.filter(
                (b): b is Extract<AnthropicContentBlock, { type: 'tool_result' }> =>
                    b.type === 'tool_result',
            );
            const rest = msg.content.filter((b) => b.type !== 'tool_result');

            for (const tr of toolResults) {
                const content =
                    typeof tr.content === 'string'
                        ? tr.content
                        : Array.isArray(tr.content)
                          ? tr.content
                                .filter(
                                    (b): b is { type: 'text'; text: string } => b.type === 'text',
                                )
                                .map((b) => b.text)
                                .join('')
                          : '';
                result.push({
                    role: 'tool',
                    tool_call_id: tr.tool_use_id,
                    content,
                });
            }

            if (rest.length > 0) {
                const textParts = rest.filter(
                    (b): b is { type: 'text'; text: string } => b.type === 'text',
                );
                const imageParts = rest.filter(
                    (b): b is { type: 'image'; source: { type: 'base64'; media_type: string; data: string } } =>
                        b.type === 'image',
                );
                const contentParts: Record<string, unknown>[] = [];
                for (const tp of textParts) {
                    contentParts.push({ type: 'text', text: tp.text });
                }
                for (const ip of imageParts) {
                    contentParts.push({
                        type: 'image_url',
                        image_url: {
                            url: `data:${ip.source.media_type};base64,${ip.source.data}`,
                        },
                    });
                }
                if (contentParts.length === 1 && contentParts[0].type === 'text') {
                    result.push({ role: 'user', content: contentParts[0].text });
                } else {
                    result.push({ role: 'user', content: contentParts });
                }
            }
            continue;
        }

        // assistant message
        if (msg.role !== 'assistant') {
            // Unknown role — pass through as-is (system, developer, etc.)
            result.push({ role: msg.role, content: msg.content });
            continue;
        }

        const textBlocks = msg.content.filter(
            (b): b is { type: 'text'; text: string } => b.type === 'text',
        );
        const thinkingBlocks = msg.content.filter(
            (b): b is { type: 'thinking'; thinking: string } => b.type === 'thinking',
        );
        const toolUseBlocks = msg.content.filter(
            (b): b is Extract<AnthropicContentBlock, { type: 'tool_use' }> =>
                b.type === 'tool_use',
        );

        const assistant: Record<string, unknown> = { role: 'assistant' };

        const text = textBlocks.map((b) => b.text).join('');
        assistant.content = text || null;

        // Echo prior reasoning back so DeepSeek (thinking mode) accepts the
        // next turn. Empty thinking blocks are skipped.
        if (thinkingBlocks.length > 0) {
            const joined = thinkingBlocks.map((b) => b.thinking).join('');
            if (joined) assistant.reasoning_content = joined;
        }

        if (toolUseBlocks.length > 0) {
            assistant.tool_calls = toolUseBlocks.map((tu) => ({
                id: tu.id,
                type: 'function',
                function: {
                    name: tu.name,
                    arguments: JSON.stringify(tu.input),
                },
            }));
        }

        result.push(assistant);
    }

    return result;
}

function translateTools(
    tools?: AnthropicMessagesBody['tools'],
): Record<string, unknown>[] | undefined {
    if (!tools || tools.length === 0) return undefined;
    return tools.map((t) => ({
        type: 'function',
        function: {
            name: t.name,
            ...(t.description ? { description: t.description } : {}),
            parameters: t.input_schema,
        },
    }));
}

function translateToolChoice(
    choice?: AnthropicToolChoice,
): string | Record<string, unknown> | undefined {
    if (!choice) return undefined;
    switch (choice.type) {
        case 'auto':
            return 'auto';
        case 'any':
            return 'required';
        case 'tool':
            return { type: 'function', function: { name: choice.name } };
    }
}
