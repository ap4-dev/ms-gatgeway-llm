import { translateRequest } from './request-adapter';

describe('request-adapter', () => {
    describe('translateRequest', () => {
        it('translates a basic text-only request', () => {
            const result = translateRequest({
                model: 'claude-sonnet-4-20250514',
                max_tokens: 1024,
                messages: [{ role: 'user', content: 'hello' }],
            });

            expect(result.model).toBe('claude-sonnet-4-20250514');
            expect(result.max_tokens).toBe(1024);
            expect(result.messages).toEqual([{ role: 'user', content: 'hello' }]);
        });

        it('converts system string to system message', () => {
            const result = translateRequest({
                model: 'claude-sonnet-4-20250514',
                max_tokens: 1024,
                system: 'You are helpful',
                messages: [{ role: 'user', content: 'hello' }],
            });

            expect(result.messages[0]).toEqual({ role: 'system', content: 'You are helpful' });
            expect(result.messages[1]).toEqual({ role: 'user', content: 'hello' });
        });

        it('converts system blocks to system message', () => {
            const result = translateRequest({
                model: 'claude-sonnet-4-20250514',
                max_tokens: 1024,
                system: [
                    { type: 'text', text: 'Part 1' },
                    { type: 'text', text: 'Part 2' },
                ],
                messages: [{ role: 'user', content: 'hello' }],
            });

            expect(result.messages[0]).toEqual({ role: 'system', content: 'Part 1\n\nPart 2' });
        });

        it('splits tool_result blocks into separate tool messages', () => {
            const result = translateRequest({
                model: 'claude-sonnet-4-20250514',
                max_tokens: 1024,
                messages: [
                    { role: 'user', content: 'search for cats' },
                    {
                        role: 'assistant',
                        content: [
                            { type: 'text', text: 'Let me search.' },
                            { type: 'tool_use', id: 'toolu_123', name: 'web_search', input: { query: 'cats' } },
                        ],
                    },
                    {
                        role: 'user',
                        content: [
                            { type: 'tool_result', tool_use_id: 'toolu_123', content: 'cats are cute' },
                        ],
                    },
                ],
            });

            // user message, assistant with tool_calls, tool message
            const msgs = result.messages;
            expect(msgs[0]).toEqual({ role: 'user', content: 'search for cats' });
            expect(msgs[1]).toMatchObject({
                role: 'assistant',
                content: 'Let me search.',
                tool_calls: [{ id: 'toolu_123', type: 'function', function: { name: 'web_search' } }],
            });
            expect(msgs[2]).toEqual({ role: 'tool', tool_call_id: 'toolu_123', content: 'cats are cute' });
        });

        it('translates tools with input_schema to parameters', () => {
            const result = translateRequest({
                model: 'claude-sonnet-4-20250514',
                max_tokens: 1024,
                messages: [{ role: 'user', content: 'hello' }],
                tools: [{
                    name: 'web_search',
                    description: 'Search the web',
                    input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
                }],
            });

            expect(result.tools).toEqual([{
                type: 'function',
                function: {
                    name: 'web_search',
                    description: 'Search the web',
                    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
                },
            }]);
        });

        it('maps tool_choice types', () => {
            expect(translateRequest({
                model: 'm', max_tokens: 100,
                messages: [{ role: 'user', content: 'hi' }],
                tool_choice: { type: 'auto' },
            }).tool_choice).toBe('auto');

            expect(translateRequest({
                model: 'm', max_tokens: 100,
                messages: [{ role: 'user', content: 'hi' }],
                tool_choice: { type: 'any' },
            }).tool_choice).toBe('required');

            expect(translateRequest({
                model: 'm', max_tokens: 100,
                messages: [{ role: 'user', content: 'hi' }],
                tool_choice: { type: 'tool', name: 'web_search' },
            }).tool_choice).toEqual({ type: 'function', function: { name: 'web_search' } });
        });

        it('maps stop_sequences to stop', () => {
            const result = translateRequest({
                model: 'm', max_tokens: 100,
                messages: [{ role: 'user', content: 'hi' }],
                stop_sequences: ['END', 'STOP'],
            });

            expect(result.stop).toEqual(['END', 'STOP']);
        });

        it('maps metadata.user_id to user', () => {
            const result = translateRequest({
                model: 'm', max_tokens: 100,
                messages: [{ role: 'user', content: 'hi' }],
                metadata: { user_id: 'u123' },
            });

            expect((result as any).user).toBe('u123');
        });

        it('forwards thinking config verbatim', () => {
            const result = translateRequest({
                model: 'm', max_tokens: 100,
                messages: [{ role: 'user', content: 'hi' }],
                thinking: { type: 'enabled', budget_tokens: 2048 },
            });

            expect((result as any).thinking).toEqual({ type: 'enabled', budget_tokens: 2048 });
        });

        it('maps adaptive thinking to enabled (Claude 4.6+ style)', () => {
            const result = translateRequest({
                model: 'm', max_tokens: 100,
                messages: [{ role: 'user', content: 'hi' }],
                thinking: { type: 'adaptive' },
            });

            expect((result as any).thinking).toEqual({ type: 'enabled' });
        });

        it('forwards disabled thinking verbatim', () => {
            const result = translateRequest({
                model: 'm', max_tokens: 100,
                messages: [{ role: 'user', content: 'hi' }],
                thinking: { type: 'disabled' },
            });

            expect((result as any).thinking).toEqual({ type: 'disabled' });
        });

        it('drops unknown thinking types instead of forwarding', () => {
            const result = translateRequest({
                model: 'm', max_tokens: 100,
                messages: [{ role: 'user', content: 'hi' }],
                thinking: { type: 'auto' },
            });

            expect((result as any).thinking).toBeUndefined();
        });

        it('echoes assistant thinking blocks as reasoning_content', () => {
            const result = translateRequest({
                model: 'm', max_tokens: 100,
                messages: [
                    { role: 'user', content: '1+1?' },
                    {
                        role: 'assistant',
                        content: [
                            { type: 'thinking', thinking: 'suma simple', signature: 'sig_1' },
                            { type: 'text', text: '2' },
                        ],
                    },
                ],
            });

            const assistant = result.messages[1] as any;
            expect(assistant.role).toBe('assistant');
            expect(assistant.content).toBe('2');
            expect(assistant.reasoning_content).toBe('suma simple');
        });

        it('skips empty thinking blocks when echoing', () => {
            const result = translateRequest({
                model: 'm', max_tokens: 100,
                messages: [
                    { role: 'user', content: 'hi' },
                    { role: 'assistant', content: [{ type: 'thinking', thinking: '' }] },
                ],
            });

            const assistant = result.messages[1] as any;
            expect(assistant.reasoning_content).toBeUndefined();
        });
    });
});
