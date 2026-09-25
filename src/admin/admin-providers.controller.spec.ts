import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConflictException, NotFoundException } from '@nestjs/common';
import { AdminProvidersController } from './admin-providers.controller';
import { ProviderRegistryService } from '../providers/provider.registry';
import { ProviderRegistryRepository } from '../database/repositories/provider-registry.repository';

/**
 * In-memory SQLite harness mirroring `provider-registry.repository.spec.ts`:
 * apply the migration subset the registry needs, then wrap the repo in a real
 * `ProviderRegistryService` so the controller runs against genuine SQL
 * semantics (FKs, conflicts, cascades) instead of hand-rolled fakes.
 */
function makeDb(): Database.Database {
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
    db.exec(
        'ALTER TABLE model_configs ADD COLUMN disable_thinking INTEGER NOT NULL DEFAULT 0 CHECK (disable_thinking IN (0,1))',
    );
    return db;
}

interface Harness {
    controller: AdminProvidersController;
    registry: ProviderRegistryService;
    repo: ProviderRegistryRepository;
    db: Database.Database;
}

function makeHarness(): Harness {
    const db = makeDb();
    const repo = new ProviderRegistryRepository(db);
    const registry = new ProviderRegistryService(repo);
    return { controller: new AdminProvidersController(registry), registry, repo, db };
}

describe('AdminProvidersController.list', () => {
    it('lists providers sorted by id with models and usedInAliases', () => {
        const { controller, repo } = makeHarness();
        repo.upsertProvider(
            { id: 'nan', apiKeyEnv: 'NAN_API_KEY', baseURL: 'https://api.nan.builders/v1' },
            { qwen: { real: 'qwen3.6' }, mimo: { real: 'mimo-v2.5', maxTokens: 8192 } },
        );
        repo.upsertProvider({ id: 'alpha', apiKeyEnv: 'ALPHA_API_KEY' }, { m1: { real: 'real-m1' } });
        repo.replaceAliasEntry('coder', ['nan/qwen', 'nan/mimo']);

        const out = controller.list();
        expect(out.providers.map((p) => p.id)).toEqual(['alpha', 'nan']);

        const nan = out.providers.find((p) => p.id === 'nan')!;
        expect(nan.apiKeyEnv).toBe('NAN_API_KEY');
        expect(nan.baseUrl).toBe('https://api.nan.builders/v1');
        expect(nan.timeoutMs).toBeNull();
        expect(nan.supportsSearch).toBe(false);
        const qwen = nan.models.find((m) => m.modelKey === 'qwen')!;
        expect(qwen.realName).toBe('qwen3.6');
        expect(qwen.maxTokens).toBeNull();
        expect(qwen.supportsStream).toBe(true);
        expect(qwen.disableThinking).toBe(false);
        expect(qwen.usedInAliases).toEqual(['coder']);
        const mimo = nan.models.find((m) => m.modelKey === 'mimo')!;
        expect(mimo.maxTokens).toBe(8192);
        expect(mimo.usedInAliases).toEqual(['coder']);
        expect(nan.models.map((m) => m.modelKey)).toEqual(['mimo', 'qwen']);
    });

    it('returns an empty list on an empty database', () => {
        const { controller } = makeHarness();
        expect(controller.list()).toEqual({ providers: [] });
    });
});

describe('AdminProvidersController.create', () => {
    it('creates a provider and returns its view', () => {
        const { controller, repo } = makeHarness();
        const view = controller.create({
            id: 'openai',
            apiKeyEnv: 'OPENAI_API_KEY',
            baseUrl: 'https://api.openai.com/v1',
            timeoutMs: 30000,
            supportsSearch: true,
        });
        expect(view).toEqual({
            id: 'openai',
            apiKeyEnv: 'OPENAI_API_KEY',
            baseUrl: 'https://api.openai.com/v1',
            timeoutMs: 30000,
            supportsSearch: true,
            models: [],
        });
        expect(repo.findProvider('openai')?.api_key_env).toBe('OPENAI_API_KEY');
    });

    it('throws ConflictException when the id already exists', () => {
        const { controller } = makeHarness();
        controller.create({ id: 'nan', apiKeyEnv: 'NAN_API_KEY' });
        expect(() => controller.create({ id: 'nan', apiKeyEnv: 'OTHER' })).toThrow(
            ConflictException,
        );
    });
});

describe('AdminProvidersController.patch', () => {
    it('merges only the provided fields', () => {
        const { controller, repo } = makeHarness();
        repo.upsertProvider(
            { id: 'nan', apiKeyEnv: 'NAN_API_KEY', baseURL: 'https://old.example', timeoutMs: 1000 },
            { qwen: { real: 'qwen3.6' } },
        );
        const view = controller.patch('nan', { timeoutMs: 2000, supportsSearch: true });
        expect(view.apiKeyEnv).toBe('NAN_API_KEY');
        expect(view.baseUrl).toBe('https://old.example');
        expect(view.timeoutMs).toBe(2000);
        expect(view.supportsSearch).toBe(true);
        expect(repo.listProviders().nan.models.qwen.real).toBe('qwen3.6');
    });

    it('throws NotFoundException for an unknown provider', () => {
        const { controller } = makeHarness();
        expect(() => controller.patch('nope', { timeoutMs: 10 })).toThrow(NotFoundException);
    });
});

describe('AdminProvidersController.remove', () => {
    it('deletes an unreferenced provider', () => {
        const { controller, repo } = makeHarness();
        repo.createProvider({ id: 'openai', apiKeyEnv: 'OPENAI_API_KEY' });
        expect(() => controller.remove('openai')).not.toThrow();
        expect(repo.findProvider('openai')).toBeUndefined();
    });

    it('throws NotFoundException for an unknown provider', () => {
        const { controller } = makeHarness();
        expect(() => controller.remove('nope')).toThrow(NotFoundException);
    });

    it('throws ConflictException naming the aliases that back the provider', () => {
        const { controller, repo } = makeHarness();
        repo.upsertProvider({ id: 'nan', apiKeyEnv: 'NAN_API_KEY' }, { qwen: { real: 'qwen3.6' } });
        repo.replaceAliasEntry('coder', ['nan/qwen']);
        repo.replaceAliasEntry('fast', ['nan/qwen']);
        let error: unknown;
        try {
            controller.remove('nan');
        } catch (e) {
            error = e;
        }
        expect(error).toBeInstanceOf(ConflictException);
        const message = (error as ConflictException).message;
        expect(message).toContain('coder');
        expect(message).toContain('fast');
    });
});

describe('AdminProvidersController models', () => {
    it('creates a model and returns its view', () => {
        const { controller, repo } = makeHarness();
        repo.createProvider({ id: 'nan', apiKeyEnv: 'NAN_API_KEY' });
        const view = controller.createModel('nan', {
            modelKey: 'qwen',
            realName: 'qwen3.6',
            maxTokens: 4096,
            supportsStream: false,
            disableThinking: true,
        });
        expect(view).toEqual({
            modelKey: 'qwen',
            realName: 'qwen3.6',
            maxTokens: 4096,
            supportsStream: false,
            disableThinking: true,
            usedInAliases: [],
        });
    });

    it('throws ConflictException when (provider, model) already exists', () => {
        const { controller, repo } = makeHarness();
        repo.upsertProvider({ id: 'nan', apiKeyEnv: 'NAN_API_KEY' }, { qwen: { real: 'qwen3.6' } });
        expect(() =>
            controller.createModel('nan', { modelKey: 'qwen', realName: 'other' }),
        ).toThrow(ConflictException);
    });

    it('throws NotFoundException when the provider is missing', () => {
        const { controller } = makeHarness();
        expect(() =>
            controller.createModel('nope', { modelKey: 'qwen', realName: 'qwen3.6' }),
        ).toThrow(NotFoundException);
    });

    it('patches a model and merges only provided fields', () => {
        const { controller, repo } = makeHarness();
        repo.upsertProvider({ id: 'nan', apiKeyEnv: 'NAN_API_KEY' }, { qwen: { real: 'qwen3.6' } });
        const view = controller.patchModel('nan', 'qwen', { maxTokens: 8192 });
        expect(view.realName).toBe('qwen3.6');
        expect(view.maxTokens).toBe(8192);
        expect(view.supportsStream).toBe(true);
        expect(view.disableThinking).toBe(false);
    });

    it('throws NotFoundException for unknown provider or model on patch', () => {
        const { controller, repo } = makeHarness();
        repo.upsertProvider({ id: 'nan', apiKeyEnv: 'NAN_API_KEY' }, { qwen: { real: 'qwen3.6' } });
        expect(() => controller.patchModel('nope', 'qwen', { maxTokens: 1 })).toThrow(
            NotFoundException,
        );
        expect(() => controller.patchModel('nan', 'nope', { maxTokens: 1 })).toThrow(
            NotFoundException,
        );
    });

    it('deletes an unreferenced model', () => {
        const { controller, repo } = makeHarness();
        repo.upsertProvider({ id: 'nan', apiKeyEnv: 'NAN_API_KEY' }, { qwen: { real: 'qwen3.6' } });
        expect(() => controller.removeModel('nan', 'qwen')).not.toThrow();
        expect(repo.modelExists('nan', 'qwen')).toBe(false);
    });

    it('throws ConflictException naming aliases when the model backs an alias', () => {
        const { controller, repo } = makeHarness();
        repo.upsertProvider({ id: 'nan', apiKeyEnv: 'NAN_API_KEY' }, { qwen: { real: 'qwen3.6' } });
        repo.replaceAliasEntry('coder', ['nan/qwen']);
        let error: unknown;
        try {
            controller.removeModel('nan', 'qwen');
        } catch (e) {
            error = e;
        }
        expect(error).toBeInstanceOf(ConflictException);
        expect((error as ConflictException).message).toContain('coder');
    });

    it('throws NotFoundException for unknown provider or model on delete', () => {
        const { controller, repo } = makeHarness();
        repo.upsertProvider({ id: 'nan', apiKeyEnv: 'NAN_API_KEY' }, { qwen: { real: 'qwen3.6' } });
        expect(() => controller.removeModel('nope', 'qwen')).toThrow(NotFoundException);
        expect(() => controller.removeModel('nan', 'nope')).toThrow(NotFoundException);
    });
});
