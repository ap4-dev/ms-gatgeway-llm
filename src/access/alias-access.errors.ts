/**
 * Raised when an authenticated client asks for an alias that its allowlist does
 * not include (`AliasAccessService.isPermitted` returned `false`).
 *
 * Framework-free on purpose (same constraint as `quota.errors.ts`): this file
 * must not import any Nest/HTTP type. The 403 mapping is a presentation concern
 * owned by the transport layer, so the domain error can be asserted from specs
 * and caught by non-HTTP callers without dragging in the web stack.
 *
 * `clientId` is nullable in the detail because the guard runs before any
 * authentication-specific branching: the access service itself decides that "no
 * client" means unrestricted, so a null here would only ever appear if that rule
 * changed. Keeping it nullable avoids a dead branch in the caller and keeps the
 * payload useful for logs.
 */
export class AliasNotPermittedError extends Error {
    constructor(
        public readonly detail: {
            clientId: string | null;
            aliasKey: string;
        },
    ) {
        super(`Alias "${detail.aliasKey}" is not permitted for this client`);
        this.name = 'AliasNotPermittedError';
    }
}
