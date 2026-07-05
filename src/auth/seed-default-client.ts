import { Logger } from '@nestjs/common';
import { ClientService } from './client.service';

/**
 * First-boot provisioning helper. If the `clients` table is empty,
 * create a default admin client with a freshly generated API key and
 * print the plaintext key to stdout **once**. Subsequent boots are
 * a no-op (the row already exists).
 *
 * The plaintext is shown only here. We never persist it; only the
 * scrypt hash lives in the DB.
 */
export function ensureDefaultAdminClient(
    clients: ClientService,
    logger: Logger,
    options: { id?: string; name?: string; rateLimitRpm?: number } = {},
): { created: boolean; clientId: string } {
    const count = clients.count();
    if (count > 0) {
        return { created: false, clientId: '' };
    }
    const id = options.id ?? 'admin';
    const name = options.name ?? 'Default admin';
    const rateLimitRpm = options.rateLimitRpm ?? 60;
    const { client, plaintextApiKey } = clients.create({
        id,
        name,
        rateLimitRpm,
    });

    logger.log(`┌─────────────────────────────────────────────────────────────────┐`);
    logger.log(`│ First-boot: created default admin client`);
    logger.log(`│`);
    logger.log(`│   client id : ${client.id}`);
    logger.log(`│   key prefix: ${client.apiKeyPrefix}…  (for log correlation)`);
    logger.log(`│   rate limit: ${client.rateLimitRpm} rpm`);
    logger.log(`│`);
    logger.log(`│   API key (save now — never shown again):`);
    logger.log(`│     ${plaintextApiKey}`);
    logger.log(`│`);
    logger.log(`│ Use it as: Authorization: Bearer ${plaintextApiKey}`);
    logger.log(`└─────────────────────────────────────────────────────────────────┘`);

    return { created: true, clientId: client.id };
}
