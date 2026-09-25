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
        listAliasEntriesByAlias: Database.Statement;
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
        getWeights: Database.Statement;
        deleteWeightsForAlias: Database.Statement;
        insertWeight: Database.Statement;
        // Admin CRUD support (Phase 5.6).
        findProviderRow: Database.Statement;
        updateProviderRow: Database.Statement;
        getModelRow: Database.Statement;
        updateModelRow: Database.Statement;
        deleteModelRow: Database.Statement;
        modelExists: Database.Statement;
        aliasesUsingProvider: Database.Statement;
        aliasesUsingModel: Database.Statement;
        countAliasEntries: Database.Statement;
        deleteAliasPolicy: Database.Statement;
        deleteAliasEntryAt: Database.Statement;
        shiftAliasEntryPositions: Database.Statement;
        deleteWeightAt: Database.Statement;
        shiftWeightPositions: Database.Statement;
    };

    constructor(private readonly db: Database.Database) {
        this.queries = {
            listProviders: this.db.prepare(
                'SELECT id, api_key_env, base_url, timeout_ms, supports_search FROM providers',
            ),
            listModels: this.db.prepare(
                'SELECT provider_id, model_key, real_name, max_tokens, supports_stream, disable_thinking FROM model_configs',
            ),
            listAliases: this.db.prepare(
                'SELECT alias_name, position, provider_id, model_key FROM alias_entries ORDER BY alias_name, position',
            ),
            listAliasEntriesByAlias: this.db.prepare(
                'SELECT alias_name, position, provider_id, model_key, priority FROM alias_entries WHERE alias_name = ? ORDER BY position',
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
                'INSERT INTO providers (id, api_key_env, base_url, timeout_ms, supports_search) VALUES (?, ?, ?, ?, ?)',
            ),
            insertModel: this.db.prepare(
                'INSERT INTO model_configs (provider_id, model_key, real_name, max_tokens, supports_stream, disable_thinking) VALUES (?, ?, ?, ?, ?, ?)',
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
            getWeights: this.db.prepare(
                'SELECT position, weight FROM alias_weights WHERE alias_key = ? ORDER BY position',
            ),
            deleteWeightsForAlias: this.db.prepare(
                'DELETE FROM alias_weights WHERE alias_key = ?',
            ),
            insertWeight: this.db.prepare(
                'INSERT INTO alias_weights (alias_key, position, weight) VALUES (?, ?, ?) ON CONFLICT(alias_key, position) DO UPDATE SET weight = excluded.weight',
            ),
            findProviderRow: this.db.prepare(
                'SELECT id, api_key_env, base_url, timeout_ms, supports_search FROM providers WHERE id = ?',
            ),
            updateProviderRow: this.db.prepare(`
                UPDATE providers SET
                    api_key_env     = ?,
                    base_url        = ?,
                    timeout_ms      = ?,
                    supports_search = ?,
                    updated_at      = unixepoch()
                WHERE id = ?
            `),
            getModelRow: this.db.prepare(
                'SELECT provider_id, model_key, real_name, max_tokens, supports_stream, disable_thinking FROM model_configs WHERE provider_id = ? AND model_key = ?',
            ),
            updateModelRow: this.db.prepare(`
                UPDATE model_configs SET
                    real_name        = ?,
                    max_tokens       = ?,
                    supports_stream  = ?,
                    disable_thinking = ?
                WHERE provider_id = ? AND model_key = ?
            `),
            deleteModelRow: this.db.prepare(
                'DELETE FROM model_configs WHERE provider_id = ? AND model_key = ?',
            ),
            modelExists: this.db.prepare(
                'SELECT 1 AS ok FROM model_configs WHERE provider_id = ? AND model_key = ?',
            ),
            aliasesUsingProvider: this.db.prepare(
                'SELECT DISTINCT alias_name FROM alias_entries WHERE provider_id = ? ORDER BY alias_name',
            ),
            aliasesUsingModel: this.db.prepare(
                'SELECT DISTINCT alias_name FROM alias_entries WHERE provider_id = ? AND model_key = ? ORDER BY alias_name',
            ),
            countAliasEntries: this.db.prepare(
                'SELECT COUNT(*) AS c FROM alias_entries WHERE alias_name = ?',
            ),
            deleteAliasPolicy: this.db.prepare(
                'DELETE FROM alias_policy WHERE alias_key = ?',
            ),
            deleteAliasEntryAt: this.db.prepare(
                'DELETE FROM alias_entries WHERE alias_name = ? AND position = ?',
            ),
            shiftAliasEntryPositions: this.db.prepare(
                'UPDATE alias_entries SET position = position - 1 WHERE alias_name = ? AND position > ?',
            ),
            deleteWeightAt: this.db.prepare(
                'DELETE FROM alias_weights WHERE alias_key = ? AND position = ?',
            ),
            shiftWeightPositions: this.db.prepare(
                'UPDATE alias_weights SET position = position - 1 WHERE alias_key = ? AND position > ?',
            ),
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
            disable_thinking: number;
        }>) {
            const cfg: ModelConfig = { real: r.real_name };
            if (r.max_tokens != null) cfg.maxTokens = r.max_tokens;
            if (r.supports_stream === 0) cfg.supportsStream = false;
            if (r.disable_thinking === 1) cfg.disableThinking = true;
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
            supports_search: number;
        }>) {
            const cfg: ProviderConfig = {
                apiKeyEnv: p.api_key_env,
                models: modelsByProvider.get(p.id) ?? {},
            };
            if (p.base_url) cfg.baseURL = p.base_url;
            if (p.timeout_ms) cfg.timeoutMs = p.timeout_ms;
            if (p.supports_search === 1) cfg.supportsSearch = true;
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

    /**
     * Per-alias weights (used by `'weighted'` routing strategy).
     * Returns one row per (alias_key, position) — keyed by position so
     * callers can index by chain position. Empty array means no
     * explicit configuration (treat every entry as weight=1).
     */
    getWeights(aliasKey: string): Array<{ position: number; weight: number }> {
        return this.queries.getWeights.all(aliasKey) as Array<{
            position: number;
            weight: number;
        }>;
    }

    /**
     * Idempotent replace. Empty array → deletes all existing rows for
     * the alias. Throws when any weight is `<= 0` (DB CHECK would
     * throw anyway, but validating in JS gives a clearer error).
     */
    upsertWeights(aliasKey: string, weights: number[]): void {
        for (const w of weights) {
            if (!Number.isInteger(w) || w <= 0) {
                throw new Error(
                    `weights must be positive integers; got ${w}`,
                );
            }
        }
        const txn = this.db.transaction(() => {
            this.queries.deleteWeightsForAlias.run(aliasKey);
            weights.forEach((weight, position) => {
                this.queries.insertWeight.run(aliasKey, position, weight);
            });
        });
        txn();
    }

    /**
     * Phase-after-5.5: returns the alias entries with their priorities
     * in `position`-order. Used by `'priority-grouped'` strategy to
     * group entries by priority. Snake_case columns internally;
     * callers translate.
     */
    getAliasEntries(
        aliasKey: string,
    ): Array<{
        provider_id: string;
        model_key: string;
        position: number;
        priority: number;
    }> {
        return this.queries.listAliasEntriesByAlias.all(aliasKey) as Array<{
            provider_id: string;
            model_key: string;
            position: number;
            priority: number;
        }>;
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
                provider.supportsSearch === true ? 1 : 0,
            );
            for (const [modelKey, cfg] of Object.entries(models)) {
                this.queries.insertModel.run(
                    (provider as any).id,
                    modelKey,
                    cfg.real,
                    cfg.maxTokens ?? null,
                    cfg.supportsStream === false ? 0 : 1,
                    cfg.disableThinking === true ? 1 : 0,
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

    // --- admin CRUD helpers (Phase 5.6) ---------------------------------

    /** Raw `providers` row (includes `id`); `undefined` when absent. */
    findProvider(id: string): ProviderRow | undefined {
        return this.queries.findProviderRow.get(id) as ProviderRow | undefined;
    }

    /** Raw `model_configs` row; `undefined` when absent. */
    getModelRow(providerId: string, modelKey: string): ModelRow | undefined {
        return this.queries.getModelRow.get(providerId, modelKey) as ModelRow | undefined;
    }

    /** True when `(provider_id, model_key)` exists. */
    modelExists(providerId: string, modelKey: string): boolean {
        return this.queries.modelExists.get(providerId, modelKey) !== undefined;
    }

    /**
     * INSERT a provider (no models). The admin controller checks id
     * uniqueness first and surfaces 409 instead of letting the PK constraint
     * throw.
     */
    createProvider(input: {
        id: string;
        apiKeyEnv: string;
        baseURL?: string;
        timeoutMs?: number;
        supportsSearch?: boolean;
    }): void {
        this.queries.insertProvider.run(
            input.id,
            input.apiKeyEnv,
            input.baseURL ?? null,
            input.timeoutMs ?? null,
            input.supportsSearch === true ? 1 : 0,
        );
    }

    /**
     * Partial UPDATE for a provider. Reads the current row, merges only the
     * provided fields, then writes the full row back. SQLite cannot
     * distinguish "not provided" from an explicit NULL inside one prepared
     * UPDATE without dynamic SQL, and this table has no nullable-required
     * columns, so read-merge-write keeps a single cached statement valid.
     */
    updateProvider(
        id: string,
        fields: {
            apiKeyEnv?: string;
            baseURL?: string;
            timeoutMs?: number;
            supportsSearch?: boolean;
        },
    ): void {
        const current = this.findProvider(id);
        if (!current) return;
        this.queries.updateProviderRow.run(
            fields.apiKeyEnv ?? current.api_key_env,
            fields.baseURL !== undefined ? fields.baseURL : current.base_url,
            fields.timeoutMs !== undefined ? fields.timeoutMs : current.timeout_ms,
            fields.supportsSearch !== undefined
                ? fields.supportsSearch
                    ? 1
                    : 0
                : current.supports_search,
            id,
        );
    }

    /** Hard DELETE; FK cascade also drops the provider's `model_configs`. */
    deleteProvider(id: string): void {
        this.queries.deleteProviderCascade.run(id);
    }

    /** INSERT a model for an existing provider. */
    createModel(
        providerId: string,
        modelKey: string,
        cfg: {
            real: string;
            maxTokens?: number;
            supportsStream?: boolean;
            disableThinking?: boolean;
        },
    ): void {
        this.queries.insertModel.run(
            providerId,
            modelKey,
            cfg.real,
            cfg.maxTokens ?? null,
            cfg.supportsStream === false ? 0 : 1,
            cfg.disableThinking === true ? 1 : 0,
        );
    }

    /**
     * Partial UPDATE for a model. Same read-merge-write rationale as
     * {@link updateProvider}; the model's `real_name` is NOT NULL, so the
     * merge never writes a null into a required column.
     */
    updateModel(
        providerId: string,
        modelKey: string,
        fields: {
            realName?: string;
            maxTokens?: number;
            supportsStream?: boolean;
            disableThinking?: boolean;
        },
    ): void {
        const current = this.getModelRow(providerId, modelKey);
        if (!current) return;
        this.queries.updateModelRow.run(
            fields.realName ?? current.real_name,
            fields.maxTokens !== undefined ? fields.maxTokens : current.max_tokens,
            fields.supportsStream !== undefined
                ? fields.supportsStream
                    ? 1
                    : 0
                : current.supports_stream,
            fields.disableThinking !== undefined
                ? fields.disableThinking
                    ? 1
                    : 0
                : current.disable_thinking,
            providerId,
            modelKey,
        );
    }

    /** DELETE a single model; cascades any `alias_entries` that reference it. */
    deleteModel(providerId: string, modelKey: string): void {
        this.queries.deleteModelRow.run(providerId, modelKey);
    }

    /** Distinct alias names whose chain references the provider. */
    aliasesUsingProvider(providerId: string): string[] {
        return (
            this.queries.aliasesUsingProvider.all(providerId) as Array<{
                alias_name: string;
            }>
        ).map((r) => r.alias_name);
    }

    /** Distinct alias names whose chain references the provider+model pair. */
    aliasesUsingModel(providerId: string, modelKey: string): string[] {
        return (
            this.queries.aliasesUsingModel.all(providerId, modelKey) as Array<{
                alias_name: string;
            }>
        ).map((r) => r.alias_name);
    }

    /**
     * Create (or replace) an alias atomically: chain entries, per-alias
     * strategy and a clean weights slate. Callers must validate that every
     * `providerId/modelKey` exists — the composite FK enforces it too.
     */
    createAlias(aliasName: string, chain: string[], strategy: RoutingStrategyKind): void {
        const txn = this.db.transaction(() => {
            this.queries.deleteAliasChain.run(aliasName);
            this.queries.deleteWeightsForAlias.run(aliasName);
            chain.forEach((path, position) => {
                const [providerId, modelKey] = path.split('/');
                this.queries.insertAliasEntry.run(aliasName, position, providerId, modelKey);
            });
            this.queries.upsertAliasPolicy.run(aliasName, strategy);
        });
        txn();
    }

    /** Remove an alias entirely: chain entries + strategy + weights. */
    deleteAlias(aliasName: string): void {
        const txn = this.db.transaction(() => {
            this.queries.deleteAliasChain.run(aliasName);
            this.queries.deleteWeightsForAlias.run(aliasName);
            this.queries.deleteAliasPolicy.run(aliasName);
        });
        txn();
    }

    /**
     * Append a single entry at the end of the chain.
     *
     * Weight consistency: positions are 0-based and contiguous, so the new
     * position is the current entry count. When the alias already has explicit
     * `alias_weights` rows we insert weight `1` for the new position so the
     * stored array stays aligned with the chain; when it has none we leave it
     * empty and the `weight = 1` default applies uniformly (see
     * {@link getWeights}). Callers enforce the 64-entry ceiling and
     * provider/model existence.
     */
    appendAliasEntry(aliasName: string, path: string): void {
        const [providerId, modelKey] = path.split('/');
        const txn = this.db.transaction(() => {
            const count = (this.queries.countAliasEntries.get(aliasName) as { c: number }).c;
            this.queries.insertAliasEntry.run(aliasName, count, providerId, modelKey);
            const weights = this.queries.getWeights.all(aliasName) as Array<unknown>;
            if (weights.length > 0) {
                this.queries.insertWeight.run(aliasName, count, 1);
            }
        });
        txn();
    }

    /**
     * Remove the entry at `position` and reindex everything after it.
     *
     * `alias_entries.position` and `alias_weights.position` are both 0-based
     * indices into the chain, so after deleting the entry we decrement every
     * later position in both tables. The weight row for the removed position is
     * deleted first (a later row must not inherit it). Callers guard against
     * emptying the chain (minimum one entry).
     */
    removeAliasEntry(aliasName: string, position: number): void {
        const txn = this.db.transaction(() => {
            this.queries.deleteAliasEntryAt.run(aliasName, position);
            this.queries.shiftAliasEntryPositions.run(aliasName, position);
            this.queries.deleteWeightAt.run(aliasName, position);
            this.queries.shiftWeightPositions.run(aliasName, position);
        });
        txn();
    }
}

/** Raw `providers` row shape (snake_case columns). */
export interface ProviderRow {
    id: string;
    api_key_env: string;
    base_url: string | null;
    timeout_ms: number | null;
    supports_search: number;
}

/** Raw `model_configs` row shape (snake_case columns). */
export interface ModelRow {
    provider_id: string;
    model_key: string;
    real_name: string;
    max_tokens: number | null;
    supports_stream: number;
    disable_thinking: number;
}
