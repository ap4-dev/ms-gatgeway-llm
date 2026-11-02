import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { ProviderRegistryService } from '../providers/provider.registry';
import { ApiKeyAuthGuard } from '../auth/api-key.guard';
import { RateLimitGuard } from '../ratelimit/rate-limit.guard';
import type { Client } from '../auth/client.repository';
import { AliasAccessService } from '../access/alias-access.service';

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
 * Per-client allowlist: an alias the authenticated client may not CALL is also
 * not ADVERTISED, otherwise every client SDK would offer a model that answers
 * `403`. The rule is the same `AliasAccessService.getAccess` decision the
 * request gate uses — one implementation, so "no rows means unrestricted"
 * cannot be read two ways here and in `ChatService`. Filtering an alias out is
 * indistinguishable from the alias not existing, which is exactly what a
 * restricted client should be able to tell.
 *
 * NOTE: the path is `@Controller('models')` and the global prefix `/v1`
 * is applied by `main.ts` via `app.setGlobalPrefix('v1')`. Putting
 * `v1` here too would yield `/v1/v1/models`.
 */
@Controller('v1/models')
@UseGuards(ApiKeyAuthGuard, RateLimitGuard)
export class ModelsController {
    // Stable timestamp per process boot — OpenAI clients only compare this
    // string against the same value on subsequent calls, so we don't need
    // a true creation date (registry files don't carry one).
    private readonly createdAt = Math.floor(Date.now() / 1000);

    constructor(
        private readonly registry: ProviderRegistryService,
        /**
         * Same allowlist the request gate reads: `/v1/models` and
         * `/v1/chat/completions` must never disagree about what a client may use.
         */
        private readonly access: AliasAccessService,
    ) {}

    @Get()
    list(@Req() req: FastifyRequest & { client?: Client }): ModelsListResponse {
        const byId = new Map<string, ModelListEntry>();
        // Anonymous traffic and clients with no rows are both `unrestricted`;
        // that decision is the access service's, never this controller's.
        const access = this.access.getAccess(req.client?.id ?? null);

        for (const [aliasKey, aliasChain] of Object.entries(this.registry.aliases)) {
            if (!this.access.isPermitted(access, aliasKey)) continue;
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
