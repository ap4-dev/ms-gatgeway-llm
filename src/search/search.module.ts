import { Module } from '@nestjs/common';
import { SearchController } from './search.controller';
import { SearchService } from './search.service';
import {
    NanSearchProvider,
    searchEndpointFor,
} from './nan-search.provider';
import { SEARCH_PROVIDER } from './search-provider.interface';
import { ProviderRegistryService } from '../providers/provider.registry';
import { ChatModule } from '../chat/chat.module';

/**
 * Search feature module — see docs/search.md.
 *
 * Provider-agnostic core. The composition root below selects the active
 * search provider **by capability**: the first `providers` row with
 * `supports_search = 1` (migration 0012). The chosen row's `id`,
 * `base_url` (+ `/search`) and `api_key_env` are handed to the wire-format
 * adapter (`NanSearchProvider`), which holds no provider identity. Swapping
 * the search provider is a DB change — no code change.
 *
 * Exposed surfaces live in sibling modules:
 *   - POST /v1/search  (REST, NaN-shaped)         ← this module
 *   - POST /v1/mcp     (JSON-RPC 2.0 — MCP protocol) ← `mcp/`
 *   - GET  /v1/tools   (OpenAI-shaped discovery)  ← `tools/`
 *
 * `ChatModule` is imported for its exported observability services
 * (RequestLogService, LlmLoggingService) — search rows land in the same
 * `request_logs` table with `model_requested = '$search'`.
 */
@Module({
    imports: [ChatModule],
    controllers: [SearchController],
    providers: [
        {
            provide: SEARCH_PROVIDER,
            useFactory: (registry: ProviderRegistryService) => {
                const entry = Object.entries(registry.providers).find(
                    ([, p]) => p.supportsSearch === true,
                );
                if (!entry) {
                    throw new Error(
                        'No search-capable provider configured: set supports_search=1 on a providers row.',
                    );
                }
                const [id, cfg] = entry;
                return new NanSearchProvider({
                    id,
                    baseUrl: searchEndpointFor({
                        id,
                        baseURL: cfg.baseURL,
                        apiKeyEnv: cfg.apiKeyEnv,
                    }),
                    apiKeyEnv: cfg.apiKeyEnv,
                });
            },
            inject: [ProviderRegistryService],
        },
        SearchService,
    ],
    exports: [SearchService],
})
export class SearchModule {}
