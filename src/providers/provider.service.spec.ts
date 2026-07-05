import OpenAI from 'openai';
import { ProviderService } from './provider.service';
import { ProviderRegistryService } from './provider.registry';
import { resetEnvCache, getEnv } from '../config/env.schema';

jest.mock('openai', () => ({
    __esModule: true,
    default: jest.fn().mockImplementation(() => ({
        chat: { completions: { create: jest.fn() } },
    })),
}));

const OpenAIConstructor = OpenAI as unknown as jest.Mock;

const fixturePolicy = {
    fallbackEnabled: true,
    strategy: 'primary' as const,
    healthCheckIntervalMs: 30_000,
    requestTimeoutMs: 120_000,
    failureThreshold: 5,
    cooldownMs: 30_000,
    halfOpenProbes: 1,
};

const fixtureRegistry = {
    providers: {
        nan: {
            apiKeyEnv: 'NAN_API_KEY',
            baseURL: 'https://api.nan.builders/v1',
            timeoutMs: 180_000,
            models: {
                'qwen3.6': { real: 'qwen3.6' },
                'qwen3-coder': { real: 'qwen3-coder', maxTokens: 16384 },
                'deepseek-r1': { real: 'deepseek-r1' },
            },
        },
        openai: {
            apiKeyEnv: 'OPENAI_API_KEY',
            baseURL: 'https://api.openai.com/v1',
            timeoutMs: 60_000,
            models: {
                'gpt-4o': { real: 'gpt-4o' },
                'gpt-4o-mini': { real: 'gpt-4o-mini' },
            },
        },
    },
    aliases: {
        default: ['nan/qwen3.6', 'openai/gpt-4o-mini'],
        fast: ['openai/gpt-4o-mini', 'nan/qwen3.6'],
        strong: ['nan/deepseek-r1'],
        coder: ['nan/qwen3-coder', 'openai/gpt-4o'],
    },
    routing: fixturePolicy,
};

function makeRegistry(): ProviderRegistryService {
    // Bypass file I/O — inject the parsed shape directly via casting.
    return {
        file: fixtureRegistry,
        providers: fixtureRegistry.providers,
        aliases: fixtureRegistry.aliases,
        policy: fixturePolicy,
        has: (id: string) => id in fixtureRegistry.providers,
        get: (id: string) => fixtureRegistry.providers[id as keyof typeof fixtureRegistry.providers],
        findModel: (upstream: string) => {
            for (const [pid, provider] of Object.entries(fixtureRegistry.providers)) {
                for (const modelKey of Object.keys(provider.models)) {
                    if (modelKey === upstream) {
                        return {
                            providerId: pid,
                            modelKey,
                            config: provider,
                        };
                    }
                }
            }
            return undefined;
        },
    } as unknown as ProviderRegistryService;
}

function makeService(registry = makeRegistry(), env = getEnv()) {
    return new ProviderService(registry, env);
}

function setUpKeys() {
    process.env.NAN_API_KEY = 'sk-nan-test';
    process.env.OPENAI_API_KEY = 'sk-openai-test';
}

describe('ProviderService.resolve', () => {
    beforeEach(() => {
        resetEnvCache();
        OpenAIConstructor.mockClear();
        setUpKeys();
    });

    afterEach(() => {
        delete process.env.NAN_API_KEY;
        delete process.env.OPENAI_API_KEY;
    });

    it('expands a registered alias to the underlying provider/model', () => {
        const resolved = makeService().resolve('fast');
        expect(resolved.providerId).toBe('openai');
        expect(resolved.modelKey).toBe('gpt-4o-mini');
        expect(resolved.upstreamModel).toBe('gpt-4o-mini');
        expect(resolved.apiKey).toBe('sk-openai-test');
    });

    it('falls back to the "default" alias when the input is unknown', () => {
        const resolved = makeService().resolve('not-in-anyone');
        expect(resolved.providerId).toBe('nan');
        expect(resolved.modelKey).toBe('qwen3.6');
    });

    it('resolves an explicit provider/model path', () => {
        const resolved = makeService().resolve('nan/qwen3-coder');
        expect(resolved.providerId).toBe('nan');
        expect(resolved.modelKey).toBe('qwen3-coder');
        expect(resolved.overrides.maxTokens).toBe(16384);
    });

    it('resolves a bare model key by scanning providers', () => {
        const resolved = makeService().resolve('deepseek-r1');
        expect(resolved.providerId).toBe('nan');
        expect(resolved.modelKey).toBe('deepseek-r1');
    });

    it('throws when the alias points to an unknown provider/model', () => {
        // Build a registry whose alias points nowhere valid.
        const badRegistry = makeRegistry();
        (badRegistry as any).aliases.broken = ['nonexistent/whatever'];
        expect(() => makeService(badRegistry).resolve('broken')).toThrow(
            /Unknown provider "nonexistent"|Unknown model "whatever"/,
        );
    });

    it('throws with a clear message when the API key env var is missing', () => {
        delete process.env.NAN_API_KEY;
        expect(() => makeService().resolve('nan/qwen3.6')).toThrow(
            /NAN_API_KEY/,
        );
    });

    it('lists known aliases/models when the input is unrecognised and no default alias', () => {
        const original = fixtureRegistry.aliases.default;
        delete fixtureRegistry.aliases.default;
        const registryNoDefault = makeRegistry();
        expect(() => makeService(registryNoDefault).resolve('mystery-model'))
            .toThrow(/Known aliases/);
        // restore for the rest of the suite
        fixtureRegistry.aliases.default = original;
    });
});

describe('ProviderService.resolveChain', () => {
    beforeEach(() => {
        resetEnvCache();
        OpenAIConstructor.mockClear();
        setUpKeys();
    });

    afterEach(() => {
        delete process.env.NAN_API_KEY;
        delete process.env.OPENAI_API_KEY;
    });

    it('returns the full ordered fallback chain for an alias', () => {
        const chain = makeService().resolveChain('fast');
        expect(chain).toHaveLength(2);
        expect(chain.map((r) => `${r.providerId}/${r.modelKey}`)).toEqual([
            'openai/gpt-4o-mini',
            'nan/qwen3.6',
        ]);
    });

    it('returns a single-element chain for a bare model key', () => {
        const chain = makeService().resolveChain('gpt-4o');
        expect(chain).toHaveLength(1);
        expect(chain[0].providerId).toBe('openai');
    });

    it('returns a single-element chain for an explicit provider/model path', () => {
        const chain = makeService().resolveChain('nan/qwen3-coder');
        expect(chain).toHaveLength(1);
        expect(chain[0].upstreamModel).toBe('qwen3-coder');
    });

    it('uses the "default" alias chain when nothing else matches', () => {
        const chain = makeService().resolveChain('not-in-anyone');
        expect(chain).toHaveLength(2);
        expect(chain[0].providerId).toBe('nan');
        expect(chain[1].providerId).toBe('openai');
    });

    it('populates timeoutMs from the provider override when present', () => {
        const chain = makeService().resolveChain('openai/gpt-4o-mini');
        expect(chain[0].timeoutMs).toBe(60_000); // openai provider override
    });

    it('falls back to the policy default when the provider has no timeoutMs', () => {
        // Remove the per-provider override on the nan provider and confirm
        // we pick up the routing.requestTimeoutMs default.
        const original = (fixtureRegistry.providers.nan as any).timeoutMs;
        delete (fixtureRegistry.providers.nan as any).timeoutMs;
        try {
            const chain = makeService().resolveChain('nan/qwen3.6');
            expect(chain[0].timeoutMs).toBe(120_000);
        } finally {
            (fixtureRegistry.providers.nan as any).timeoutMs = original;
        }
    });
});

describe('ProviderService.clientFor', () => {
    beforeEach(() => {
        resetEnvCache();
        OpenAIConstructor.mockClear();
        setUpKeys();
    });

    it('caches one OpenAI client per provider id', () => {
        const service = makeService();
        const a = service.clientFor(service.resolve('fast'));
        const b = service.clientFor(service.resolve('openai/gpt-4o'));
        const c = service.clientFor(service.resolve('nan/qwen3.6'));

        expect(OpenAIConstructor).toHaveBeenCalledTimes(2);
        expect(a).toBe(b); // same provider "openai"
        expect(a).not.toBe(c); // different provider "nan"
        expect(OpenAIConstructor).toHaveBeenNthCalledWith(1, {
            apiKey: 'sk-openai-test',
            baseURL: 'https://api.openai.com/v1',
        });
        expect(OpenAIConstructor).toHaveBeenNthCalledWith(2, {
            apiKey: 'sk-nan-test',
            baseURL: 'https://api.nan.builders/v1',
        });
    });
});
