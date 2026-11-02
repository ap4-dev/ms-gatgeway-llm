import type { AliasNotPermittedError } from './alias-access.errors';

/**
 * Presentation helpers shared by the OpenAI-compatible and Anthropic transports.
 *
 * Framework-free on purpose (same constraint as `quota.errors.ts` and
 * `quota-http.ts`): no Nest, no Fastify, no HTTP imports. Both controllers own
 * the transport wiring; this file only owns what a `403` for a forbidden alias
 * looks like, so the two protocols cannot drift apart on the human-facing text.
 *
 * `permission_error` is the discriminator in BOTH protocols — OpenAI and
 * Anthropic each document that type for a `403`. That matters here: the quota
 * error keeps `rate_limit_error` / `insufficient_quota` on a `429`, so a client
 * (or an operator) can tell "this key may not use this alias" apart from "this
 * alias is out of monthly tokens" without parsing prose.
 */

/**
 * One message for both protocols.
 *
 * Names the alias that was refused and nothing else:
 *  - it does **not** enumerate the aliases that ARE permitted — that would turn
 *    a permission error into a directory of the fleet;
 *  - it is **identical** whether the alias is missing from the client's
 *    allowlist or missing from the registry entirely, so a restricted client
 *    cannot probe which alias names exist.
 *
 * `err.detail.clientId` is deliberately not rendered: the caller already knows
 * which key it used, and the alias is the actionable part.
 */
export function aliasForbiddenMessage(err: AliasNotPermittedError): string {
    return (
        `Alias "${err.detail.aliasKey}" is not permitted for this client. ` +
        `Ask the gateway operator to grant access to it.`
    );
}

/**
 * OpenAI-compatible 403 body.
 *
 * `code: 'alias_not_permitted'` is OUR machine token for logs and dashboards;
 * `type: 'permission_error'` is what OpenAI SDKs already understand on a 403, so
 * a client surfaces a permission failure instead of a generic one.
 */
export function openAiAliasForbiddenBody(err: AliasNotPermittedError): {
    error: {
        message: string;
        type: 'permission_error';
        code: 'alias_not_permitted';
        alias: string;
    };
} {
    return {
        error: {
            message: aliasForbiddenMessage(err),
            type: 'permission_error',
            code: 'alias_not_permitted',
            alias: err.detail.aliasKey,
        },
    };
}

/** Anthropic-style 403 body (their API uses `permission_error` too). */
export function anthropicAliasForbiddenBody(err: AliasNotPermittedError): {
    type: 'error';
    error: { type: 'permission_error'; message: string };
} {
    return {
        type: 'error',
        error: {
            type: 'permission_error',
            message: aliasForbiddenMessage(err),
        },
    };
}
