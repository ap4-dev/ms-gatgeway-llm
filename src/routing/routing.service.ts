import { Injectable } from '@nestjs/common';
import type { ChatCompletionCreateParams } from 'openai/resources/chat/completions';
import type { CompletionResult } from '../chat/chat.service';
import type { ResolvedModel } from '../providers/provider.model';
import { ProviderService } from '../providers/provider.service';
import {
    CircuitBreakerService,
    CircuitOpenError,
} from '../resilience/circuit-breaker.service';

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
 * (via {@link ProviderService.resolveChain}), walks it while consulting the
 * {@link CircuitBreakerService} for each entry, and invokes the caller-supplied
 * `executor` against the first non-open provider. On failure, transparently
 * retries on the next chain entry. Throws {@link RoutingFailedError} when
 * every entry has been exhausted.
 */
@Injectable()
export class RoutingService {
    constructor(
        private readonly providers: ProviderService,
        private readonly breaker: CircuitBreakerService,
    ) {}

    async route(
        model: string,
        _body: ChatCompletionCreateParams,
        executor: RouteExecutor,
    ): Promise<RouteResult> {
        const chain = this.providers.resolveChain(model);
        const attempts: RouteAttempt[] = [];

        for (const resolved of chain) {
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
