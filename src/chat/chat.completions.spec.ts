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
import { RequestLogService } from '../observability/request-log.service';
import { RoutingFailedError } from '../routing/routing.service';

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
 * ResolvedModel and exposes a mocked OpenAI client.
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

/** A fake RequestLogService — methods are no-ops so ChatService's logging
 *  call doesn't crash in unit tests. Real behavior is covered in the
 *  RequestLogService spec. */
function makeFakeLog(): RequestLogService {
    return {
        recordSuccess: jest.fn(),
        recordFailure: jest.fn(),
    } as unknown as RequestLogService;
}

/** A fake RoutingService: invokes the supplied executor and packages the
 *  result. Use `failWith` to simulate a router-level rejection. */
function makeFakeRouter(
    resolved: ResolvedModel,
    opts: { failWith?: Error } = {},
): {
    router: RoutingService;
    route: jest.Mock;
} {
    const route = jest.fn();
    if (opts.failWith) {
        route.mockRejectedValue(opts.failWith);
    } else {
        route.mockImplementation(
            async (_model: string, _body: any, executor: RouteExecutor) => {
                const result = await executor(resolved, new AbortController().signal);
                const out: RouteResult = {
                    result,
                    providerId: resolved.providerId,
                    attempts: [
                        {
                            providerId: resolved.providerId,
                            upstreamModel: resolved.upstreamModel,
                            ok: true,
                            durationMs: 1,
                        },
                    ],
                };
                return out;
            },
        );
    }
    const router = { route } as unknown as RoutingService;
    return { router, route };
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
        const log = makeFakeLog();
        const service = new ChatService(fakeEnv, fake.provider, router.router, log);

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
        expect(optsPass?.signal).toBeInstanceOf(AbortSignal);

        expect(result).toEqual({ id: 'cmpl-1' });
        expect((log.recordSuccess as jest.Mock)).toHaveBeenCalledTimes(1);
        expect((log.recordSuccess as jest.Mock).mock.calls[0][0]).toMatchObject({
            requestedModel: 'gpt-test',
            resolvedProvider: 'test',
            resolvedModel: 'gpt-real',
            attempts: 1,
        });
    });

    it('returns the SDK stream untouched when stream=true', async () => {
        const fake = makeFakeProvider();
        const router = makeFakeRouter(fake.resolved);
        const service = new ChatService(fakeEnv, fake.provider, router.router, makeFakeLog());

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
        const service = new ChatService(fakeEnv, fake.provider, router.router, makeFakeLog());
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
        const service = new ChatService(fakeEnv, fake.provider, router.router, makeFakeLog());
        fake.create.mockResolvedValueOnce({});

        await service.completions(buildSampleBody() as any);

        const arg = fake.create.mock.calls[0][0];
        expect(arg.max_tokens).toBe(4096);
    });

    it('does not overwrite caller-provided max_tokens', async () => {
        const fake = makeFakeProvider();
        (fake.resolved.overrides as { maxTokens?: number }).maxTokens = 4096;
        const router = makeFakeRouter(fake.resolved);
        const service = new ChatService(fakeEnv, fake.provider, router.router, makeFakeLog());
        fake.create.mockResolvedValueOnce({});

        await service.completions(buildSampleBody({ max_tokens: 99 }) as any);

        const arg = fake.create.mock.calls[0][0];
        expect(arg.max_tokens).toBe(99);
    });

    it('propagates errors from the router and records a failure log', async () => {
        const fake = makeFakeProvider();
        const router = {
            route: jest.fn().mockRejectedValue(new Error('Unknown model "nope"')),
        } as unknown as RoutingService;
        const log = makeFakeLog();
        const service = new ChatService(fakeEnv, fake.provider, router, log);

        await expect(service.completions(buildSampleBody() as any)).rejects.toThrow(
            /Unknown model/,
        );
        expect((log.recordFailure as jest.Mock)).toHaveBeenCalledTimes(1);
    });

    it('records RoutingFailedError with the attempts it carries', async () => {
        const fake = makeFakeProvider();
        const router = {
            route: jest.fn().mockImplementation(() => {
                throw new RoutingFailedError('fast', [
                    {
                        providerId: 'openai',
                        upstreamModel: 'gpt-4o-mini',
                        ok: false,
                        circuitOpen: true,
                        durationMs: 0,
                    },
                ]);
            }),
        } as unknown as RoutingService;
        const log = makeFakeLog();
        const service = new ChatService(fakeEnv, fake.provider, router, log);

        await expect(service.completions(buildSampleBody() as any)).rejects.toBeInstanceOf(
            RoutingFailedError,
        );
        const args = (log.recordFailure as jest.Mock).mock.calls[0][0];
        expect(args.requestedModel).toBe('fast');
        expect(args.attempts).toHaveLength(1);
    });

    it('propagates upstream errors from the OpenAI client', async () => {
        const fake = makeFakeProvider();
        const router = makeFakeRouter(fake.resolved);
        const service = new ChatService(fakeEnv, fake.provider, router.router, makeFakeLog());
        fake.create.mockRejectedValueOnce(new Error('upstream boom'));

        await expect(service.completions(buildSampleBody() as any)).rejects.toThrow(
            'upstream boom',
        );
    });
});
