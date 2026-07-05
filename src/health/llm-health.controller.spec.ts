import { LlmHealthController } from './llm-health.controller';
import type { CircuitBreakerService, CircuitSnapshot } from '../resilience/circuit-breaker.service';

function makeBreaker(snapshots: CircuitSnapshot[]) {
    return {
        listProviders: jest.fn().mockReturnValue(snapshots),
    } as unknown as CircuitBreakerService;
}

describe('LlmHealthController', () => {
    it('returns the breaker snapshots under `providers`', () => {
        const snapshots: CircuitSnapshot[] = [
            {
                providerId: 'nan',
                state: 'closed',
                failures: 0,
                canServe: true,
            },
            {
                providerId: 'openai',
                state: 'open',
                failures: 5,
                lastFailureAt: 1_700_000_000_000,
                openedAt: 1_700_000_001_000,
                canServe: false,
            },
        ];
        const controller = new LlmHealthController(makeBreaker(snapshots));

        const res = controller.get();
        expect(res.status).toBe('degraded'); // one or more providers can't serve
        expect(res.providers).toHaveLength(2);
        expect(res.providers.map((p) => p.id)).toEqual(['nan', 'openai']);
        expect(res.providers.find((p) => p.id === 'openai')).toMatchObject({
            state: 'open',
            canServe: false,
            failures: 5,
        });
    });

    it('reports overall ok when every provider can serve', () => {
        const snapshots: CircuitSnapshot[] = [
            { providerId: 'nan', state: 'closed', failures: 0, canServe: true },
            { providerId: 'openai', state: 'closed', failures: 0, canServe: true },
        ];
        const controller = new LlmHealthController(makeBreaker(snapshots));

        expect(controller.get().status).toBe('ok');
    });

    it('reports overall down when every provider cannot serve', () => {
        const snapshots: CircuitSnapshot[] = [
            { providerId: 'nan', state: 'open', failures: 5, canServe: false },
            { providerId: 'openai', state: 'open', failures: 5, canServe: false },
        ];
        const controller = new LlmHealthController(makeBreaker(snapshots));

        expect(controller.get().status).toBe('down');
    });

    it('handles an empty breaker (no known providers)', () => {
        const controller = new LlmHealthController(makeBreaker([]));
        expect(controller.get()).toEqual({ status: 'ok', providers: [] });
    });
});
