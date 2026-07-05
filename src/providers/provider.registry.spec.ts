import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { seedProvidersFromFile } from '../database/seed/seed-on-first-boot';
import { ProviderRegistryRepository } from '../database/repositories/provider-registry.repository';
import { ProviderRegistryService } from './provider.registry';

/** Build an in-memory DB with the providers schema + a sample seed applied. */
function makeServiceWithSeed(seed: object = SEED): {
    service: ProviderRegistryService;
    db: Database.Database;
} {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(
        readFileSync(join(process.cwd(), 'migrations/0001_providers.sql'), 'utf-8'),
    );
    const tmp = require('node:fs').mkdtempSync(
        join(require('node:os').tmpdir(), 'ms-registry-spec-'),
    );
    const seedPath = join(tmp, 'seed.json');
    require('node:fs').writeFileSync(seedPath, JSON.stringify(seed));
    seedProvidersFromFile(db, seedPath, '0001_test');
    require('node:fs').rmSync(tmp, { recursive: true, force: true });
    const repo = new ProviderRegistryRepository(db);
    return { service: new ProviderRegistryService(repo), db };
}

const SEED = {
    providers: {
        nan: {
            apiKeyEnv: 'NAN_API_KEY',
            baseURL: 'https://api.nan.builders/v1',
            timeoutMs: 60_000,
            models: {
                'qwen3.6': { real: 'qwen3.6' },
                coder: { real: 'qwen3-coder', maxTokens: 8192 },
            },
        },
        openai: {
            apiKeyEnv: 'OPENAI_API_KEY',
            models: {
                'gpt-4o-mini': { real: 'gpt-4o-mini' },
            },
        },
    },
    aliases: {
        fast: ['openai/gpt-4o-mini', 'nan/qwen3.6'],
        coder: ['nan/coder'],
    },
    routing: {
        fallbackEnabled: true,
        strategy: 'fallback' as const,
        healthCheckIntervalMs: 30_000,
        requestTimeoutMs: 120_000,
        failureThreshold: 5,
        cooldownMs: 30_000,
        halfOpenProbes: 1,
    },
};

describe('ProviderRegistryService (DB-backed)', () => {
    describe('after seeding', () => {
        let db: Database.Database;
        let service: ProviderRegistryService;

        beforeEach(() => {
            ({ db, service } = makeServiceWithSeed());
        });

        afterEach(() => {
            db.close();
        });

        it('exposes providers keyed by id with nested models', () => {
            const providers = service.providers;
            expect(Object.keys(providers).sort()).toEqual(['nan', 'openai']);
            expect(providers.nan.apiKeyEnv).toBe('NAN_API_KEY');
            expect(providers.nan.models.coder.maxTokens).toBe(8192);
            expect(providers.openai.models['gpt-4o-mini'].real).toBe('gpt-4o-mini');
        });

        it('exposes aliases as ordered fallback chains', () => {
            expect(service.aliases.fast).toEqual(['openai/gpt-4o-mini', 'nan/qwen3.6']);
            expect(service.aliases.coder).toEqual(['nan/coder']);
        });

        it('exposes the routing policy', () => {
            expect(service.policy.strategy).toBe('fallback');
            expect(service.policy.requestTimeoutMs).toBe(120_000);
        });

        it('file synthesises a ProvidersFile snapshot', () => {
            const snap = service.file;
            expect(snap.providers.nan.apiKeyEnv).toBe('NAN_API_KEY');
            expect(snap.aliases.fast[0]).toBe('openai/gpt-4o-mini');
            expect(snap.routing?.strategy).toBe('fallback');
        });

        it('has() / get() check provider ids against the live DB', () => {
            expect(service.has('nan')).toBe(true);
            expect(service.has('ghost')).toBe(false);
            expect(service.get('nan')?.apiKeyEnv).toBe('NAN_API_KEY');
            expect(service.get('ghost')).toBeUndefined();
        });

        it('findModel scans across providers and returns the first match', () => {
            expect(service.findModel('qwen3.6')?.providerId).toBe('nan');
            expect(service.findModel('gpt-4o-mini')?.providerId).toBe('openai');
            expect(service.findModel('nonexistent')).toBeUndefined();
        });
    });

    describe('hot-reload', () => {
        it('reflects a write to providers done after construction', () => {
            const { service, db } = makeServiceWithSeed();
            try {
                // Insert a new provider directly. The service should see it
                // on the next read.
                db.prepare(
                    'INSERT INTO providers (id, api_key_env, base_url) VALUES (?, ?, ?)',
                ).run('anthropic', 'ANTHROPIC_API_KEY', 'https://api.anthropic.com/v1');
                db.prepare(
                    'INSERT INTO model_configs (provider_id, model_key, real_name) VALUES (?, ?, ?)',
                ).run('anthropic', 'claude-haiku', 'claude-3-5-haiku');

                expect(service.has('anthropic')).toBe(true);
                expect(service.get('anthropic')?.baseURL).toBe(
                    'https://api.anthropic.com/v1',
                );
                expect(service.findModel('claude-haiku')?.providerId).toBe(
                    'anthropic',
                );
            } finally {
                db.close();
            }
        });
    });

    describe('seed rejection', () => {
        it('throws when the seed file is malformed (Zod failure)', () => {
            const db = new Database(':memory:');
            db.pragma('foreign_keys = ON');
            db.exec(
                readFileSync(
                    join(process.cwd(), 'migrations/0001_providers.sql'),
                    'utf-8',
                ),
            );
            const tmp = require('node:fs').mkdtempSync(
                join(require('node:os').tmpdir(), 'ms-bad-seed-'),
            );
            const seedPath = join(tmp, 'seed.json');
            // Aliases MUST be of the form provider/model — this one isn't.
            require('node:fs').writeFileSync(
                seedPath,
                JSON.stringify({
                    providers: { nan: { apiKeyEnv: 'N', models: { m1: { real: 'r1' } } } },
                    aliases: { bad: ['not-a-path'] },
                }),
            );
            try {
                expect(() =>
                    seedProvidersFromFile(db, seedPath, 'bad.json'),
                ).toThrow(/aliases must be in the form/);
            } finally {
                require('node:fs').rmSync(tmp, { recursive: true, force: true });
                db.close();
            }
        });
    });
});
