// Module-scope reference so the jest.mock factory can close over it.
// jest.mock is hoisted above this `let`, but the binding lives in module
// scope and is captured by reference when the factory runs.
jest.mock('openai', () => {
    const local = jest.fn();
    const Ctor = jest.fn().mockImplementation(() => ({
        chat: { completions: { create: local } },
    }));
    return { __esModule: true, default: Ctor };
});

import OpenAI from 'openai';
import { ChatService } from './chat.service';
import type { Env } from '../config/env.schema';

const OpenAICtor = OpenAI as unknown as jest.Mock;

const fakeEnv: Env = {
    NODE_ENV: 'test',
    PORT: 3000,
    LLM_PROVIDER_API_KEY: 'sk-test',
    LLM_PROVIDER_BASE_URL: 'https://example.com/v1',
    CORS_ORIGINS: '',
    START_TOKEN: undefined,
    MS: 'ms-gateway-llm',
};

function buildSampleBody(overrides: Record<string, unknown> = {}) {
    return {
        model: 'gpt-test',
        messages: [{ role: 'user', content: 'hi' }],
        stream: false,
        ...overrides,
    };
}
describe('ChatService.completions', () => {
    let service: ChatService;
    let create: jest.Mock;

    beforeEach(() => {
        OpenAICtor.mockClear();
        service = new ChatService(fakeEnv);
        // The jest.mock factory closes over a single `create` fn shared by
        // every OpenAI instance, so each test resets its call history.
        create = (OpenAICtor.mock.results[0].value.chat.completions
            .create as jest.Mock);
        create.mockReset();
    });

    it('instantiates the OpenAI client with the configured credentials', () => {
        // Re-instantiate to pick up the same scenario with a clean instance
        // (the outer beforeEach already constructed one — this asserts on it).
        expect(OpenAICtor).toHaveBeenCalledWith({
            apiKey: 'sk-test',
            baseURL: 'https://example.com/v1',
        });
    });

    it('forwards the request to the OpenAI SDK and returns the response (non-stream)', async () => {
        const fakeCompletion = { id: 'cmpl-1', choices: [{ message: { content: 'pong' } }] };
        create.mockResolvedValueOnce(fakeCompletion);

        const result = await service.completions(buildSampleBody() as any);

        expect(create).toHaveBeenCalledTimes(1);
        const callArg = create.mock.calls[0][0];
        expect(callArg.model).toBe('gpt-test');
        expect(callArg.messages).toEqual([{ role: 'user', content: 'hi' }]);
        expect(result).toBe(fakeCompletion);
    });

    it('returns the SDK stream untouched when stream=true', async () => {
        async function* fakeStream() {
            yield { id: 'c1', choices: [{ delta: { content: 'a' } }] };
            yield { id: 'c2', choices: [{ delta: { content: 'b' } }] };
        }
        const stream = fakeStream();
        create.mockResolvedValueOnce(stream);

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
        create.mockResolvedValueOnce({});

        await service.completions({
            model: 'gpt-test',
            messages: [
                { role: 'system', content: 'be brief' },
                { role: 'system', content: 'use Spanish' },
                { role: 'user', content: 'saluda' },
            ],
        } as any);

        const callArg = create.mock.calls[0][0];
        expect(callArg.messages).toHaveLength(2);
        expect(callArg.messages[0]).toEqual({
            role: 'system',
            content: 'be brief\n\nuse Spanish',
        });
        expect(callArg.messages[1]).toEqual({
            role: 'user',
            content: 'saluda',
        });
    });

    it('propagates upstream errors', async () => {
        create.mockRejectedValueOnce(new Error('upstream boom'));

        await expect(service.completions(buildSampleBody() as any))
            .rejects.toThrow('upstream boom');
    });
});
