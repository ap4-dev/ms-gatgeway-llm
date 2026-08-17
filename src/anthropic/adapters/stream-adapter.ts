import type { ChatCompletionChunk } from 'openai/resources/chat/completions';
import type { AnthropicStreamEvent, AnthropicResponseBlock } from '../types';

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

function generateMessageId(): string {
    let id = 'msg_';
    for (let i = 0; i < 24; i++) {
        id += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    }
    return id;
}

type StreamState = 'WAITING' | 'IN_TEXT' | 'IN_TOOL_USE' | 'CLOSED';

interface ToolCallAccumulator {
    id: string;
    name: string;
    arguments: string;
}

export function createStreamAdapter(
    source: AsyncIterable<ChatCompletionChunk>,
    requestedModel: string,
): AsyncGenerator<AnthropicStreamEvent> {
    const msgId = generateMessageId();
    let state: StreamState = 'WAITING';
    let blockIndex = 0;
    let currentToolIndex = -1;
    const toolCalls: Map<number, ToolCallAccumulator> = new Map();
    let outputTokens = 0;
    let pingSent = false;

    function emitMessageStart(): AnthropicStreamEvent {
        return {
            type: 'message_start',
            message: {
                id: msgId,
                type: 'message',
                role: 'assistant',
                content: [],
                model: requestedModel,
                stop_reason: null,
                stop_sequence: null,
                usage: { input_tokens: 0, output_tokens: 0 },
            },
        };
    }

    function emitContentBlockStart(idx: number, block: AnthropicResponseBlock): AnthropicStreamEvent {
        return { type: 'content_block_start', index: idx, content_block: block };
    }

    function* processChunk(chunk: ChatCompletionChunk): Generator<AnthropicStreamEvent> {
        const usage = chunk.usage;
        if (usage?.completion_tokens) {
            outputTokens = usage.completion_tokens;
        }

        const choice = chunk.choices?.[0];
        if (!choice) return;

        const delta = choice.delta;
        const finishReason = choice.finish_reason;

        // Text content
        if (typeof delta?.content === 'string' && delta.content.length > 0) {
            if (state === 'WAITING') {
                yield emitMessageStart();
                yield emitContentBlockStart(blockIndex, { type: 'text', text: '' });
                if (!pingSent) {
                    yield { type: 'ping' };
                    pingSent = true;
                }
                state = 'IN_TEXT';
            }
            if (state === 'IN_TEXT') {
                yield {
                    type: 'content_block_delta',
                    index: blockIndex,
                    delta: { type: 'text_delta', text: delta.content },
                };
            }
        }

        // Tool calls
        if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
                const tcIdx = tc.index ?? 0;

                if (state === 'WAITING') {
                    yield emitMessageStart();
                    if (!pingSent) {
                        yield { type: 'ping' };
                        pingSent = true;
                    }
                    state = 'IN_TOOL_USE';
                    currentToolIndex = tcIdx;
                    toolCalls.set(tcIdx, {
                        id: tc.id ?? `toolu_${Date.now()}`,
                        name: tc.function?.name ?? '',
                        arguments: '',
                    });
                    yield emitContentBlockStart(blockIndex, {
                        type: 'tool_use',
                        id: toolCalls.get(tcIdx)!.id,
                        name: toolCalls.get(tcIdx)!.name,
                        input: {},
                    });
                } else if (state === 'IN_TEXT') {
                    yield { type: 'content_block_stop', index: blockIndex };
                    blockIndex++;
                    state = 'IN_TOOL_USE';
                    currentToolIndex = tcIdx;
                    toolCalls.set(tcIdx, {
                        id: tc.id ?? `toolu_${Date.now()}`,
                        name: tc.function?.name ?? '',
                        arguments: '',
                    });
                    yield emitContentBlockStart(blockIndex, {
                        type: 'tool_use',
                        id: toolCalls.get(tcIdx)!.id,
                        name: toolCalls.get(tcIdx)!.name,
                        input: {},
                    });
                } else if (state === 'IN_TOOL_USE' && tcIdx !== currentToolIndex) {
                    yield { type: 'content_block_stop', index: blockIndex };
                    blockIndex++;
                    currentToolIndex = tcIdx;
                    toolCalls.set(tcIdx, {
                        id: tc.id ?? `toolu_${Date.now()}`,
                        name: tc.function?.name ?? '',
                        arguments: '',
                    });
                    yield emitContentBlockStart(blockIndex, {
                        type: 'tool_use',
                        id: toolCalls.get(tcIdx)!.id,
                        name: toolCalls.get(tcIdx)!.name,
                        input: {},
                    });
                }

                // Accumulate arguments
                const existing = toolCalls.get(tcIdx);
                if (existing && tc.function?.arguments) {
                    existing.arguments += tc.function.arguments;
                    if (tc.id && !existing.id.startsWith('toolu_')) {
                        existing.id = tc.id;
                    }
                    if (tc.function?.name && !existing.name) {
                        existing.name = tc.function.name;
                    }
                    yield {
                        type: 'content_block_delta',
                        index: blockIndex,
                        delta: { type: 'input_json_delta', partial_json: tc.function.arguments },
                    };
                }
            }
        }

        // Finish
        if (finishReason) {
            if (state !== 'CLOSED') {
                if (state === 'WAITING') {
                    yield emitMessageStart();
                    if (!pingSent) {
                        yield { type: 'ping' };
                        pingSent = true;
                    }
                } else {
                    yield { type: 'content_block_stop', index: blockIndex };
                }

                const stopReason = mapFinishReason(finishReason);
                yield {
                    type: 'message_delta',
                    delta: { stop_reason: stopReason, stop_sequence: null },
                    usage: { output_tokens: outputTokens || estimateTokens(chunk) },
                };
                yield { type: 'message_stop' };
                state = 'CLOSED';
            }
        }
    }

    return (async function* () {
        for await (const chunk of source) {
            yield* processChunk(chunk);
        }
        const finalState = state as string;
        if (finalState !== 'CLOSED') {
            if (finalState === 'WAITING') {
                yield emitMessageStart();
            }
            if (finalState === 'IN_TEXT' || finalState === 'IN_TOOL_USE') {
                yield { type: 'content_block_stop' as const, index: blockIndex };
            }
            yield {
                type: 'message_delta' as const,
                delta: { stop_reason: 'end_turn' as const, stop_sequence: null },
                usage: { output_tokens: outputTokens },
            };
            yield { type: 'message_stop' as const };
        }
    })();
}

function mapFinishReason(
    reason: string,
): 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use' {
    switch (reason) {
        case 'stop':
            return 'end_turn';
        case 'length':
            return 'max_tokens';
        case 'tool_calls':
            return 'tool_use';
        default:
            return 'end_turn';
    }
}

function estimateTokens(_chunk: ChatCompletionChunk): number {
    return 0;
}
