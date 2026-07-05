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
 * call. Defaults to `'primary'` (chain order). Phase 3 behaviour when
 * no row is configured for the alias; `'round-robin'` rotates the
 * starting chain index per call. Future strategies (`'weighted'`,
 * priority groups) live in the same enum and dispatch on the same
 * lookup, so adding them does not require touching this service.
 *
 * Cursor (round-robin state) is keyed by the requested model string so
 * distinct aliases rotate independently. The cursor advances once per
 * route attempt — failures of the chosen entry still fall through to
 * the next index in the rotated sequence.
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
            chain.length,
            // Cursor advances once per route attempt, regardless of
            // strategy (for primary/fallback the cursor isn't read but
            // the wiring is cheap).
            () => this.cursor.next(model, chain.length),
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
}
