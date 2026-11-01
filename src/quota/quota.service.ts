import { Inject, Injectable, Optional } from '@nestjs/common';
import {
    QuotaRepository,
    type ClientAliasQuota,
    type ClientAliasUsage,
} from '../database/repositories/quota.repository';
import { QuotaExhaustedError, secondsUntilInstant } from './quota.errors';

/**
 * Injection token for the wall clock. Production binds `Date.now`; specs bind a
 * controllable function so month rollover and `retryAfterSeconds` are asserted
 * against an exact instant instead of the real calendar.
 */
export const QUOTA_CLOCK = 'QUOTA_CLOCK';

const MS_PER_SECOND = 1000;

/**
 * One `(client, alias)` quota as an administrative read model: the stored
 * allowance joined with the usage of the period in progress.
 *
 * `exhausted` is `tokens >= monthlyTokenLimit` — the SAME strict rule
 * `resolveTarget` applies — so an admin listing can never claim a client is
 * fine while the gate is already diverting it. `remaining` is clamped at 0
 * because the post-hoc accounting accepts overshoot (plan §5 R2) and a
 * negative allowance would be meaningless in the UI.
 */
export interface ClientQuotaView {
    aliasKey: string;
    monthlyTokenLimit: number;
    divertAliasKey: string | null;
    periodKey: string;
    tokens: number;
    requests: number;
    remaining: number;
    exhausted: boolean;
    /** Unix SECONDS of the next UTC month start, matching the error detail. */
    resetsAt: number;
    retryAfterSeconds: number;
}

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
     * `atMs` is the instant the REQUEST STARTED, passed by the caller, and it
     * exists for one reason: the gate (`resolveTarget`) and the accounting must
     * resolve the SAME period. A request that enters at 23:59:59 on the last day
     * of a month and finishes after midnight would otherwise be admitted
     * against November and billed to December — silently refunding the previous
     * month's counter and spending the fresh one. Only the caller knows when the
     * request began, so the caller owns the instant; defaulting to `this.now()`
     * keeps direct callers (admin tooling, reconciliation) working. See review
     * finding R3-001.
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
    recordUsage(
        clientId: string | null,
        servedAlias: string,
        tokens: number,
        atMs: number = this.now(),
    ): void {
        if (!clientId) {
            return;
        }

        if (!this.quotas.getQuota(clientId, servedAlias)) {
            return;
        }

        this.quotas.addUsage({
            clientId,
            aliasKey: servedAlias,
            // Period of the request start, never of the write time.
            periodKey: this.periodKey(atMs),
            tokens: normaliseTokens(tokens),
        });
    }

    /**
     * Seconds a client should wait before the quota can reset, for `Retry-After`.
     *
     * Delegates to `secondsUntilInstant` — the single formula shared with the
     * HTTP 429 mapping — applied to the next UTC month start, the only instant
     * the counter can reset since there is no cron job.
     */
    retryAfterSeconds(nowMs: number = this.now()): number {
        return secondsUntilInstant(Math.floor(nextUtcMonthStart(nowMs) / MS_PER_SECOND), nowMs);
    }

    /**
     * Every quota of one client joined with the usage of the period in progress.
     *
     * Exactly two queries regardless of how many aliases the client has
     * (`listQuotasByClient` + `listUsageByClientPeriod`), joined in memory by
     * `aliasKey`; a per-alias usage lookup would turn the admin listing into
     * N + 1. Cache-free like everything else here, so an admin limit change is
     * visible on the very next call.
     *
     * A quota with no usage row yet simply reports zeroes, and usage from other
     * months is invisible because the period key comes from ONE clock read.
     * Ordering follows the repository: by `alias_key`.
     */
    describeQuotas(clientId: string, nowMs: number = this.now()): ClientQuotaView[] {
        const periodKey = this.periodKey(nowMs);
        const usageByAlias = new Map<string, ClientAliasUsage>(
            this.quotas
                .listUsageByClientPeriod(clientId, periodKey)
                .map((usage) => [usage.aliasKey, usage]),
        );

        return this.quotas
            .listQuotasByClient(clientId)
            .map((quota) => this.toView(quota, usageByAlias.get(quota.aliasKey), periodKey, nowMs));
    }

    /**
     * Persist one `(client, alias)` allowance and return the resulting view.
     *
     * Deliberately dumb about semantics: alias existence and the `divert_alias_key`
     * registry check are the admin layer's job, and the `monthly_token_limit > 0`
     * / `divert_alias_key <> alias_key` rules are DB CHECKs — the same split the
     * repository `upsertQuota` documents. The service only writes and projects.
     *
     * The returned view reuses `toView`, so the numbers an admin sees after a
     * write cannot drift from what `describeQuotas` reports afterwards.
     */
    upsertQuota(
        clientId: string,
        input: { aliasKey: string; monthlyTokenLimit: number; divertAliasKey?: string | null },
        nowMs: number = this.now(),
    ): ClientQuotaView {
        this.quotas.upsertQuota({
            clientId,
            aliasKey: input.aliasKey,
            monthlyTokenLimit: input.monthlyTokenLimit,
            divertAliasKey: input.divertAliasKey ?? null,
        });

        const periodKey = this.periodKey(nowMs);
        // Only the usage needs reading: the stored allowance is exactly the input
        // just written (the DB stores it verbatim). Projected through the same
        // helper `describeQuotas` uses, so the numbers cannot drift.
        const usage = this.quotas.getUsage(clientId, input.aliasKey, periodKey);

        return this.toView(
            {
                aliasKey: input.aliasKey,
                monthlyTokenLimit: input.monthlyTokenLimit,
                divertAliasKey: input.divertAliasKey ?? null,
            },
            usage ?? undefined,
            periodKey,
            nowMs,
        );
    }

    /** Remove one `(client, alias)` allowance; `true` only when a row existed. */
    removeQuota(clientId: string, aliasKey: string): boolean {
        return this.quotas.deleteQuota(clientId, aliasKey);
    }

    /**
     * The single projection from stored rows to the administrative read model.
     *
     * One place on purpose: `describeQuotas` and `upsertQuota` must never be able
     * to disagree about `remaining`/`exhausted`/`resetsAt` for the same state.
     * `usage` is absent when the client has not spent anything in the period.
     */
    private toView(
        quota: Pick<ClientAliasQuota, 'aliasKey' | 'monthlyTokenLimit' | 'divertAliasKey'>,
        usage: ClientAliasUsage | undefined,
        periodKey: string,
        nowMs: number,
    ): ClientQuotaView {
        const tokens = usage?.tokens ?? 0;

        return {
            aliasKey: quota.aliasKey,
            monthlyTokenLimit: quota.monthlyTokenLimit,
            divertAliasKey: quota.divertAliasKey,
            periodKey,
            tokens,
            requests: usage?.requests ?? 0,
            remaining: Math.max(0, quota.monthlyTokenLimit - tokens),
            // Strict `>=`, identical to `resolveTarget`: exactly on the limit is
            // already exhausted.
            exhausted: tokens >= quota.monthlyTokenLimit,
            resetsAt: nextUtcMonthStart(nowMs) / MS_PER_SECOND,
            retryAfterSeconds: this.retryAfterSeconds(nowMs),
        };
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
