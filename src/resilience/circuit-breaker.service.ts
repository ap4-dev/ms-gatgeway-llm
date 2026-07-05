import { Inject, Injectable } from '@nestjs/common';
import { PROVIDER_REGISTRY } from '../providers/provider.registry';
import type { ProviderRegistryService } from '../providers/provider.registry';

/**
 * Circuit breaker policy. Mirrors the Zod-derived `RoutingPolicy` knobs but
 * kept as a local type so the resilience module stays decoupled from the
 * provider module.
 */
export interface CircuitBreakerPolicy {
    /** Consecutive failures in `closed` that trip the breaker into `open`. */
    failureThreshold: number;
    /** Time the breaker stays `open` before allowing a probe (`half-open`). */
    cooldownMs: number;
    /** Max concurrent probes allowed in `half-open`. */
    halfOpenProbes: number;
}

export type CircuitState = 'closed' | 'open' | 'half-open';

interface ProviderCircuit {
    state: CircuitState;
    /** Consecutive failures in `closed` (reset on success). */
    failures: number;
    /** Last recorded failure timestamp (ms). */
    lastFailureAt?: number;
    /** When the breaker most recently transitioned to `open`. */
    openedAt?: number;
    /** Probe slots currently held by in-flight `half-open` requests. */
    inFlightProbes: number;
}

/**
 * Thrown by `execute()` when the breaker is `open` for the requested
 * provider. Distinct error type so callers can branch on it without string
 * matching.
 */
export class CircuitOpenError extends Error {
    constructor(public readonly providerId: string) {
        super(`Circuit is open for provider "${providerId}"`);
        this.name = 'CircuitOpenError';
    }
}

/**
 * Snapshot of a single provider's breaker state, intended for health probes
 * and observability. Returned by `listProviders()`.
 */
export interface CircuitSnapshot {
    providerId: string;
    state: CircuitState;
    failures: number;
    lastFailureAt?: number;
    openedAt?: number;
    canServe: boolean;
}

/**
 * Per-provider circuit breaker with three states (closed → open → half-open
 * → closed|open). One instance services all providers — state is keyed by
 * `providerId`. The clock is injectable so tests advance time deterministically.
 */
@Injectable()
export class CircuitBreakerService {
    private readonly circuits = new Map<string, ProviderCircuit>();
    /** Provider ids we've ever seen — drives the health endpoint's full list. */
    private readonly known = new Set<string>();

    constructor(
        private readonly policy: CircuitBreakerPolicy,
        private readonly now: () => number = Date.now,
        @Inject(PROVIDER_REGISTRY)
        private readonly registry?: ProviderRegistryService,
    ) {}

    /** Current state for a provider. Unknown providers report `closed`. */
    getState(providerId: string): CircuitState {
        const c = this.circuits.get(providerId);
        if (!c) return 'closed';
        this.maybeTransitionFromOpen(c, providerId);
        return c.state;
    }

    /**
     * Whether a request for this provider should be sent right now. Updates
     * `open` → `half-open` if the cooldown has elapsed (side effect makes the
     * first caller pay the transition cost instead of every subsequent one).
     */
    canRequest(providerId: string): boolean {
        const c = this.circuits.get(providerId);
        if (!c) return true;
        this.maybeTransitionFromOpen(c, providerId);
        if (c.state === 'closed') return true;
        if (c.state === 'open') return false;
        // half-open: cap concurrent probes
        return c.inFlightProbes < this.policy.halfOpenProbes;
    }

    /** Record a successful upstream call. Closes the breaker if half-open. */
    recordSuccess(providerId: string): void {
        this.known.add(providerId);
        const c = this.ensure(providerId);
        c.failures = 0;
        if (c.state === 'half-open') {
            c.state = 'closed';
            c.openedAt = undefined;
            c.inFlightProbes = 0;
        }
    }

    /** Record a failed upstream call. Trips the breaker when threshold hit. */
    recordFailure(providerId: string, error?: unknown): void {
        this.known.add(providerId);
        const c = this.ensure(providerId);
        const t = this.now();
        c.lastFailureAt = t;
        if (c.state === 'half-open') {
            // A failed probe re-opens the breaker.
            c.state = 'open';
            c.openedAt = t;
            c.inFlightProbes = 0;
            return;
        }
        c.failures += 1;
        if (c.state === 'closed' && c.failures >= this.policy.failureThreshold) {
            c.state = 'open';
            c.openedAt = t;
        }
        // `error` retained for future structured logging (Phase 4).
        void error;
    }

    /**
     * Run `fn` for a provider, gating it on the breaker. Re-throws the
     * underlying error from `fn` and records it as a failure. Throws
     * {@link CircuitOpenError} when the breaker rejects the call.
     */
    async execute<T>(providerId: string, fn: () => Promise<T>): Promise<T> {
        if (!this.canRequest(providerId)) {
            throw new CircuitOpenError(providerId);
        }
        const c = this.ensure(providerId);
        const probing = c.state === 'half-open';
        if (probing) c.inFlightProbes += 1;
        try {
            const result = await fn();
            if (probing) c.inFlightProbes = Math.max(0, c.inFlightProbes - 1);
            this.recordSuccess(providerId);
            return result;
        } catch (err) {
            if (probing) c.inFlightProbes = Math.max(0, c.inFlightProbes - 1);
            this.recordFailure(providerId, err);
            throw err;
        }
    }

    /**
     * Snapshot every known provider's breaker state, plus any provider in
     * the registry we haven't seen fail yet (those are reported `closed`).
     */
    listProviders(): CircuitSnapshot[] {
        const ids = new Set<string>(this.known);
        if (this.registry) {
            for (const id of Object.keys(this.registry.providers)) ids.add(id);
        }
        const out: CircuitSnapshot[] = [];
        for (const id of ids) {
            const c = this.circuits.get(id);
            const state = this.getState(id);
            out.push({
                providerId: id,
                state,
                failures: c?.state === 'half-open' ? 0 : c?.failures ?? 0,
                lastFailureAt: c?.lastFailureAt,
                openedAt: c?.openedAt,
                canServe: this.canRequest(id),
            });
        }
        return out.sort((a, b) => a.providerId.localeCompare(b.providerId));
    }

    // --- internals -------------------------------------------------------

    private ensure(providerId: string): ProviderCircuit {
        let c = this.circuits.get(providerId);
        if (!c) {
            c = {
                state: 'closed',
                failures: 0,
                inFlightProbes: 0,
            };
            this.circuits.set(providerId, c);
        }
        return c;
    }

    private maybeTransitionFromOpen(c: ProviderCircuit, _id: string): void {
        if (c.state !== 'open' || c.openedAt === undefined) return;
        if (this.now() - c.openedAt >= this.policy.cooldownMs) {
            c.state = 'half-open';
            c.inFlightProbes = 0;
            // Keep the failures counter tied to the original failure window
            // until the probe resolves; success clears it, failure re-opens.
        }
    }
}
