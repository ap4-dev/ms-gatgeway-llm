import { Injectable, Logger } from '@nestjs/common';
import { ClientRepository, type Client } from './client.repository';
import {
    extractPrefix,
    generateApiKey,
    hashApiKey,
    verifyApiKey,
} from './api-key-hash.util';

export interface CreatedClient {
    client: Client;
    /** The plaintext API key. Shown to the operator ONCE; never persisted. */
    plaintextApiKey: string;
}

/**
 * Phase 5 client service. Owns the lifecycle of API keys and exposes the
 * fast-path lookups the auth/rate-limit guards need.
 *
 *  - `verifyApiKey(plaintext)`: scan-by-prefix, constant-time verify, touch
 *    `last_used_at` on success. Called from `ApiKeyAuthGuard` on every
 *    request.
 *  - `createAdmin(name, scope?)`: provisioning helper used by the
 *    first-boot auto-seed. Returns the plaintext key exactly once.
 */
@Injectable()
export class ClientService {
    private readonly logger = new Logger(ClientService.name);

    constructor(private readonly repo: ClientRepository) {}

    /** Constant-time API key verification. Returns the client or undefined. */
    verifyApiKey(plaintext: string): Client | undefined {
        if (!plaintext || plaintext.length === 0) return undefined;
        const prefix = extractPrefix(plaintext);
        const candidate = this.repo.findActiveByPrefix(prefix);
        if (!candidate) return undefined;
        if (!verifyApiKey(plaintext, candidate.apiKeyHash)) return undefined;
        // Side-effect: touch last_used_at. Best-effort — we never fail
        // the request because of it.
        try {
            this.repo.touchLastUsed(candidate.id, Math.floor(Date.now() / 1000));
        } catch (err: any) {
            this.logger.warn(
                `touch last_used_at failed for client=${candidate.id}: ${err?.message ?? err}`,
            );
        }
        return candidate;
    }

    /** Idempotent provisioning helper used by the first-boot seed. */
    create(input: {
        id: string;
        name: string;
        scopes?: string[];
        rateLimitRpm?: number;
        rateLimitTpm?: number | null;
    }): CreatedClient {
        const plaintext = generateApiKey();
        const client = this.insert(input, plaintext);
        return { client, plaintextApiKey: plaintext };
    }

    findById(id: string): Client | undefined {
        return this.repo.findById(id);
    }

    list(): Client[] {
        return this.repo.list();
    }

    count(): number {
        return this.repo.count();
    }

    revoke(id: string): void {
        this.repo.revoke(id, Math.floor(Date.now() / 1000));
    }

    /** Internal — used by tests that want to inject a known plaintext. */
    insertWithPlaintext(
        input: {
            id: string;
            name: string;
            scopes?: string[];
            rateLimitRpm?: number;
            rateLimitTpm?: number | null;
        },
        plaintext: string,
    ): Client {
        return this.insert(input, plaintext);
    }

    private insert(
        input: {
            id: string;
            name: string;
            scopes?: string[];
            rateLimitRpm?: number;
            rateLimitTpm?: number | null;
        },
        plaintext: string,
    ): Client {
        const prefix = extractPrefix(plaintext);
        const apiKeyHash = hashApiKey(plaintext);
        this.repo.insert({
            id: input.id,
            name: input.name,
            scopes: input.scopes,
            rateLimitRpm: input.rateLimitRpm,
            rateLimitTpm: input.rateLimitTpm,
            apiKeyHash,
            apiKeyPrefix: prefix,
        });
        const client = this.repo.findById(input.id);
        if (!client) {
            // Should never happen — insert just succeeded. Defensive throw.
            throw new Error(`Failed to load client after insert: ${input.id}`);
        }
        return client;
    }
}
