import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiKeyAuthGuard } from '../auth/api-key.guard';
import { RateLimitGuard } from '../ratelimit/rate-limit.guard';
import { WEB_SEARCH_TOOL } from './web-search.tool';

/**
 * GET /v1/tools — tool discovery for non-MCP clients (Kilo, OpenCode, …).
 *
 * Shape mirrors the OpenAI tools array (`type: 'function'`) so clients can
 * slot `web_search` straight into their existing chat-completions tooling
 * without parsing MCP. Auth is the same as GET /v1/models: API key +
 * rate limit, no extra scope.
 */
@Controller('v1/tools')
@UseGuards(ApiKeyAuthGuard, RateLimitGuard)
export class ToolsController {
    @Get()
    list(): {
        object: 'list';
        data: Array<{
            type: 'function';
            function: {
                name: string;
                description: string;
                parameters: typeof WEB_SEARCH_TOOL.inputSchema;
            };
        }>;
    } {
        return {
            object: 'list',
            data: [
                {
                    type: 'function',
                    function: {
                        name: WEB_SEARCH_TOOL.name,
                        description: WEB_SEARCH_TOOL.description,
                        parameters: WEB_SEARCH_TOOL.inputSchema,
                    },
                },
            ],
        };
    }
}
