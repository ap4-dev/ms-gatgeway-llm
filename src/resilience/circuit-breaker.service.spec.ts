import {
    CircuitBreakerService,
    CircuitOpenError,
} from './circuit-breaker.service';
import type { CircuitBreakerPolicy } from './circuit-breaker.service';

const policy: CircuitBreakerPolicy = {
    failureThreshold: 3,
    cooldownMs: 1_000,
    halfOpenProbes: 1,
};

/**
 * Build a CB whose internal clock is controllable from the test. Returns the
 * service + a `tick(ms)` helper that advances the clock.
 */
function makeBreaker(p = policy, now = 0) {
    let current = now;
    const cb = new CircuitBreakerService(p, () => current);
    return {
        cb,
        tick: (ms: number) => {
            current += ms;
        },
        setNow: (v: number) => {
            current = v;
        },
    };
}

describe('CircuitBreakerService — closed-state accounting', () => {
    it('starts closed for an unknown provider', () => {
        const { cb } = makeBreaker();
        expect(cb.getState('nan')).toBe('closed');
        expect(cb.canRequest('nan')).toBe(true);
    });

    it('records failures but stays closed below threshold', () => {
        const { cb } = makeBreaker({ ...policy, failureThreshold: 3 });
        cb.recordFailure('nan');
        cb.recordFailure('nan');
        expect(cb.getState('nan')).toBe('closed');
        expect(cb.canRequest('nan')).toBe(true);
    });

    it('opens when failures reach the threshold', () => {
        const { cb } = makeBreaker({ ...policy, failureThreshold: 3 });
        cb.recordFailure('nan');
        cb.recordFailure('nan');
        cb.recordFailure('nan');
        expect(cb.getState('nan')).toBe('open');
        expect(cb.canRequest('nan')).toBe(false);
    });

    it('a success resets the failure counter in closed state', () => {
        const { cb } = makeBreaker({ ...policy, failureThreshold: 3 });
        cb.recordFailure('nan');
        cb.recordFailure('nan');
        cb.recordSuccess('nan');
        cb.recordFailure('nan');
        cb.recordFailure('nan');
        // Only 2 consecutive failures since the success → still closed.
        expect(cb.getState('nan')).toBe('closed');
    });

    it('tracks providers independently', () => {
        const { cb } = makeBreaker({ ...policy, failureThreshold: 2 });
        cb.recordFailure('nan');
        cb.recordFailure('nan');
        cb.recordFailure('openai');
        expect(cb.getState('nan')).toBe('open');
        expect(cb.getState('openai')).toBe('closed');
    });
});

describe('CircuitBreakerService — cooldown & half-open transitions', () => {
    it('stays open during the cooldown window', () => {
        const { cb, tick } = makeBreaker({ ...policy, cooldownMs: 1_000 });
        for (let i = 0; i < policy.failureThreshold; i++) cb.recordFailure('nan');
        tick(999);
        expect(cb.getState('nan')).toBe('open');
        expect(cb.canRequest('nan')).toBe(false);
    });

    it('transitions to half-open once the cooldown elapses', () => {
        const { cb, tick } = makeBreaker({ ...policy, cooldownMs: 1_000 });
        for (let i = 0; i < policy.failureThreshold; i++) cb.recordFailure('nan');
        tick(1_000);
        // First probe should be permitted → transitions open → half-open.
        expect(cb.canRequest('nan')).toBe(true);
        expect(cb.getState('nan')).toBe('half-open');
    });

    it('a successful probe closes the breaker', async () => {
        const { cb, tick } = makeBreaker({ ...policy, cooldownMs: 1_000 });
        for (let i = 0; i < policy.failureThreshold; i++) cb.recordFailure('nan');
        tick(1_000);

        const result = await cb.execute('nan', async () => 'ok');
        expect(result).toBe('ok');
        expect(cb.getState('nan')).toBe('closed');
    });

    it('a failed probe re-opens the breaker', async () => {
        const { cb, tick } = makeBreaker({ ...policy, cooldownMs: 1_000 });
        for (let i = 0; i < policy.failureThreshold; i++) cb.recordFailure('nan');
        tick(1_000);

        await expect(
            cb.execute('nan', async () => {
                throw new Error('still broken');
            }),
        ).rejects.toThrow('still broken');
        expect(cb.getState('nan')).toBe('open');
    });

    it('limits concurrent probes in half-open per the policy', async () => {
        // Build a breaker that allows 2 concurrent half-open probes.
        const { cb, tick } = makeBreaker({
            ...policy,
            cooldownMs: 1_000,
            halfOpenProbes: 2,
        });
        for (let i = 0; i < policy.failureThreshold; i++) cb.recordFailure('nan');
        tick(1_000);
        // Touch canRequest so the breaker transitions open → half-open.
        expect(cb.canRequest('nan')).toBe(true);

        // Start two slow probes — that fills the probe slot.
        let resolveA!: () => void;
        let resolveB!: () => void;
        const probeA = cb.execute(
            'nan',
            () => new Promise<string>((res) => { resolveA = () => res('a'); }),
        );
        const probeB = cb.execute(
            'nan',
            () => new Promise<string>((res) => { resolveB = () => res('b'); }),
        );
        // Both probes are in flight → a third must be denied.
        expect(cb.canRequest('nan')).toBe(false);

        // Resolve so the breaker settles back to closed for the next test.
        resolveA();
        resolveB();
        await Promise.all([probeA, probeB]);
        expect(cb.getState('nan')).toBe('closed');
    });
});

describe('CircuitBreakerService — execute()', () => {
    it('runs the fn when closed and returns its value', async () => {
        const { cb } = makeBreaker();
        const fn = jest.fn().mockResolvedValue('payload');
        const result = await cb.execute('nan', fn);
        expect(result).toBe('payload');
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it('throws CircuitOpenError without calling the fn when open', async () => {
        const { cb } = makeBreaker({ ...policy, failureThreshold: 2 });
        cb.recordFailure('nan');
        cb.recordFailure('nan');
        const fn = jest.fn();
        await expect(cb.execute('nan', fn)).rejects.toBeInstanceOf(CircuitOpenError);
        expect(fn).not.toHaveBeenCalled();
    });

    it('re-throws the underlying error when the fn fails in closed state', async () => {
        const { cb } = makeBreaker();
        const boom = new Error('boom');
        await expect(cb.execute('nan', async () => { throw boom; })).rejects.toBe(boom);
    });

    it('opens after threshold when failures bubble up through execute()', async () => {
        const { cb } = makeBreaker({ ...policy, failureThreshold: 3 });
        for (let i = 0; i < 3; i++) {
            await expect(
                cb.execute('nan', async () => { throw new Error('x'); }),
            ).rejects.toThrow('x');
        }
        expect(cb.getState('nan')).toBe('open');
    });
});

describe('CircuitBreakerService — introspection', () => {
    it('listProviders returns one entry per recorded provider', () => {
        const { cb } = makeBreaker();
        cb.recordSuccess('nan');
        cb.recordSuccess('openai');
        const list = cb.listProviders();
        const ids = list.map((p) => p.providerId).sort();
        expect(ids).toEqual(['nan', 'openai']);
        expect(list.every((p) => p.state === 'closed')).toBe(true);
    });

    it('listProviders reflects failure/half-open metadata', () => {
        const { cb, tick } = makeBreaker({ ...policy, cooldownMs: 1_000 });
        cb.recordFailure('nan');
        cb.recordFailure('nan');
        cb.recordFailure('nan'); // opens
        tick(1_000);
        cb.canRequest('nan'); // → half-open

        const entry = cb.listProviders().find((p) => p.providerId === 'nan');
        expect(entry?.state).toBe('half-open');
        expect(entry?.failures).toBe(0); // reset on transition to half-open
        expect(entry?.openedAt).toBeDefined();
    });
});
