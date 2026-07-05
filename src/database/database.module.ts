import { Global, Logger, Module } from '@nestjs/common';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseService } from './database.service';
import { DATABASE_PATH } from './database.constants';
import { ENV_CONFIG } from '../config/env.token';
import type { Env } from '../config/env.schema';
import { MigrationRunner } from './migrations/migration-runner';
import { seedProvidersFromFile } from './seed/seed-on-first-boot';
import { ClientRepository } from '../auth/client.repository';
import { ClientService } from '../auth/client.service';
import { ensureDefaultAdminClient } from '../auth/seed-default-client';

/**
 * Default project-relative paths. Resolved against `process.cwd()` when
 * Nest creates the provider. Tests that need to bypass these can override
 * the factory.
 */
const DEFAULT_MIGRATIONS_DIR = resolve(process.cwd(), 'migrations');
const DEFAULT_SEEDS_DIR = join(DEFAULT_MIGRATIONS_DIR, 'seeds');
const DEFAULT_SEED_FILE = join(DEFAULT_SEEDS_DIR, '0001_initial_providers.json');

/**
 * Global module exposing {@link DatabaseService} (the singleton SQLite
 * connection). On first construction the factory also runs pending SQL
 * migrations and the registry seed, so by the time any `@Inject(...)`
 * downstream receives the service, the schema + bootstrap data are ready.
 *
 * The factory skips the migration step when the `migrations/` directory
 * is absent (useful in tests that build a `:memory:` DB and apply schema
 * inline). It still opens the connection and sets pragmas in every case.
 */
@Global()
@Module({
    providers: [
        {
            provide: DATABASE_PATH,
            useFactory: (env: Env) => env.DATABASE_PATH,
            inject: [ENV_CONFIG],
        },
        {
            provide: DatabaseService,
            useFactory: (rawPath: string) => {
                const service = new DatabaseService(rawPath);
                try {
                    if (existsSync(DEFAULT_MIGRATIONS_DIR)) {
                        const runner = new MigrationRunner(
                            service.db,
                            DEFAULT_MIGRATIONS_DIR,
                            DEFAULT_SEEDS_DIR,
                        );
                        runner.run();
                        if (existsSync(DEFAULT_SEED_FILE)) {
                            seedProvidersFromFile(
                                service.db,
                                DEFAULT_SEED_FILE,
                                '0001_initial_providers',
                            );
                        }
                    }
                } catch (err) {
                    service.close();
                    throw err;
                }
                return service;
            },
            inject: [DATABASE_PATH],
        },
        // Phase 5 first-boot admin seed. Runs once on the very first
        // boot when the `clients` table is empty. Subsequent boots
        // short-circuit. The ClientService instance shares the
        // DatabaseService's underlying connection.
        {
            provide: 'FIRST_BOOT_PROVISIONING',
            useFactory: (db: DatabaseService) => {
                const logger = new Logger('FirstBoot');
                const clientService = new ClientService(
                    new ClientRepository(db.db),
                );
                ensureDefaultAdminClient(clientService, logger);
                return true;
            },
            inject: [DatabaseService],
        },
    ],
    exports: [DatabaseService, DATABASE_PATH],
})
export class DatabaseModule {}
