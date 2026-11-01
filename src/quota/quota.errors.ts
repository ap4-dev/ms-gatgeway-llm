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
