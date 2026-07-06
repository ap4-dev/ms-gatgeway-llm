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
import { LlmLoggingService } from '../observability/llm-logging.service';
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
        priority: 0,
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

/** Same idea for the structured-logging service. */
function makeFakeStructuredLog(): LlmLoggingService {
    return {
        logRequest: jest.fn(),
    } as unknown as LlmLoggingService;
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
        const service = new ChatService(fakeEnv, fake.provider, router.router, log, makeFakeStructuredLog());

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
        const successArgs = (log.recordSuccess as jest.Mock).mock.calls[0][0];
        expect(successArgs).toMatchObject({
            requestedModel: 'gpt-test',
            resolvedProvider: 'test',
            resolvedModel: 'gpt-real',
            attempts: 1,
        });
        // Prompt hash must be a stable 16-char hex.
        expect(successArgs.promptHash).toMatch(/^[0-9a-f]{16}$/);
    });

    it('captures upstream token counts from the ChatCompletion.usage payload', async () => {
        const fake = makeFakeProvider();
        const router = makeFakeRouter(fake.resolved);
        const log = makeFakeLog();
        const structuredLog = makeFakeStructuredLog();
        const service = new ChatService(
            fakeEnv,
            fake.provider,
            router.router,
            log,
            structuredLog,
        );

        fake.create.mockResolvedValueOnce({
            id: 'cmpl-1',
            usage: {
                prompt_tokens: 42,
                completion_tokens: 17,
                total_tokens: 59,
            },
        });
        await service.completions(buildSampleBody() as any);

        const successArgs = (log.recordSuccess as jest.Mock).mock.calls[0][0];
        expect(successArgs.promptTokens).toBe(42);
        expect(successArgs.completionTokens).toBe(17);
        expect(successArgs.totalTokens).toBe(59);

        // Structured log carries the same numbers.
        const event = (structuredLog.logRequest as jest.Mock).mock.calls[0][0];
        expect(event).toMatchObject({
            status: 'ok',
            promptTokens: 42,
            completionTokens: 17,
            totalTokens: 59,
            promptHash: expect.any(String),
        });
    });

    it('emits a structured chat.request event on success with status=ok', async () => {
        const fake = makeFakeProvider();
        const router = makeFakeRouter(fake.resolved);
        const structuredLog = makeFakeStructuredLog();
        const service = new ChatService(
            fakeEnv,
            fake.provider,
            router.router,
            makeFakeLog(),
            structuredLog,
        );
        fake.create.mockResolvedValueOnce({ id: 'cmpl-1' });
        await service.completions(buildSampleBody() as any);
        const event = (structuredLog.logRequest as jest.Mock).mock.calls[0][0];
        expect(event.event).toBe('chat.request');
        expect(event.status).toBe('ok');
        expect(event.model).toBe('gpt-test');
        expect(event.resolvedProvider).toBe('test');
        expect(event.resolvedModel).toBe('gpt-test');
        expect(event.attempts).toBe(1);
        expect(event.promptHash).toMatch(/^[0-9a-f]{16}$/);
    });

    it('forwards the upstream stream live (TTFT preserved) and logs after iteration when stream=true', async () => {
        const fake = makeFakeProvider();
        const router = makeFakeRouter(fake.resolved);
        const service = new ChatService(fakeEnv, fake.provider, router.router, makeFakeLog(), makeFakeStructuredLog());

        async function* fakeStream() {
            yield { id: 'c1', choices: [{ delta: { content: 'a' } }] };
            yield { id: 'c2', choices: [{ delta: { content: 'b' } }] };
        }
        fake.create.mockResolvedValueOnce(fakeStream());

        const result = await service.completions(
            buildSampleBody({ stream: true }) as any,
        );

        // Tee wraps the source — caller iterates a *different* object that
        // pulls from the upstream iterable on demand. No front-buffer.
        expect(result).toBeDefined();
        expect(typeof result[Symbol.asyncIterator]).toBe('function');

        const chunks: any[] = [];
        for await (const chunk of result as any) {
            chunks.push(chunk);
        }
        expect(chunks).toHaveLength(2);
        expect(chunks[0].id).toBe('c1');
        expect(chunks[1].id).toBe('c2');
    });

    it('captures token counts from the final usage chunk after streaming completes', async () => {
        const fake = makeFakeProvider();
        const router = makeFakeRouter(fake.resolved);
        const log = makeFakeLog();
        const structuredLog = makeFakeStructuredLog();
        const service = new ChatService(
            fakeEnv,
            fake.provider,
            router.router,
            log,
            structuredLog,
        );

        async function* fakeStream() {
            yield { id: 'c1', choices: [{ delta: { content: 'a' } }] };
            yield {
                id: 'c2',
                choices: [{ delta: {}, finish_reason: 'stop' }],
                usage: {
                    prompt_tokens: 42,
                    completion_tokens: 17,
                    total_tokens: 59,
                },
            };
        }
        fake.create.mockResolvedValueOnce(fakeStream());

        const stream = (await service.completions(
            buildSampleBody({ stream: true }) as any,
        )) as AsyncIterable<any>;

        // Logging is async — it fires after the controller finishes iterating.
        expect((log.recordSuccess as jest.Mock)).not.toHaveBeenCalled();
        for await (const _chunk of stream) {
            /* drain */
        }
        // Allow the post-iteration microtask (logged.then(...)) to flush.
        await new Promise((r) => setImmediate(r));

        const successArgs = (log.recordSuccess as jest.Mock).mock.calls[0][0];
        expect(successArgs.promptTokens).toBe(42);
        expect(successArgs.completionTokens).toBe(17);
        expect(successArgs.totalTokens).toBe(59);

        const event = (structuredLog.logRequest as jest.Mock).mock.calls[0][0];
        expect(event).toMatchObject({
            status: 'ok',
            promptTokens: 42,
            completionTokens: 17,
            totalTokens: 59,
        });
    });

    it('estimates token counts when the upstream never surfaces usage in the stream', async () => {
        const fake = makeFakeProvider();
        const router = makeFakeRouter(fake.resolved);
        const log = makeFakeLog();
        const service = new ChatService(
            fakeEnv,
            fake.provider,
            router.router,
            log,
            makeFakeStructuredLog(),
        );

        // 40 chars of completion → ceil(40/4) = 10 completion tokens.
        // Prompt body is JSON.stringified by the estimator, so we only
        // assert > 0 + consistency (total = prompt + completion) instead
        // of pinning the prompt number (which depends on field ordering).
        async function* fakeStream() {
            yield {
                id: 'c1',
                choices: [{ delta: { content: 'a'.repeat(40) } }],
            };
        }
        fake.create.mockResolvedValueOnce(fakeStream());

        const stream = (await service.completions(
            buildSampleBody({ stream: true }) as any,
        )) as AsyncIterable<any>;
        for await (const _chunk of stream) {
            /* drain */
        }
        await new Promise((r) => setImmediate(r));

        const successArgs = (log.recordSuccess as jest.Mock).mock.calls[0][0];
        expect(successArgs.promptTokens).toBeGreaterThan(0);
        expect(successArgs.completionTokens).toBe(10);
        expect(successArgs.totalTokens).toBe(
            successArgs.promptTokens + successArgs.completionTokens,
        );
    });

    it('does not block the caller on token logging when streaming', async () => {
        const fake = makeFakeProvider();
        const router = makeFakeRouter(fake.resolved);
        const service = new ChatService(
            fakeEnv,
            fake.provider,
            router.router,
            makeFakeLog(),
            makeFakeStructuredLog(),
        );

        // Upstream yields the first chunk synchronously, then delays the
        // second long enough to prove we don't wait for it before returning.
        async function* slowStream() {
            yield { id: 'c1', choices: [{ delta: { content: 'a' } }] };
            await new Promise((r) => setTimeout(r, 50));
            yield { id: 'c2', choices: [{ delta: {} }] };
        }
        fake.create.mockResolvedValueOnce(slowStream());

        const start = Date.now();
        const result = await service.completions(
            buildSampleBody({ stream: true }) as any,
        );
        const elapsed = Date.now() - start;
        // Return must happen *before* the slow chunk — proves no front-buffer.
        expect(elapsed).toBeLessThan(40);
        expect(result).toBeDefined();

        // Drain so the post-iteration log fires and we don't leak timers.
        for await (const _chunk of result as AsyncIterable<any>) {
            /* drain */
        }
    });

    it('forwards stream_options.include_usage=true to the upstream on streamed requests', async () => {
        const fake = makeFakeProvider();
        const router = makeFakeRouter(fake.resolved);
        const service = new ChatService(fakeEnv, fake.provider, router.router, makeFakeLog(), makeFakeStructuredLog());

        async function* fakeStream() {
            yield { id: 'c1', choices: [{ delta: { content: 'a' } }] };
        }
        fake.create.mockResolvedValueOnce(fakeStream());

        await service.completions(buildSampleBody({ stream: true }) as any);

        const arg = fake.create.mock.calls[0][0];
        expect(arg.stream_options).toEqual({ include_usage: true });
        expect(arg.stream).toBe(true);
    });

    it('does not overwrite caller-provided stream_options', async () => {
        const fake = makeFakeProvider();
        const router = makeFakeRouter(fake.resolved);
        const service = new ChatService(fakeEnv, fake.provider, router.router, makeFakeLog(), makeFakeStructuredLog());

        async function* fakeStream() {
            yield { id: 'c1', choices: [{ delta: { content: 'a' } }] };
        }
        fake.create.mockResolvedValueOnce(fakeStream());

        await service.completions(
            buildSampleBody({
                stream: true,
                stream_options: { include_usage: false },
            }) as any,
        );

        const arg = fake.create.mock.calls[0][0];
        expect(arg.stream_options).toEqual({ include_usage: false });
    });

    it('does not set stream_options for non-streaming requests', async () => {
        const fake = makeFakeProvider();
        const router = makeFakeRouter(fake.resolved);
        const service = new ChatService(fakeEnv, fake.provider, router.router, makeFakeLog(), makeFakeStructuredLog());
        fake.create.mockResolvedValueOnce({ id: 'cmpl-1' });

        await service.completions(buildSampleBody() as any);

        const arg = fake.create.mock.calls[0][0];
        expect(arg.stream_options).toBeUndefined();
    });

    it('normalizes the body before calling the upstream (merges system messages)', async () => {
        const fake = makeFakeProvider();
        const router = makeFakeRouter(fake.resolved);
        const service = new ChatService(fakeEnv, fake.provider, router.router, makeFakeLog(), makeFakeStructuredLog());
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
        const service = new ChatService(fakeEnv, fake.provider, router.router, makeFakeLog(), makeFakeStructuredLog());
        fake.create.mockResolvedValueOnce({});

        await service.completions(buildSampleBody() as any);

        const arg = fake.create.mock.calls[0][0];
        expect(arg.max_tokens).toBe(4096);
    });

    it('does not overwrite caller-provided max_tokens', async () => {
        const fake = makeFakeProvider();
        (fake.resolved.overrides as { maxTokens?: number }).maxTokens = 4096;
        const router = makeFakeRouter(fake.resolved);
        const service = new ChatService(fakeEnv, fake.provider, router.router, makeFakeLog(), makeFakeStructuredLog());
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
        const service = new ChatService(fakeEnv, fake.provider, router, log, makeFakeStructuredLog());

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
        const service = new ChatService(fakeEnv, fake.provider, router, log, makeFakeStructuredLog());

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
        const service = new ChatService(fakeEnv, fake.provider, router.router, makeFakeLog(), makeFakeStructuredLog());
        fake.create.mockRejectedValueOnce(new Error('upstream boom'));

        await expect(service.completions(buildSampleBody() as any)).rejects.toThrow(
            'upstream boom',
        );
    });
});
