import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export const PREFIX_LENGTH = 8;

/**
 * Format produced by `hashApiKey`:
 *
 *     scrypt$<saltHex>$<hashHex>
 *
 * Pre-scrypt is meant to be honest about the algorithm so we can rotate
 * it later without colliding with old hashes. Salt is 16 bytes; hash is
 * 32 bytes (per scryptSync defaults).
 *
 * scrypt parameters: N=16384, r=8, p=1 (the scryptSync defaults; ~10ms per
 * hash on a modern CPU — fine for a single verify-per-request).
 */

const SCRYPT_PARAMS = { keylen: 32 };
const SCRYPT_PREFIX = 'scrypt';

export function hashApiKey(plaintext: string): string {
    if (!plaintext || plaintext.length === 0) {
        throw new Error('api-key hash: plaintext must be non-empty');
    }
    const salt = randomBytes(16);
    const derived = scryptSync(plaintext, salt, SCRYPT_PARAMS.keylen);
    return [
        SCRYPT_PREFIX,
        salt.toString('hex'),
        derived.toString('hex'),
    ].join('$');
}

export function verifyApiKey(plaintext: string, stored: string | null | undefined): boolean {
    if (!plaintext || !stored) return false;
    const parts = stored.split('$');
    if (parts.length !== 3) return false;
    const [algo, saltHex, hashHex] = parts;
    if (algo !== SCRYPT_PREFIX) return false;
    if (!saltHex || !hashHex) return false;
    let salt: Buffer;
    let expected: Buffer;
    try {
        salt = Buffer.from(saltHex, 'hex');
        expected = Buffer.from(hashHex, 'hex');
    } catch {
        return false;
    }
    if (expected.length === 0) return false;
    const derived = scryptSync(plaintext, salt, expected.length);
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
