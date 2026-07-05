jest.mock('openai', () => {
    const local = jest.fn();
    const Ctor = jest.fn().mockImplementation(() => ({
        chat: { completions: { create: local } },
    }));
    return { __esModule: true, default: Ctor };
});

import OpenAI from 'openai';
import { ChatService } from './chat.service';
import { ProviderService } from '../providers/provider.service';
import type { Env } from '../config/env.schema';
import type { ResolvedModel } from '../providers/provider.model';
import type { RouteExecutor, RouteResult, RoutingService } from '../routing/routing.service';

const OpenAICtor = OpenAI as unknown as jest.Mock;

const fakeEnv: Env = {
    NODE_ENV: 'test',
    PORT: 3000,
    LLM_PROVIDER_API_KEY: undefined,
    LLM_PROVIDER_BASE_URL: 'https://example.com/v1',
    CORS_ORIGINS: '',
    START_TOKEN: undefined,
    MS: 'ms-gateway-llm',
};

/**
 * Build a fake ProviderService for tests. Resolves to a deterministic
 * ResolvedModel and exposes a mocked OpenAI client. The wiring layer that
 * ultimately drives the SDK now lives in the executor passed to the router.
 */
function makeFakeProvider(model = 'gpt-test', upstream = 'gpt-test'): {
    provider: ProviderService;
    resolved: ResolvedModel;
    clientFor: jest.Mock;
    create: jest.Mock;
} {
    const resolved: ResolvedModel = {
        requestedAs: model,
        providerId: 'test',
        modelKey: model,
        upstreamModel: upstream,
        apiKey: 'sk-fake',
        baseURL: 'https://example.com/v1',
        overrides: {},
        supportsStream: true,
        timeoutMs: 30_000,
    };
    const create = jest.fn();
    const clientFor = jest.fn().mockReturnValue({ chat: { completions: { create } } });
    const resolve = jest.fn().mockReturnValue(resolved);
    const resolveChain = jest.fn().mockReturnValue([resolved]);
    const provider = { resolve, resolveChain, clientFor } as unknown as ProviderService;
    return { provider, resolved, clientFor, create };
}

/**
 * Build a fake RoutingService. The fake's `route()` just invokes the
 * executor on the first available resolved model with a fresh AbortSignal.
 * Tests that need fallback / circuit behavior cover that at the
 * RoutingService spec level.
 */
function makeFakeRouter(resolved: ResolvedModel): {
    router: RoutingService;
    route: jest.Mock;
    receivedBody: () => any;
    receivedExecutor: () => RouteExecutor | undefined;
} {
    const route = jest.fn();
    let captured: { body: any; executor: RouteExecutor } | undefined;
    route.mockImplementation(async (model: string, body: any, executor: RouteExecutor) => {
        captured = { body, executor };
        const result = await executor(resolved, new AbortController().signal);
        const out: RouteResult = {
            result,
            providerId: resolved.providerId,
            attempts: [],
        };
        return out;
    });
    const router = { route } as unknown as RoutingService;
    return {
        router,
        route,
        receivedBody: () => captured?.body,
        receivedExecutor: () => captured?.executor,
    };
}

function buildSampleBody(overrides: Record<string, unknown> = {}) {
    return {
        model: 'gpt-test',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
        ...overrides,
    };
}

describe('ChatService.completions', () => {
    beforeEach(() => {
        OpenAICtor.mockClear();
    });

    it('delegates to RoutingService.route and forwards its result', async () => {
        const fake = makeFakeProvider('gpt-test', 'gpt-real');
        const router = makeFakeRouter(fake.resolved);
        const service = new ChatService(fakeEnv, fake.provider, router.router);

        fake.create.mockResolvedValueOnce({ id: 'cmpl-1' });
        const result = await service.completions(buildSampleBody() as any);

        expect(router.route).toHaveBeenCalledTimes(1);
        const [modelArg, bodyArg] = router.route.mock.calls[0];
        expect(modelArg).toBe('gpt-test');
        expect(bodyArg).toMatchObject({ model: 'gpt-test' });

        expect(fake.clientFor).toHaveBeenCalledWith(fake.resolved);
        expect(fake.create).toHaveBeenCalledTimes(1);
        const [bodyPass, optsPass] = fake.create.mock.calls[0];
        expect(bodyPass.model).toBe('gpt-real');
        expect(bodyPass.messages).toEqual([{ role: 'user', content: 'hi' }]);
        // Signal option plumbed through the executor.
        expect(optsPass).toBeDefined();
        expect(optsPass.signal).toBeInstanceOf(AbortSignal);

        expect(result).toEqual({ id: 'cmpl-1' });
    });

    it('returns the SDK stream untouched when stream=true', async () => {
        const fake = makeFakeProvider();
        const router = makeFakeRouter(fake.resolved);
        const service = new ChatService(fakeEnv, fake.provider, router.router);

        async function* fakeStream() {
            yield { id: 'c1', choices: [{ delta: { content: 'a' } }] };
            yield { id: 'c2', choices: [{ delta: { content: 'b' } }] };
        }
        const stream = fakeStream();
        fake.create.mockResolvedValueOnce(stream);

        const result = await service.completions(
            buildSampleBody({ stream: true }) as any,
        );

        expect(result).toBe(stream);

        const chunks: any[] = [];
        for await (const chunk of result as any) {
            chunks.push(chunk);
        }
        expect(chunks).toHaveLength(2);
    });

    it('normalizes the body before calling the upstream (merges system messages)', async () => {
        const fake = makeFakeProvider();
        const router = makeFakeRouter(fake.resolved);
        const service = new ChatService(fakeEnv, fake.provider, router.router);
        fake.create.mockResolvedValueOnce({});

        await service.completions({
            model: 'gpt-test',
            messages: [
                { role: 'system', content: 'be brief' },
                { role: 'system', content: 'use Spanish' },
                { role: 'user', content: 'saluda' },
            ],
        } as any);

        const arg = fake.create.mock.calls[0][0];
        expect(arg.messages).toHaveLength(2);
        expect(arg.messages[0]).toEqual({
            role: 'system',
            content: 'be brief\n\nuse Spanish',
        });
        expect(arg.messages[1]).toEqual({
            role: 'user',
            content: 'saluda',
        });
    });

    it('applies maxTokens from the resolved model when the caller did not set it', async () => {
        const fake = makeFakeProvider();
        (fake.resolved.overrides as { maxTokens?: number }).maxTokens = 4096;
        const router = makeFakeRouter(fake.resolved);
        const service = new ChatService(fakeEnv, fake.provider, router.router);
        fake.create.mockResolvedValueOnce({});

        await service.completions(buildSampleBody() as any);

        const arg = fake.create.mock.calls[0][0];
        expect(arg.max_tokens).toBe(4096);
    });

    it('does not overwrite caller-provided max_tokens', async () => {
        const fake = makeFakeProvider();
        (fake.resolved.overrides as { maxTokens?: number }).maxTokens = 4096;
        const router = makeFakeRouter(fake.resolved);
        const service = new ChatService(fakeEnv, fake.provider, router.router);
        fake.create.mockResolvedValueOnce({});

        await service.completions(buildSampleBody({ max_tokens: 99 }) as any);

        const arg = fake.create.mock.calls[0][0];
        expect(arg.max_tokens).toBe(99);
    });

    it('propagates errors from resolveChain (rejected upstream of the executor)', async () => {
        const fake = makeFakeProvider();
        const router = {
            route: jest
                .fn()
                .mockRejectedValue(new Error('Unknown model "nope"')),
        } as unknown as RoutingService;
        const service = new ChatService(fakeEnv, fake.provider, router);

        await expect(service.completions(buildSampleBody() as any))
            .rejects.toThrow(/Unknown model/);
    });

    it('propagates upstream errors from the OpenAI client', async () => {
        const fake = makeFakeProvider();
        const router = makeFakeRouter(fake.resolved);
        const service = new ChatService(fakeEnv, fake.provider, router.router);
        fake.create.mockRejectedValueOnce(new Error('upstream boom'));

        await expect(service.completions(buildSampleBody() as any))
            .rejects.toThrow('upstream boom');
    });
});
