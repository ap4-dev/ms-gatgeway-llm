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
import { AliasAccessService } from '../access/alias-access.service';
import type { ClientAliasAccessRepository } from '../database/repositories/client-alias-access.repository';
import { AliasNotPermittedError } from '../access/alias-access.errors';
import { RoutingFailedError } from '../routing/routing.service';

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

/**
 * The REAL `AliasAccessService` over a fake repository.
 *
 * Using the production class (instead of a hand-rolled stub) is deliberate: the
 * "no rows means unrestricted" rule belongs to the service, so a spec that passes
 * here cannot drift from what the request path actually reads. Only the SQLite
 * lookup is faked.
 *
 * `permitted === undefined` means "the client has no rows at all", which is the
 * unrestricted case every existing client is in.
 */
function makeAccess(permitted?: readonly string[]): {
    service: AliasAccessService;
    listByClient: jest.Mock;
} {
    const listByClient = jest.fn(() =>
        (permitted ?? []).map((aliasKey) => ({ clientId: 'client-1', aliasKey })),
    );
    const repo = { listByClient } as unknown as ClientAliasAccessRepository;
    return { service: new AliasAccessService(repo), listByClient };
}

/** Convenience for specs that are not about access at all. */
function unrestrictedAccess(): AliasAccessService {
    return makeAccess().service;
}

interface QuotaHarness {
    service: ChatService;
    route: jest.Mock;
    resolveTarget: jest.Mock;
    recordUsage: jest.Mock;
    recordSuccess: jest.Mock;
    recordFailure: jest.Mock;
    structuredLog: { logRequest: jest.Mock };
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
        // Unrestricted: this file tests the quota gate, so the allowlist must
        // never be the reason a call stops. The guard has its own harness below.
        unrestrictedAccess(),
    );
    return { service, route, resolveTarget, recordUsage, recordSuccess, recordFailure, structuredLog };
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
        // R3-001: a throw out of `recordSuccess` means NEITHER half of the
        // accounting ran, so the tail has to move the quota counter even though
        // the log row is lost. Exactly once — reconciliation can repair
        // under-counting, a double count is unrecoverable.
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
        // The derived rejection is swallowed and reported, never left dangling.
        expect(warn).toHaveBeenCalledWith(
            expect.stringContaining('stream post-processing failed'),
        );
    });

    it('charges the SERVED alias when a throwing recordSuccess loses the log row', async () => {
        // Same R3-001 recovery, on a diverted request: the fallback accounting
        // must charge `slave`, never the exhausted `codex`.
        const harness = makeQuotaHarness({
            result: usageStream(),
            resolveTarget: (_clientId, alias) =>
                alias === 'codex' ? 'slave' : alias,
        });
        harness.recordSuccess.mockImplementationOnce(() => {
            throw new Error('sqlite write failed');
        });
        jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined as any);

        const result = await harness.service.completions(
            { model: 'codex', messages: QUOTA_MESSAGES, stream: true } as any,
            'client-1',
        );
        for await (const _chunk of result as AsyncIterable<any>) {
            // drain
        }
        await flushAsync();

        expect(harness.recordUsage).toHaveBeenCalledTimes(1);
        expect(harness.recordUsage.mock.calls[0][1]).toBe('slave');
    });

    it('does not double-account a stream whose handler already accounted', async () => {
        const harness = makeQuotaHarness({ result: usageStream() });

        const result = await harness.service.completions(
            { model: 'codex', messages: QUOTA_MESSAGES, stream: true } as any,
            'client-1',
        );
        for await (const _chunk of result as AsyncIterable<any>) {
            // drain
        }
        await flushAsync();

        // The handler accounted once; the `accounted` flag keeps the tail from
        // charging the prompt-only estimate on top of it.
        expect(harness.recordSuccess).toHaveBeenCalledTimes(1);
        expect(harness.recordUsage).toHaveBeenCalledTimes(1);
        expect(harness.recordUsage).toHaveBeenCalledWith(
            'client-1',
            'codex',
            TOTAL_TOKENS,
            REQUESTED_AT_MS,
        );
    });

    it('records the served alias beside the requested one when quota diverted the request', async () => {
        const harness = makeQuotaHarness({
            result: bufferedResult(),
            resolveTarget: (_clientId, alias) =>
                alias === 'codex' ? 'slave' : alias,
        });

        await harness.service.completions(
            { model: 'codex', messages: QUOTA_MESSAGES } as any,
            'client-1',
        );

        // request_logs: what the client ASKED for plus what actually SERVED it,
        // so `served_alias <> model_requested` identifies the degradation.
        expect(harness.recordSuccess).toHaveBeenCalledWith(
            expect.objectContaining({
                // `requestedModel` is the record-service arg name; it lands in
                // `request_logs.model_requested`.
                requestedModel: 'codex',
                servedAlias: 'slave',
            }),
        );
        // Structured event: the audit trail of the silent downgrade.
        expect(harness.structuredLog.logRequest).toHaveBeenCalledWith(
            expect.objectContaining({
                model: 'codex',
                servedAlias: 'slave',
                quotaDivertedFrom: 'codex',
            }),
        );
    });

    it('records the requested alias as served and no diversion field when nothing was diverted', async () => {
        const harness = makeQuotaHarness({ result: bufferedResult() });

        await harness.service.completions(
            { model: 'codex', messages: QUOTA_MESSAGES } as any,
            'client-1',
        );

        expect(harness.recordSuccess).toHaveBeenCalledWith(
            expect.objectContaining({
                requestedModel: 'codex',
                servedAlias: 'codex',
            }),
        );
        const event = harness.structuredLog.logRequest.mock.calls[0][0];
        expect(event.servedAlias).toBe('codex');
        // Absent, not null: the non-diverted event shape is unchanged.
        expect(event).not.toHaveProperty('quotaDivertedFrom');
    });

    it('records the served alias on the streamed and the rejected-stream paths too', async () => {
        const divert = (_clientId: string | null, alias: string) =>
            alias === 'codex' ? 'slave' : alias;

        const streamed = makeQuotaHarness({ result: usageStream(), resolveTarget: divert });
        const ok = await streamed.service.completions(
            { model: 'codex', messages: QUOTA_MESSAGES, stream: true } as any,
            'client-1',
        );
        for await (const _chunk of ok as AsyncIterable<any>) {
            // drain
        }
        await flushAsync();
        expect(streamed.recordSuccess).toHaveBeenCalledWith(
            expect.objectContaining({ requestedModel: 'codex', servedAlias: 'slave' }),
        );
        expect(streamed.structuredLog.logRequest).toHaveBeenCalledWith(
            expect.objectContaining({ servedAlias: 'slave', quotaDivertedFrom: 'codex' }),
        );

        const drowned = makeQuotaHarness({ result: failingStream(), resolveTarget: divert });
        const bad = await drowned.service.completions(
            { model: 'codex', messages: QUOTA_MESSAGES, stream: true } as any,
            'client-1',
        );
        await expect(
            (async () => {
                for await (const _chunk of bad as AsyncIterable<any>) {
                    // drain until the upstream throws
                }
            })(),
        ).rejects.toThrow('upstream died mid-stream');
        await flushAsync();
        expect(drowned.recordSuccess).toHaveBeenCalledWith(
            expect.objectContaining({ requestedModel: 'codex', servedAlias: 'slave' }),
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

    it('records the served alias when a diverted request fails to route', async () => {
        // A diverted request that then fails is still a diverted request: the
        // failure row must show what the client asked for ('codex') AND what was
        // actually routed ('slave'), otherwise a downgraded failure is
        // indistinguishable from the client asking for 'slave' directly.
        const harness = makeQuotaHarness({
            result: bufferedResult(),
            resolveTarget: (_clientId, alias) =>
                alias === 'codex' ? 'slave' : alias,
        });
        harness.route.mockRejectedValueOnce(
            new RoutingFailedError('codex', [
                {
                    providerId: 'provider-a',
                    upstreamModel: 'qwen-3.6',
                    ok: false,
                    circuitOpen: false,
                    error: new Error('upstream 500'),
                    durationMs: 3,
                },
            ]),
        );

        await expect(
            harness.service.completions(
                { model: 'codex', messages: QUOTA_MESSAGES } as any,
                'client-1',
            ),
        ).rejects.toBeInstanceOf(RoutingFailedError);

        expect(harness.recordFailure).toHaveBeenCalledTimes(1);
        expect(harness.recordFailure.mock.calls[0][0]).toMatchObject({
            requestedModel: 'codex',
            servedAlias: 'slave',
        });
        expect(harness.structuredLog.logRequest.mock.calls[0][0]).toMatchObject(
            {
                model: 'codex',
                servedAlias: 'slave',
                quotaDivertedFrom: 'codex',
                status: 'error',
            },
        );
    });

    it('omits quotaDivertedFrom from a failure event when nothing was diverted', async () => {
        const harness = makeQuotaHarness({ result: bufferedResult() });
        harness.route.mockRejectedValueOnce(
            new RoutingFailedError('codex', [
                {
                    providerId: 'provider-a',
                    upstreamModel: 'qwen-3.6',
                    ok: false,
                    circuitOpen: false,
                    error: new Error('upstream 500'),
                    durationMs: 3,
                },
            ]),
        );

        await expect(
            harness.service.completions(
                { model: 'codex', messages: QUOTA_MESSAGES } as any,
                'client-1',
            ),
        ).rejects.toBeInstanceOf(RoutingFailedError);

        expect(harness.recordFailure.mock.calls[0][0]).toMatchObject({
            requestedModel: 'codex',
            servedAlias: 'codex',
        });
        const event = harness.structuredLog.logRequest.mock.calls[0][0];
        expect(event.servedAlias).toBe('codex');
        // Absent, never `null` — non-diverted events keep their old shape.
        expect('quotaDivertedFrom' in event).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// Alias access guard (per-client allowlist enforcement)
//
// The guard decides whether the alias the CLIENT ASKED FOR may be used at all.
// It runs before the quota gate and it never looks at the alias the gate ends up
// routing to — see the invariant test at the end of this block, which is the
// whole reason that ordering is load-bearing.
// ---------------------------------------------------------------------------

interface AccessHarness {
    service: ChatService;
    route: jest.Mock;
    resolveTarget: jest.Mock;
    recordUsage: jest.Mock;
    recordFailure: jest.Mock;
    listByClient: jest.Mock;
}

function makeAccessHarness(opts: {
    permitted?: readonly string[];
    result: CompletionResult;
    resolveTarget?: (clientId: string | null, alias: string) => string;
}): AccessHarness {
    const access = makeAccess(opts.permitted);
    const quota = makeQuotaHarness({ result: opts.result, resolveTarget: opts.resolveTarget });
    const service = new ChatService(
        {} as any,
        { clientFor: jest.fn() } as any,
        { route: quota.route } as any,
        {
            recordSuccess: quota.recordSuccess,
            recordFailure: quota.recordFailure,
            recordAttemptFailure: jest.fn(),
        } as any,
        quota.structuredLog as any,
        { resolveTarget: quota.resolveTarget, recordUsage: quota.recordUsage } as unknown as QuotaService,
        access.service,
    );
    return {
        service,
        route: quota.route,
        resolveTarget: quota.resolveTarget,
        recordUsage: quota.recordUsage,
        recordFailure: quota.recordFailure,
        listByClient: access.listByClient,
    };
}

describe('ChatService alias access guard', () => {
    beforeEach(() => {
        jest.spyOn(Date, 'now').mockReturnValue(FIXED_NOW_MS);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('refuses an alias outside the client allowlist before anything is routed', async () => {
        const harness = makeAccessHarness({
            permitted: ['codex'],
            result: bufferedResult(),
        });

        await expect(
            harness.service.completions(
                { model: 'slave', messages: QUOTA_MESSAGES } as any,
                'client-1',
            ),
        ).rejects.toBeInstanceOf(AliasNotPermittedError);

        // Nothing reached the router and nothing was accounted.
        expect(harness.route).not.toHaveBeenCalled();
        expect(harness.recordUsage).not.toHaveBeenCalled();
    });

    it('runs BEFORE the quota gate, so a forbidden alias never resolves a target', async () => {
        const harness = makeAccessHarness({
            permitted: ['codex'],
            result: bufferedResult(),
        });

        await expect(
            harness.service.completions(
                { model: 'slave', messages: QUOTA_MESSAGES } as any,
                'client-1',
            ),
        ).rejects.toBeInstanceOf(AliasNotPermittedError);

        expect(harness.resolveTarget).not.toHaveBeenCalled();
    });

    it('still records a failure row for the refused request (audit trail)', async () => {
        const harness = makeAccessHarness({
            permitted: ['codex'],
            result: bufferedResult(),
        });

        await expect(
            harness.service.completions(
                { model: 'slave', messages: QUOTA_MESSAGES } as any,
                'client-1',
            ),
        ).rejects.toBeInstanceOf(AliasNotPermittedError);

        expect(harness.recordFailure).toHaveBeenCalledTimes(1);
        expect(harness.recordFailure.mock.calls[0][0]).toMatchObject({
            requestedModel: 'slave',
            attempts: 0,
        });
    });

    it('serves an alias that IS in the allowlist', async () => {
        const harness = makeAccessHarness({
            permitted: ['codex'],
            result: bufferedResult(),
        });

        await expect(
            harness.service.completions(
                { model: 'codex', messages: QUOTA_MESSAGES } as any,
                'client-1',
            ),
        ).resolves.toBeDefined();

        expect(harness.route.mock.calls[0][0]).toBe('codex');
    });

    it('leaves a client with NO rows unrestricted (every alias usable)', async () => {
        const harness = makeAccessHarness({
            permitted: undefined,
            result: bufferedResult(),
        });

        await expect(
            harness.service.completions(
                { model: 'anything-goes', messages: QUOTA_MESSAGES } as any,
                'client-1',
            ),
        ).resolves.toBeDefined();

        expect(harness.listByClient).toHaveBeenCalledWith('client-1');
        expect(harness.route.mock.calls[0][0]).toBe('anything-goes');
    });

    it('does not read the allowlist at all for anonymous traffic', async () => {
        const harness = makeAccessHarness({
            permitted: ['codex'],
            result: bufferedResult(),
        });

        await expect(
            harness.service.completions(
                { model: 'slave', messages: QUOTA_MESSAGES } as any,
                null,
            ),
        ).resolves.toBeDefined();

        expect(harness.listByClient).not.toHaveBeenCalled();
    });

    /**
     * THE INVARIANT. A quota diversion is silent by design (D1), so the client
     * keeps its permission for the alias it asked for; the divert target is the
     * gateway's own choice and is NOT re-checked against the allowlist. If this
     * ever regresses, every exhausted-but-permitted client starts receiving 403
     * for a request it is entitled to make.
     */
    it('serves a quota diversion into an alias OUTSIDE the allowlist', async () => {
        const harness = makeAccessHarness({
            // `codex` is permitted; `slave` deliberately is not.
            permitted: ['codex'],
            result: bufferedResult(),
            resolveTarget: (_clientId, alias) => (alias === 'codex' ? 'slave' : alias),
        });

        const result = await harness.service.completions(
            { model: 'codex', messages: QUOTA_MESSAGES } as any,
            'client-1',
        );

        expect(result).toBeDefined();
        // Routed to the divert alias, which is not in the allowlist…
        expect(harness.route.mock.calls[0][0]).toBe('slave');
        // …and charged to it, without any 403 in between.
        expect(harness.recordUsage).toHaveBeenCalledWith(
            'client-1',
            'slave',
            TOTAL_TOKENS,
            REQUESTED_AT_MS,
        );
    });

    it('checks the alias the client asked for, not the alias it was served by', async () => {
        const harness = makeAccessHarness({
            permitted: ['codex'],
            result: bufferedResult(),
            resolveTarget: (_clientId, alias) => (alias === 'codex' ? 'slave' : alias),
        });

        await harness.service.completions(
            { model: 'codex', messages: QUOTA_MESSAGES } as any,
            'client-1',
        );

        // One allowlist read for one request: the guard is not consulted again
        // with the divert target.
        expect(harness.listByClient).toHaveBeenCalledTimes(1);
    });
});
