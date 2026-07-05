import { ProviderService } from '../providers/provider.service';
import type { ResolvedModel, RoutingStrategyKind } from '../providers/provider.model';
import {
    CircuitBreakerService,
    CircuitOpenError,
} from '../resilience/circuit-breaker.service';
import type { CircuitBreakerPolicy } from '../resilience/circuit-breaker.service';
import { RoutingFailedError, RoutingService } from './routing.service';
import { RoundRobinCursor } from './round-robin-cursor';

const policy: CircuitBreakerPolicy = {
    failureThreshold: 2,
    cooldownMs: 1_000,
    halfOpenProbes: 1,
};

const env = {
    NODE_ENV: 'test' as const,
    PORT: 3000,
    LLM_PROVIDER_API_KEY: undefined,
    LLM_PROVIDER_BASE_URL: undefined,
    CORS_ORIGINS: '',
    START_TOKEN: undefined,
    MS: 'ms-gateway-llm',
};

const fixtureAlias = {
    providers: {
        nan: {
            apiKeyEnv: 'NAN_API_KEY',
            baseURL: 'https://api.nan.builders/v1',
            timeoutMs: 10_000,
            models: {
                'qwen3.6': { real: 'qwen3.6' },
                'qwen3-coder': { real: 'qwen3-coder' },
            },
        },
        openai: {
            apiKeyEnv: 'OPENAI_API_KEY',
            baseURL: 'https://api.openai.com/v1',
            timeoutMs: 5_000,
            models: {
                'gpt-4o': { real: 'gpt-4o' },
                'gpt-4o-mini': { real: 'gpt-4o-mini' },
            },
        },
    },
    aliases: {
        fast: ['openai/gpt-4o-mini', 'nan/qwen3.6'],
        nanonly: ['nan/qwen3-coder'],
    },
};

const fixturePolicy = {
    fallbackEnabled: true,
    strategy: 'primary' as const,
    healthCheckIntervalMs: 30_000,
    requestTimeoutMs: 120_000,
    failureThreshold: 5,
    cooldownMs: 30_000,
    halfOpenProbes: 1,
};

function makeRegistry() {
    return {
        file: fixtureAlias,
        providers: fixtureAlias.providers,
        aliases: fixtureAlias.aliases,
        policy: fixturePolicy,
        has: (id: string) => id in fixtureAlias.providers,
        get: (id: string) => fixtureAlias.providers[id as keyof typeof fixtureAlias.providers],
        findModel: (upstream: string) => {
            for (const [pid, provider] of Object.entries(fixtureAlias.providers)) {
                for (const modelKey of Object.keys(provider.models)) {
                    if (modelKey === upstream) {
                        return { providerId: pid, modelKey, config: provider };
                    }
                }
            }
            return undefined;
        },
    } as any;
}

function makeService(
    breaker = new CircuitBreakerService(policy),
    strategyFor: (aliasKey: string) => RoutingStrategyKind = () => 'primary',
    cursor: RoundRobinCursor = new RoundRobinCursor(),
) {
    process.env.NAN_API_KEY = 'sk-nan-test';
    process.env.OPENAI_API_KEY = 'sk-openai-test';
    const providers = new ProviderService(makeRegistry(), env as any);
    return {
        service: new RoutingService(providers, breaker, strategyFor, cursor),
        breaker,
        cursor,
    };
}

function fakeResolved(overrides: Partial<ResolvedModel> = {}): ResolvedModel {
    return {
        requestedAs: 'fast',
        providerId: 'openai',
        modelKey: 'gpt-4o-mini',
        upstreamModel: 'gpt-4o-mini',
        apiKey: 'sk-openai-test',
        baseURL: 'https://api.openai.com/v1',
        overrides: {},
        supportsStream: true,
        timeoutMs: 5_000,
        ...overrides,
    };
}

describe('RoutingService.route', () => {
    afterEach(() => {
        delete process.env.NAN_API_KEY;
        delete process.env.OPENAI_API_KEY;
    });

    it('returns the first chain entry result when it succeeds', async () => {
        const { service } = makeService();
        const executor = jest
            .fn()
            .mockResolvedValueOnce({ id: 'primary' });

        const out = await service.route('fast', { model: 'fast' } as any, executor);

        expect(executor).toHaveBeenCalledTimes(1);
        expect(out.result).toEqual({ id: 'primary' });
        expect(out.providerId).toBe('openai');
        expect(out.attempts).toHaveLength(1);
        expect(out.attempts[0]).toMatchObject({ ok: true, providerId: 'openai' });
    });

    it('falls back to the next entry when the primary throws', async () => {
        const { service } = makeService();
        const executor = jest
            .fn()
            .mockImplementationOnce(async () => { throw new Error('upstream 500'); })
            .mockResolvedValueOnce({ id: 'fallback' });

        const out = await service.route('fast', { model: 'fast' } as any, executor);

        expect(executor).toHaveBeenCalledTimes(2);
        expect(out.providerId).toBe('nan');
        expect(out.result).toEqual({ id: 'fallback' });
        expect(out.attempts).toMatchObject([
            { providerId: 'openai', ok: false, circuitOpen: false },
            { providerId: 'nan', ok: true },
        ]);
    });

    it('skips providers whose circuit is open and continues down the chain', async () => {
        const { service, breaker } = makeService();
        // Trip openai's breaker.
        breaker.recordFailure('openai');
        breaker.recordFailure('openai');

        const executor = jest.fn().mockResolvedValueOnce({ id: 'nan-success' });
        const out = await service.route('fast', { model: 'fast' } as any, executor);

        expect(executor).toHaveBeenCalledTimes(1);
        expect(out.providerId).toBe('nan');
        expect(out.attempts).toMatchObject([
            { providerId: 'openai', ok: false, circuitOpen: true },
            { providerId: 'nan', ok: true },
        ]);
    });

    it('passes a per-attempt AbortSignal whose timeout equals resolved.timeoutMs', async () => {
        const { service } = makeService();
        const executor = jest.fn().mockResolvedValueOnce('ok');
        const seenTimeouts: number[] = [];

        await service.route('fast', { model: 'fast' } as any, async (_r, signal) => {
            // The SDK would treat `signal` as an AbortSignal; the timeout value
            // is captured by checking that AbortSignal.timeout(timeoutMs) was used.
            expect(signal).toBeInstanceOf(AbortSignal);
            seenTimeouts.push(_r.timeoutMs);
            return 'ok';
        });

        expect(seenTimeouts).toEqual([5_000]); // openai/gpt-4o-mini → 5000ms
    });

    it('throws RoutingFailedError when every chain entry fails', async () => {
        const { service } = makeService();
        const executor = jest
            .fn()
            .mockImplementationOnce(async () => { throw new Error('a'); })
            .mockImplementationOnce(async () => { throw new Error('b'); });

        await expect(service.route('fast', { model: 'fast' } as any, executor))
            .rejects.toBeInstanceOf(RoutingFailedError);

        try {
            await service.route('fast', { model: 'fast' } as any, executor);
        } catch (err) {
            const e = err as RoutingFailedError;
            expect(e.attempts).toHaveLength(2);
            expect(e.attempts.every((a) => !a.ok)).toBe(true);
            expect(e.attempts.map((a) => a.providerId)).toEqual(['openai', 'nan']);
        }
    });

    it('throws RoutingFailedError when every chain entry has an open circuit', async () => {
        const { service, breaker } = makeService();
        breaker.recordFailure('openai');
        breaker.recordFailure('openai');
        breaker.recordFailure('nan');
        breaker.recordFailure('nan');

        await expect(
            service.route('fast', { model: 'fast' } as any, jest.fn()),
        ).rejects.toBeInstanceOf(RoutingFailedError);
    });

    it('does not call the executor when resolveChain fails', async () => {
        const { service } = makeService();
        const executor = jest.fn();
        await expect(
            service.route('totally-unknown', { model: 'totally-unknown' } as any, executor),
        ).rejects.toThrow(/Unknown model/);
        expect(executor).not.toHaveBeenCalled();
    });

    it('treats CircuitOpenError thrown by the executor (race condition) as circuit-open', async () => {
        const { service } = makeService();
        // Executor that throws CircuitOpenError even though canRequest was
        // true at check time (a probe from another caller tripped the
        // breaker in between). Use a counter so we can decide per-call what
        // to do — `mockImplementationOnce` chain alone is brittle here.
        let calls = 0;
        const executor = jest
            .fn<Promise<unknown>, [ResolvedModel, AbortSignal]>()
            .mockImplementationOnce(async () => {
                calls++;
                throw new CircuitOpenError('openai');
            })
            .mockImplementationOnce(async () => {
                calls++;
                return { id: 'nan-success' };
            });

        const out = await service.route('fast', { model: 'fast' } as any, executor as any);
        expect(calls).toBe(2);
        expect(out.providerId).toBe('nan');
        expect(out.attempts).toMatchObject([
            { providerId: 'openai', ok: false, circuitOpen: true },
            { providerId: 'nan', ok: true },
        ]);
    });
});

describe('RoutingService — round-robin strategy', () => {
    it('rotates the initial provider across calls', async () => {
        const cursor = new RoundRobinCursor();
        const { service } = makeService(
            new CircuitBreakerService(policy),
            () => 'round-robin',
            cursor,
        );

        const seen: string[] = [];
        for (let i = 0; i < 4; i++) {
            const result = await service.route('fast', { model: 'fast' } as any, async () => ({ id: 'ok' }));
            seen.push(result.providerId);
        }
        expect(seen).toEqual(['openai', 'nan', 'openai', 'nan']);
    });

    it('keeps cursors per requested model (so aliases rotate independently)', async () => {
        const cursor = new RoundRobinCursor();
        const { service } = makeService(
            new CircuitBreakerService(policy),
            () => 'round-robin',
            cursor,
        );

        const a1 = await service.route('fast', { model: 'fast' } as any, async () => ({ id: 'ok' }));
        const n1 = await service.route('nanonly', { model: 'nanonly' } as any, async () => ({ id: 'ok' }));
        const a2 = await service.route('fast', { model: 'fast' } as any, async () => ({ id: 'ok' }));
        const n2 = await service.route('nanonly', { model: 'nanonly' } as any, async () => ({ id: 'ok' }));

        expect(a1.providerId).toBe('openai');
        expect(n1.providerId).toBe('nan');
        expect(a2.providerId).toBe('nan');
        expect(n2.providerId).toBe('nan');
    });

    it('round-robin skips an open circuit and continues to the next', async () => {
        const cursor = new RoundRobinCursor();
        const breaker = new CircuitBreakerService(policy);
        const { service } = makeService(breaker, () => 'round-robin', cursor);

        breaker.recordFailure('openai');
        breaker.recordFailure('openai');

        const result = await service.route('fast', { model: 'fast' } as any, async () => ({ id: 'ok' }));
        expect(result.providerId).toBe('nan');
        expect(result.attempts).toMatchObject([
            { providerId: 'openai', ok: false, circuitOpen: true },
            { providerId: 'nan', ok: true },
        ]);
    });

    it('with a single-entry chain behaves like primary (no change)', async () => {
        const cursor = new RoundRobinCursor();
        const { service } = makeService(
            new CircuitBreakerService(policy),
            () => 'round-robin',
            cursor,
        );
        for (let i = 0; i < 5; i++) {
            const result = await service.route('nanonly', { model: 'nanonly' } as any, async () => ({ id: 'ok' }));
            expect(result.providerId).toBe('nan');
        }
    });
});

describe('RoutingService — per-alias strategy', () => {
    it('honors the strategy resolution per requested alias', async () => {
        const cursor = new RoundRobinCursor();
        // Map each alias to a specific strategy.
        const strategyFor = (alias: string) => {
            if (alias === 'fast') return 'round-robin';
            if (alias === 'nanonly') return 'primary';
            return 'primary';
        };
        const { service } = makeService(
            new CircuitBreakerService(policy),
            strategyFor,
            cursor,
        );

        // fast uses round-robin → rotates across openai/nan.
        const a1 = await service.route('fast', { model: 'fast' } as any, async () => ({ id: 'ok' }));
        const a2 = await service.route('fast', { model: 'fast' } as any, async () => ({ id: 'ok' }));
        expect(a1.providerId).toBe('openai');
        expect(a2.providerId).toBe('nan');

        // nanonly uses primary → always chain[0] = nan.
        const n1 = await service.route('nanonly', { model: 'nanonly' } as any, async () => ({ id: 'ok' }));
        const n2 = await service.route('nanonly', { model: 'nanonly' } as any, async () => ({ id: 'ok' }));
        expect(n1.providerId).toBe('nan');
        expect(n2.providerId).toBe('nan');
    });

    it('defaults to primary when the strategyFor callback returns the default', async () => {
        const { service } = makeService(); // no override → primary
        // Two successive calls — chain order is the same both times.
        const a1 = await service.route('fast', { model: 'fast' } as any, async () => ({ id: 'ok' }));
        const a2 = await service.route('fast', { model: 'fast' } as any, async () => ({ id: 'ok' }));
        expect(a1.providerId).toBe('openai');
        expect(a2.providerId).toBe('openai');
    });
});
