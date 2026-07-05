import { z } from 'zod';

/**
 * Schema + inferred types for the multi-provider registry declared in
 * `config/providers.json`.
 *
 * The file is the single source of truth: routing keys, model real names,
 * per-model overrides and the `aliases` table that decodes user-facing
 * names like "fast" → "openai/gpt-4o-mini".
 */

// --- model config --------------------------------------------------------

const ModelConfigSchema = z.object({
    real: z.string().min(1, 'real model name is required'),
    maxTokens: z.number().int().positive().optional(),
    supportsStream: z.boolean().optional(),
});

export type ModelConfig = z.infer<typeof ModelConfigSchema>;

// --- provider config -----------------------------------------------------

const ProviderConfigSchema = z.object({
    // Env var name holding the provider's API key. Resolved against
    // process.env at boot. Phase 4 may move this to a credential store.
    apiKeyEnv: z.string().min(1, 'apiKeyEnv is required'),
    // Default baseURL for the provider; can be overridden by LLM_PROVIDER_BASE_URL.
    baseURL: z.string().url().optional(),
    // Phase 3: per-provider request timeout (ms). Falls back to the global
    // `routing.requestTimeoutMs` when omitted.
    timeoutMs: z.number().int().positive().optional(),
    models: z.record(z.string(), ModelConfigSchema),
});

export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

// --- aliases -------------------------------------------------------------

// Phase 3: each alias is an ordered chain of "providerId/modelId" entries.
// The first entry is the primary; the rest are fallbacks in priority order
// (used by `RoutingService` when the primary fails or its circuit is open).
// We enforce `min(1)` so every alias has at least a primary.
const ChainEntry = z.string().regex(/^[^/\s]+\/[^/\s]+$/, {
    message: 'aliases must be in the form "providerId/modelId"',
});

const AliasesSchema = z.record(
    z.string(),
    z.array(ChainEntry).min(1, 'alias chain must contain at least one entry'),
);

export type Aliases = z.infer<typeof AliasesSchema>;

// --- routing policy ------------------------------------------------------

const RoutingSchema = z.object({
    fallbackEnabled: z.boolean().default(true),
    strategy: z.enum(['primary', 'round-robin', 'fallback']).default('primary'),
    healthCheckIntervalMs: z.number().int().positive().default(30_000),
    requestTimeoutMs: z.number().int().positive().default(120_000),
    // Phase 3: circuit breaker knobs (apply globally to every provider).
    failureThreshold: z
        .number()
        .int()
        .positive()
        .default(5),
    cooldownMs: z
        .number()
        .int()
        .positive()
        .default(30_000),
    halfOpenProbes: z
        .number()
        .int()
        .positive()
        .default(1),
});

export type RoutingPolicy = z.infer<typeof RoutingSchema>;

// --- top-level providers.json -------------------------------------------

export const ProvidersFileSchema = z.object({
    providers: z.record(z.string(), ProviderConfigSchema),
    aliases: AliasesSchema.optional(),
    routing: RoutingSchema.optional(),
});

export type ProvidersFile = z.infer<typeof ProvidersFileSchema>;

// --- resolved model (output of ProviderService.resolve) ----------------

export interface ResolvedModel {
    /** Original string the caller passed (alias, "provider/model", or "model"). */
    requestedAs: string;
    /** Provider id (e.g. "nan"). */
    providerId: string;
    /** Alias of the model as referenced in the registry (e.g. "qwen3-coder"). */
    modelKey: string;
    /** Real upstream model name (e.g. "qwen3-coder"). */
    upstreamModel: string;
    /** Resolved API key for the provider. */
    apiKey: string;
    /** Resolved baseURL. */
    baseURL: string;
    /** Per-model overrides applied to the outbound body. */
    overrides: {
        maxTokens?: number;
    };
    /** Streaming is supported when explicitly marked true (we default conservative). */
    supportsStream: boolean;
    /**
     * Effective request timeout in ms (provider override or the policy
     * default). Used by `RoutingService` to derive an `AbortSignal` per
     * upstream attempt.
     */
    timeoutMs: number;
}
