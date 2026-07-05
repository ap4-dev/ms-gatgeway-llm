import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * Build a CORS origin handler from a comma-separated allowlist string.
 *
 * Behavior:
 *   - When `allow` is "*" the handler accepts every origin (useful for dev).
 *   - When `allow` is undefined/empty the handler rejects all browser origins
 *     in production (NODE_ENV=production) and allows all in non-production
 *     so local curl/server-to-server traffic is not blocked.
 *   - Otherwise the origin must match one of the comma-separated entries
 *     exactly. Whitespace around entries is trimmed.
 *
 * Token-less requests (no Origin header — curl, server-to-server, same-origin)
 * are always accepted, matching the prior implementation's semantics.
 */
export function buildCorsHandler(allow: string | undefined) {
    const allowlist = (allow ?? '')
        .split(',')
        .map((o) => o.trim())
        .filter((o) => o.length > 0);

    const isWildcard = allowlist.length === 1 && allowlist[0] === '*';
    const isProduction = process.env.NODE_ENV === 'production';

    return (
        origin: string | undefined,
        callback: (err: Error | null, allow?: boolean) => void,
    ) => {
        // Same-origin / curl / server-to-server: no Origin header to check.
        if (!origin) return callback(null, true);

        if (isWildcard) return callback(null, true);

        if (allowlist.length === 0) {
            // No allowlist configured. In production be strict; elsewhere be lenient.
            return callback(null, !isProduction);
        }

        return callback(null, allowlist.includes(origin));
    };
}

/**
 * Type-only helper for callers that want to plug the handler into a Nest
 * middleware. The runtime API is the CORS origin function above.
 */
export type CorsOriginFn = (
    req: FastifyRequest,
    reply: FastifyReply,
    done: (err: Error | null) => void,
) => void;

export const _typeOnly: CorsOriginFn | undefined = undefined;
