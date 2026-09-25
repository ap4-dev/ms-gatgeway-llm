import Database from 'better-sqlite3';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProviderRegistryRepository } from './provider-registry.repository';
import { MigrationRunner } from '../migrations/migration-runner';

function makeDb(): { db: Database.Database; cleanup: () => void } {
    const dir = mkdtempSync(join(tmpdir(), 'ms-repop-'));
    const migrationsDir = join(dir, 'migrations');
    require('node:fs').mkdirSync(migrationsDir, { recursive: true });
    const sql = [
        '0001_providers.sql',
        '0005_alias_strategy.sql',
        '0006_alias_weights.sql',
        '0007_alias_priority.sql',
        '0008_alias_strategy_enum_widen.sql',
        '0012_provider_capabilities.sql',
    ]
        .map((f) => readFileSync(join(process.cwd(), 'migrations', f), 'utf-8'))
        .join('\n');
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(sql);
    db.exec('ALTER TABLE model_configs ADD COLUMN disable_thinking INTEGER NOT NULL DEFAULT 0 CHECK (disable_thinking IN (0,1))');
    return { db, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe('ProviderRegistryRepository', () => {
    let db: Database.Database;
    let cleanup: () => void;

    beforeEach(() => {
        ({ db, cleanup } = makeDb());
    });

    afterEach(() => {
        db.close();
        cleanup();
    });

    describe('reads', () => {
        it('listProviders returns one entry per provider with nested models', () => {
            const repo = new ProviderRegistryRepository(db);
            repo.upsertProvider(
                {
                    id: 'nan',
                    apiKeyEnv: 'NAN_API_KEY',
                    baseURL: 'https://api.nan.builders/v1',
                    timeoutMs: 60_000,
                },
                {
                    'qwen3.6': { real: 'qwen3.6' },
                    coder: { real: 'qwen3-coder', maxTokens: 16384 },
                },
            );
            repo.upsertProvider(
                {
                    id: 'openai',
                    apiKeyEnv: 'OPENAI_API_KEY',
                },
                {
                    'gpt-4o-mini': { real: 'gpt-4o-mini' },
                },
            );

            const providers = repo.listProviders();
            expect(Object.keys(providers).sort()).toEqual(['nan', 'openai']);
            expect(providers.nan.apiKeyEnv).toBe('NAN_API_KEY');
            expect(providers.nan.baseURL).toBe('https://api.nan.builders/v1');
            expect(providers.nan.timeoutMs).toBe(60_000);
            expect(providers.nan.models.coder.maxTokens).toBe(16384);
            expect(providers.openai.baseURL).toBeUndefined();
            expect(providers.openai.timeoutMs).toBeUndefined();
            expect(providers.openai.models['gpt-4o-mini'].real).toBe('gpt-4o-mini');
        });

        it('getProvider returns undefined for unknown id', () => {
            const repo = new ProviderRegistryRepository(db);
            expect(repo.getProvider('nope')).toBeUndefined();
        });

        it('listAliases returns chains ordered by position', () => {
            const repo = new ProviderRegistryRepository(db);
            repo.upsertProvider(
                { id: 'a', apiKeyEnv: 'A' },
                { 'm1': { real: 'a-m1' }, 'm2': { real: 'a-m2' } },
            );
            repo.upsertProvider(
                { id: 'b', apiKeyEnv: 'B' },
                { 'm1': { real: 'b-m1' } },
            );

            const insert = db.prepare(
                'INSERT INTO alias_entries (alias_name, position, provider_id, model_key) VALUES (?, ?, ?, ?)',
            );
            insert.run('fast', 1, 'a', 'm1');
            insert.run('fast', 0, 'b', 'm1');
            insert.run('coder', 0, 'a', 'm2');

            const aliases = repo.listAliases();
            expect(aliases.fast).toEqual(['b/m1', 'a/m1']);
            expect(aliases.coder).toEqual(['a/m2']);
        });

        it('listAliases skips aliases with no entries', () => {
            const repo = new ProviderRegistryRepository(db);
            const aliases = repo.listAliases();
            expect(aliases).toEqual({});
        });

        it('getPolicy returns the singleton with all fields populated', () => {
            const repo = new ProviderRegistryRepository(db);
            const policy = repo.getPolicy();
            expect(policy.fallbackEnabled).toBe(true);
            expect(policy.requestTimeoutMs).toBe(120_000);
            expect(policy.cooldownMs).toBe(30_000);
            expect(policy.failureThreshold).toBe(5);
            expect(policy.halfOpenProbes).toBe(1);
            expect((policy as any).strategy).toBeUndefined();
        });

        it('getStrategy returns primary by default and the stored value when configured', () => {
            const repo = new ProviderRegistryRepository(db);
            expect(repo.getStrategy('unknown-alias')).toBe('primary');
            repo.upsertAliasPolicy('fast', 'round-robin');
            expect(repo.getStrategy('fast')).toBe('round-robin');
        });

        it('findModel scans across providers and returns the first match', () => {
            const repo = new ProviderRegistryRepository(db);
            repo.upsertProvider(
                { id: 'a', apiKeyEnv: 'A' },
                { 'shared': { real: 'shared-real' } },
            );
            repo.upsertProvider(
                { id: 'b', apiKeyEnv: 'B' },
                { 'shared': { real: 'shared-real' } },
            );

            const found = repo.findModel('shared');
            expect(found?.providerId).toBe('a');
            expect(found?.modelKey).toBe('shared');
        });

        it('findModel returns undefined when no provider owns the model key', () => {
            const repo = new ProviderRegistryRepository(db);
            repo.upsertProvider({ id: 'a', apiKeyEnv: 'A' }, { m1: { real: 'r1' } });
            expect(repo.findModel('m2')).toBeUndefined();
        });
    });

    describe('writes', () => {
        it('upsertAliasPolicy accepts widened enum values', () => {
            const repo = new ProviderRegistryRepository(db);
            expect(() => repo.upsertAliasPolicy('a', 'weighted')).not.toThrow();
            expect(() => repo.upsertAliasPolicy('b', 'priority-grouped')).not.toThrow();
        });

        it('upsertProvider replaces an existing provider and cascades its old models', () => {
            const repo = new ProviderRegistryRepository(db);
            repo.upsertProvider(
                { id: 'a', apiKeyEnv: 'A' },
                { m1: { real: 'r1' }, m2: { real: 'r2' } },
            );
            expect(Object.keys(repo.listProviders().a.models).sort()).toEqual(['m1', 'm2']);

            repo.upsertProvider(
                { id: 'a', apiKeyEnv: 'A2', baseURL: 'https://example/v1' },
                { m1: { real: 'r1-new' }, m3: { real: 'r3' } },
            );

            const providers = repo.listProviders();
            expect(providers.a.apiKeyEnv).toBe('A2');
            expect(providers.a.baseURL).toBe('https://example/v1');
            expect(Object.keys(providers.a.models).sort()).toEqual(['m1', 'm3']);
            expect(providers.a.models.m1.real).toBe('r1-new');
            expect(providers.a.models.m3.real).toBe('r3');
            expect(providers.a.models.m2).toBeUndefined();
        });

        it('upsertProvider inserts a brand-new provider when id is unknown', () => {
            const repo = new ProviderRegistryRepository(db);
            repo.upsertProvider(
                { id: 'fresh', apiKeyEnv: 'F' },
                { x: { real: 'r' } },
            );
            expect(repo.getProvider('fresh')?.models.x.real).toBe('r');
        });

        it('replaceAliasEntry deletes the previous chain and inserts the new one', () => {
            const repo = new ProviderRegistryRepository(db);
            repo.upsertProvider(
                { id: 'a', apiKeyEnv: 'A' },
                { m1: { real: 'r1' }, m2: { real: 'r2' } },
            );

            repo.replaceAliasEntry('fast', ['a/m1']);
            repo.replaceAliasEntry('fast', ['a/m2', 'a/m1']);

            expect(repo.listAliases().fast).toEqual(['a/m2', 'a/m1']);
        });

        it('replaceAliasEntry with an empty array removes the alias entirely', () => {
            const repo = new ProviderRegistryRepository(db);
            repo.upsertProvider({ id: 'a', apiKeyEnv: 'A' }, { m1: { real: 'r1' } });
            repo.replaceAliasEntry('fast', ['a/m1']);
            expect(repo.listAliases().fast).toEqual(['a/m1']);
            repo.replaceAliasEntry('fast', []);
            expect(repo.listAliases().fast).toBeUndefined();
        });

        it('setPolicy updates the singleton row', () => {
            const repo = new ProviderRegistryRepository(db);
            repo.setPolicy({ failureThreshold: 10 });
            const policy = repo.getPolicy();
            expect(policy.failureThreshold).toBe(10);
            expect(policy.cooldownMs).toBe(30_000);
        });
    });

    describe('weights (alias_weights table)', () => {
        it('returns an empty array when no rows exist', () => {
            const repo = new ProviderRegistryRepository(db);
            expect(repo.getWeights('fast')).toEqual([]);
        });

        it('upsertWeights stores rows indexed by position', () => {
            const repo = new ProviderRegistryRepository(db);
            repo.upsertWeights('fast', [5, 3, 2]);
            const got = repo.getWeights('fast');
            expect(got).toEqual([
                { position: 0, weight: 5 },
                { position: 1, weight: 3 },
                { position: 2, weight: 2 },
            ]);
        });

        it('upsertWeights is idempotent when called with the same array', () => {
            const repo = new ProviderRegistryRepository(db);
            repo.upsertWeights('fast', [5, 3]);
            repo.upsertWeights('fast', [5, 3]);
            expect(repo.getWeights('fast')).toHaveLength(2);
        });

        it('upsertWeights with an empty array removes all existing rows', () => {
            const repo = new ProviderRegistryRepository(db);
            repo.upsertWeights('fast', [5, 3]);
            repo.upsertWeights('fast', []);
            expect(repo.getWeights('fast')).toEqual([]);
        });

        it('rejects non-positive weights', () => {
            const repo = new ProviderRegistryRepository(db);
            expect(() => repo.upsertWeights('fast', [0])).toThrow(/positive/);
            expect(() => repo.upsertWeights('fast', [-1])).toThrow(/positive/);
        });
    });

    describe('alias_entries priorities (priority column)', () => {
        beforeEach(() => {
            db.prepare(
                `INSERT INTO providers (id, api_key_env, base_url) VALUES (?, ?, ?)`,
            ).run('a', 'A', 'https://a.example');
            db.prepare(
                `INSERT INTO providers (id, api_key_env, base_url) VALUES (?, ?, ?)`,
            ).run('b', 'B', 'https://b.example');
            db.prepare(
                'INSERT INTO model_configs (provider_id, model_key, real_name) VALUES (?, ?, ?)',
            ).run('a', 'm1', 'real-m1');
            db.prepare(
                'INSERT INTO model_configs (provider_id, model_key, real_name) VALUES (?, ?, ?)',
            ).run('a', 'm2', 'real-m2');
            db.prepare(
                'INSERT INTO model_configs (provider_id, model_key, real_name) VALUES (?, ?, ?)',
            ).run('b', 'm3', 'real-m3');
            const insertEntry = db.prepare(
                'INSERT INTO alias_entries (alias_name, position, provider_id, model_key, priority) VALUES (?, ?, ?, ?, ?)',
            );
            insertEntry.run('code', 0, 'a', 'm1', 0);
            insertEntry.run('code', 1, 'b', 'm3', 1);
            insertEntry.run('code', 2, 'a', 'm2', 1);
        });

        it('returns entries with priorities in position order', () => {
            const repo = new ProviderRegistryRepository(db);
            const entries = repo.getAliasEntries('code');
            expect(entries.map((e) => ({ p: e.position, pr: e.priority, m: e.model_key }))).toEqual([
                { p: 0, pr: 0, m: 'm1' },
                { p: 1, pr: 1, m: 'm3' },
                { p: 2, pr: 1, m: 'm2' },
            ]);
            expect(entries[0].provider_id).toBe('a');
        });

        it('returns an empty array for an unknown alias', () => {
            const repo = new ProviderRegistryRepository(db);
            expect(repo.getAliasEntries('nope')).toEqual([]);
        });
    });

    describe('provider + model CRUD', () => {
        it('findProvider returns the raw row for a known id', () => {
            const repo = new ProviderRegistryRepository(db);
            repo.upsertProvider(
                {
                    id: 'nan',
                    apiKeyEnv: 'NAN_API_KEY',
                    baseURL: 'https://a.example',
                    timeoutMs: 1000,
                    supportsSearch: true,
                },
                { m1: { real: 'r1' } },
            );
            const row = repo.findProvider('nan');
            expect(row?.id).toBe('nan');
            expect(row?.api_key_env).toBe('NAN_API_KEY');
            expect(row?.base_url).toBe('https://a.example');
            expect(row?.timeout_ms).toBe(1000);
            expect(row?.supports_search).toBe(1);
        });

        it('findProvider returns undefined for an unknown id', () => {
            const repo = new ProviderRegistryRepository(db);
            expect(repo.findProvider('nope')).toBeUndefined();
        });

        it('modelExists reflects the (provider_id, model_key) pair', () => {
            const repo = new ProviderRegistryRepository(db);
            repo.upsertProvider({ id: 'a', apiKeyEnv: 'A' }, { m1: { real: 'r1' } });
            expect(repo.modelExists('a', 'm1')).toBe(true);
            expect(repo.modelExists('a', 'm2')).toBe(false);
            expect(repo.modelExists('b', 'm1')).toBe(false);
        });

        it('createProvider inserts a provider without touching models', () => {
            const repo = new ProviderRegistryRepository(db);
            repo.createProvider({ id: 'fresh', apiKeyEnv: 'FRESH_API_KEY' });
            expect(repo.findProvider('fresh')?.api_key_env).toBe('FRESH_API_KEY');
            expect(repo.listProviders().fresh.models).toEqual({});
        });

        it('updateProvider merges only the provided fields and keeps models', () => {
            const repo = new ProviderRegistryRepository(db);
            repo.upsertProvider(
                { id: 'a', apiKeyEnv: 'A', baseURL: 'https://a.example', timeoutMs: 1000 },
                { m1: { real: 'r1' } },
            );
            repo.updateProvider('a', { timeoutMs: 2000, supportsSearch: true });
            const row = repo.findProvider('a')!;
            expect(row.api_key_env).toBe('A');
            expect(row.base_url).toBe('https://a.example');
            expect(row.timeout_ms).toBe(2000);
            expect(row.supports_search).toBe(1);
            expect(repo.listProviders().a.models.m1.real).toBe('r1');
        });

        it('deleteProvider removes the provider and cascades its models', () => {
            const repo = new ProviderRegistryRepository(db);
            repo.upsertProvider({ id: 'a', apiKeyEnv: 'A' }, { m1: { real: 'r1' } });
            repo.deleteProvider('a');
            expect(repo.findProvider('a')).toBeUndefined();
            expect(repo.listProviders().a).toBeUndefined();
            expect(repo.modelExists('a', 'm1')).toBe(false);
        });

        it('createModel inserts a model row', () => {
            const repo = new ProviderRegistryRepository(db);
            repo.createProvider({ id: 'a', apiKeyEnv: 'A' });
            repo.createModel('a', 'm1', {
                real: 'real-m1',
                maxTokens: 4096,
                supportsStream: false,
                disableThinking: true,
            });
            const row = repo.getModelRow('a', 'm1')!;
            expect(row.real_name).toBe('real-m1');
            expect(row.max_tokens).toBe(4096);
            expect(row.supports_stream).toBe(0);
            expect(row.disable_thinking).toBe(1);
        });

        it('updateModel merges only the provided fields', () => {
            const repo = new ProviderRegistryRepository(db);
            repo.upsertProvider({ id: 'a', apiKeyEnv: 'A' }, { m1: { real: 'r1' } });
            repo.updateModel('a', 'm1', { realName: 'r1-new', disableThinking: true });
            const row = repo.getModelRow('a', 'm1')!;
            expect(row.real_name).toBe('r1-new');
            expect(row.disable_thinking).toBe(1);
            expect(row.supports_stream).toBe(1);
        });

        it('deleteModel removes only that model', () => {
            const repo = new ProviderRegistryRepository(db);
            repo.upsertProvider(
                { id: 'a', apiKeyEnv: 'A' },
                { m1: { real: 'r1' }, m2: { real: 'r2' } },
            );
            repo.deleteModel('a', 'm1');
            expect(repo.modelExists('a', 'm1')).toBe(false);
            expect(repo.modelExists('a', 'm2')).toBe(true);
        });

        it('aliasesUsingProvider lists the alias names that reference it', () => {
            const repo = new ProviderRegistryRepository(db);
            repo.upsertProvider({ id: 'a', apiKeyEnv: 'A' }, { m1: { real: 'r1' } });
            repo.upsertProvider({ id: 'b', apiKeyEnv: 'B' }, { m1: { real: 'r1' } });
            repo.replaceAliasEntry('fast', ['a/m1', 'b/m1']);
            repo.replaceAliasEntry('coder', ['a/m1']);
            expect(repo.aliasesUsingProvider('a')).toEqual(['coder', 'fast']);
            expect(repo.aliasesUsingProvider('b')).toEqual(['fast']);
            expect(repo.aliasesUsingProvider('nope')).toEqual([]);
        });

        it('aliasesUsingModel lists the alias names that reference provider+model', () => {
            const repo = new ProviderRegistryRepository(db);
            repo.upsertProvider(
                { id: 'a', apiKeyEnv: 'A' },
                { m1: { real: 'r1' }, m2: { real: 'r2' } },
            );
            repo.replaceAliasEntry('fast', ['a/m1', 'a/m2']);
            repo.replaceAliasEntry('coder', ['a/m1']);
            expect(repo.aliasesUsingModel('a', 'm1')).toEqual(['coder', 'fast']);
            expect(repo.aliasesUsingModel('a', 'm2')).toEqual(['fast']);
            expect(repo.aliasesUsingModel('a', 'nope')).toEqual([]);
        });
    });

    describe('alias CRUD', () => {
        beforeEach(() => {
            db.prepare('INSERT INTO providers (id, api_key_env) VALUES (?, ?)').run('a', 'A');
            db.prepare('INSERT INTO providers (id, api_key_env) VALUES (?, ?)').run('b', 'B');
            db.prepare(
                'INSERT INTO model_configs (provider_id, model_key, real_name) VALUES (?, ?, ?)',
            ).run('a', 'm1', 'a-m1');
            db.prepare(
                'INSERT INTO model_configs (provider_id, model_key, real_name) VALUES (?, ?, ?)',
            ).run('a', 'm2', 'a-m2');
            db.prepare(
                'INSERT INTO model_configs (provider_id, model_key, real_name) VALUES (?, ?, ?)',
            ).run('b', 'm3', 'b-m3');
        });

        it('createAlias inserts the chain in order with the requested strategy', () => {
            const repo = new ProviderRegistryRepository(db);
            repo.createAlias('fast', ['a/m1', 'b/m3'], 'round-robin');
            expect(repo.listAliases().fast).toEqual(['a/m1', 'b/m3']);
            expect(repo.getStrategy('fast')).toBe('round-robin');
        });

        it('deleteAlias removes entries, policy and weights', () => {
            const repo = new ProviderRegistryRepository(db);
            repo.createAlias('fast', ['a/m1'], 'weighted');
            repo.upsertWeights('fast', [5]);
            repo.deleteAlias('fast');
            expect(repo.listAliases().fast).toBeUndefined();
            expect(repo.getStrategy('fast')).toBe('primary');
            expect(repo.getWeights('fast')).toEqual([]);
        });

        it('appendAliasEntry appends at the end and keeps explicit weights aligned', () => {
            const repo = new ProviderRegistryRepository(db);
            repo.createAlias('fast', ['a/m1'], 'weighted');
            repo.upsertWeights('fast', [5]);
            repo.appendAliasEntry('fast', 'b/m3');
            expect(repo.listAliases().fast).toEqual(['a/m1', 'b/m3']);
            expect(repo.getWeights('fast')).toEqual([
                { position: 0, weight: 5 },
                { position: 1, weight: 1 },
            ]);
        });

        it('appendAliasEntry leaves weights empty when none were configured', () => {
            const repo = new ProviderRegistryRepository(db);
            repo.createAlias('fast', ['a/m1'], 'primary');
            repo.appendAliasEntry('fast', 'b/m3');
            expect(repo.getWeights('fast')).toEqual([]);
        });

        it('removeAliasEntry shifts positions and reindexes weights', () => {
            const repo = new ProviderRegistryRepository(db);
            repo.createAlias('fast', ['a/m1', 'b/m3', 'a/m2'], 'weighted');
            repo.upsertWeights('fast', [5, 3, 2]);
            repo.removeAliasEntry('fast', 1);
            expect(repo.listAliases().fast).toEqual(['a/m1', 'a/m2']);
            expect(repo.getWeights('fast')).toEqual([
                { position: 0, weight: 5 },
                { position: 1, weight: 2 },
            ]);
        });
    });
});
