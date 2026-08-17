import { translateResponse } from './response-adapter';
import type { ChatCompletion } from 'openai/resources/chat/completions';

function makeCompletion(overrides: Partial<ChatCompletion> = {}): ChatCompletion {
    return {
        id: 'chatcmpl-abc123',
        object: 'chat.completion',
        created: Date.now(),
        model: 'qwen3.6',
        choices: [{
            index: 0,
            message: { role: 'assistant', content: 'Hello!', refusal: null },
            finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        ...overrides,
    } as ChatCompletion;
}

describe('response-adapter', () => {
    describe('translateResponse', () => {
        it('translates a text-only response', () => {
            const result = translateResponse(makeCompletion(), 'claude-sonnet-4-20250514');

            expect(result.type).toBe('message');
            expect(result.role).toBe('assistant');
            expect(result.model).toBe('claude-sonnet-4-20250514');
            expect(result.content).toEqual([{ type: 'text', text: 'Hello!' }]);
            expect(result.stop_reason).toBe('end_turn');
            expect(result.stop_sequence).toBeNull();
            expect(result.usage).toEqual({ input_tokens: 10, output_tokens: 5 });
            expect(result.id).toMatch(/^msg_/);
        });

        it('maps finish_reason: stop → end_turn', () => {
            const result = translateResponse(
                makeCompletion({ choices: [{ index: 0, message: { role: 'assistant', content: 'x', refusal: null }, finish_reason: 'stop' }] } as any),
                'm',
            );
            expect(result.stop_reason).toBe('end_turn');
        });

        it('maps finish_reason: length → max_tokens', () => {
            const result = translateResponse(
                makeCompletion({ choices: [{ index: 0, message: { role: 'assistant', content: 'x', refusal: null }, finish_reason: 'length' }] } as any),
                'm',
            );
            expect(result.stop_reason).toBe('max_tokens');
        });

        it('maps finish_reason: tool_calls → tool_use', () => {
            const result = translateResponse(
                makeCompletion({
                    choices: [{
                        index: 0,
                        message: {
                            role: 'assistant',
                            content: null,
                            refusal: null,
                            tool_calls: [{
                                id: 'call_abc',
                                type: 'function',
                                function: { name: 'web_search', arguments: '{"query":"cats"}' },
                            }],
                        },
                        finish_reason: 'tool_calls',
                    }],
                } as any),
                'm',
            );

            expect(result.stop_reason).toBe('tool_use');
            expect(result.content).toEqual([
                { type: 'tool_use', id: 'call_abc', name: 'web_search', input: { query: 'cats' } },
            ]);
        });

        it('translates tool_calls to tool_use content blocks', () => {
            const result = translateResponse(
                makeCompletion({
                    choices: [{
                        index: 0,
                        message: {
                            role: 'assistant',
                            content: 'Let me search.',
                            refusal: null,
                            tool_calls: [{
                                id: 'call_123',
                                type: 'function',
                                function: { name: 'web_search', arguments: '{"query":"dogs"}' },
                            }],
                        },
                        finish_reason: 'tool_calls',
                    }],
                } as any),
                'm',
            );

            expect(result.content).toHaveLength(2);
            expect(result.content[0]).toEqual({ type: 'text', text: 'Let me search.' });
            expect(result.content[1]).toEqual({
                type: 'tool_use',
                id: 'call_123',
                name: 'web_search',
                input: { query: 'dogs' },
            });
        });

        it('handles malformed tool_call arguments gracefully', () => {
            const result = translateResponse(
                makeCompletion({
                    choices: [{
                        index: 0,
                        message: {
                            role: 'assistant',
                            content: null,
                            refusal: null,
                            tool_calls: [{
                                id: 'call_bad',
                                type: 'function',
                                function: { name: 'test', arguments: 'not-json' },
                            }],
                        },
                        finish_reason: 'tool_calls',
                    }],
                } as any),
                'm',
            );

            expect((result.content[0] as any).input).toEqual({});
        });

        it('surfaces reasoning_content as a thinking block before text', () => {
            const result = translateResponse(
                makeCompletion({
                    choices: [{
                        index: 0,
                        message: {
                            role: 'assistant',
                            content: 'ok',
                            refusal: null,
                            reasoning_content: 'We need answer only ok.',
                        },
                        finish_reason: 'stop',
                    }],
                } as any),
                'm',
            );

            expect(result.content).toEqual([
                { type: 'thinking', thinking: 'We need answer only ok.', signature: '' },
                { type: 'text', text: 'ok' },
            ]);
        });

        it('omits thinking block when reasoning_content is absent or empty', () => {
            const plain = translateResponse(makeCompletion(), 'm');
            expect(plain.content).toEqual([{ type: 'text', text: 'Hello!' }]);

            const empty = translateResponse(
                makeCompletion({
                    choices: [{
                        index: 0,
                        message: { role: 'assistant', content: 'hi', refusal: null, reasoning_content: '' },
                        finish_reason: 'stop',
                    }],
                } as any),
                'm',
            );
            expect(empty.content).toEqual([{ type: 'text', text: 'hi' }]);
        });
    });
});
