import {
    hashApiKey,
    verifyApiKey,
    PREFIX_LENGTH,
    extractPrefix,
} from './api-key-hash.util';

const PEPPER = 'unit-test-pepper-' + 'a'.repeat(32); // >= 32 chars

describe('api-key hash util', () => {
    describe('hashApiKey + verifyApiKey', () => {
        it('round-trips a plaintext key', () => {
            const hashed = hashApiKey('sk-abc123def456', PEPPER);
            expect(verifyApiKey('sk-abc123def456', hashed, PEPPER)).toBe(true);
        });

        it('rejects a different plaintext', () => {
            const hashed = hashApiKey('sk-abc123def456', PEPPER);
            expect(verifyApiKey('sk-abc123def457', hashed, PEPPER)).toBe(false);
        });

        it('produces a deterministic hash for the same input + pepper (no salt)', () => {
            // HMAC is symmetric and salt-less. The same plaintext +
            // pepper MUST produce the same stored value, or cache
            // lookups by sha256/prefix would miss.
            const a = hashApiKey('sk-abc123def456', PEPPER);
            const b = hashApiKey('sk-abc123def456', PEPPER);
            expect(a).toBe(b);
        });

        it('uses the recognised hmac$ prefix on the stored hash', () => {
            const hashed = hashApiKey('sk-abc123def456', PEPPER);
            expect(hashed.startsWith('hmac$')).toBe(true);
            expect(hashed).toMatch(/^hmac\$[0-9a-f]{64}$/);
        });

        it('rejects an empty plaintext', () => {
            expect(() => hashApiKey('', PEPPER)).toThrow(/plaintext must be non-empty/);
        });

        it('rejects a too-short pepper at hash time', () => {
            expect(() => hashApiKey('sk-x', 'short')).toThrow(/pepper/);
        });

        it('produces different hashes for the same plaintext under different peppers', () => {
            const a = hashApiKey('sk-abc123def456', PEPPER);
            const b = hashApiKey('sk-abc123def456', 'different-pepper-' + 'a'.repeat(32));
            expect(a).not.toBe(b);
            // Each verifies with its own pepper but not the other's.
            expect(verifyApiKey('sk-abc123def456', a, PEPPER)).toBe(true);
            expect(verifyApiKey('sk-abc123def456', a, 'different-pepper-' + 'a'.repeat(32))).toBe(false);
        });

        it('verifyApiKey rejects a malformed stored value', () => {
            expect(verifyApiKey('sk-anything', 'not-a-valid-hash', PEPPER)).toBe(false);
            expect(verifyApiKey('sk-anything', 'hmac$', PEPPER)).toBe(false);
            expect(verifyApiKey('sk-anything', 'hmac$nolyhex', PEPPER)).toBe(false);
        });

        it('verifyApiKey rejects legacy scrypt$ rows (clean break)', () => {
            const stored = 'scrypt$00112233445566778899aabbccddeeff$ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100';
            expect(verifyApiKey('sk-anything', stored, PEPPER)).toBe(false);
        });

        it('verifyApiKey rejects any non-hmac$ format', () => {
            expect(verifyApiKey('sk-anything', 'bcrypt$abc', PEPPER)).toBe(false);
            expect(verifyApiKey('sk-anything', 'argon2$abc', PEPPER)).toBe(false);
            expect(verifyApiKey('sk-anything', '', PEPPER)).toBe(false);
            expect(verifyApiKey('sk-anything', null, PEPPER)).toBe(false);
            expect(verifyApiKey('sk-anything', undefined, PEPPER)).toBe(false);
        });

        it('verifyApiKey rejects a too-short or absent pepper defensively', () => {
            const hashed = hashApiKey('sk-abc', PEPPER);
            expect(verifyApiKey('sk-abc', hashed, '')).toBe(false);
            expect(verifyApiKey('sk-abc', hashed, 'short')).toBe(false);
            // @ts-expect-error: intentionally bad input to probe the defensive branch.
            expect(verifyApiKey('sk-abc', hashed, undefined)).toBe(false);
        });

        it('verifyApiKey is constant-time vs the hex suffix (length-mismatch fast-path)', () => {
            // A shorter expected-length stored value must short-circuit,
            // not fall through to a timing-sensitive compare path.
            const stored = 'hmac$' + 'aa'; // 1 byte hex prefix only
            expect(verifyApiKey('sk-anything', stored, PEPPER)).toBe(false);
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
