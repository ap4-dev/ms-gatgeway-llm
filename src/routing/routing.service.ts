import { Injectable } from '@nestjs/common';
import type { ChatCompletionCreateParams } from 'openai/resources/chat/completions';
import type { CompletionResult } from '../chat/chat.service';
import type {
    ResolvedModel,
    RoutingStrategyKind,
} from '../providers/provider.model';
import { ProviderService } from '../providers/provider.service';
import {
    CircuitBreakerService,
    CircuitOpenError,
} from '../resilience/circuit-breaker.service';
import { RoundRobinCursor } from './round-robin-cursor';
import { pickOrder } from './strategy';

/**
 * The executor handed to `RoutingService.route`. Receives the resolved
 * model and an `AbortSignal` whose timeout is the provider's effective
 * `timeoutMs`. Must throw to signal an attempt failure.
 */
export type RouteExecutor = (
    resolved: ResolvedModel,
    signal: AbortSignal,
) => Promise<CompletionResult>;

export interface RouteAttemptOk {
    providerId: string;
    upstreamModel: string;
    ok: true;
    durationMs: number;
}
export interface RouteAttemptFailed {
    providerId: string;
    upstreamModel: string;
    ok: false;
    circuitOpen: boolean;
    error?: unknown;
    durationMs: number;
}

export type RouteAttempt = RouteAttemptOk | RouteAttemptFailed;

export interface RouteResult {
    result: CompletionResult;
    providerId: string;
    attempts: RouteAttempt[];
}

/**
 * Thrown when every chain entry has been tried (and either failed or was
 * skipped due to an open circuit). Carries per-attempt metadata so callers
 * can build a useful HTTP error response.
 */
export class RoutingFailedError extends Error {
    constructor(
        public readonly requestedModel: string,
        public readonly attempts: RouteAttempt[],
    ) {
        super(
            `All ${attempts.length} provider(s) failed for model "${requestedModel}"`,
        );
        this.name = 'RoutingFailedError';
    }
}

/**
 * Resolves a user-supplied model identifier to an ordered fallback chain
 * (via {@link ProviderService.resolveChain}), then walks it under the
 * supervision of {@link CircuitBreakerService}.
 *
 * Strategy is PER ALIAS — looked up via `strategyFor(aliasKey)` on every
 * call. Each strategy produces an index sequence via `pickOrder`:
 *   - 'primary' / 'fallback' : chain order.
 *   - 'round-robin'          : cursor-rotated starting index, walks forward.
 *   - 'weighted'             : per-call weighted random pick, walks forward
 *                              (no cursor involvement).
 *   - 'priority-grouped'     : sorted by (priority asc, position asc).
 *
 * Cursor state is keyed by the requested model string so distinct aliases
 * rotate independently for round-robin. Weighted sampling is independent
 * per call (no state).
 */
@Injectable()
export class RoutingService {
    constructor(
        private readonly providers: ProviderService,
        private readonly breaker: CircuitBreakerService,
        private readonly strategyFor: (aliasKey: string) => RoutingStrategyKind = () => 'primary',
        private readonly cursor: RoundRobinCursor = new RoundRobinCursor(),
    ) {}

    async route(
        model: string,
        _body: ChatCompletionCreateParams,
        executor: RouteExecutor,
    ): Promise<RouteResult> {
        const chain = this.providers.resolveChain(model);
        if (chain.length === 0) {
            throw new RoutingFailedError(model, []);
        }

        const strategy = this.strategyFor(model);
        const order = pickOrder(
            strategy,
            chain,
            // Cursor advances once per route attempt. For strategies that
            // don't read it (`'primary'`, `'fallback'`, `'weighted'`,
            // `'priority-grouped'`) the wiring is cheap; only
            // `'round-robin'` consumes this closure.
            () => this.cursor.next(model, chain.length),
            // For `'weighted'` we read the per-alias weights from the
            // registry. For other strategies this is ignored.
            this.aliasWeightsFor(model, chain.length),
        );

        const attempts: RouteAttempt[] = [];

        for (const idx of order) {
            const resolved = chain[idx];
            const start = Date.now();

            if (!this.breaker.canRequest(resolved.providerId)) {
                attempts.push({
                    providerId: resolved.providerId,
                    upstreamModel: resolved.upstreamModel,
                    ok: false,
                    circuitOpen: true,
                    durationMs: Date.now() - start,
                });
                continue;
            }

            const signal = AbortSignal.timeout(resolved.timeoutMs);
            try {
                const result = await this.breaker.execute(
                    resolved.providerId,
                    () => executor(resolved, signal),
                );
                attempts.push({
                    providerId: resolved.providerId,
                    upstreamModel: resolved.upstreamModel,
                    ok: true,
                    durationMs: Date.now() - start,
                });
                return {
                    result,
                    providerId: resolved.providerId,
                    attempts,
                };
            } catch (err) {
                const circuitOpen = err instanceof CircuitOpenError;
                attempts.push({
                    providerId: resolved.providerId,
                    upstreamModel: resolved.upstreamModel,
                    ok: false,
                    circuitOpen,
                    error: circuitOpen ? undefined : err,
                    durationMs: Date.now() - start,
                });
                // Continue to next chain entry.
            }
        }

        throw new RoutingFailedError(model, attempts);
    }

    /**
     * Read per-position weights for the alias. Returns a parallel array
     * of length `chainLength`, defaulting missing positions to 1
     * (uniform mix). Returns `undefined` when the alias doesn't exist
     * (e.g. a bare `provider/model` path); in that case `pickOrder`
     * falls back to uniform sampling.
     */
    private aliasWeightsFor(model: string, chainLength: number): number[] | undefined {
        const registry = this.providers.registryRef;
        const rows = registry.getWeights?.(model);
        if (!rows || rows.length === 0) return undefined;
        const out = new Array<number>(chainLength).fill(1);
        for (const r of rows) {
            if (r.position >= 0 && r.position < chainLength) {
                out[r.position] = r.weight;
            }
        }
        return out;
    }
}
