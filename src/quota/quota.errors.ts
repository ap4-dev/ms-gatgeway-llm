/**
 * Raised by `QuotaService.resolveTarget` when a client has burnt its monthly
 * token allowance for an alias and there is no divert alias to degrade to.
 *
 * Framework-free on purpose: this file must not import any Nest/HTTP type.
 * The HTTP mapping (429 + `Retry-After`) is a presentation concern owned by the
 * transport layer, so the domain error can also be asserted from specs and
 * caught by non-HTTP callers without dragging in the web stack.
 */
export class QuotaExhaustedError extends Error {
    /**
     * Machine-readable payload for logs and the HTTP mapping. `resetsAt` is in
     * unix SECONDS (not ms) because that is what `Retry-After` and `unixepoch()`
     * speak, and it points at the start of the next UTC month — the only place
     * the counter can reset, since there is no cron job.
     */
    constructor(
        public readonly detail: {
            clientId: string;
            aliasKey: string;
            periodKey: string;
            limit: number;
            used: number;
            resetsAt: number;
        },
    ) {
        super(
            `Quota exhausted for client ${detail.clientId} on alias ${detail.aliasKey}: used ${detail.used} of ${detail.limit} tokens in ${detail.periodKey}`,
        );
        this.name = 'QuotaExhaustedError';
    }
}

const MS_PER_SECOND = 1000;

/**
 * Seconds between `nowMs` and `instantSeconds`, for `Retry-After`.
 *
 * This is the ONE formula for "how long until that instant" in the quota
 * domain; every caller delegates here so the 429 transports and the service
 * can never drift apart on rounding. `instantSeconds` is unix SECONDS (what
 * `Retry-After` and `unixepoch()` speak) and `nowMs` is floored to whole
 * seconds, so the result is always an integer.
 *
 * The clamp at 1 exists because `Retry-After: 0` reads to clients as "retry
 * now" — which is the exact opposite of what a quota error means — and a
 * negative value is meaningless. A sub-second remainder or a clock skewed past
 * the reset instant therefore degrades to "1 second", never to 0 or below.
 */
export function secondsUntilInstant(instantSeconds: number, nowMs: number = Date.now()): number {
    return Math.max(1, instantSeconds - Math.floor(nowMs / MS_PER_SECOND));
}
