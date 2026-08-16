import { Body, Controller, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ApiKeyAuthGuard } from '../auth/api-key.guard';
import { RequireScopesGuard } from '../auth/require-scopes.guard';
import { RateLimitGuard } from '../ratelimit/rate-limit.guard';
import { RequireScopes } from '../auth/require-scopes.decorator';
import type { Client } from '../auth/client.repository';
import { SearchService, SearchBodySchema, type SearchBody } from './search.service';
import { SearchProviderError } from './search-provider.interface';
import { WEB_SEARCH_TOOL } from './web-search.tool';
import { stripSource } from './search.controller';

/**
 * POST /v1/mcp — MCP (Model Context Protocol) server over JSON-RPC 2.0.
 *
 * Stateless, like NaN's own MCP: no sessions, no SSE stream. Each POST is
 * one JSON-RPC round-trip. Supported methods:
 *
 *   initialize            → protocol version + capabilities
 *   notifications/initialized (no id) → 202, no body
 *   tools/list            → [{ name: 'web_search', description, inputSchema }]
 *   tools/call            → SearchService.search(args) → results
 *   ping                  → {}
 *
 * Per MCP convention, JSON-RPC errors are returned with **HTTP 200** and an
 * `error` field — never a non-2xx status. Notifications (requests without
 * an `id`) get a 202 with an empty body.
 *
 * Auth mirrors the other write endpoints: API key + `chat.write` scope +
 * per-client rate limit.
 */
@Controller('v1/mcp')
@UseGuards(ApiKeyAuthGuard, RequireScopesGuard, RateLimitGuard)
@RequireScopes('chat.write')
export class McpController {
    constructor(private readonly search: SearchService) {}

    @Post()
    async handle(
        @Body() raw: unknown,
        @Req() req: FastifyRequest & { client?: Client },
        @Res() reply: FastifyReply,
    ): Promise<FastifyReply> {
        const clientId = req.client?.id ?? null;
        const parsed = parseBody(raw);

        // Not parseable as JSON-RPC → 200 with a parse-error envelope.
        if (!parsed) {
            return sendJson(reply, {
                jsonrpc: '2.0',
                id: null,
                error: { code: -32700, message: 'Parse error' },
            });
        }

        // Notifications carry no `id` → acknowledge with an empty 202.
        if (!('id' in parsed)) {
            return reply.code(202).send();
        }

        const response = await dispatch(parsed, this.search, clientId);
        return sendJson(reply, response);
    }
}

// ---------------------------------------------------------------------------
// JSON-RPC core — pure functions, exported for unit tests.
// ---------------------------------------------------------------------------

export interface JsonRpcError {
    code: number;
    message: string;
    data?: unknown;
}

export type JsonRpcResponse =
    | { jsonrpc: '2.0'; id: unknown; result: unknown }
    | { jsonrpc: '2.0'; id: unknown; error: JsonRpcError };

const JSONRPC = '2.0' as const;

// Latest protocol version we speak, plus the versions we can echo back.
const SUPPORTED_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const LATEST_PROTOCOL_VERSION = '2025-06-18';

const SERVER_INFO = {
    name: 'ms-gateway-llm',
    version: '1.0.0',
};

/** Parse the raw body into a JSON-RPC request object, or null on failure. */
export function parseBody(raw: unknown): Record<string, unknown> | null {
    let value = raw;
    if (typeof raw === 'string') {
        try {
            value = JSON.parse(raw);
        } catch {
            return null;
        }
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
}

/**
 * Dispatch one JSON-RPC request. `id` is guaranteed present (notifications
 * are filtered by the controller before calling). Never throws — search
 * failures become `isError: true` tool results, everything else becomes a
 * JSON-RPC error object.
 */
export async function dispatch(
    request: Record<string, unknown>,
    search: SearchService,
    clientId: string | null,
): Promise<JsonRpcResponse> {
    const id = request.id ?? null;
    const method = request.method;

    if (typeof method !== 'string' || method.length === 0) {
        return error(id, -32600, 'Invalid Request');
    }

    switch (method) {
        case 'initialize':
            return result(id, initializeResult(request.params));
        case 'ping':
            return result(id, {});
        case 'tools/list':
            return result(id, { tools: [toolForMcp()] });
        case 'tools/call':
            return callTool(id, request.params, search, clientId);
        default:
            return error(id, -32601, `Method not found: ${method}`);
    }
}

function initializeResult(params: unknown): unknown {
    const requested =
        params && typeof params === 'object'
            ? (params as Record<string, unknown>).protocolVersion
            : undefined;
    const protocolVersion =
        typeof requested === 'string' &&
        SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
            ? requested
            : LATEST_PROTOCOL_VERSION;
    return {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
    };
}

function toolForMcp(): Record<string, unknown> {
    return {
        name: WEB_SEARCH_TOOL.name,
        description: WEB_SEARCH_TOOL.description,
        inputSchema: WEB_SEARCH_TOOL.inputSchema,
    };
}

async function callTool(
    id: unknown,
    params: unknown,
    search: SearchService,
    clientId: string | null,
): Promise<JsonRpcResponse> {
    if (!params || typeof params !== 'object' || Array.isArray(params)) {
        return error(id, -32602, 'Invalid params: expected an object');
    }
    const p = params as Record<string, unknown>;
    if (p.name !== WEB_SEARCH_TOOL.name) {
        return error(
            id,
            -32602,
            `Unknown tool: ${String(p.name ?? '(missing)')}. Known tools: ${WEB_SEARCH_TOOL.name}`,
        );
    }
    if (!p.arguments || typeof p.arguments !== 'object' || Array.isArray(p.arguments)) {
        return error(id, -32602, 'Invalid params: tool arguments must be an object');
    }

    const parsed = SearchBodySchema.safeParse(p.arguments);
    if (!parsed.success) {
        return error(id, -32602, 'Invalid tool arguments', {
            issues: parsed.error.issues.map((i) => ({
                path: i.path.join('.'),
                message: i.message,
            })),
        });
    }

    try {
        const response = await search.search(parsed.data as SearchBody, clientId);
        const cleaned = stripSource(response);
        const text = JSON.stringify(cleaned);
        return result(id, {
            content: [{ type: 'text', text }],
            structuredContent: cleaned,
            isError: false,
        });
    } catch (err) {
        const message =
            err instanceof SearchProviderError
                ? `${err.code}: ${err.message}`
                : err instanceof Error
                ? err.message
                : String(err);
        return result(id, {
            content: [{ type: 'text', text: message }],
            isError: true,
        });
    }
}

function result(id: unknown, resultValue: unknown): JsonRpcResponse {
    return { jsonrpc: JSONRPC, id, result: resultValue };
}

function error(
    id: unknown,
    code: number,
    message: string,
    data?: unknown,
): JsonRpcResponse {
    return {
        jsonrpc: JSONRPC,
        id,
        error: { code, message, ...(data !== undefined ? { data } : {}) },
    };
}

function sendJson(reply: FastifyReply, body: JsonRpcResponse): FastifyReply {
    return reply
        .header('Content-Type', 'application/json')
        .code(200)
        .send(body);
}
