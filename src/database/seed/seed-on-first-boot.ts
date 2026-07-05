import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { ProvidersFileSchema } from '../../providers/provider.model';
import { ProviderRegistryRepository } from '../repositories/provider-registry.repository';

export interface SeedResult {
    /** True when we actually applied rows; false if the seed was already recorded. */
    applied: boolean;
    providers: number;
    aliases: number;
    policy: boolean;
}

/**
 * Apply the initial seed JSON to a fresh database. Idempotent: a row in
 * `_migrations(name, applied_at, kind='seed')` matching `seedName` causes
 * the function to no-op. Wrapped in a single transaction so a Zod failure
 * (or any malformed row) leaves the DB untouched.
 */
export function seedProvidersFromFile(
    db: Database.Database,
    seedPath: string,
    seedName: string,
): SeedResult {
    // `_migrations` is normally created by MigrationRunner. The seed may run
    // before migrations (or stand alone in tests), so create-if-missing here.
    db.exec(`
        CREATE TABLE IF NOT EXISTS _migrations (
            name        TEXT PRIMARY KEY,
            applied_at  INTEGER NOT NULL,
            kind        TEXT NOT NULL CHECK (kind IN ('schema','seed'))
        );
    `);

    const alreadySeeded = db
        .prepare('SELECT 1 FROM _migrations WHERE kind = ? AND name = ?')
        .get('seed', seedName);
    if (alreadySeeded) {
        return { applied: false, providers: 0, aliases: 0, policy: false };
    }

    let raw: string;
    try {
        raw = readFileSync(seedPath, 'utf-8');
    } catch (err: any) {
        throw new Error(
            `Cannot read seed file at ${seedPath}: ${err?.message ?? err}`,
        );
    }
    let parsedJson: unknown;
    try {
        parsedJson = JSON.parse(raw);
    } catch (err: any) {
        throw new Error(
            `Invalid JSON in seed file at ${seedPath}: ${err?.message ?? err}`,
        );
    }
    const parsed = ProvidersFileSchema.parse(parsedJson);

    const txn = db.transaction(() => {
        const repo = new ProviderRegistryRepository(db);
        for (const [id, provider] of Object.entries(parsed.providers ?? {})) {
            // Inject the id into the provider config so repository can key on it.
            repo.upsertProvider(
                { id, ...(provider as any) } as any,
                (provider as any).models,
            );
        }
        if (parsed.aliases) {
            for (const [alias, chain] of Object.entries(parsed.aliases)) {
                repo.replaceAliasEntry(alias, chain);
            }
        }
        if (parsed.routing) {
            repo.setPolicy(parsed.routing);
        }
        db.prepare(
            'INSERT INTO _migrations (name, applied_at, kind) VALUES (?, ?, ?)',
        ).run(seedName, Math.floor(Date.now() / 1000), 'seed');
    });

    txn();

    return {
        applied: true,
        providers: Object.keys(parsed.providers ?? {}).length,
        aliases: Object.keys(parsed.aliases ?? {}).length,
        policy: parsed.routing != null,
    };
}
