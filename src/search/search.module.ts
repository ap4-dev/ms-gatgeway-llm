import { Module } from '@nestjs/common';
import { SearchController } from './search.controller';
import { McpController } from './mcp.controller';
import { ToolsController } from './tools.controller';
import { SearchService } from './search.service';
import { NanSearchProvider } from './nan-search.provider';
import { SEARCH_PROVIDER } from './search-provider.interface';
import { ChatModule } from '../chat/chat.module';

/**
 * Search feature module — see docs/search.md.
 *
 * Exposes three surfaces over one provider-agnostic core:
 *   - POST /v1/search  (REST, NaN-shaped)
 *   - POST /v1/mcp     (JSON-RPC 2.0 — MCP protocol)
 *   - GET  /v1/tools   (OpenAI-shaped discovery for Kilo/OpenCode)
 *
 * The active provider is bound to the `SEARCH_PROVIDER` token here; swap
 * `NanSearchProvider` for another implementation and clients never notice.
 *
 * `ChatModule` is imported for its exported observability services
 * (RequestLogService, LlmLoggingService) — search rows land in the same
 * `request_logs` table with `model_requested = '$search'`.
 */
@Module({
    imports: [ChatModule],
    controllers: [SearchController, McpController, ToolsController],
    providers: [
        { provide: SEARCH_PROVIDER, useClass: NanSearchProvider },
        SearchService,
    ],
    exports: [SearchService],
})
export class SearchModule {}
