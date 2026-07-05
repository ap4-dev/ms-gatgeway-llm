import { z } from 'zod';

/**
 * Typed schema for the gateway runtime configuration.
 *
 * Sources, in order of priority (highest first):
 *   1. Doppler SDK (loaded in main.ts via inyectEnv) — writes to process.env
 *   2. process.env loaded from .env by `dotenv/config`
 *
 * Doppler runs first in main.ts, so its values always win.
 */
// Accepted aliases — Doppler in this project uses the project convention
// `dev`/`stg`/`prd`. Local `.env` has historically used `develop`. We accept
// every variant in the schema, then normalize to a canonical form so the
// rest of the codebase only sees standard Node values.
const NODE_ENV_ALIASES = {
    development: 'development',
    develop: 'development',
    dev: 'development',
    staging: 'staging',
    stg: 'staging',
    production: 'production',
    prod: 'production',
    prd: 'production',
    test: 'test',
} as const;

const envSchema = z.object({
    NODE_ENV: z
        .enum(
            Object.keys(NODE_ENV_ALIASES) as [keyof typeof NODE_ENV_ALIASES],
        )
        .transform((v) => NODE_ENV_ALIASES[v])
        .default('development'),
    PORT: z.coerce.number().int().positive().default(3000),

    // Phase 1: held the single OpenAI client config. Phase 2 moves this into
    // config/providers.json + per-provider env vars (NAN_API_KEY, etc.).
    // Both legacy keys are now optional; ProviderService will surface a
    // clear error if a required provider has no key.
    LLM_PROVIDER_API_KEY: z.string().optional(),
    LLM_PROVIDER_BASE_URL: z
        .string()
        .url('LLM_PROVIDER_BASE_URL must be a valid URL')
        .optional(),

    // CORS allowlist (comma-separated origins or "*")
    CORS_ORIGINS: z.string().optional(),

    // Doppler
    START_TOKEN: z.string().optional(),
    MS: z.string().default('ms-proxy'),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | undefined;

/**
 * Read & validate process.env. Caches the result so callers can call
 * getEnv() freely without re-parsing.
 *
 * Throws a ZodError with a human-readable message when the schema fails.
 */
export function getEnv(): Env {
    if (cached) return cached;

    const raw = { ...process.env };
    // Some Doppler setups emit uppercase variants; Zod's enum is case-sensitive
    // so we don't try to coerce this here — callers should set NODE_ENV in
    // their preferred convention (development / staging / production / test,
    // or the project aliases dev / stg / prd / develop / prod).

    const parsed = envSchema.safeParse(raw);
    if (!parsed.success) {
        const issues = parsed.error.issues
            .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
            .join('\n');
        throw new Error(`Invalid environment configuration:\n${issues}`);
    }
    cached = parsed.data;
    return cached;
}

/**
 * Test-only helper. Lets specs reset the cache between cases after
 * mutating process.env.
 */
export function resetEnvCache(): void {
    cached = undefined;
}
