import { Inject, Injectable, Optional } from '@nestjs/common';
import { QuotaRepository } from '../database/repositories/quota.repository';
import { QuotaExhaustedError } from './quota.errors';

/**
 * Injection token for the wall clock. Production binds `Date.now`; specs bind a
 * controllable function so month rollover and `retryAfterSeconds` are asserted
 * against an exact instant instead of the real calendar.
 */
export const QUOTA_CLOCK = 'QUOTA_CLOCK';

const MS_PER_SECOND = 1000;

/**
 * Monthly token quota gate, keyed by `(client, alias)`.
 *
 * Deliberately CACHE-FREE and SYNCHRONOUS (feature plan §5). The requirement
 * that matters is "raise the limit mid-month and the client gets back in on the
 * NEXT request" — any TTL cache would leave a window where the new limit is
 * already stored but the client is still diverted, which is exactly the bug the
 * design is meant to avoid. better-sqlite3 is synchronous and both reads are
 * primary-key lookups, so going straight to the DB costs microseconds. Hence:
 * no cache, no invalidation, no staleness, and no `async` API for nothing.
 *
 * The gate is pre-flight and the accounting is post-hoc, so a client that is
 * just under the limit still gets one full request served (accepted overshoot,
 * R2 in the plan). In exchange no tokens are ever reserved for a model call
 * that might not happen.
 */
@Injectable()
export class QuotaService {
    private readonly now: () => number;

    constructor(
        private readonly quotas: QuotaRepository,
        @Optional() @Inject(QUOTA_CLOCK) now?: () => number,
    ) {
        this.now = now ?? Date.now;
    }

    /**
     * UTC calendar month of `nowMs` as `YYYY-MM` (zero-padded).
     *
     * UTC on purpose: the period boundary must not move with the server's
     * timezone, otherwise a DST switch or a redeploy in another region would
     * shift the reset instant for every client.
     */
    periodKey(nowMs: number = this.now()): string {
        const date = new Date(nowMs);
        const month = date.getUTCMonth() + 1;
        return `${date.getUTCFullYear()}-${month < 10 ? `0${month}` : month}`;
    }

    /**
     * Decide which alias actually serves this request (feature plan §4).
     *
     * Order matters and each early return is load-bearing:
     * 1. no client → nothing to gate (unauthenticated/paths/models traffic);
     * 2. no quota row → the alias is UNLIMITED, so the usage table is never
     *    even read: gated-free aliases like `slave` cost zero I/O;
     * 3. `used < limit` → serve what was asked. Strict, because a client
     *    sitting exactly on the limit is already exhausted;
     * 4. exhausted with a divert alias → silent degradation, no header, no
     *    body mutation;
     * 5. exhausted without one → throw, and let the HTTP layer render 429.
     *
     * There is no recursion: a divert alias with no quota row simply takes the
     * normal routing path, so `slave` keeps its own principal+fallback walk.
     */
    resolveTarget(clientId: string | null, requestedAlias: string): string {
        if (!clientId) {
            return requestedAlias;
        }

        const quota = this.quotas.getQuota(clientId, requestedAlias);
        if (!quota) {
            return requestedAlias;
        }

        // One clock read for the whole decision, so the period used for the
        // usage lookup and the `resetsAt` above can never straddle a boundary.
        const nowMs = this.now();
        const periodKey = this.periodKey(nowMs);
        const used = this.quotas.getUsage(clientId, requestedAlias, periodKey)?.tokens ?? 0;

        if (used < quota.monthlyTokenLimit) {
            return requestedAlias;
        }

        if (quota.divertAliasKey) {
            return quota.divertAliasKey;
        }

        throw new QuotaExhaustedError({
            clientId,
            aliasKey: requestedAlias,
            periodKey,
            limit: quota.monthlyTokenLimit,
            used,
            resetsAt: nextUtcMonthStart(nowMs) / MS_PER_SECOND,
        });
    }

    /**
     * Account one served request, called after the response (feature plan §5).
     *
     * Usage is recorded against the alias ACTUALLY served. That is what freezes
     * the exhausted alias's counter during degradation and lets a mid-month
     * limit raise restore access without touching any state: gated traffic
     * increments, diverted traffic does not because the divert alias has no
     * quota row of its own.
     *
     * `tokens` is normalised to a non-negative integer first. `0` is a valid
     * count (the request still happened), while a negative or `NaN` value would
     * violate the `tokens >= 0` CHECK and blow up mid-request on a path that has
     * already sent the response — so clamping is safer than trusting the caller.
     */
    recordUsage(clientId: string | null, servedAlias: string, tokens: number): void {
        if (!clientId) {
            return;
        }

        if (!this.quotas.getQuota(clientId, servedAlias)) {
            return;
        }

        this.quotas.addUsage({
            clientId,
            aliasKey: servedAlias,
            periodKey: this.periodKey(),
            tokens: normaliseTokens(tokens),
        });
    }

    /**
     * Seconds a client should wait before the quota can reset, for `Retry-After`.
     *
     * Floored at 1 because `Retry-After: 0` reads as "retry now" and a negative
     * value is meaningless: the next month start is always strictly in the
     * future, so the clamp is purely defensive against a skewed clock.
     */
    retryAfterSeconds(nowMs: number = this.now()): number {
        const deltaMs = nextUtcMonthStart(nowMs) - nowMs;
        return Math.max(1, Math.ceil(deltaMs / MS_PER_SECOND));
    }
}

/** Unix ms of the first instant of the next UTC month. */
function nextUtcMonthStart(nowMs: number): number {
    const date = new Date(nowMs);
    return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
}

/** Coerce arbitrary caller input into the non-negative integer the DB accepts. */
function normaliseTokens(tokens: number): number {
    return Math.max(0, Math.trunc(Number.isFinite(tokens) ? tokens : 0));
}
