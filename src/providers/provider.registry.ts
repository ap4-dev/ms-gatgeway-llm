import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Injectable, Logger } from '@nestjs/common';
import { ZodError } from 'zod';
import {
    ProviderConfig,
    ProvidersFile,
    ProvidersFileSchema,
} from './provider.model';

/**
 * Default location of the providers registry. Resolved against process.cwd()
 * which is the project root both in dev (`pnpm start:dev`) and prod
 * (`node dist/main`).
 */
export const DEFAULT_PROVIDERS_FILE = 'config/providers.json';

/** Token used to inject the loaded registry into other providers. */
export const PROVIDER_REGISTRY = Symbol('PROVIDER_REGISTRY');

/**
 * Read + validate a providers.json file. Pure function for testability.
 *
 * Throws a descriptive error when the file is unreadable or invalid so that
 * misconfiguration fails fast at startup (instead of mid-request).
 */
export function loadProvidersFile(
    filePath: string = DEFAULT_PROVIDERS_FILE,
): ProvidersFile {
    const absolute = resolve(process.cwd(), filePath);

    let raw: string;
    try {
        raw = readFileSync(absolute, 'utf-8');
    } catch (err: any) {
        throw new Error(
            `Cannot read providers registry at ${absolute}: ${err?.message ?? err}`,
        );
    }

    let parsedJson: unknown;
    try {
        parsedJson = JSON.parse(raw);
    } catch (err: any) {
        throw new Error(
            `Invalid JSON in providers registry at ${absolute}: ${err?.message ?? err}`,
        );
    }

    try {
        return ProvidersFileSchema.parse(parsedJson);
    } catch (err) {
        const zerr = err as ZodError;
        const details = zerr.issues
            .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
            .join('\n');
        throw new Error(
            `Providers registry at ${absolute} does not match schema:\n${details}`,
        );
    }
}

/**
 * Nest provider that owns the loaded registry and exposes typed views
 * (lookup-by-id, list models, list aliases). Wired into CoreModule so the
 * file is read once at startup.
 */
@Injectable()
export class ProviderRegistryService {
    private readonly logger = new Logger(ProviderRegistryService.name);
    private readonly _file: ProvidersFile;

    /**
     * @internal Use the `ProviderRegistryProvider` factory from `CoreModule`
     * so the `filePath` is supplied from outside the DI container (this
     * constructor must NOT take a stringly-typed parameter — otherwise Nest
     * interprets it as a DI token for a `String` provider and throws
     * `UnknownDependenciesException`).
     */
    constructor(filePath: string) {
        this._file = loadProvidersFile(filePath);
        this.logger.log(
            `Loaded ${Object.keys(this._file.providers).length} provider(s) from ${filePath}`,
        );
    }

    /** Raw, parsed file contents. */
    get file(): ProvidersFile {
        return this._file;
    }

    get providers(): Record<string, ProviderConfig> {
        return this._file.providers;
    }

    get aliases(): Record<string, string[]> {
        return this._file.aliases ?? {};
    }

    /** Resolved routing policy (always defined; Zod applies defaults). */
    get policy(): NonNullable<ProvidersFile['routing']> {
        return this._file.routing!;
    }

    has(providerId: string): boolean {
        return providerId in this._file.providers;
    }

    get(providerId: string): ProviderConfig | undefined {
        return this._file.providers[providerId];
    }

    /** Best-effort model lookup across all providers. Returns the first match. */
    findModel(
        upstreamModel: string,
    ): { providerId: string; modelKey: string; config: ProviderConfig } | undefined {
        for (const [providerId, provider] of Object.entries(this._file.providers)) {
            for (const modelKey of Object.keys(provider.models)) {
                if (modelKey === upstreamModel) {
                    return { providerId, modelKey, config: provider };
                }
            }
        }
        return undefined;
    }
}
