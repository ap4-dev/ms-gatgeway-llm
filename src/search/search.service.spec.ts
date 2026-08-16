import { Logger } from '@nestjs/common';
import { SearchService, toOptions, SEARCH_LOG_MODEL } from './search.service';
import {
    SearchProviderError,
    SearchRateLimitedError,
    type SearchProvider,
    type SearchResponse,
} from './search-provider.interface';
import type { RequestLogService } from '../observability/request-log.service';
import type { LlmLoggingService } from '../observability/llm-logging.service';

function makeProvider(behavior: 'ok' | 'fail' | 'ratelimit' = 'ok'): SearchProvider {
    return {
        id: 'nan',
        search: jest.fn(async () => {
            if (behavior === 'fail') {
                throw new SearchProviderError('upstream exploded');
            }
            if (behavior === 'ratelimit') {
                throw new SearchRateLimitedError('slow down', 30_000);
            }
            return {
                results: [
                    {
                        title: 'Example',
                        url: 'https://example.com',
                        snippet: 'Hello',
                        source: 'internal',
                    },
                ],
                cached: false,
            };
        }),
    } as unknown as SearchProvider;
}

function makeLoggers() {
    return {
        requestLog: {
            recordSuccess: jest.fn(),
            recordFailure: jest.fn(),
        } as unknown as RequestLogService,
        structuredLog: {
            logRequest: jest.fn(),
        } as unknown as LlmLoggingService,
    };
}

describe('SearchService', () => {
    let warnSpy: jest.SpyInstance;

    beforeEach(() => {
        warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    });

    afterEach(() => {
        warnSpy.mockRestore();
    });

    describe('toOptions', () => {
        it('maps wire shape to provider options', () => {
            expect(
                toOptions({
                    query: 'hello',
                    count: 7,
                    freshness: 'pw',
                    fetch_content: true,
                }),
            ).toEqual({
                query: 'hello',
                count: 7,
                freshness: 'pw',
                fetchContent: true,
            });
        });

        it('omits undefined fields', () => {
            expect(toOptions({ query: 'hello' })).toEqual({ query: 'hello' });
        });
    });

    describe('search', () => {
        it('returns provider results and logs a success row with $search marker', async () => {
            const provider = makeProvider('ok');
            const { requestLog, structuredLog } = makeLoggers();
            const svc = new SearchService(provider, requestLog, structuredLog);

            const res = await svc.search({ query: 'hello' }, 'client-1');

            expect(res.results).toHaveLength(1);
            expect(res.results[0].title).toBe('Example');
            expect(requestLog.recordSuccess).toHaveBeenCalledWith(
                expect.objectContaining({
                    requestedModel: SEARCH_LOG_MODEL,
                    resolvedProvider: 'nan',
                    resolvedModel: null,
                    attempts: 1,
                    clientKey: 'client-1',
                }),
            );
            expect(structuredLog.logRequest).toHaveBeenCalledWith(
                expect.objectContaining({
                    event: 'search.request',
                    status: 'ok',
                    resultCount: 1,
                    cached: false,
                }),
            );
        });

        it('re-throws provider errors and logs a failure row', async () => {
            const provider = makeProvider('fail');
            const { requestLog, structuredLog } = makeLoggers();
            const svc = new SearchService(provider, requestLog, structuredLog);

            await expect(svc.search({ query: 'x' })).rejects.toBeInstanceOf(
                SearchProviderError,
            );
            expect(requestLog.recordFailure).toHaveBeenCalledWith(
                expect.objectContaining({
                    requestedModel: SEARCH_LOG_MODEL,
                    attempts: 1,
                    resolvedProvider: 'nan',
                }),
            );
            expect(structuredLog.logRequest).toHaveBeenCalledWith(
                expect.objectContaining({ event: 'search.request', status: 'error' }),
            );
        });

        it('preserves the rate-limit error code for the controller mapping', async () => {
            const provider = makeProvider('ratelimit');
            const { requestLog, structuredLog } = makeLoggers();
            const svc = new SearchService(provider, requestLog, structuredLog);

            const err = await svc.search({ query: 'x' }).catch((e) => e);
            expect(err).toBeInstanceOf(SearchRateLimitedError);
            expect(err.code).toBe('search_rate_limited');
            expect(err.retryAfterMs).toBe(30_000);
        });

        it('wraps non-provider errors as SearchProviderError', async () => {
            const provider = {
                id: 'nan',
                search: jest.fn(async () => {
                    throw new Error('boom');
                }),
            } as unknown as SearchProvider;
            const { requestLog, structuredLog } = makeLoggers();
            const svc = new SearchService(provider, requestLog, structuredLog);

            const err = await svc.search({ query: 'x' }).catch((e) => e);
            expect(err).toBeInstanceOf(SearchProviderError);
            expect((err as SearchProviderError).code).toBe('search_unavailable');
            expect(err.message).toBe('boom');
        });
    });
});
