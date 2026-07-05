import Database from 'better-sqlite3';
import type {
    ModelConfig,
    ProviderConfig,
    RoutingPolicy,
    RoutingStrategyKind,
} from '../../providers/provider.model';

/**
 * Thin SQLite-backed repository for the multi-provider registry.
 *
 * All read methods hit the DB synchronously (better-sqlite3 is sync), which
 * is what Phase 3's `ProviderRegistryService` expects — no in-memory cache
 * means inserts land in real time for the lifetime of the process.
 *
 * Schema lives in `migrations/0001_providers.sql`. Field names here use
 * `snake_case` to match the SQL columns; the public surface translates back
 * to the existing `camelCase` JSON shape so callers (ProviderService,
 * CircuitBreakerService, ModelsController) need no changes.
 */
export class ProviderRegistryRepository {
    /** Pre-prepared statements are reused for every call. */
    private readonly queries: {
        listProviders: Database.Statement;
        listModels: Database.Statement;
        listAliases: Database.Statement;
        getPolicy: Database.Statement;
        findModelByKey: Database.Statement;
        deleteProviderCascade: Database.Statement;
        insertProvider: Database.Statement;
        insertModel: Database.Statement;
        deleteAliasChain: Database.Statement;
        insertAliasEntry: Database.Statement;
        countProviders: Database.Statement;
        updatePolicy: Database.Statement;
        getStrategy: Database.Statement;
        upsertAliasPolicy: Database.Statement;
    };

    constructor(private readonly db: Database.Database) {
        this.queries = {
            listProviders: this.db.prepare(
                'SELECT id, api_key_env, base_url, timeout_ms FROM providers',
            ),
            listModels: this.db.prepare(
                'SELECT provider_id, model_key, real_name, max_tokens, supports_stream FROM model_configs',
            ),
            listAliases: this.db.prepare(
                'SELECT alias_name, position, provider_id, model_key FROM alias_entries ORDER BY alias_name, position',
            ),
            getPolicy: this.db.prepare(
                'SELECT fallback_enabled, health_check_interval_ms, request_timeout_ms, failure_threshold, cooldown_ms, half_open_probes FROM routing_policy WHERE id = 1',
            ),
            findModelByKey: this.db.prepare(
                'SELECT provider_id, model_key FROM model_configs WHERE model_key = ? ORDER BY provider_id LIMIT 1',
            ),
            deleteProviderCascade: this.db.prepare(
                'DELETE FROM providers WHERE id = ?',
            ),
            insertProvider: this.db.prepare(
                'INSERT INTO providers (id, api_key_env, base_url, timeout_ms) VALUES (?, ?, ?, ?)',
            ),
            insertModel: this.db.prepare(
                'INSERT INTO model_configs (provider_id, model_key, real_name, max_tokens, supports_stream) VALUES (?, ?, ?, ?, ?)',
            ),
            deleteAliasChain: this.db.prepare(
                'DELETE FROM alias_entries WHERE alias_name = ?',
            ),
            insertAliasEntry: this.db.prepare(
                'INSERT INTO alias_entries (alias_name, position, provider_id, model_key) VALUES (?, ?, ?, ?)',
            ),
            countProviders: this.db.prepare(
                'SELECT COUNT(*) AS c FROM providers',
            ),
            updatePolicy: this.db.prepare(`
                UPDATE routing_policy SET
                    fallback_enabled         = ?,
                    health_check_interval_ms = ?,
                    request_timeout_ms       = ?,
                    failure_threshold        = ?,
                    cooldown_ms              = ?,
                    half_open_probes         = ?
                WHERE id = 1
            `),
            getStrategy: this.db.prepare(
                'SELECT strategy FROM alias_policy WHERE alias_key = ?',
            ),
            upsertAliasPolicy: this.db.prepare(`
                INSERT INTO alias_policy (alias_key, strategy)
                VALUES (?, ?)
                ON CONFLICT(alias_key) DO UPDATE SET strategy = excluded.strategy
            `),
        };
    }

    // --- reads ----------------------------------------------------------

    /** All providers, keyed by id, each with its model map nested under `models`. */
    listProviders(): Record<string, ProviderConfig> {
        const modelsByProvider = new Map<string, Record<string, ModelConfig>>();
        for (const r of this.queries.listModels.all() as Array<{
            provider_id: string;
            model_key: string;
            real_name: string;
            max_tokens: number | null;
            supports_stream: number;
        }>) {
            const cfg: ModelConfig = { real: r.real_name };
            if (r.max_tokens != null) cfg.maxTokens = r.max_tokens;
            if (r.supports_stream === 0) cfg.supportsStream = false;
            const existing = modelsByProvider.get(r.provider_id) ?? {};
            existing[r.model_key] = cfg;
            modelsByProvider.set(r.provider_id, existing);
        }
        const out: Record<string, ProviderConfig> = {};
        for (const p of this.queries.listProviders.all() as Array<{
            id: string;
            api_key_env: string;
            base_url: string | null;
            timeout_ms: number | null;
        }>) {
            const cfg: ProviderConfig = {
                apiKeyEnv: p.api_key_env,
                models: modelsByProvider.get(p.id) ?? {},
            };
            if (p.base_url) cfg.baseURL = p.base_url;
            if (p.timeout_ms) cfg.timeoutMs = p.timeout_ms;
            out[p.id] = cfg;
        }
        return out;
    }

    getProvider(id: string): ProviderConfig | undefined {
        return this.listProviders()[id];
    }

    /** Alias chains ordered by `position`. Aliases with no entries are omitted. */
    listAliases(): Record<string, string[]> {
        const byName = new Map<string, string[]>();
        for (const r of this.queries.listAliases.all() as Array<{
            alias_name: string;
            position: number;
            provider_id: string;
            model_key: string;
        }>) {
            const path = `${r.provider_id}/${r.model_key}`;
            const arr = byName.get(r.alias_name) ?? [];
            arr.push(path);
            byName.set(r.alias_name, arr);
        }
        const out: Record<string, string[]> = {};
        for (const [name, paths] of byName) {
            if (paths.length > 0) out[name] = paths;
        }
        return out;
    }

    /** The singleton routing policy row, defaults if missing. */
    getPolicy(): RoutingPolicy {
        const row = this.queries.getPolicy.get() as
            | {
                  fallback_enabled: number;
                  health_check_interval_ms: number;
                  request_timeout_ms: number;
                  failure_threshold: number;
                  cooldown_ms: number;
                  half_open_probes: number;
              }
            | undefined;
        if (!row) {
            return {
                fallbackEnabled: true,
                healthCheckIntervalMs: 30_000,
                requestTimeoutMs: 120_000,
                failureThreshold: 5,
                cooldownMs: 30_000,
                halfOpenProbes: 1,
            };
        }
        return {
            fallbackEnabled: row.fallback_enabled === 1,
            healthCheckIntervalMs: row.health_check_interval_ms,
            requestTimeoutMs: row.request_timeout_ms,
            failureThreshold: row.failure_threshold,
            cooldownMs: row.cooldown_ms,
            halfOpenProbes: row.half_open_probes,
        };
    }

    /**
     * Per-alias strategy. Reads from `alias_policy`; defaults to
     * `'primary'` when no row exists for the alias. Pure lookup — phase
     * 5.5 has no admin endpoint to mutate this from the API, so updates
     * happen via SQL / seed.
     */
    getStrategy(aliasKey: string): RoutingStrategyKind {
        const row = this.queries.getStrategy.get(aliasKey) as
            | { strategy: RoutingStrategyKind }
            | undefined;
        return row?.strategy ?? 'primary';
    }

    /** Phase 5.5: idempotent upsert for the per-alias strategy. Used
     *  by future admin endpoints / scripts. */
    upsertAliasPolicy(aliasKey: string, strategy: RoutingStrategyKind): void {
        this.queries.upsertAliasPolicy.run(aliasKey, strategy);
    }

    /** First provider that has a model with the given key. `undefined` if none. */
    findModel(modelKey: string): {
        providerId: string;
        modelKey: string;
        config: ProviderConfig;
    } | undefined {
        const row = this.queries.findModelByKey.get(modelKey) as
            | { provider_id: string; model_key: string }
            | undefined;
        if (!row) return undefined;
        const providers = this.listProviders();
        const config = providers[row.provider_id];
        if (!config) return undefined;
        return {
            providerId: row.provider_id,
            modelKey: row.model_key,
            config,
        };
    }

    /** Used by seed-on-first-boot to detect the empty-DB state. */
    countProviders(): number {
        return (this.queries.countProviders.get() as { c: number }).c;
    }

    // --- writes (seed only — Phase 5 may add admin endpoints) -----------

    /**
     * Insert or replace a provider. Cascades to model_configs (old models
     * for this id are dropped, new ones inserted). No-op on empty models.
     */
    upsertProvider(provider: ProviderConfig, models: Record<string, ModelConfig>): void {
        const txn = this.db.transaction(() => {
            this.queries.deleteProviderCascade.run((provider as any).id);
            this.queries.insertProvider.run(
                (provider as any).id,
                provider.apiKeyEnv,
                provider.baseURL ?? null,
                provider.timeoutMs ?? null,
            );
            for (const [modelKey, cfg] of Object.entries(models)) {
                this.queries.insertModel.run(
                    (provider as any).id,
                    modelKey,
                    cfg.real,
                    cfg.maxTokens ?? null,
                    cfg.supportsStream === false ? 0 : 1,
                );
            }
        });
        txn();
    }

    /** Replace the chain for a single alias atomically. Empty array = delete. */
    replaceAliasEntry(aliasName: string, paths: string[]): void {
        const txn = this.db.transaction(() => {
            this.queries.deleteAliasChain.run(aliasName);
            paths.forEach((path, position) => {
                const [providerId, modelKey] = path.split('/');
                if (!providerId || !modelKey) {
                    throw new Error(
                        `Alias entry "${path}" must be "providerId/modelKey"`,
                    );
                }
                this.queries.insertAliasEntry.run(
                    aliasName,
                    position,
                    providerId,
                    modelKey,
                );
            });
        });
        txn();
    }

    /**
     * Update the singleton routing policy. Pass only the fields to change;
     * missing fields fall back to the existing row's values.
     */
    setPolicy(partial: Partial<RoutingPolicy>): void {
        const current = this.getPolicy();
        const next: RoutingPolicy = { ...current, ...partial };
        this.queries.updatePolicy.run(
            next.fallbackEnabled ? 1 : 0,
            next.healthCheckIntervalMs,
            next.requestTimeoutMs,
            next.failureThreshold,
            next.cooldownMs,
            next.halfOpenProbes,
        );
    }
}
