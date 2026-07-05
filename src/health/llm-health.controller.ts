import { Controller, Get } from '@nestjs/common';
import {
    CircuitBreakerService,
    type CircuitSnapshot,
} from '../resilience/circuit-breaker.service';

interface ProviderHealthEntry {
    id: string;
    state: CircuitSnapshot['state'];
    failures: number;
    canServe: boolean;
    lastFailureAt?: number;
    openedAt?: number;
}

type HealthStatus = 'ok' | 'degraded' | 'down';

interface LlmHealthResponse {
    status: HealthStatus;
    providers: ProviderHealthEntry[];
}

/**
 * GET /v1/health/llm — per-provider gateway health.
 *
 * Returns a snapshot of every provider tracked by the circuit breaker
 * (closed/open/half-open + failure counters) plus an aggregate `status`
 * field that's easy to scrape with a process supervisor:
 *   - `ok`       — every provider can serve.
 *   - `degraded` — at least one provider can serve.
 *   - `down`     — no provider can serve.
 *
 * The path is `@Controller('health/llm')` so the global `/v1` prefix set in
 * `main.ts` produces `/v1/health/llm`.
 */
@Controller('health/llm')
export class LlmHealthController {
    constructor(private readonly breaker: CircuitBreakerService) {}

    @Get()
    get(): LlmHealthResponse {
        const snapshots = this.breaker.listProviders();
        const providers: ProviderHealthEntry[] = snapshots.map((s) => ({
            id: s.providerId,
            state: s.state,
            failures: s.failures,
            canServe: s.canServe,
            lastFailureAt: s.lastFailureAt,
            openedAt: s.openedAt,
        }));
        const total = providers.length;
        const canServeCount = providers.filter((p) => p.canServe).length;
        let status: HealthStatus;
        if (total === 0 || canServeCount === total) status = 'ok';
        else if (canServeCount === 0) status = 'down';
        else status = 'degraded';
        return { status, providers };
    }
}
