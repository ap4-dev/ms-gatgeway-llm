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

export async function inyectEnv() {
    const logger = new Logger("EnviromentLoader");
    const token = process.env.START_TOKEN;

    if (!token) {
        logger.warn("START_TOKEN no definido. Saltando carga de Doppler...");
        return;
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
            if (ENV === "dev") {
                logger.log(`${key}: ${result[key]}`);
            }
        });

        logger.log(
            `✅ Secretos cargados exitosamente para el proyecto: ${PROJECT} config: ${ENV}`,
        );
    } catch (error) {
        logger.error(
            `❌ Error cargando secretos desde Doppler: ${JSON.stringify(error)}`,
        );
        throw error;
    }
}
