import { DopplerSDK } from "@dopplerhq/node-sdk";
import { Logger } from "@nestjs/common";
require("dotenv").config();
export const PROJECT = process.env.MS || "ms-ap4";
export const ENV =
    process.env.NODE_ENV === "production"
        ? "prd"
        : process.env.NODE_ENV === "staging"
            ? "stg"
            : "dev";

export interface EnvLoadOptions {
    /**
     * Suppress the per-key `key: value` debug logging (the `ENV === 'dev'`
     * branch below) while keeping the final success line. Operator CLIs
     * (`pnpm db:migrate`) use this: their output gets pasted into tickets, and
     * a boot log is allowed to be verbose where a ticket is not.
     *
     * Defaults to `false`, so the server boot log is unchanged.
     */
    quiet?: boolean;
}

export interface EnvLoadResult {
    /** True only when Doppler actually supplied secrets. */
    loaded: boolean;
    /** Doppler project the secrets were downloaded from (`MS`). */
    project: string;
    /** Doppler config derived from `NODE_ENV` (`dev` | `stg` | `prd`). */
    config: string;
}

/**
 * Download the project's secrets from Doppler and write them over
 * `process.env` (uppercased), exactly as the server does at boot.
 *
 * Returns the provenance it derived so an operator CLI can print *where* a
 * value such as `DATABASE_PATH` came from instead of guessing.
 */
export async function inyectEnv(
    options: EnvLoadOptions = {},
): Promise<EnvLoadResult> {
    const logger = new Logger("EnviromentLoader");
    const token = process.env.START_TOKEN;

    if (!token) {
        logger.warn("START_TOKEN no definido. Saltando carga de Doppler...");
        return { loaded: false, project: PROJECT, config: ENV };
    }

    try {
        const doppler = new DopplerSDK({ accessToken: token });

        const result = await doppler.secrets.download(PROJECT, ENV, {
            format: "json",
            includeDynamicSecrets: true,
            dynamicSecretsTtlSec: 1800,
        });

        Object.keys(result).forEach((key) => {
            process.env[key.toUpperCase()] = result[key];
            if (ENV === "dev" && !options.quiet) {
                logger.log(`${key}: ${result[key]}`);
            }
        });

        logger.log(
            `✅ Secretos cargados exitosamente para el proyecto: ${PROJECT} config: ${ENV}`,
        );

        return { loaded: true, project: PROJECT, config: ENV };
    } catch (error) {
        logger.error(
            `❌ Error cargando secretos desde Doppler: ${JSON.stringify(error)}`,
        );
        throw error;
    }
}
