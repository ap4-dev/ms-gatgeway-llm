import {
    hashApiKey,
    verifyApiKey,
    PREFIX_LENGTH,
    extractPrefix,
} from './api-key-hash.util';

describe('api-key hash util', () => {
    describe('hashApiKey + verifyApiKey', () => {
        it('round-trips a plaintext key', () => {
            const hashed = hashApiKey('sk-abc123def456');
            expect(verifyApiKey('sk-abc123def456', hashed)).toBe(true);
        });

        it('rejects a different plaintext', () => {
            const hashed = hashApiKey('sk-abc123def456');
            expect(verifyApiKey('sk-abc123def457', hashed)).toBe(false);
        });

        it('produces a different hash for the same input each call (salt per hash)', () => {
            const a = hashApiKey('sk-abc123def456');
            const b = hashApiKey('sk-abc123def456');
            expect(a).not.toBe(b);
            // Both verify the same plaintext.
            expect(verifyApiKey('sk-abc123def456', a)).toBe(true);
            expect(verifyApiKey('sk-abc123def456', b)).toBe(true);
        });

        it('uses a recognised prefix on the stored hash', () => {
            const hashed = hashApiKey('sk-abc123def456');
            expect(hashed.startsWith('scrypt$')).toBe(true);
        });

        it('rejects an empty plaintext', () => {
            expect(() => hashApiKey('')).toThrow(/plaintext must be non-empty/);
        });

        it('verifyApiKey rejects a malformed stored value', () => {
            expect(verifyApiKey('sk-anything', 'not-a-valid-hash')).toBe(false);
            expect(verifyApiKey('sk-anything', 'scrypt$')).toBe(false);
            expect(verifyApiKey('sk-anything', 'scrypt$noly')).toBe(false);
        });
    });

    describe('extractPrefix', () => {
        it('returns the first PREFIX_LENGTH chars of the key', () => {
            expect(extractPrefix('sk-abcdefghijkl')).toBe('sk-abcde');
            expect(extractPrefix('abcdef')).toBe('abcdef');
        });

        it('pads with the original string if shorter than PREFIX_LENGTH', () => {
            expect(extractPrefix('abc')).toBe('abc');
        });

        it('exposes PREFIX_LENGTH = 8', () => {
            expect(PREFIX_LENGTH).toBe(8);
        });
    });
});
