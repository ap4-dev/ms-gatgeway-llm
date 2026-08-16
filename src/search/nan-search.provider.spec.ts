import { NanSearchProvider, normalizeResponse } from './nan-search.provider';
import {
    SearchProviderError,
    SearchRateLimitedError,
    SearchTimeoutError,
} from './search-provider.interface';

function makeHttp() {
    return { post: jest.fn() } as any;
}

describe('NanSearchProvider', () => {
    const API_KEY = 'sk-nan-test';

    beforeEach(() => {
        process.env.NAN_API_KEY = API_KEY;
    });

    afterEach(() => {
        delete process.env.NAN_API_KEY;
    });

    describe('search', () => {
        it('posts to /v1/search with Bearer auth and maps the response', async () => {
            const http = makeHttp();
            http.post.mockResolvedValue({
                data: {
                    results: [
                        {
                            title: 'A',
                            url: 'https://a.example',
                            snippet: 'snippet a',
                            content: 'full a',
                            source: 'nan-internal',
                        },
                        { title: 'B', url: 'https://b.example', snippet: 'snippet b' },
                    ],
                    cached: true,
                },
            });
            const provider = new NanSearchProvider({ apiKey: API_KEY, http });

            const res = await provider.search({
                query: 'hello',
                count: 5,
                freshness: 'pd',
                fetchContent: true,
            });

            expect(http.post).toHaveBeenCalledWith(
                'https://api.nan.builders/v1/search',
                {
                    query: 'hello',
                    count: 5,
                    freshness: 'pd',
                    fetch_content: true,
                },
                expect.objectContaining({
                    headers: expect.objectContaining({
                        Authorization: `Bearer ${API_KEY}`,
                    }),
                    timeout: 120_000,
                }),
            );
            expect(res.cached).toBe(true);
            expect(res.results).toHaveLength(2);
            expect(res.results[0]).toEqual({
                title: 'A',
                url: 'https://a.example',
                snippet: 'snippet a',
                content: 'full a',
                source: 'nan-internal',
            });
        });

        it('uses a shorter timeout when content is not requested', async () => {
            const http = makeHttp();
            http.post.mockResolvedValue({ data: { results: [], cached: false } });
            const provider = new NanSearchProvider({ apiKey: API_KEY, http });

            await provider.search({ query: 'hi' });

            expect(http.post).toHaveBeenCalledWith(
                expect.any(String),
                expect.objectContaining({ query: 'hi' }),
                expect.objectContaining({ timeout: 30_000 }),
            );
        });

        it('throws a clear error when NAN_API_KEY is missing', async () => {
            delete process.env.NAN_API_KEY;
            const provider = new NanSearchProvider({ http: makeHttp() });

            await expect(provider.search({ query: 'x' })).rejects.toThrow(
                /NAN_API_KEY/,
            );
        });

        it('maps HTTP 429 to SearchRateLimitedError with Retry-After', async () => {
            const http = makeHttp();
            const err = new Error('rate limited') as any;
            err.isAxiosError = true;
            err.response = { status: 429, headers: { 'retry-after': '42' } };
            http.post.mockRejectedValue(err);
            const provider = new NanSearchProvider({ apiKey: API_KEY, http });

            const thrown = await provider.search({ query: 'x' }).catch((e) => e);
            expect(thrown).toBeInstanceOf(SearchRateLimitedError);
            expect(thrown.retryAfterMs).toBe(42_000);
        });

        it('maps timeouts to SearchTimeoutError', async () => {
            const http = makeHttp();
            const err = new Error('timeout') as any;
            err.isAxiosError = true;
            err.code = 'ECONNABORTED';
            http.post.mockRejectedValue(err);
            const provider = new NanSearchProvider({ apiKey: API_KEY, http });

            const thrown = await provider.search({ query: 'x' }).catch((e) => e);
            expect(thrown).toBeInstanceOf(SearchTimeoutError);
        });

        it('maps other upstream HTTP errors to SearchProviderError with detail', async () => {
            const http = makeHttp();
            const err = new Error('bad gateway') as any;
            err.isAxiosError = true;
            err.response = {
                status: 502,
                data: { error: { message: 'upstream down' } },
            };
            http.post.mockRejectedValue(err);
            const provider = new NanSearchProvider({ apiKey: API_KEY, http });

            const thrown = await provider.search({ query: 'x' }).catch((e) => e);
            expect(thrown).toBeInstanceOf(SearchProviderError);
            expect(thrown.code).toBe('search_unavailable');
            expect(thrown.message).toContain('upstream down');
        });
    });

    describe('normalizeResponse', () => {
        it('skips entries without a url and tolerates junk', () => {
            const res = normalizeResponse({
                results: [
                    { title: 'ok', url: 'https://ok.example', snippet: 's' },
                    { title: 'no url' },
                    'garbage',
                    null,
                ],
                cached: false,
            });
            expect(res.results).toHaveLength(1);
            expect(res.results[0].url).toBe('https://ok.example');
        });

        it('defaults snippet to empty string and drops empty content', () => {
            const res = normalizeResponse({
                results: [{ title: 'x', url: 'https://x.example' }],
                cached: false,
            });
            expect(res.results[0].snippet).toBe('');
            expect(res.results[0].content).toBeUndefined();
        });

        it('throws on a non-object payload', () => {
            expect(() => normalizeResponse(null)).toThrow(SearchProviderError);
            expect(() => normalizeResponse('nope')).toThrow(SearchProviderError);
        });
    });
});
