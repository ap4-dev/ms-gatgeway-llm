import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readFileSync } from 'node:fs';
import { seedProvidersFromFile } from './seed-on-first-boot';

function makeDbWithSchema(): Database.Database {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(
        readFileSync(join(process.cwd(), 'migrations/0001_providers.sql'), 'utf-8'),
    );
    db.exec(
        readFileSync(join(process.cwd(), 'migrations/0005_alias_strategy.sql'), 'utf-8'),
    );
    db.exec(
        readFileSync(join(process.cwd(), 'migrations/0006_alias_weights.sql'), 'utf-8'),
    );
    db.exec(
        readFileSync(join(process.cwd(), 'migrations/0007_alias_priority.sql'), 'utf-8'),
    );
    db.exec(
        readFileSync(join(process.cwd(), 'migrations/0008_alias_strategy_enum_widen.sql'), 'utf-8'),
    );
    // _migrations is normally created by MigrationRunner. Tests that
    // pre-populate it (or assume it exists) need the table present.
    db.exec(`
        CREATE TABLE IF NOT EXISTS _migrations (
            name        TEXT PRIMARY KEY,
            applied_at  INTEGER NOT NULL,
            kind        TEXT NOT NULL CHECK (kind IN ('schema','seed'))
        );
    `);
    return db;
}

const validSeed = {
    providers: {
        nan: {
            apiKeyEnv: 'NAN_API_KEY',
            baseURL: 'https://api.nan.builders/v1',
            timeoutMs: 180_000,
            models: {
                'qwen3.6': { real: 'qwen3.6' },
                'qwen3-coder': { real: 'qwen3-coder', maxTokens: 16384 },
            },
        },
    },
    aliases: {
        fast: ['nan/qwen3.6'],
    },
    routing: {
        fallbackEnabled: true,
        healthCheckIntervalMs: 30_000,
        requestTimeoutMs: 120_000,
        failureThreshold: 5,
        cooldownMs: 30_000,
        halfOpenProbes: 1,
    },
};

function writeSeed(dir: string, name: string, body: unknown): string {
    const path = join(dir, name);
    writeFileSync(path, JSON.stringify(body, null, 2));
    return path;
}

describe('seedProvidersFromFile', () => {
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'ms-seed-'));
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it('applies providers, models, aliases, and policy on an empty DB and records kind=seed', () => {
        const db = makeDbWithSchema();
        const seedPath = writeSeed(dir, 'seed.json', validSeed);
        const result = seedProvidersFromFile(db, seedPath, '0001_initial_providers');

        expect(result.applied).toBe(true);
        expect(result.providers).toBe(1);
        expect(result.aliases).toBe(1);
        expect(result.policy).toBe(true);

        // Migration runner tracked it under kind=seed.
        const records = db
            .prepare('SELECT name, kind FROM _migrations WHERE kind = ?')
            .all('seed') as Array<{ name: string; kind: string }>;
        expect(records.map((r) => r.name)).toEqual(['0001_initial_providers']);

        // Spot-check seeded data.
        const policies = db.prepare('SELECT * FROM routing_policy').all();
        expect(policies).toHaveLength(1);
        const aliases = db.prepare('SELECT alias_name FROM alias_entries').all();
        expect((aliases as any[]).map((r) => r.alias_name)).toEqual(['fast']);
        db.close();
    });

    it('is a no-op when a kind=seed row already exists', () => {
        const db = makeDbWithSchema();
        // Pre-register a seed name so the run sees it as already seeded.
        db.prepare(
            'INSERT INTO _migrations (name, applied_at, kind) VALUES (?, ?, ?)',
        ).run('0001_initial_providers', Date.now() / 1000 | 0, 'seed');

        const seedPath = writeSeed(dir, 'seed.json', validSeed);
        const result = seedProvidersFromFile(db, seedPath, '0001_initial_providers');

        expect(result.applied).toBe(false);
        // No providers were inserted (table is empty).
        const count = db.prepare('SELECT COUNT(*) AS c FROM providers').get() as { c: number };
        expect(count.c).toBe(0);
        db.close();
    });

    it('throws a clear error when the seed JSON fails the Zod schema', () => {
        const db = makeDbWithSchema();
        const broken = {
            providers: {
                nan: {
                    apiKeyEnv: 'N',
                    // missing models entry — but Zod actually allows empty models,
                    // so we break it differently: a bad alias shape.
                },
            },
            aliases: {
                bad: ['just-a-name'], // missing 'provider/model' form
            },
        };
        const seedPath = writeSeed(dir, 'bad.json', broken);

        expect(() => seedProvidersFromFile(db, seedPath, 'bad.json')).toThrow(
            /does not match schema|aliases must be in the form/,
        );

        // No partial writes — providers table is still empty.
        const count = db.prepare('SELECT COUNT(*) AS c FROM providers').get() as { c: number };
        expect(count.c).toBe(0);
        db.close();
    });

    it('throws a clear error when the seed file is missing', () => {
        const db = makeDbWithSchema();
        expect(() =>
            seedProvidersFromFile(db, join(dir, 'nope.json'), 'nope'),
        ).toThrow(/Cannot read seed/);
        db.close();
    });
});
