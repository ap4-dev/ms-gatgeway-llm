import OpenAI from 'openai';
import { Inject, Injectable } from '@nestjs/common';
import type { ResolvedModel } from './provider.model';
import {
    PROVIDER_REGISTRY,
    ProviderRegistryService,
} from './provider.registry';
import { ENV_CONFIG } from '../config/env.token';
import type { Env } from '../config/env.schema';

/**
 * Resolves user-facing model names (alias, provider/model, or model) into a
 * concrete upstream configuration and owns a cached OpenAI client per
 * provider.
 *
 * Resolution order for the input string:
 *   1. An alias — anything in `registry.aliases`. Each alias is an ordered
 *      chain; the first entry is the primary, the rest are fallbacks.
 *   2. "providerId/modelKey" — single-element chain.
 *   3. modelKey — searched across all providers (single-element chain whose
 *      backing provider is the one that owns the key).
 *   4. fallback to the "default" alias chain if registered.
 *   5. throw with a helpful list of known models otherwise.
 *
 * `resolve()` returns the primary entry of the chain (used by callers that
 * only need one model — e.g. the catalog). `resolveChain()` returns the
 * whole ordered chain; `RoutingService` iterates it for fallback.
 */
@Injectable()
export class ProviderService {
    private readonly clients = new Map<string, OpenAI>();

    constructor(
        @Inject(PROVIDER_REGISTRY) private readonly registry: ProviderRegistryService,
        @Inject(ENV_CONFIG) private readonly env: Env,
    ) {}

    /**
     * Resolve a user-supplied model identifier to a fully populated
     * `ResolvedModel` representing the primary of its chain.
     */
    resolve(model: string): ResolvedModel {
        return this.resolveChain(model)[0];
    }

    /**
     * Resolve a user-supplied model identifier to the full ordered chain of
     * `ResolvedModel`s that should be tried in order (primary first,
     * fallbacks after). Throws if nothing matches.
     */
    resolveChain(model: string): ResolvedModel[] {
        if (!model || typeof model !== 'string') {
            throw new Error('Model name is required');
        }

        // 1) alias lookup
        const aliasTarget = this.registry.aliases[model];
        if (aliasTarget) {
            return aliasTarget.map((entry) => this.resolvePath(entry, model));
        }

        // 2) explicit "provider/model" path → single-element chain
        if (model.includes('/')) {
            return [this.resolvePath(model, model)];
        }

        // 3) model-key scan across providers → single-element chain
        const found = this.registry.findModel(model);
        if (found) {
            return [
                this.buildResolved(
                    model,
                    model,
                    found.providerId,
                    found.modelKey,
                    found.config,
                ),
            ];
        }

        // 4) fallback to the "default" alias chain
        const defaultChain = this.registry.aliases.default;
        if (defaultChain) {
            return defaultChain.map((entry) => this.resolvePath(entry, model));
        }

        // 5) nothing matched
        throw new Error(
            `Unknown model "${model}". Known aliases: ${Object.keys(this.registry.aliases).join(', ') || '(none)'}. ` +
                `Known models: ${Object.values(this.registry.providers)
                    .flatMap((p) => Object.keys(p.models))
                    .join(', ')}.`,
        );
    }

    /**
     * Returns a cached OpenAI client for the provider that backs the
     * resolved model. Reuses one instance per provider id so all models
     * sharing an upstream share a single connection pool.
     */
    clientFor(resolved: ResolvedModel): OpenAI {
        const existing = this.clients.get(resolved.providerId);
        if (existing) return existing;

        const created = new OpenAI({
            apiKey: resolved.apiKey,
            baseURL: resolved.baseURL,
        });
        this.clients.set(resolved.providerId, created);
        return created;
    }

    // --- internals -------------------------------------------------------

    private resolvePath(path: string, requestedAs: string): ResolvedModel {
        const [providerId, modelKey] = path.split('/');
        if (!providerId || !modelKey) {
            throw new Error(
                `Invalid provider/model path "${path}" — expected "providerId/modelKey"`,
            );
        }

        const provider = this.registry.get(providerId);
        if (!provider) {
            throw new Error(
                `Unknown provider "${providerId}" referenced by "${requestedAs}".`,
            );
        }
        const modelCfg = provider.models[modelKey];
        if (!modelCfg) {
            throw new Error(
                `Unknown model "${modelKey}" on provider "${providerId}".`,
            );
        }

        return this.buildResolved(requestedAs, modelKey, providerId, modelKey, provider);
    }

    private buildResolved(
        requestedAs: string,
        modelKey: string,
        providerId: string,
        _modelKeyOnProvider: string,
        provider: {
            apiKeyEnv: string;
            baseURL?: string;
            timeoutMs?: number;
            models: Record<string, any>;
        },
    ): ResolvedModel {
        const apiKey = process.env[provider.apiKeyEnv];
        if (!apiKey) {
            throw new Error(
                `Provider "${providerId}" requires env var ${provider.apiKeyEnv} but it is not set.`,
            );
        }
        const baseURL =
            provider.baseURL ?? this.env.LLM_PROVIDER_BASE_URL ?? 'https://api.openai.com/v1';
        const timeoutMs =
            provider.timeoutMs ?? this.registry.policy.requestTimeoutMs;

        const modelCfg = provider.models[modelKey];
        return {
            requestedAs,
            providerId,
            modelKey,
            upstreamModel: modelCfg.real,
            apiKey,
            baseURL,
            overrides: {
                ...(typeof modelCfg.maxTokens === 'number'
                    ? { maxTokens: modelCfg.maxTokens }
                    : {}),
            },
            supportsStream: modelCfg.supportsStream ?? true,
            timeoutMs,
        };
    }
}
