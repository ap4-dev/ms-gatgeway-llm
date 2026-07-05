import { Controller, Get } from '@nestjs/common';
import { ProviderRegistryService } from '../providers/provider.registry';

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
 * Clients (Kilo, OpenCode, Claude Code, …) call this to discover available
 * models. The gateway returns every model registered in providers.json
 * (one entry per model, not per alias). Providers whose `apiKeyEnv` is not
 * configured are filtered out so the list never shows unreachable models.
 *
 * NOTE: the path is `@Controller('models')` and the global prefix `/v1` is
 * applied by `main.ts` via `app.setGlobalPrefix('v1')`. Putting `v1` here
 * too would yield `/v1/v1/models`.
 */
@Controller('models')
export class ModelsController {
    // Stable timestamp per process boot — OpenAI clients only compare this
    // string against the same value on subsequent calls, so we don't need
    // a true creation date (registry files don't carry one).
    private readonly createdAt = Math.floor(Date.now() / 1000);

    constructor(private readonly registry: ProviderRegistryService) {}

    @Get()
    list(): ModelsListResponse {
        // Use a map keyed by `id` so that when an alias points to a model
        // key with the same name, we don't emit duplicates.
        const byId = new Map<string, ModelListEntry>();

        // Aliases first. The `id` a client should send is the alias name
        // (e.g. "fast", "coder"), not the upstream model id. Each alias is
        // now an ordered fallback chain; we advertise the alias under its
        // primary (chain[0]) and silently skip the alias if its primary is
        // unavailable (no api key or unknown model).
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

        // Direct model keys (deduped against aliases).
        for (const [providerId, provider] of Object.entries(
            this.registry.providers,
        )) {
            // Skip a provider entirely when its API key env var is unset —
            // the gateway can't proxy calls to it, so don't advertise it.
            if (!process.env[provider.apiKeyEnv]) continue;

            for (const modelKey of Object.keys(provider.models)) {
                if (byId.has(modelKey)) continue;
                byId.set(modelKey, {
                    id: modelKey,
                    object: 'model',
                    created: this.createdAt,
                    owned_by: providerId,
                });
            }
        }

        // Sort by id for a deterministic, stable response.
        return { object: 'list', data: Array.from(byId.values()).sort((a, b) => a.id.localeCompare(b.id)) };
    }
}
