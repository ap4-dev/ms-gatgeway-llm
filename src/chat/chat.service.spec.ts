import { Logger } from '@nestjs/common';
import {
    ChatService,
    MAX_TOKENS_CEILING,
    REQUEST_PARAMS_SNIPPET_CHARS,
    clampMaxTokens,
    extractText,
    mergeSystemMessages,
    serializeRequestParams,
    type CompletionResult,
} from './chat.service';
import type { ChatMessage } from './chat.service';
import { QuotaExhaustedError } from '../quota/quota.errors';
import type { QuotaService } from '../quota/quota.service';

describe('clampMaxTokens', () => {
    it('leaves requests without max_tokens untouched', () => {
        const body = { model: 'qwen3.6', messages: [] };
        expect(clampMaxTokens(body)).toBe(body);
    });

    it('leaves max_tokens within the accepted range untouched', () => {
        const body = { model: 'qwen3.6', max_tokens: 4096 };
        expect(clampMaxTokens(body)).toBe(body);
    });

    it('leaves max_tokens exactly at the ceiling untouched', () => {
        const body = { model: 'qwen3.6', max_tokens: MAX_TOKENS_CEILING };
        expect(clampMaxTokens(body)).toBe(body);
    });

    it('clamps caller-supplied max_tokens above the upstream ceiling', () => {
        // nan rejects with: "Range of max_tokens should be [1, 131072]".
        const body = { model: 'qwen3.6', max_tokens: 200_000 };
        expect(clampMaxTokens(body).max_tokens).toBe(MAX_TOKENS_CEILING);
    });

    it('does not mutate the input body', () => {
        const body = { model: 'qwen3.6', max_tokens: 500_000 };
        const clamped = clampMaxTokens(body);
        expect(body.max_tokens).toBe(500_000);
        expect(clampMaxTokens(body)).not.toBe(body);
    });

    it('ignores non-numeric max_tokens values', () => {
        const body = { model: 'qwen3.6', max_tokens: 'lots' };
        expect(clampMaxTokens(body as any)).toBe(body);
    });
});

describe('mergeSystemMessages', () => {
    it('returns the input untouched when it is not an array', () => {
        expect(mergeSystemMessages(undefined as unknown as ChatMessage[])).toBeUndefined();
        expect(mergeSystemMessages(null as unknown as ChatMessage[])).toBeNull();
    });

    it('returns an empty array untouched', () => {
        expect(mergeSystemMessages([])).toEqual([]);
    });

    it('returns input unchanged when there are no system messages', () => {
        const messages: ChatMessage[] = [
            { role: 'user', content: 'hello' },
            { role: 'assistant', content: 'hi' },
        ];
        expect(mergeSystemMessages(messages)).toBe(messages);
    });

    it('returns single system message unchanged', () => {
        const messages: ChatMessage[] = [
            { role: 'system', content: 'be nice' },
            { role: 'user', content: 'hi' },
        ];
        const result = mergeSystemMessages(messages);
        expect(result).toHaveLength(2);
        expect(result[0]).toEqual({ role: 'system', content: 'be nice' });
        expect(result[1]).toEqual({ role: 'user', content: 'hi' });
    });

    it('merges consecutive leading system messages into one', () => {
        const messages: ChatMessage[] = [
            { role: 'system', content: 'be nice' },
            { role: 'system', content: 'be concise' },
            { role: 'user', content: 'hi' },
        ];
        const result = mergeSystemMessages(messages);
        expect(result).toHaveLength(2);
        expect(result[0].role).toBe('system');
        expect(result[0].content).toBe('be nice\n\nbe concise');
        expect(result[1]).toEqual({ role: 'user', content: 'hi' });
    });

    it('merges every system message into a single leading one', () => {
        // The implementation collapses ALL system messages regardless of
        // whether they were consecutive in the input. Non-system messages keep
        // their order; systems are hoisted to the front.
        const messages: ChatMessage[] = [
            { role: 'system', content: 'first' },
            { role: 'system', content: 'second' },
            { role: 'user', content: 'hi' },
            { role: 'system', content: 'third' },
            { role: 'assistant', content: 'reply' },
        ];
        const result = mergeSystemMessages(messages);
        expect(result).toHaveLength(3);
        expect(result[0].role).toBe('system');
        expect(result[0].content).toBe('first\n\nsecond\n\nthird');
        expect(result[1]).toEqual({ role: 'user', content: 'hi' });
        expect(result[2]).toEqual({ role: 'assistant', content: 'reply' });
    });

    it('preserves the order of non-system messages', () => {
        const messages: ChatMessage[] = [
            { role: 'system', content: 'sys' },
            { role: 'user', content: 'a' },
            { role: 'assistant', content: 'b' },
            { role: 'user', content: 'c' },
        ];
        const result = mergeSystemMessages(messages);
        expect(result.map((m) => m.content)).toEqual(['sys', 'a', 'b', 'c']);
    });

    it('keeps other metadata (name) from the first system message', () => {
        const messages: ChatMessage[] = [
            { role: 'system', content: 'first', name: 'instructions' },
            { role: 'system', content: 'second' },
        ];
        const result = mergeSystemMessages(messages);
        expect(result[0].name).toBe('instructions');
        expect(result[0].content).toBe('first\n\nsecond');
    });

    it('extracts text from array content (e.g. multimodal parts)', () => {
        // Within a single message, parts are concatenated without a separator
        // (extractText.join("")). Across messages they are joined with "\n\n".
        const messages: ChatMessage[] = [
            { role: 'system', content: [{ type: 'text', text: 'sys a' }] },
            {
                role: 'system',
                content: [{ type: 'text', text: 'sys b' }, { type: 'text', text: 'sys c' }],
            },
        ];
        const result = mergeSystemMessages(messages);
        expect(result[0].content).toBe('sys a\n\nsys bsys c');
    });

    it('skips empty system messages when merging', () => {
        const messages: ChatMessage[] = [
            { role: 'system', content: '' },
            { role: 'system', content: 'real' },
            { role: 'system', content: '' },
        ];
        const result = mergeSystemMessages(messages);
        expect(result[0].content).toBe('real');
    });

    it('falls back to the first system content if all systems are empty', () => {
        const messages: ChatMessage[] = [
            { role: 'system', content: '' },
            { role: 'system', content: '' },
        ];
        const result = mergeSystemMessages(messages);
        expect(result).toHaveLength(1);
        expect(result[0].content).toBe('');
    });
});

describe('extractText', () => {
    it('returns string content unchanged', () => {
        expect(extractText('hello')).toBe('hello');
    });

    it('joins an array of plain strings', () => {
        expect(extractText(['a', 'b', 'c'])).toBe('abc');
    });

    it('extracts `text` from object parts', () => {
        expect(extractText([{ text: 'a' }, { text: 'b' }])).toBe('ab');
    });

    it('coerces missing/null text to empty string', () => {
        expect(extractText([{ text: null }, { text: undefined }])).toBe('');
    });

    it('returns empty string for non-string, non-array content', () => {
        expect(extractText(42 as unknown as string)).toBe('');
        expect(extractText(null as unknown as string)).toBe('');
        expect(extractText({} as unknown as string)).toBe('');
    });
});

describe('serializeRequestParams', () => {
    it('excludes messages from the serialized params', () => {
        const out = serializeRequestParams({
            model: 'fast',
            messages: [{ role: 'user', content: 'hello' }],
        });
        expect(out).not.toBeNull();
        const parsed = JSON.parse(out as string);
        expect(parsed.messages).toBeUndefined();
        expect(parsed.model).toBe('fast');
    });

    it('includes scalar request params', () => {
        const out = serializeRequestParams({
            model: 'fast',
            max_tokens: 512,
            temperature: 0.2,
            stream: true,
            messages: [{ role: 'user', content: 'hi' }],
        });
        const parsed = JSON.parse(out as string);
        expect(parsed).toMatchObject({
            model: 'fast',
            max_tokens: 512,
            temperature: 0.2,
            stream: true,
        });
    });

    it('truncates a long first user message at the snippet cap with an ellipsis', () => {
        const long = 'x'.repeat(REQUEST_PARAMS_SNIPPET_CHARS + 50);
        const out = serializeRequestParams({
            model: 'fast',
            messages: [{ role: 'user', content: long }],
        });
        const parsed = JSON.parse(out as string);
        expect(parsed.first_user_message).toHaveLength(
            REQUEST_PARAMS_SNIPPET_CHARS + 1,
        );
        expect(parsed.first_user_message.endsWith('\u2026')).toBe(true);
        expect(
            parsed.first_user_message.startsWith(
                'x'.repeat(REQUEST_PARAMS_SNIPPET_CHARS),
            ),
        ).toBe(true);
    });

    it('does not add an ellipsis when the first user message fits', () => {
        const out = serializeRequestParams({
            model: 'fast',
            messages: [{ role: 'user', content: 'short' }],
        });
        expect(JSON.parse(out as string).first_user_message).toBe('short');
    });

    it('extracts text from array-content user messages via extractText', () => {
        const out = serializeRequestParams({
            model: 'fast',
            messages: [
                { role: 'system', content: 'sys' },
                {
                    role: 'user',
                    content: [
                        { type: 'text', text: 'part-a' },
                        { type: 'text', text: 'part-b' },
                    ],
                },
            ],
        });
        expect(JSON.parse(out as string).first_user_message).toBe('part-apart-b');
    });

    it('returns null for null or undefined bodies', () => {
        expect(serializeRequestParams(null)).toBeNull();
        expect(serializeRequestParams(undefined)).toBeNull();
    });

    it('includes first_user_message when the body has only messages', () => {
        const out = serializeRequestParams({
            messages: [{ role: 'user', content: 'only message' }],
        });
        expect(out).not.toBeNull();
        const parsed = JSON.parse(out as string);
        expect(parsed.first_user_message).toBe('only message');
        expect(parsed.messages).toBeUndefined();
    });

    it('drops first_user_message and re-serializes when the JSON exceeds the cap', () => {
        // 3000 chars of metadata blow past the 2048-char cap; dropping the
        // 200-char snippet brings the row back under it.
        const out = serializeRequestParams({
            model: 'fast',
            max_tokens: 512,
            metadata: { note: 'z'.repeat(2000) },
            messages: [{ role: 'user', content: 'short' }],
        });
        const parsed = JSON.parse(out as string);
        expect(parsed.first_user_message).toBeUndefined();
        expect(parsed.max_tokens).toBe(512);
    });

    it('falls back to the core scalars when even the trimmed JSON exceeds the cap', () => {
        const out = serializeRequestParams({
            model: 'fast',
            max_tokens: 4096,
            temperature: 0.5,
            stream: true,
            metadata: { note: 'z'.repeat(3000) },
            messages: [{ role: 'user', content: 'short' }],
        });
        expect(JSON.parse(out as string)).toEqual({
            model: 'fast',
            max_tokens: 4096,
            temperature: 0.5,
            stream: true,
        });
    });

    it('returns null when the oversized body has no core scalar params', () => {
        const out = serializeRequestParams({
            metadata: { note: 'z'.repeat(3000) },
            messages: [{ role: 'user', content: 'short' }],
        });
        expect(out).toBeNull();
    });

    it('never throws on non-serializable bodies and returns null', () => {
        expect(() => serializeRequestParams(() => undefined)).not.toThrow();
        expect(serializeRequestParams(() => undefined)).toBeNull();

        const circular: Record<string, unknown> = { model: 'fast' };
        circular.self = circular;
        expect(() => serializeRequestParams(circular)).not.toThrow();
        expect(serializeRequestParams(circular)).toBeNull();
    });
});

// ---------------------------------------------------------------------------
// Quota gate wiring (feature plan §4/§5, work unit T4a)
//
// `ChatService` is constructed directly with fakes: the class is plain
// TypeScript apart from `@Inject`, so no Nest testing module is needed to
// assert which alias reached the router and what got accounted.
// ---------------------------------------------------------------------------

/** Fixed request instant, so `requestedAt` and the accounted period are deterministic. */
const FIXED_NOW_MS = Date.parse('2026-11-30T23:59:59Z');
/** What `completions` derives from `Date.now()`: UNIX seconds, floored, then ms again. */
const REQUESTED_AT_MS = Math.floor(FIXED_NOW_MS / 1000) * 1000;

const QUOTA_MESSAGES = [{ role: 'user', content: 'hola' }];
const TOTAL_TOKENS = 33;

/** `ChatCompletion`-shaped buffered result carrying real upstream usage. */
function bufferedResult(): CompletionResult {
    return {
        id: 'cmpl-quota',
        usage: {
            prompt_tokens: 11,
            completion_tokens: TOTAL_TOKENS - 11,
            total_tokens: TOTAL_TOKENS,
        },
    } as unknown as CompletionResult;
}

/** Stream that ends with a `usage` chunk, like an upstream honouring `include_usage`. */
function usageStream(): AsyncIterable<any> {
    return (async function* () {
        yield { choices: [{ delta: { content: 'ho' } }] };
        yield { choices: [{ delta: { content: 'la' } }] };
        yield {
            choices: [],
            usage: {
                prompt_tokens: 11,
                completion_tokens: TOTAL_TOKENS - 11,
                total_tokens: TOTAL_TOKENS,
            },
        };
    })();
}

/** Stream that dies mid-flight — the only way to reach the `.catch()` path. */
function failingStream(): AsyncIterable<any> {
    return (async function* () {
        yield { choices: [{ delta: { content: 'par' } }] };
        throw new Error('upstream died mid-stream');
    })();
}

/** Let the fire-and-forget accounting of a streamed response settle. */
const flushAsync = (): Promise<void> =>
    new Promise<void>((resolve) => setImmediate(resolve));

interface QuotaHarness {
    service: ChatService;
    route: jest.Mock;
    resolveTarget: jest.Mock;
    recordUsage: jest.Mock;
    recordSuccess: jest.Mock;
    recordFailure: jest.Mock;
}

function makeQuotaHarness(opts: {
    result: CompletionResult;
    resolveTarget?: (clientId: string | null, alias: string) => string;
}): QuotaHarness {
    const route = jest.fn().mockResolvedValue({
        result: opts.result,
        providerId: 'provider-a',
        attempts: [
            {
                providerId: 'provider-a',
                upstreamModel: 'upstream-x',
                ok: true,
                durationMs: 1,
            },
        ],
    });
    const providers = {
        clientFor: jest
            .fn()
            .mockReturnValue({ chat: { completions: { create: jest.fn() } } }),
    } as any;
    const recordSuccess = jest.fn();
    const recordFailure = jest.fn();
    const requestLog = {
        recordSuccess,
        recordFailure,
        recordAttemptFailure: jest.fn(),
    } as any;
    const structuredLog = { logRequest: jest.fn() } as any;
    const recordUsage = jest.fn();
    const resolveTarget = jest.fn(
        opts.resolveTarget ?? ((_clientId: string | null, alias: string) => alias),
    );
    const quota = { resolveTarget, recordUsage } as unknown as QuotaService;
    const service = new ChatService(
        {} as any,
        providers,
        { route } as any,
        requestLog,
        structuredLog,
        quota,
    );
    return { service, route, resolveTarget, recordUsage, recordSuccess, recordFailure };
}

describe('ChatService quota gate', () => {
    beforeEach(() => {
        jest.spyOn(Date, 'now').mockReturnValue(FIXED_NOW_MS);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('routes with the requested alias and accounts usage against it while under quota', async () => {
        const harness = makeQuotaHarness({ result: bufferedResult() });

        const result = await harness.service.completions(
            { model: 'codex', messages: QUOTA_MESSAGES } as any,
            'client-1',
        );

        expect(result).toBe((await harness.route.mock.results[0].value).result);
        expect(harness.route).toHaveBeenCalledTimes(1);
        expect(harness.route.mock.calls[0][0]).toBe('codex');
        expect(harness.recordUsage).toHaveBeenCalledTimes(1);
        expect(harness.recordUsage).toHaveBeenCalledWith(
            'client-1',
            'codex',
            TOTAL_TOKENS,
            REQUESTED_AT_MS,
        );
    });

    it('routes with the divert alias and charges it instead of the exhausted alias', async () => {
        const harness = makeQuotaHarness({
            result: bufferedResult(),
            resolveTarget: (_clientId, alias) =>
                alias === 'codex' ? 'slave' : alias,
        });

        await harness.service.completions(
            { model: 'codex', messages: QUOTA_MESSAGES } as any,
            'client-1',
        );

        expect(harness.route.mock.calls[0][0]).toBe('slave');
        expect(harness.recordUsage).toHaveBeenCalledTimes(1);
        expect(harness.recordUsage).toHaveBeenCalledWith(
            'client-1',
            'slave',
            TOTAL_TOKENS,
            REQUESTED_AT_MS,
        );
        // The exhausted alias's counter must freeze, never be charged.
        expect(harness.recordUsage.mock.calls.map((call) => call[1])).not.toContain(
            'codex',
        );
    });

    it('propagates QuotaExhaustedError without routing and still logs one failure row', async () => {
        const exhausted = new QuotaExhaustedError({
            clientId: 'client-1',
            aliasKey: 'codex',
            periodKey: '2026-11',
            limit: 20_000_000,
            used: 20_000_000,
            resetsAt: Date.UTC(2026, 11, 1) / 1000,
        });
        const harness = makeQuotaHarness({
            result: bufferedResult(),
            resolveTarget: () => {
                throw exhausted;
            },
        });

        await expect(
            harness.service.completions(
                { model: 'codex', messages: QUOTA_MESSAGES } as any,
                'client-1',
            ),
        ).rejects.toBe(exhausted);

        expect(harness.route).not.toHaveBeenCalled();
        expect(harness.recordFailure).toHaveBeenCalledTimes(1);
        expect(harness.recordUsage).not.toHaveBeenCalled();
    });

    it('accounts streamed usage only once the returned iterable has been consumed', async () => {
        const harness = makeQuotaHarness({ result: usageStream() });

        const result = await harness.service.completions(
            { model: 'codex', messages: QUOTA_MESSAGES, stream: true } as any,
            'client-1',
        );

        expect(harness.recordUsage).not.toHaveBeenCalled();

        const chunks: any[] = [];
        for await (const chunk of result as AsyncIterable<any>) {
            chunks.push(chunk);
        }
        await flushAsync();

        expect(chunks).toHaveLength(3);
        expect(harness.recordUsage).toHaveBeenCalledTimes(1);
        expect(harness.recordUsage).toHaveBeenCalledWith(
            'client-1',
            'codex',
            TOTAL_TOKENS,
            REQUESTED_AT_MS,
        );
    });

    it('accounts a prompt-only estimate when the stream dies mid-flight', async () => {
        const harness = makeQuotaHarness({ result: failingStream() });

        const result = await harness.service.completions(
            { model: 'codex', messages: QUOTA_MESSAGES, stream: true } as any,
            'client-1',
        );

        // The iteration error still reaches the consumer; only the *logging*
        // side is swallowed, so the accounting failure never re-enters it.
        await expect(
            (async () => {
                for await (const _chunk of result as AsyncIterable<any>) {
                    // drain until the upstream throws
                }
            })(),
        ).rejects.toThrow('upstream died mid-stream');

        await flushAsync();

        // Same estimator the stream fallback uses, with the tap buffer empty
        // (the chunks were lost with the rejection) → prompt-only estimate.
        const expectedPromptTokens = Math.max(
            1,
            Math.ceil(JSON.stringify(QUOTA_MESSAGES).length / 4),
        );
        expect(harness.recordUsage).toHaveBeenCalledTimes(1);
        expect(harness.recordUsage).toHaveBeenCalledWith(
            'client-1',
            'codex',
            expectedPromptTokens,
            REQUESTED_AT_MS,
        );
        // recordSuccess keeps its historical `tokens: undefined` on that path.
        expect(harness.recordSuccess).toHaveBeenCalledTimes(1);
        expect(harness.recordSuccess.mock.calls[0][7]).toBeUndefined();
    });

    it('does not fall back to the rejected-stream handler when the success handler throws', async () => {
        // R3-001: `logged.then(f).catch(g)` also routes a throw from `f` into
        // `g`, which writes a SECOND request_logs row + a second accounting
        // entry for the same request. Force `f` to throw by making the row
        // write inside `recordSuccess` blow up; the rejected-stream handler
        // must stay unreachable.
        const harness = makeQuotaHarness({ result: usageStream() });
        harness.recordSuccess.mockImplementationOnce(() => {
            throw new Error('sqlite write failed');
        });
        const warn = jest
            .spyOn(Logger.prototype, 'warn')
            .mockImplementation(() => undefined as any);

        const result = await harness.service.completions(
            { model: 'codex', messages: QUOTA_MESSAGES, stream: true } as any,
            'client-1',
        );

        // The post-processing failure happens off the response path, so the
        // consumer still drains the stream cleanly.
        const chunks: any[] = [];
        for await (const chunk of result as AsyncIterable<any>) {
            chunks.push(chunk);
        }
        await flushAsync();

        expect(chunks).toHaveLength(3);
        // Exactly one attempt: a second call would be the rejected-stream
        // branch re-recording the same request.
        expect(harness.recordSuccess).toHaveBeenCalledTimes(1);
        // The prompt-only estimate of the rejected-stream branch must not run
        // either — it would double-count the spend.
        expect(harness.recordUsage).not.toHaveBeenCalled();
        // The derived rejection is swallowed and reported, never left dangling.
        expect(warn).toHaveBeenCalledWith(
            expect.stringContaining('stream post-processing failed'),
        );
    });

    it('never turns a successful response into an error when accounting fails', async () => {
        const harness = makeQuotaHarness({ result: bufferedResult() });
        harness.recordUsage.mockImplementationOnce(() => {
            throw new Error('sqlite is unavailable');
        });
        const warn = jest
            .spyOn(Logger.prototype, 'warn')
            .mockImplementation(() => undefined as any);

        const result = await harness.service.completions(
            { model: 'codex', messages: QUOTA_MESSAGES } as any,
            'client-1',
        );

        expect(result).toMatchObject({ id: 'cmpl-quota' });
        expect(warn).toHaveBeenCalledTimes(1);
    });
});
