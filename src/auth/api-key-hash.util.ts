import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const PREFIX_LENGTH = 8;

/**
 * Format produced by `hashApiKey`:
 *
 *     hmac$<hex of HMAC-SHA256(pepper, plaintext)>
 *
 * Why HMAC instead of scrypt:
 *   - Keys are 256-bit random (`sk-` + 64 hex), so scrypt's slow KDF buys
 *     no brute-force resistance beyond what the entropy already provides.
 *   - HMAC-SHA256 takes ~1 µs. scrypt at default params (~10 ms) blocked
 *     the event loop on every authenticated request.
 *   - The pepper is a server-side secret loaded from env. It is NOT in
 *     the database — so a leaked DB alone is not enough to forge a
 *     verification.
 *
 * Legacy `scrypt$…` rows are rejected outright (returns false). Operators
 * must re-hash existing keys via the CLI: `pnpm admin:reset -- --plain …`.
 */

const HMAC_PREFIX = 'hmac';

function assertPepper(pepper: string): void {
    if (!pepper || pepper.length < 32) {
        throw new Error('api-key hash: pepper must be non-empty (>=32 chars)');
    }
}

export function hashApiKey(plaintext: string, pepper: string): string {
    if (!plaintext || plaintext.length === 0) {
        throw new Error('api-key hash: plaintext must be non-empty');
    }
    assertPepper(pepper);
    const digest = createHmac('sha256', pepper)
        .update(plaintext)
        .digest();
    return [HMAC_PREFIX, digest.toString('hex')].join('$');
}

export function verifyApiKey(
    plaintext: string,
    stored: string | null | undefined,
    pepper: string,
): boolean {
    if (!plaintext || !stored) return false;
    if (typeof pepper !== 'string' || pepper.length < 32) {
        // Defensive: refuse to run with no/short pepper rather than
        // silently falling through to a comparison against nothing.
        return false;
    }
    const parts = stored.split('$');
    if (parts.length !== 2) return false;
    const [algo, hashHex] = parts;
    if (algo !== HMAC_PREFIX) return false; // Rejects legacy `scrypt$…` rows.
    if (!hashHex) return false;
    let expected: Buffer;
    try {
        expected = Buffer.from(hashHex, 'hex');
    } catch {
        return false;
    }
    if (expected.length === 0) return false;
    const derived = createHmac('sha256', pepper).update(plaintext).digest();
    if (derived.length !== expected.length) return false;
    return timingSafeEqual(derived, expected);
}

/**
 * Public, non-secret prefix of a key. Logged alongside requests so
 * operators can correlate a row to the issuing client without the
 * secret ever touching the disk or the log pipeline.
 */
export function extractPrefix(key: string): string {
    if (key.length <= PREFIX_LENGTH) return key;
    return key.slice(0, PREFIX_LENGTH);
}

/**
 * Generate a fresh client API key. 32 random bytes hex-encoded with a
 * recognisable prefix so it stands out in support tickets. The full
 * plaintext is returned so the operator can hand it to the client; it
 * is *not* persisted.
 */
export function generateApiKey(): string {
    return 'sk-' + randomBytes(32).toString('hex');
}
