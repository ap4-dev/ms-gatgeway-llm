import { BadRequestException, Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
    QuotaRepository,
    type ClientAliasUsage,
} from '../database/repositories/quota.repository';
import { QUOTA_CLOCK } from './quota.service';

const MS_PER_SECOND = 1000;

/** `YYYY-MM` only: no day, no offset, no rollover arithmetic outside UTC. */
const PERIOD_KEY_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

/** One `(client, alias)` pair whose stored counter disagrees with the logs. */
export interface ReconcileDriftRow {
    clientId: string;
    aliasKey: string;
    storedTokens: number;
    computedTokens: number;
    storedRequests: number;
    computedRequests: number;
}

/**
 * Outcome of one reconciliation pass.
 *
 * `rowsScanned` counts ATTRIBUTABLE `request_logs` rows in the window (those
 * with a `client_key`); `pairsConsidered` counts `(client, alias)` pairs that
 * have a quota row — the only pairs allowed to own a usage counter; `repaired`
 * counts pairs actually written, which is always 0 under `dryRun`.
 */
export interface ReconcileReport {
    periodKey: string;
    dryRun: boolean;
    rowsScanned: number;
    pairsConsidered: number;
    drift: ReconcileDriftRow[];
    repaired: number;
}

export interface ReconcileOptions {
    /** UTC calendar month to reconcile; defaults to the month in progress. */
    periodKey?: string;
    /** Report only, write nothing. */
    dryRun?: boolean;
}

/**
 * Repair pass for `client_alias_usage` (feature plan §6 and T6).
 *
 * The live path (`QuotaService.recordUsage`) is an append-only UPSERT: it never
 * verifies what it accumulated. Any lost write — an unexpected process death
 * between the response and the accounting, a manual DB edit, a bug on a path
 * that bailed before recording — silently under-counts a client's month and
 * makes the gate serve an alias whose quota is already spent. Reconciliation
 * re-derives the counters from the durable `request_logs` table, so stored
 * state can be rebuilt instead of merely trusted.
 *
 * Reconciliation is the ONLY writer of absolute values. It is explicit, admin
 * triggered, and idempotent: a second pass over the same data finds no drift,
 * because the first pass already wrote the computed totals rather than a delta.
 */
@Injectable()
export class QuotaReconcileService {
    private readonly logger = new Logger(QuotaReconcileService.name);
    private readonly now: () => number;

    constructor(
        private readonly quotas: QuotaRepository,
        @Optional() @Inject(QUOTA_CLOCK) now?: () => number,
    ) {
        this.now = now ?? Date.now;
    }

    reconcile(options: ReconcileOptions = {}): ReconcileReport {
        const periodKey = options.periodKey ?? periodKeyOf(this.now());
        assertPeriodKey(periodKey);
        const dryRun = options.dryRun === true;

        const window = utcMonthWindow(periodKey);
        // The whole pass is SYNCHRONOUS (better-sqlite3, no `await` anywhere), so
        // it cannot interleave with the accounting of an in-flight request in
        // this process: nothing can call `addUsage` between the read above and
        // the writes below. No transaction is needed to keep the comparison and
        // the repair consistent.
        const aggregates = this.quotas.aggregateRequestLogUsage(window);
        const rowsScanned = aggregates.reduce((sum, row) => sum + row.requests, 0);

        // One query for the whole period instead of a lookup per pair, and a Map
        // instead of a plain object so an alias named `__proto__` cannot touch
        // the prototype chain.
        const storedByPair = new Map<string, ClientAliasUsage>(
            this.quotas
                .listUsageByPeriod(periodKey)
                .map((usage) => [pairKey(usage.clientId, usage.aliasKey), usage]),
        );
        const computedByPair = new Map(
            aggregates.map((row) => [pairKey(row.clientId, row.aliasKey), row]),
        );

        const quotaPairs = this.quotas.listAllQuotas();
        const drift: ReconcileDriftRow[] = [];
        let repaired = 0;

        for (const pair of quotaPairs) {
            // THE CORRECTNESS RULE, and it looks like an omission on purpose:
            // `QuotaService.recordUsage` returns early when the served alias has
            // no `client_alias_quotas` row, so the live path only ever tracks
            // aliases that HAVE a quota. Iterating `quotaPairs` (rather than the
            // aggregates) applies the identical rule. Attributing every alias
            // that appears in `request_logs` would fabricate usage rows the
            // runtime never creates and then report permanent phantom drift for
            // them on every future pass.
            const key = pairKey(pair.clientId, pair.aliasKey);
            const stored = storedByPair.get(key);
            const computed = computedByPair.get(key);

            const storedTokens = stored?.tokens ?? 0;
            const storedRequests = stored?.requests ?? 0;
            // No traffic in the window means the computed counter IS zero, so a
            // quota pair that has never been used is correctly in sync (not
            // "missing drift") and costs no write.
            const computedTokens = computed?.tokens ?? 0;
            const computedRequests = computed?.requests ?? 0;

            if (storedTokens === computedTokens && storedRequests === computedRequests) {
                continue;
            }

            drift.push({
                clientId: pair.clientId,
                aliasKey: pair.aliasKey,
                storedTokens,
                computedTokens,
                storedRequests,
                computedRequests,
            });

            if (dryRun) {
                continue;
            }

            this.quotas.setUsage({
                clientId: pair.clientId,
                aliasKey: pair.aliasKey,
                periodKey,
                tokens: computedTokens,
                requests: computedRequests,
            });
            repaired += 1;

            this.logger.log(
                `reconcile ${periodKey}: repaired client "${pair.clientId}" alias "${pair.aliasKey}" — ` +
                    `tokens ${storedTokens} -> ${computedTokens}, requests ${storedRequests} -> ${computedRequests}`,
            );
        }

        // Exactly one summary line, and nothing else on a clean pass: an
        // operator running this nightly should get silence unless something
        // actually needed repair.
        this.logger.log(
            `reconcile ${periodKey}: scanned ${rowsScanned} request_logs rows, ` +
                `${quotaPairs.length} quota pairs, ${drift.length} drifted, ` +
                `${repaired} repaired${dryRun ? ' (dry run: no writes)' : ''}`,
        );

        return {
            periodKey,
            dryRun,
            rowsScanned,
            pairsConsidered: quotaPairs.length,
            drift,
            repaired,
        };
    }
}

/**
 * UTC calendar month of `nowMs` as `YYYY-MM`.
 *
 * Same formula as `QuotaService.periodKey`; kept local so this service needs no
 * clock-bearing collaborator — injecting `QuotaService` here would put two
 * clocks in play for one period boundary.
 */
function periodKeyOf(nowMs: number): string {
    const date = new Date(nowMs);
    const month = date.getUTCMonth() + 1;
    return `${date.getUTCFullYear()}-${month < 10 ? `0${month}` : month}`;
}

/** Half-open `[start, nextStart)` unix-second window of one UTC month. */
function utcMonthWindow(periodKey: string): { fromTs: number; toTs: number } {
    const year = Number(periodKey.slice(0, 4));
    const month = Number(periodKey.slice(5, 7));
    return {
        fromTs: Date.UTC(year, month - 1, 1) / MS_PER_SECOND,
        toTs: Date.UTC(year, month, 1) / MS_PER_SECOND,
    };
}

/**
 * Reject anything that is not a real UTC calendar month. Validate the SERVICE
 * too, not just the HTTP query: reconciliation rewrites accounting rows, so a
 * typo like `2026-13` must fail loudly here rather than silently producing a
 * window of all zeroes and "repairing" a client down to 0 tokens.
 */
function assertPeriodKey(periodKey: string): void {
    if (!PERIOD_KEY_PATTERN.test(periodKey)) {
        throw new BadRequestException(
            `periodKey: expected a UTC calendar month as YYYY-MM, got "${periodKey}"`,
        );
    }
}

/** Map key for one `(client, alias)` pair; NUL cannot appear in either id. */
function pairKey(clientId: string, aliasKey: string): string {
    return `${clientId}\u0000${aliasKey}`;
}
