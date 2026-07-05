import { extractText, mergeSystemMessages } from './chat.service';
import type { ChatMessage } from './chat.service';

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
