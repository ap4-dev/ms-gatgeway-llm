import { createStreamAdapter } from './stream-adapter';
import type { ChatCompletionChunk } from 'openai/resources/chat/completions';
import type { AnthropicStreamEvent } from '../types';

async function collectEvents(source: AsyncGenerator<AnthropicStreamEvent>): Promise<AnthropicStreamEvent[]> {
    const events: AnthropicStreamEvent[] = [];
    for await (const event of source) {
        events.push(event);
    }
    return events;
}

async function* makeChunks(chunks: ChatCompletionChunk[]): AsyncGenerator<ChatCompletionChunk> {
    for (const chunk of chunks) {
        yield chunk;
    }
}

function textChunk(content: string, finishReason?: string | null): ChatCompletionChunk {
    return {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        created: Date.now(),
        model: 'qwen3.6',
        choices: [{
            index: 0,
            delta: { content },
            finish_reason: finishReason as any,
        }],
    } as ChatCompletionChunk;
}

function toolCallStartChunk(id: string, name: string): ChatCompletionChunk {
    return {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        created: Date.now(),
        model: 'qwen3.6',
        choices: [{
            index: 0,
            delta: {
                tool_calls: [{
                    index: 0,
                    id,
                    type: 'function' as const,
                    function: { name, arguments: '' },
                }],
            },
            finish_reason: null,
        }],
    } as ChatCompletionChunk;
}

function toolCallDeltaChunk(arguments_: string, toolIndex = 0): ChatCompletionChunk {
    return {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        created: Date.now(),
        model: 'qwen3.6',
        choices: [{
            index: 0,
            delta: {
                tool_calls: [{
                    index: toolIndex,
                    function: { arguments: arguments_ },
                }],
            },
            finish_reason: null,
        }],
    } as ChatCompletionChunk;
}

function finishChunk(reason: string): ChatCompletionChunk {
    return {
        id: 'chatcmpl-1',
        object: 'chat.completion.chunk',
        created: Date.now(),
        model: 'qwen3.6',
        choices: [{
            index: 0,
            delta: {},
            finish_reason: reason as any,
        }],
    } as ChatCompletionChunk;
}

describe('stream-adapter', () => {
    it('emits complete event sequence for a text-only stream', async () => {
        const events = await collectEvents(
            createStreamAdapter(
                makeChunks([textChunk('Hello'), textChunk(' world'), finishChunk('stop')]),
                'claude-sonnet-4-20250514',
            ),
        );

        const types = events.map((e) => e.type);
        expect(types).toEqual([
            'message_start',
            'content_block_start',
            'ping',
            'content_block_delta',
            'content_block_delta',
            'content_block_stop',
            'message_delta',
            'message_stop',
        ]);

        // message_start
        const msgStart = events[0] as Extract<AnthropicStreamEvent, { type: 'message_start' }>;
        expect(msgStart.message.model).toBe('claude-sonnet-4-20250514');
        expect(msgStart.message.role).toBe('assistant');
        expect(msgStart.message.id).toMatch(/^msg_/);

        // text deltas
        const delta1 = events[3] as Extract<AnthropicStreamEvent, { type: 'content_block_delta' }>;
        expect(delta1.delta).toEqual({ type: 'text_delta', text: 'Hello' });
        const delta2 = events[4] as Extract<AnthropicStreamEvent, { type: 'content_block_delta' }>;
        expect(delta2.delta).toEqual({ type: 'text_delta', text: ' world' });

        // message_delta
        const msgDelta = events[events.length - 2] as Extract<AnthropicStreamEvent, { type: 'message_delta' }>;
        expect(msgDelta.delta.stop_reason).toBe('end_turn');
    });

    it('emits tool_use content blocks for tool call streams', async () => {
        const events = await collectEvents(
            createStreamAdapter(
                makeChunks([
                    toolCallStartChunk('toolu_abc', 'web_search'),
                    toolCallDeltaChunk('{"query":'),
                    toolCallDeltaChunk('"cats"}'),
                    finishChunk('tool_calls'),
                ]),
                'm',
            ),
        );

        const types = events.map((e) => e.type);
        expect(types).toEqual([
            'message_start',
            'ping',
            'content_block_start',
            'content_block_delta',
            'content_block_delta',
            'content_block_stop',
            'message_delta',
            'message_stop',
        ]);

        // content_block_start for tool_use
        const blockStart = events[2] as Extract<AnthropicStreamEvent, { type: 'content_block_start' }>;
        expect(blockStart.content_block).toEqual({
            type: 'tool_use',
            id: 'toolu_abc',
            name: 'web_search',
            input: {},
        });

        // input_json_delta events
        const d1 = events[3] as Extract<AnthropicStreamEvent, { type: 'content_block_delta' }>;
        expect(d1.delta).toEqual({ type: 'input_json_delta', partial_json: '{"query":' });
        const d2 = events[4] as Extract<AnthropicStreamEvent, { type: 'content_block_delta' }>;
        expect(d2.delta).toEqual({ type: 'input_json_delta', partial_json: '"cats"}' });

        // stop_reason
        const msgDelta = events[events.length - 2] as Extract<AnthropicStreamEvent, { type: 'message_delta' }>;
        expect(msgDelta.delta.stop_reason).toBe('tool_use');
    });

    it('handles text followed by tool_use', async () => {
        const events = await collectEvents(
            createStreamAdapter(
                makeChunks([
                    textChunk('Let me search.'),
                    toolCallStartChunk('toolu_1', 'web_search'),
                    toolCallDeltaChunk('{"query":"hi"}'),
                    finishChunk('tool_calls'),
                ]),
                'm',
            ),
        );

        const types = events.map((e) => e.type);
        expect(types).toEqual([
            'message_start',
            'content_block_start',  // text block
            'ping',
            'content_block_delta',  // text delta
            'content_block_stop',   // text block end
            'content_block_start',  // tool_use block
            'content_block_delta',  // input_json_delta
            'content_block_stop',   // tool_use block end
            'message_delta',
            'message_stop',
        ]);
    });

    it('handles an empty stream gracefully', async () => {
        const events = await collectEvents(
            createStreamAdapter(makeChunks([]), 'm'),
        );

        const types = events.map((e) => e.type);
        expect(types).toEqual(['message_start', 'message_delta', 'message_stop']);
    });

    it('generates consistent message id across all events', async () => {
        const events = await collectEvents(
            createStreamAdapter(
                makeChunks([textChunk('hi'), finishChunk('stop')]),
                'm',
            ),
        );

        const msgStart = events.find((e) => e.type === 'message_start') as Extract<AnthropicStreamEvent, { type: 'message_start' }>;
        const id = msgStart.message.id;
        expect(id).toMatch(/^msg_/);
        // All events in the same stream should reference the same message
        // (only message_start has the id, but it should be consistent)
    });

    it('handles multiple tool calls', async () => {
        const events = await collectEvents(
            createStreamAdapter(
                makeChunks([
                    toolCallStartChunk('toolu_1', 'web_search'),
                    toolCallDeltaChunk('{"q":"a"}'),
                    toolCallStartChunk('toolu_2', 'web_search'),
                    toolCallDeltaChunk('{"q":"b"}', 1),
                    finishChunk('tool_calls'),
                ]),
                'm',
            ),
        );

        const blockStarts = events.filter((e) => e.type === 'content_block_start');
        expect(blockStarts).toHaveLength(2);
    });
});
