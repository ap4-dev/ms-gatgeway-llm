import { Injectable } from '@nestjs/common';
import { ClientAliasAccessRepository } from '../database/repositories/client-alias-access.repository';

/**
 * What a client is allowed to see and use, as ONE value.
 *
 * A discriminated union instead of two booleans or a bare array: the future
 * `/v1/models` filter and the future chat guard must never be able to disagree
 * about what a missing row means. There is exactly one interpretation, and it
 * is produced here.
 *
 *  - `unrestricted` — the client has no access rows at all: every alias in the
 *    registry is visible and usable, exactly as before the allowlist existed.
 *  - `restricted`   — the client has at least one row: the set is EXHAUSTIVE.
 *    An alias not in it is forbidden, even though "there is no row for it".
 */
export type AliasAccess =
    | { mode: 'unrestricted' }
    | { mode: 'restricted'; aliases: ReadonlySet<string> };

/** Administrative read model of one client's allowlist. */
export interface AliasAccessDescription {
    clientId: string;
    mode: 'unrestricted' | 'restricted';
    /** Sorted alias keys; empty when `mode` is `unrestricted`. */
    aliases: string[];
}

/**
 * Per-client alias allowlist (visibility + permission), keyed by `client_id`.
 *
 * Deliberately CACHE-FREE and SYNCHRONOUS, for the same reason
 * `QuotaService` is: revoking access must take effect on the VERY NEXT request.
 * Any TTL cache would leave a window where the row is already gone but the
 * client is still getting in — exactly the failure the design is meant to avoid.
 * better-sqlite3 is synchronous and this is one primary-key read, so going
 * straight to the DB costs microseconds. Hence: no cache, no invalidation, no
 * staleness, and no `async` API for nothing.
 *
 * SCOPE: this service only makes the allowlist storable and readable. Nothing
 * in a request path calls it yet — enforcement is a later work unit, so this
 * unit is inert at runtime by design.
 */
@Injectable()
export class AliasAccessService {
    constructor(private readonly access: ClientAliasAccessRepository) {}

    /**
     * Resolve one client's access. THE single place the "absence" rules live.
     *
     * 1. `clientId === null` → `unrestricted`, mirroring
     *    `QuotaService.resolveTarget`'s `if (!clientId) return requestedAlias`:
     *    unauthenticated traffic has no client to restrict.
     * 2. no rows at all → `unrestricted`. This is what makes the feature
     *    deployable: every existing client keeps full access until an operator
     *    deliberately writes its first row.
     * 3. at least one row → `restricted` to exactly that set.
     */
    getAccess(clientId: string | null): AliasAccess {
        if (!clientId) {
            return { mode: 'unrestricted' };
        }

        const rows = this.access.listByClient(clientId);
        if (rows.length === 0) {
            return { mode: 'unrestricted' };
        }

        return {
            mode: 'restricted',
            aliases: new Set(rows.map((row) => row.aliasKey)),
        };
    }

    /**
     * The only interpreter of an `AliasAccess` value.
     *
     * Unrestricted permits everything — including aliases this client has never
     * heard of, since the registry is the authority on what exists and it is
     * not this gate's business. Restricted permits exactly the stored set, so
     * prototype names such as `constructor` are simply "not in the set".
     */
    isPermitted(access: AliasAccess, aliasKey: string): boolean {
        return access.mode === 'unrestricted' || access.aliases.has(aliasKey);
    }

    /**
     * Read model for the admin surface: the same decision as `getAccess`,
     * rendered as JSON-safe primitives (a `Set` is not).
     *
     * Cache-free like everything else here, so an operator's change is visible
     * on the very next call. Aliases are sorted so the response is stable.
     */
    describe(clientId: string): AliasAccessDescription {
        const access = this.getAccess(clientId);

        if (access.mode === 'unrestricted') {
            return { clientId, mode: 'unrestricted', aliases: [] };
        }

        return {
            clientId,
            mode: 'restricted',
            aliases: [...access.aliases].sort((a, b) => a.localeCompare(b)),
        };
    }

    /**
     * Replace the whole allowlist and return the resulting state.
     *
     * Deliberately dumb about semantics: registry membership and the "empty
     * list means unrestricted, so reject it" rule are the admin layer's job —
     * the same split `QuotaService.upsertQuota` documents. The returned view is
     * re-read from the DB so it cannot drift from what `describe` reports next.
     */
    replace(clientId: string, aliasKeys: readonly string[]): AliasAccessDescription {
        this.access.replaceForClient(clientId, aliasKeys);
        return this.describe(clientId);
    }

    /**
     * Remove every row of one client, returning it to `unrestricted`, and
     * return the resulting state.
     */
    clear(clientId: string): AliasAccessDescription {
        this.access.deleteForClient(clientId);
        return this.describe(clientId);
    }
}
