import { Controller, Get, UseGuards } from '@nestjs/common';
import { ProviderRegistryService } from '../providers/provider.registry';
import { ApiKeyAuthGuard } from '../auth/api-key.guard';
import { RateLimitGuard } from '../ratelimit/rate-limit.guard';

interface ModelListEntry {
    id: string;
    object: 'model';
    created: number;
    owned_by: string;
}

interface ModelsListResponse {
    object: 'list';
    data: ModelListEntry[];
}

/**
 * GET /v1/models — OpenAI-compatible model listing.
 *
 * Clients (Kilo, OpenCode, Claude Code, …) call this to discover what
 * models they can call. The gateway exposes **only the aliases**
 * configured in the registry — never the upstream real-model ids. This
 * mirrors the alias-only behavior of `GET /admin/logs`: the gateway
 * is a façade over its providers, and provider/model identity is
 * operational detail that should not leak through the public API.
 *
 * Each alias is configured as an ordered fallback chain
 * (e.g. `['nan/qwen3.6', 'nan/deepseek-v4-flash']`). The alias is
 * advertised if and only if:
 *   - its primary (chain[0]) has a configured provider whose
 *     `apiKeyEnv` is set in env, AND
 *   - the upstream model key exists on that provider.
 *
 * Aliases that point to unreachable primaries are silently skipped —
 * the client never sees a model it cannot resolve.
 *
 * NOTE: the path is `@Controller('models')` and the global prefix `/v1`
 * is applied by `main.ts` via `app.setGlobalPrefix('v1')`. Putting
 * `v1` here too would yield `/v1/v1/models`.
 */
@Controller('models')
@UseGuards(ApiKeyAuthGuard, RateLimitGuard)
export class ModelsController {
    // Stable timestamp per process boot — OpenAI clients only compare this
    // string against the same value on subsequent calls, so we don't need
    // a true creation date (registry files don't carry one).
    private readonly createdAt = Math.floor(Date.now() / 1000);

    constructor(private readonly registry: ProviderRegistryService) {}

    @Get()
    list(): ModelsListResponse {
        const byId = new Map<string, ModelListEntry>();

        for (const [aliasKey, aliasChain] of Object.entries(this.registry.aliases)) {
            const [primary] = aliasChain;
            if (!primary) continue;
            const [providerId, modelKey] = primary.split('/');
            const provider = this.registry.providers[providerId];
            if (!provider || !process.env[provider.apiKeyEnv]) continue;
            if (!provider.models[modelKey]) continue;

            byId.set(aliasKey, {
                id: aliasKey,
                object: 'model',
                created: this.createdAt,
                owned_by: providerId,
            });
        }

        // Sort by id for a deterministic, stable response.
        return {
            object: 'list',
            data: Array.from(byId.values()).sort((a, b) =>
                a.id.localeCompare(b.id),
            ),
        };
    }
}
