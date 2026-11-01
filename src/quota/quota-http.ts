import type { QuotaExhaustedError } from './quota.errors';

const MS_PER_SECOND = 1000;

/**
 * Presentation helpers shared by the OpenAI-compatible and Anthropic transports.
 *
 * Framework-free on purpose (same constraint as `quota.errors.ts`): no Nest, no
 * Fastify, no HTTP imports. Both controllers own the transport wiring; this file
 * only owns what a 429 for an exhausted monthly token quota looks like, so the
 * two protocols can never drift apart on the human-facing message.
 */

/**
 * Seconds until the quota resets, for `Retry-After`.
 *
 * Floor-clamped at 1 because `Retry-After: 0` reads as "retry now" and a
 * negative value is meaningless. `resetsAt` is unix SECONDS (matching the error
 * detail), and the current instant is floored to whole seconds so the answer is
 * always an integer.
 */
export function quotaRetryAfterSeconds(
    err: QuotaExhaustedError,
    nowMs: number = Date.now(),
): number {
    return Math.max(1, err.detail.resetsAt - Math.floor(nowMs / MS_PER_SECOND));
}

/**
 * OpenAI-compatible 429 body.
 *
 * `type: 'insufficient_quota'` is deliberate: it is the discriminator OpenAI
 * clients (Kilo, OpenCode, and the plain `openai` SDK) already understand on a
 * 429, so they surface a quota error instead of a generic failure. `code:
 * 'quota_exhausted'` is OUR machine token for logs and dashboards — the client
 * keeps working with the standard shape while we keep a precise field to grep.
 * `resets_at` is unix seconds, exactly as it appears in the error detail.
 */
export function openAiQuotaErrorBody(err: QuotaExhaustedError): {
    error: {
        message: string;
        type: 'insufficient_quota';
        code: 'quota_exhausted';
        alias: string;
        resets_at: number;
    };
} {
    return {
        error: {
            message: quotaMessage(err),
            type: 'insufficient_quota',
            code: 'quota_exhausted',
            alias: err.detail.aliasKey,
            resets_at: err.detail.resetsAt,
        },
    };
}

/** Anthropic-style 429 body (`rate_limit_error`, as their API does). */
export function anthropicQuotaErrorBody(err: QuotaExhaustedError): {
    type: 'error';
    error: { type: 'rate_limit_error'; message: string };
} {
    return {
        type: 'error',
        error: {
            type: 'rate_limit_error',
            message: quotaMessage(err),
        },
    };
}

/**
 * One message for both protocols: it names the alias, how far over the client
 * is, and the exact instant it can retry. The reset instant is rendered as ISO
 * UTC so it is unambiguous across timezones.
 */
function quotaMessage(err: QuotaExhaustedError): string {
    const resetsAtIso = new Date(err.detail.resetsAt * MS_PER_SECOND).toISOString();
    return (
        `Monthly token quota for alias "${err.detail.aliasKey}" is exhausted: ` +
        `${err.detail.used} of ${err.detail.limit} tokens used in ${err.detail.periodKey}. ` +
        `The quota resets at ${resetsAtIso}.`
    );
}
