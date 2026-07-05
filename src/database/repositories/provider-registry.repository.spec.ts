import Database from 'better-sqlite3';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProviderRegistryRepository } from './provider-registry.repository';
import { MigrationRunner } from '../migrations/migration-runner';

function makeDb() {
    const dir = mkdtempSync(join(tmpdir(), 'ms-repop-'));
    const migrationsDir = join(dir, 'migrations');
    require('node:fs').mkdirSync(migrationsDir, { recursive: true });
    // Inline the migration SQL directly so this spec doesn't depend on the
    // repo layout changing under it.
    const sql = [
        '0001_providers.sql',
        '0005_alias_strategy.sql',
    ]
        .map((f) => readFileSync(join(process.cwd(), 'migrations', f), 'utf-8'))
        .join('\n');
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(sql);
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

            // Insert in non-sequential position order to force a sort.
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
            // Phase 5.5: `strategy` no longer lives on the global policy;
            // per-alias strategy lives on `alias_policy`.
            expect((policy as any).strategy).toBeUndefined();
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
            expect(found?.providerId).toBe('a'); // first hit
            expect(found?.modelKey).toBe('shared');
        });

        it('findModel returns undefined when no provider owns the model key', () => {
            const repo = new ProviderRegistryRepository(db);
            repo.upsertProvider({ id: 'a', apiKeyEnv: 'A' }, { m1: { real: 'r1' } });
            expect(repo.findModel('m2')).toBeUndefined();
        });
    });

    describe('writes', () => {
        it('upsertProvider replaces an existing provider and cascades its old models', () => {
            const repo = new ProviderRegistryRepository(db);
            repo.upsertProvider(
                { id: 'a', apiKeyEnv: 'A' },
                { m1: { real: 'r1' }, m2: { real: 'r2' } },
            );
            expect(Object.keys(repo.listProviders().a.models).sort()).toEqual(['m1', 'm2']);

            // Replace: keep the id, change apiKeyEnv, drop m2, add m3.
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
            // Untouched fields keep their defaults.
            expect(policy.cooldownMs).toBe(30_000);
        });
    });
});
