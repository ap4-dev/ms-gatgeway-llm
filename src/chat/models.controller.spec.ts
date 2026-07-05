import { ModelsController } from './models.controller';
import { ProviderRegistryService } from '../providers/provider.registry';

function makeRegistry(
    overrides: { aliases?: Record<string, string> } = {},
): ProviderRegistryService {
    const providers = {
        nan: {
            apiKeyEnv: 'NAN_API_KEY',
            baseURL: 'https://api.nan.builders/v1',
            models: {
                'qwen3.6': { real: 'qwen3.6' },
                'qwen3-coder': { real: 'qwen3-coder', maxTokens: 16384 },
            },
        },
        openai: {
            apiKeyEnv: 'OPENAI_API_KEY',
            baseURL: 'https://api.openai.com/v1',
            models: {
                'gpt-4o-mini': { real: 'gpt-4o-mini' },
            },
        },
    } as any;

    const aliases = overrides.aliases ?? {
        default: ['nan/qwen3.6'],
        fast: ['openai/gpt-4o-mini'],
        coder: ['nan/qwen3-coder'],
    };

    return {
        providers,
        aliases,
        policy: {
            fallbackEnabled: true,
            strategy: 'primary' as const,
            healthCheckIntervalMs: 30_000,
            requestTimeoutMs: 120_000,
            failureThreshold: 5,
            cooldownMs: 30_000,
            halfOpenProbes: 1,
        },
        has: (id: string) => id in providers,
        get: (id: string) => providers[id],
        findModel: () => undefined,
        file: {} as any,
    } as unknown as ProviderRegistryService;
}

function setUpKeys(setup: { nan?: boolean; openai?: boolean }) {
    if (setup.nan) process.env.NAN_API_KEY = 'sk-nan';
    else delete process.env.NAN_API_KEY;
    if (setup.openai) process.env.OPENAI_API_KEY = 'sk-openai';
    else delete process.env.OPENAI_API_KEY;
}

describe('ModelsController', () => {
    const createdAtFloor = 1_700_000_000;

    beforeEach(() => {
        jest.spyOn(Date, 'now').mockReturnValue(createdAtFloor * 1000);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('lists aliases AND model keys (deduped) for every configured provider', () => {
        setUpKeys({ nan: true, openai: true });
        const controller = new ModelsController(makeRegistry());

        const res = controller.list();

        expect(res.object).toBe('list');
        const ids = res.data.map((d) => d.id).sort();
        // aliases: coder, default, fast
        // model keys: qwen3.6, qwen3-coder (deduped against alias "coder"), gpt-4o-mini
        expect(ids).toEqual([
            'coder',
            'default',
            'fast',
            'gpt-4o-mini',
            'qwen3-coder',
            'qwen3.6',
        ]);
    });

    it('uses the alias key as the model id (never the upstream `real` name)', () => {
        setUpKeys({ nan: true });
        const controller = new ModelsController(
            makeRegistry({
                aliases: {
                    // An alias whose name differs from the upstream id is the
                    // check we care about: id MUST equal the alias name.
                    awesome: ['nan/qwen3-coder'],
                },
            }),
        );

        const res = controller.list();
        const aliased = res.data.find((d) => d.id === 'awesome');

        expect(aliased).toBeDefined();
        expect(aliased!.owned_by).toBe('nan');
        // The upstream name "qwen3-coder" must NOT leak under either id
        // for the alias entry — it's only the model-key entry.
        expect(res.data.filter((d) => d.id === 'qwen3-coder')).toHaveLength(1);
        expect(res.data.filter((d) => d.id === 'awesome')).toHaveLength(1);
    });

    it('dedupes when an alias name matches a model key', () => {
        setUpKeys({ nan: true });
        const controller = new ModelsController(
            makeRegistry({
                aliases: {
                    // alias key == model key on the same provider
                    'qwen3-coder': ['nan/qwen3-coder'],
                },
            }),
        );

        const res = controller.list();
        expect(res.data.filter((d) => d.id === 'qwen3-coder')).toHaveLength(1);
    });

    it('skips providers whose API key env is missing', () => {
        setUpKeys({ nan: true, openai: false });
        const controller = new ModelsController(makeRegistry());

        const res = controller.list();
        const ids = res.data.map((d) => d.id);
        expect(ids).toEqual(['coder', 'default', 'qwen3-coder', 'qwen3.6']);
    });

    it('skips aliases that point to providers without their API key set', () => {
        setUpKeys({ nan: true, openai: false });
        const controller = new ModelsController(makeRegistry());

        const res = controller.list();
        expect(res.data.find((d) => d.id === 'fast')).toBeUndefined();
    });

    it('skips aliases that point to unknown providers/models', () => {
        setUpKeys({ nan: true, openai: true });
        const controller = new ModelsController(
            makeRegistry({
                aliases: {
                    ghost: ['nonexistent/nothing'],
                    broken: ['nan/no-such-model'],
                    valid: ['nan/qwen3-coder'],
                },
            }),
        );

        const res = controller.list();
        expect(res.data.find((d) => d.id === 'ghost')).toBeUndefined();
        expect(res.data.find((d) => d.id === 'broken')).toBeUndefined();
        expect(res.data.find((d) => d.id === 'valid')).toBeDefined();
    });

    it('returns an empty list when no providers are configured', () => {
        setUpKeys({});
        const controller = new ModelsController(makeRegistry());

        const res = controller.list();
        expect(res.data).toEqual([]);
    });

    it('uses a stable created timestamp per process instance', () => {
        setUpKeys({ nan: true });
        const controller = new ModelsController(makeRegistry());

        const first = controller.list();
        const second = controller.list();
        expect(first.data[0].created).toBe(second.data[0].created);
    });
});
