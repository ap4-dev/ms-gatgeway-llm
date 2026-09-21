import {
    MAX_TOKENS_CEILING,
    REQUEST_PARAMS_SNIPPET_CHARS,
    clampMaxTokens,
    extractText,
    mergeSystemMessages,
    serializeRequestParams,
} from './chat.service';
import type { ChatMessage } from './chat.service';

describe('clampMaxTokens', () => {
    it('leaves requests without max_tokens untouched', () => {
        const body = { model: 'qwen3.6', messages: [] };
        expect(clampMaxTokens(body)).toBe(body);
    });

    it('leaves max_tokens within the accepted range untouched', () => {
        const body = { model: 'qwen3.6', max_tokens: 4096 };
        expect(clampMaxTokens(body)).toBe(body);
    });

    it('leaves max_tokens exactly at the ceiling untouched', () => {
        const body = { model: 'qwen3.6', max_tokens: MAX_TOKENS_CEILING };
        expect(clampMaxTokens(body)).toBe(body);
    });

    it('clamps caller-supplied max_tokens above the upstream ceiling', () => {
        // nan rejects with: "Range of max_tokens should be [1, 131072]".
        const body = { model: 'qwen3.6', max_tokens: 200_000 };
        expect(clampMaxTokens(body).max_tokens).toBe(MAX_TOKENS_CEILING);
    });

    it('does not mutate the input body', () => {
        const body = { model: 'qwen3.6', max_tokens: 500_000 };
        const clamped = clampMaxTokens(body);
        expect(body.max_tokens).toBe(500_000);
        expect(clampMaxTokens(body)).not.toBe(body);
    });

    it('ignores non-numeric max_tokens values', () => {
        const body = { model: 'qwen3.6', max_tokens: 'lots' };
        expect(clampMaxTokens(body as any)).toBe(body);
    });
});

describe('mergeSystemMessages', () => {
    it('returns the input untouched when it is not an array', () => {
        expect(mergeSystemMessages(undefined as unknown as ChatMessage[])).toBeUndefined();
        expect(mergeSystemMessages(null as unknown as ChatMessage[])).toBeNull();
    });

    it('returns an empty array untouched', () => {
        expect(mergeSystemMessages([])).toEqual([]);
    });

    it('returns input unchanged when there are no system messages', () => {
        const messages: ChatMessage[] = [
            { role: 'user', content: 'hello' },
            { role: 'assistant', content: 'hi' },
        ];
        expect(mergeSystemMessages(messages)).toBe(messages);
    });

    it('returns single system message unchanged', () => {
        const messages: ChatMessage[] = [
            { role: 'system', content: 'be nice' },
            { role: 'user', content: 'hi' },
        ];
        const result = mergeSystemMessages(messages);
        expect(result).toHaveLength(2);
        expect(result[0]).toEqual({ role: 'system', content: 'be nice' });
        expect(result[1]).toEqual({ role: 'user', content: 'hi' });
    });

    it('merges consecutive leading system messages into one', () => {
        const messages: ChatMessage[] = [
            { role: 'system', content: 'be nice' },
            { role: 'system', content: 'be concise' },
            { role: 'user', content: 'hi' },
        ];
        const result = mergeSystemMessages(messages);
        expect(result).toHaveLength(2);
        expect(result[0].role).toBe('system');
        expect(result[0].content).toBe('be nice\n\nbe concise');
        expect(result[1]).toEqual({ role: 'user', content: 'hi' });
    });

    it('merges every system message into a single leading one', () => {
        // The implementation collapses ALL system messages regardless of
        // whether they were consecutive in the input. Non-system messages keep
        // their order; systems are hoisted to the front.
        const messages: ChatMessage[] = [
            { role: 'system', content: 'first' },
            { role: 'system', content: 'second' },
            { role: 'user', content: 'hi' },
            { role: 'system', content: 'third' },
            { role: 'assistant', content: 'reply' },
        ];
        const result = mergeSystemMessages(messages);
        expect(result).toHaveLength(3);
        expect(result[0].role).toBe('system');
        expect(result[0].content).toBe('first\n\nsecond\n\nthird');
        expect(result[1]).toEqual({ role: 'user', content: 'hi' });
        expect(result[2]).toEqual({ role: 'assistant', content: 'reply' });
    });

    it('preserves the order of non-system messages', () => {
        const messages: ChatMessage[] = [
            { role: 'system', content: 'sys' },
            { role: 'user', content: 'a' },
            { role: 'assistant', content: 'b' },
            { role: 'user', content: 'c' },
        ];
        const result = mergeSystemMessages(messages);
        expect(result.map((m) => m.content)).toEqual(['sys', 'a', 'b', 'c']);
    });

    it('keeps other metadata (name) from the first system message', () => {
        const messages: ChatMessage[] = [
            { role: 'system', content: 'first', name: 'instructions' },
            { role: 'system', content: 'second' },
        ];
        const result = mergeSystemMessages(messages);
        expect(result[0].name).toBe('instructions');
        expect(result[0].content).toBe('first\n\nsecond');
    });

    it('extracts text from array content (e.g. multimodal parts)', () => {
        // Within a single message, parts are concatenated without a separator
        // (extractText.join("")). Across messages they are joined with "\n\n".
        const messages: ChatMessage[] = [
            { role: 'system', content: [{ type: 'text', text: 'sys a' }] },
            {
                role: 'system',
                content: [{ type: 'text', text: 'sys b' }, { type: 'text', text: 'sys c' }],
            },
        ];
        const result = mergeSystemMessages(messages);
        expect(result[0].content).toBe('sys a\n\nsys bsys c');
    });

    it('skips empty system messages when merging', () => {
        const messages: ChatMessage[] = [
            { role: 'system', content: '' },
            { role: 'system', content: 'real' },
            { role: 'system', content: '' },
        ];
        const result = mergeSystemMessages(messages);
        expect(result[0].content).toBe('real');
    });

    it('falls back to the first system content if all systems are empty', () => {
        const messages: ChatMessage[] = [
            { role: 'system', content: '' },
            { role: 'system', content: '' },
        ];
        const result = mergeSystemMessages(messages);
        expect(result).toHaveLength(1);
        expect(result[0].content).toBe('');
    });
});

describe('extractText', () => {
    it('returns string content unchanged', () => {
        expect(extractText('hello')).toBe('hello');
    });

    it('joins an array of plain strings', () => {
        expect(extractText(['a', 'b', 'c'])).toBe('abc');
    });

    it('extracts `text` from object parts', () => {
        expect(extractText([{ text: 'a' }, { text: 'b' }])).toBe('ab');
    });

    it('coerces missing/null text to empty string', () => {
        expect(extractText([{ text: null }, { text: undefined }])).toBe('');
    });

    it('returns empty string for non-string, non-array content', () => {
        expect(extractText(42 as unknown as string)).toBe('');
        expect(extractText(null as unknown as string)).toBe('');
        expect(extractText({} as unknown as string)).toBe('');
    });
});

describe('serializeRequestParams', () => {
    it('excludes messages from the serialized params', () => {
        const out = serializeRequestParams({
            model: 'fast',
            messages: [{ role: 'user', content: 'hello' }],
        });
        expect(out).not.toBeNull();
        const parsed = JSON.parse(out as string);
        expect(parsed.messages).toBeUndefined();
        expect(parsed.model).toBe('fast');
    });

    it('includes scalar request params', () => {
        const out = serializeRequestParams({
            model: 'fast',
            max_tokens: 512,
            temperature: 0.2,
            stream: true,
            messages: [{ role: 'user', content: 'hi' }],
        });
        const parsed = JSON.parse(out as string);
        expect(parsed).toMatchObject({
            model: 'fast',
            max_tokens: 512,
            temperature: 0.2,
            stream: true,
        });
    });

    it('truncates a long first user message at the snippet cap with an ellipsis', () => {
        const long = 'x'.repeat(REQUEST_PARAMS_SNIPPET_CHARS + 50);
        const out = serializeRequestParams({
            model: 'fast',
            messages: [{ role: 'user', content: long }],
        });
        const parsed = JSON.parse(out as string);
        expect(parsed.first_user_message).toHaveLength(
            REQUEST_PARAMS_SNIPPET_CHARS + 1,
        );
        expect(parsed.first_user_message.endsWith('\u2026')).toBe(true);
        expect(
            parsed.first_user_message.startsWith(
                'x'.repeat(REQUEST_PARAMS_SNIPPET_CHARS),
            ),
        ).toBe(true);
    });

    it('does not add an ellipsis when the first user message fits', () => {
        const out = serializeRequestParams({
            model: 'fast',
            messages: [{ role: 'user', content: 'short' }],
        });
        expect(JSON.parse(out as string).first_user_message).toBe('short');
    });

    it('extracts text from array-content user messages via extractText', () => {
        const out = serializeRequestParams({
            model: 'fast',
            messages: [
                { role: 'system', content: 'sys' },
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: 'part-a' },
                        { type: 'text', text: 'part-b' },
                    ],
                },
            ],
        });
        expect(JSON.parse(out as string).first_user_message).toBe('part-apart-b');
    });

    it('returns null for null or undefined bodies', () => {
        expect(serializeRequestParams(null)).toBeNull();
        expect(serializeRequestParams(undefined)).toBeNull();
    });

    it('includes first_user_message when the body has only messages', () => {
        const out = serializeRequestParams({
            messages: [{ role: 'user', content: 'only message' }],
        });
        expect(out).not.toBeNull();
        const parsed = JSON.parse(out as string);
        expect(parsed.first_user_message).toBe('only message');
        expect(parsed.messages).toBeUndefined();
    });

    it('drops first_user_message and re-serializes when the JSON exceeds the cap', () => {
        // 3000 chars of metadata blow past the 2048-char cap; dropping the
        // 200-char snippet brings the row back under it.
        const out = serializeRequestParams({
            model: 'fast',
            max_tokens: 512,
            metadata: { note: 'z'.repeat(2000) },
            messages: [{ role: 'user', content: 'short' }],
        });
        const parsed = JSON.parse(out as string);
        expect(parsed.first_user_message).toBeUndefined();
        expect(parsed.max_tokens).toBe(512);
    });

    it('falls back to the core scalars when even the trimmed JSON exceeds the cap', () => {
        const out = serializeRequestParams({
            model: 'fast',
            max_tokens: 4096,
            temperature: 0.5,
            stream: true,
            metadata: { note: 'z'.repeat(3000) },
            messages: [{ role: 'user', content: 'short' }],
        });
        expect(JSON.parse(out as string)).toEqual({
            model: 'fast',
            max_tokens: 4096,
            temperature: 0.5,
            stream: true,
        });
    });

    it('returns null when the oversized body has no core scalar params', () => {
        const out = serializeRequestParams({
            metadata: { note: 'z'.repeat(3000) },
            messages: [{ role: 'user', content: 'short' }],
        });
        expect(out).toBeNull();
    });

    it('never throws on non-serializable bodies and returns null', () => {
        expect(() => serializeRequestParams(() => undefined)).not.toThrow();
        expect(serializeRequestParams(() => undefined)).toBeNull();

        const circular: Record<string, unknown> = { model: 'fast' };
        circular.self = circular;
        expect(() => serializeRequestParams(circular)).not.toThrow();
        expect(serializeRequestParams(circular)).toBeNull();
    });
});
