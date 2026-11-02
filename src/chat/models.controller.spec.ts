import { ModelsController } from './models.controller';
import { ProviderRegistryService } from '../providers/provider.registry';
import { AliasAccessService } from '../access/alias-access.service';
import type { ClientAliasAccessRepository } from '../database/repositories/client-alias-access.repository';

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

/**
 * The REAL `AliasAccessService` over a fake repository.
 *
 * "No rows means unrestricted" is as much the rule under test as the filtering
 * itself, so it is not stubbed away: both `list()` and the request gate read the
 * same `getAccess` answer, which is the whole point of the shared accessor.
 * `permitted === undefined` means the client has no rows at all.
 */
function makeAccess(permitted?: readonly string[]): AliasAccessService {
    const repo = {
        listByClient: () =>
            (permitted ?? []).map((aliasKey) => ({ clientId: 'client-1', aliasKey })),
    } as unknown as ClientAliasAccessRepository;
    return new AliasAccessService(repo);
}

/** Authenticated request stub; `null` id models anonymous traffic. */
function makeRequest(clientId: string | null = 'client-1') {
    return { client: clientId === null ? undefined : { id: clientId } } as any;
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

    it('lists ONLY aliases — never the underlying real model keys', () => {
        setUpKeys({ nan: true, openai: true });
        const controller = new ModelsController(makeRegistry(), makeAccess());

        const res = controller.list(makeRequest());

        expect(res.object).toBe('list');
        const ids = res.data.map((d) => d.id).sort();
        // Only the alias entries — none of the upstream real-model ids.
        expect(ids).toEqual(['coder', 'default', 'fast']);
    });

    it('does NOT leak any real model key (qwen3.6 / qwen3-coder / gpt-4o-mini)', () => {
        setUpKeys({ nan: true, openai: true });
        const controller = new ModelsController(makeRegistry(), makeAccess());

        const res = controller.list(makeRequest());
        const payload = JSON.stringify(res);
        // Provider-side model ids must never appear in the response.
        expect(payload).not.toContain('qwen3.6');
        expect(payload).not.toContain('qwen3-coder');
        expect(payload).not.toContain('gpt-4o-mini');
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
            makeAccess(),
        );

        const res = controller.list(makeRequest());
        const aliased = res.data.find((d) => d.id === 'awesome');

        expect(aliased).toBeDefined();
        expect(aliased!.owned_by).toBe('nan');
        // The real upstream model key must NOT appear at all in the public
        // listing — neither as a dedupe target nor as a top-level entry.
        expect(res.data.some((d) => d.id === 'qwen3-coder')).toBe(false);
        expect(res.data.filter((d) => d.id === 'awesome')).toHaveLength(1);
    });

    it('keeps the alias even when its name matches an upstream model key', () => {
        setUpKeys({ nan: true });
        const controller = new ModelsController(
            makeRegistry({
                aliases: {
                    // alias key == model key on the same provider — should
                    // still appear under its alias name, never as a raw
                    // model key entry.
                    'qwen3-coder': ['nan/qwen3-coder'],
                },
            }),
            makeAccess(),
        );

        const res = controller.list(makeRequest());
        expect(res.data.find((d) => d.id === 'qwen3-coder')).toBeDefined();
        // Only the alias is exposed, not the model-key entry separately.
        expect(res.data.filter((d) => d.id === 'qwen3-coder')).toHaveLength(1);
    });

    it('skips aliases that point to providers without their API key set', () => {
        setUpKeys({ nan: true, openai: false });
        const controller = new ModelsController(makeRegistry(), makeAccess());

        const res = controller.list(makeRequest());
        // All three default aliases are nan-routed, so they all show.
        // (`fast` points to openai/gpt-4o-mini — api key missing — skipped.)
        const ids = res.data.map((d) => d.id).sort();
        expect(ids).toEqual(['coder', 'default']);
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
            makeAccess(),
        );

        const res = controller.list(makeRequest());
        expect(res.data.find((d) => d.id === 'ghost')).toBeUndefined();
        expect(res.data.find((d) => d.id === 'broken')).toBeUndefined();
        expect(res.data.find((d) => d.id === 'valid')).toBeDefined();
    });

    it('returns an empty list when no providers are configured', () => {
        setUpKeys({});
        const controller = new ModelsController(makeRegistry(), makeAccess());

        const res = controller.list(makeRequest());
        expect(res.data).toEqual([]);
    });

    it('uses a stable created timestamp per process instance', () => {
        setUpKeys({ nan: true });
        const controller = new ModelsController(makeRegistry(), makeAccess());

        const first = controller.list(makeRequest());
        const second = controller.list(makeRequest());
        expect(first.data[0].created).toBe(second.data[0].created);
    });
});

/**
 * Allowlist filtering. Same `getAccess`/`isPermitted` rule as the request gate:
 * an alias the client may not CALL must not be ADVERTISED, or every client SDK
 * would offer a model that answers 403.
 */
describe('ModelsController allowlist filtering', () => {
    // Same instant the block above pins, so `created` stays deterministic.
    const createdAtFloor = 1_700_000_000;

    beforeEach(() => {
        jest.spyOn(Date, 'now').mockReturnValue(createdAtFloor * 1000);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('lists every reachable alias for a client with NO rows (unrestricted)', () => {
        setUpKeys({ nan: true, openai: true });
        const controller = new ModelsController(makeRegistry(), makeAccess());

        const res = controller.list(makeRequest());

        expect(res.data.map((d) => d.id).sort()).toEqual(['coder', 'default', 'fast']);
    });

    it('lists ONLY the aliases in a restricted client allowlist', () => {
        setUpKeys({ nan: true, openai: true });
        const controller = new ModelsController(
            makeRegistry(),
            makeAccess(['coder', 'fast']),
        );

        const res = controller.list(makeRequest());

        expect(res.data.map((d) => d.id).sort()).toEqual(['coder', 'fast']);
    });

    it('hides a permitted alias that is not reachable (both rules compose)', () => {
        // `fast` needs the openai key; permitted but unreachable must stay hidden,
        // exactly as it is for an unrestricted client.
        setUpKeys({ nan: true, openai: false });
        const controller = new ModelsController(
            makeRegistry(),
            makeAccess(['coder', 'fast']),
        );

        const res = controller.list(makeRequest());

        expect(res.data.map((d) => d.id)).toEqual(['coder']);
    });

    it('returns an empty list when the allowlist matches no alias', () => {
        setUpKeys({ nan: true, openai: true });
        const controller = new ModelsController(
            makeRegistry(),
            makeAccess(['ghost-alias']),
        );

        const res = controller.list(makeRequest());

        expect(res.data).toEqual([]);
        // Still a well-formed OpenAI list, not an error.
        expect(res.object).toBe('list');
    });

    it('does not leak aliases the client is not permitted to use', () => {
        setUpKeys({ nan: true, openai: true });
        const controller = new ModelsController(makeRegistry(), makeAccess(['coder']));

        const payload = JSON.stringify(controller.list(makeRequest()));

        expect(payload).toContain('coder');
        expect(payload).not.toContain('default');
        expect(payload).not.toContain('fast');
    });

    it('leaves anonymous traffic unrestricted', () => {
        setUpKeys({ nan: true, openai: true });
        const controller = new ModelsController(
            makeRegistry(),
            makeAccess(['coder']),
        );

        const res = controller.list(makeRequest(null));

        expect(res.data.map((d) => d.id).sort()).toEqual(['coder', 'default', 'fast']);
    });
});
