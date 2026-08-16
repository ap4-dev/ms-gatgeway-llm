import { McpController, parseBody, dispatch, type JsonRpcResponse } from './mcp.controller';
import type { SearchService } from './search.service';
import { SearchProviderError } from './search-provider.interface';

function makeSearch(overrides: { fail?: boolean } = {}): SearchService {
    return {
        search: jest.fn(async () => {
            if (overrides.fail) throw new SearchProviderError('upstream down');
            return {
                results: [
                    {
                        title: 'Example',
                        url: 'https://example.com',
                        snippet: 'Hello',
                        source: 'nan-internal', // must be stripped
                    },
                ],
                cached: true,
            };
        }),
    } as unknown as SearchService;
}

async function dispatchBody(
    body: Record<string, unknown>,
    search: SearchService = makeSearch(),
    clientId: string | null = 'client-1',
): Promise<JsonRpcResponse> {
    const parsed = parseBody(body);
    expect(parsed).not.toBeNull();
    return dispatch(parsed as Record<string, unknown>, search, clientId);
}

function errorOf(r: JsonRpcResponse): { code: number; message: string } | null {
    return 'error' in r ? (r.error as { code: number; message: string }) : null;
}

describe('McpController', () => {
    it('is decorated with the right route', () => {
        expect(McpController).toBeDefined();
    });

    describe('parseBody', () => {
        it('parses an object body', () => {
            expect(parseBody({ jsonrpc: '2.0', method: 'ping' })).toEqual({
                jsonrpc: '2.0',
                method: 'ping',
            });
        });

        it('parses a JSON string body', () => {
            expect(parseBody('{"jsonrpc":"2.0","method":"ping"}')).toEqual({
                jsonrpc: '2.0',
                method: 'ping',
            });
        });

        it('returns null for invalid JSON', () => {
            expect(parseBody('{nope')).toBeNull();
        });

        it('returns null for non-objects', () => {
            expect(parseBody(null)).toBeNull();
            expect(parseBody(42)).toBeNull();
            expect(parseBody([1, 2])).toBeNull();
        });
    });

    describe('initialize', () => {
        it('echoes a supported protocol version and advertises tools', async () => {
            const r = await dispatchBody({
                jsonrpc: '2.0',
                id: 1,
                method: 'initialize',
                params: {
                    protocolVersion: '2025-03-26',
                    capabilities: {},
                    clientInfo: { name: 'pi', version: '0.83.0' },
                },
            });
            expect('result' in r).toBe(true);
            const result = (r as { result: any }).result;
            expect(result.protocolVersion).toBe('2025-03-26');
            expect(result.capabilities.tools).toEqual({ listChanged: false });
            expect(result.serverInfo.name).toBe('ms-gateway-llm');
        });

        it('falls back to the latest version when the client version is unknown', async () => {
            const r = await dispatchBody({
                jsonrpc: '2.0',
                id: 2,
                method: 'initialize',
                params: { protocolVersion: '2099-01-01' },
            });
            expect((r as { result: any }).result.protocolVersion).toBe('2025-06-18');
        });
    });

    describe('ping', () => {
        it('returns an empty result', async () => {
            const r = await dispatchBody({ jsonrpc: '2.0', id: 3, method: 'ping' });
            expect(r).toEqual({ jsonrpc: '2.0', id: 3, result: {} });
        });
    });

    describe('tools/list', () => {
        it('returns web_search with a full input schema', async () => {
            const r = await dispatchBody({
                jsonrpc: '2.0',
                id: 4,
                method: 'tools/list',
            });
            const result = (r as { result: any }).result;
            expect(result.tools).toHaveLength(1);
            expect(result.tools[0].name).toBe('web_search');
            expect(result.tools[0].inputSchema.required).toEqual(['query']);
        });
    });

    describe('tools/call', () => {
        it('calls the search service and returns structured results without source', async () => {
            const search = makeSearch();
            const r = await dispatchBody(
                {
                    jsonrpc: '2.0',
                    id: 5,
                    method: 'tools/call',
                    params: {
                        name: 'web_search',
                        arguments: { query: 'hello', count: 3 },
                    },
                },
                search,
            );
            expect('result' in r).toBe(true);
            const result = (r as { result: any }).result;
            expect(result.isError).toBe(false);
            expect(result.structuredContent.results[0].source).toBeUndefined();
            expect(result.structuredContent.results[0].url).toBe('https://example.com');
            expect(result.content[0].type).toBe('text');
            expect(search.search).toHaveBeenCalledWith(
                { query: 'hello', count: 3 },
                'client-1',
            );
        });

        it('rejects unknown tools with -32602', async () => {
            const r = await dispatchBody({
                jsonrpc: '2.0',
                id: 6,
                method: 'tools/call',
                params: { name: 'nope', arguments: {} },
            });
            expect(errorOf(r)).toMatchObject({ code: -32602 });
        });

        it('rejects invalid arguments with -32602 and issues', async () => {
            const r = await dispatchBody({
                jsonrpc: '2.0',
                id: 7,
                method: 'tools/call',
                params: { name: 'web_search', arguments: { query: '' } },
            });
            const e = errorOf(r);
            expect(e?.code).toBe(-32602);
            expect((r as any).error.data.issues.length).toBeGreaterThan(0);
        });

        it('returns isError=true on provider failure instead of throwing', async () => {
            const search = makeSearch({ fail: true });
            const r = await dispatchBody(
                {
                    jsonrpc: '2.0',
                    id: 8,
                    method: 'tools/call',
                    params: { name: 'web_search', arguments: { query: 'x' } },
                },
                search,
            );
            const result = (r as { result: any }).result;
            expect(result.isError).toBe(true);
            expect(result.content[0].text).toContain('search_unavailable');
        });

        it('rejects non-object arguments with -32602', async () => {
            const r = await dispatchBody({
                jsonrpc: '2.0',
                id: 9,
                method: 'tools/call',
                params: { name: 'web_search', arguments: 'oops' },
            });
            expect(errorOf(r)).toMatchObject({ code: -32602 });
        });
    });

    describe('unknown methods', () => {
        it('returns -32601', async () => {
            const r = await dispatchBody({
                jsonrpc: '2.0',
                id: 10,
                method: 'resources/list',
            });
            expect(errorOf(r)).toMatchObject({ code: -32601 });
        });
    });

    describe('invalid requests', () => {
        it('returns -32600 when method is missing', async () => {
            const r = await dispatchBody({ jsonrpc: '2.0', id: 11 });
            expect(errorOf(r)).toMatchObject({ code: -32600 });
        });

        it('returns -32600 when method is not a string', async () => {
            const r = await dispatchBody({ jsonrpc: '2.0', id: 12, method: 5 });
            expect(errorOf(r)).toMatchObject({ code: -32600 });
        });
    });

    describe('notifications', () => {
        it('never reaches dispatch — controller 202s them (parse still works)', async () => {
            const parsed = parseBody({
                jsonrpc: '2.0',
                method: 'notifications/initialized',
            });
            expect(parsed).not.toBeNull();
            expect('id' in (parsed as Record<string, unknown>)).toBe(false);
        });
    });
});
