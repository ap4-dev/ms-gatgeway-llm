import { hashPrompt, type PromptMessage } from './prompt-hash.util';

const MSG = (overrides: Partial<PromptMessage>): PromptMessage => ({
    role: 'user',
    content: 'hi',
    ...overrides,
});

describe('hashPrompt', () => {
    it('returns a 16-char hex string', () => {
        const h = hashPrompt([MSG({ content: 'hello' })], 'fast');
        expect(h).toMatch(/^[0-9a-f]{16}$/);
    });

    it('is deterministic for the same inputs', () => {
        const a = hashPrompt([MSG({ content: 'hola' })], 'fast');
        const b = hashPrompt([MSG({ content: 'hola' })], 'fast');
        expect(a).toBe(b);
    });

    it('changes when the user content changes', () => {
        const a = hashPrompt([MSG({ content: 'hola' })], 'fast');
        const b = hashPrompt([MSG({ content: 'chau' })], 'fast');
        expect(a).not.toBe(b);
    });

    it('changes when the model changes', () => {
        const a = hashPrompt([MSG({ content: 'hola' })], 'fast');
        const b = hashPrompt([MSG({ content: 'hola' })], 'coder');
        expect(a).not.toBe(b);
    });

    it('treats whitespace-only differences as identical', () => {
        const a = hashPrompt([MSG({ content: 'hola   mundo' })], 'fast');
        const b = hashPrompt([MSG({ content: 'hola mundo' })], 'fast');
        expect(a).toBe(b);
    });

    it('is case-insensitive on the message content', () => {
        const a = hashPrompt([MSG({ content: 'HOLA' })], 'fast');
        const b = hashPrompt([MSG({ content: 'hola' })], 'fast');
        expect(a).toBe(b);
    });

    it('extracts text from array content (multimodal-style)', () => {
        const a = hashPrompt(
            [MSG({ content: [{ type: 'text', text: 'hola' }, { type: 'text', text: 'mundo' }] })],
            'fast',
        );
        const b = hashPrompt([MSG({ content: 'holamundo' })], 'fast');
        expect(a).toBe(b);
    });

    it('orders are preserved — different role orders produce different hashes', () => {
        const a = hashPrompt(
            [MSG({ role: 'system', content: 's' }), MSG({ role: 'user', content: 'u' })],
            'fast',
        );
        const b = hashPrompt(
            [MSG({ role: 'user', content: 's' }), MSG({ role: 'system', content: 'u' })],
            'fast',
        );
        expect(a).not.toBe(b);
    });

    it('returns a stable hash for an empty message list', () => {
        const h = hashPrompt([], 'fast');
        expect(h).toMatch(/^[0-9a-f]{16}$/);
        expect(hashPrompt([], 'fast')).toBe(h);
    });
});
