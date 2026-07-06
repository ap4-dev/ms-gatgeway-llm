import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ClientRepository, type Client } from './client.repository';
import {
    extractPrefix,
    generateApiKey,
    hashApiKey,
    verifyApiKey,
} from './api-key-hash.util';
import { ClientAuthCache } from './client-auth-cache';

export interface CreatedClient {
    client: Client;
    /** The plaintext API key. Shown to the operator ONCE; never persisted. */
    plaintextApiKey: string;
}

/**
 * Phase 6+ client service. Owns the lifecycle of API keys and exposes the
 * fast-path lookups the auth/rate-limit guards need.
 *
 *  - `verifyApiKey(plaintext)`: cache → SQLite prefix-scan → HMAC verify →
 *    throttle-throttled `last_used_at` touch → cache populate. Called from
 *    `ApiKeyAuthGuard` on every request. Async to fit the Redis hop.
 *  - `create(input)`: provisioning helper used by the first-boot auto-seed
 *    and by the admin CLI through the standard module import path.
 *
 * The pepper is injected via constructor — `AuthModule` pulls it from
 * `ENV_CONFIG`. Tests pass a fixed pepper fixture; the CLI reads
 * `process.env.API_KEY_PEPPER` directly via `main()` before calling here.
 */
@Injectable()
export class ClientService {
    private readonly logger = new Logger(ClientService.name);

    /**
     * In-memory throttle window for `last_used_at` SQLite writes.
     * Process-local map — single-process gateways don't need cross-process
     * coalescing. 60s reduces 100 rps of one tenant to ~1 DB write/min.
     */
    private static TOUCH_THROTTLE_MS = 60_000;
    private readonly lastTouchedAt = new Map<string, number>();

    constructor(
        private readonly repo: ClientRepository,
        private readonly cache: ClientAuthCache,
        private readonly pepper: string,
    ) {}

    /**
     * Constant-time API key verification. Async to allow the Redis
     * cache lookup; callers (the guard) already await. Returns the
     * matched client or undefined.
     */
    async verifyApiKey(plaintext: string): Promise<Client | undefined> {
        if (!plaintext || plaintext.length === 0) return undefined;

        // Hot path: cache hit — return immediately, no DB, no crypto.
        const cached = await this.cache.get(plaintext);
        if (cached) {
            this.touchLastUsedIfStale(cached.id);
            return cached;
        }

        // Cold path: SQLite prefix-scan + HMAC verify + populate.
        const prefix = extractPrefix(plaintext);
        const candidate = this.repo.findActiveByPrefix(prefix);
        if (!candidate) return undefined;
        if (!verifyApiKey(plaintext, candidate.apiKeyHash, this.pepper)) {
            return undefined;
        }

        this.touchLastUsedIfStale(candidate.id);

        // Populate cache in fire-and-forget. The awaited `set` swallows
        // its own errors (fail-open) so we don't need to handle them here.
        void this.cache.set(plaintext, candidate);
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

    /**
     * Phase 5.5 partial update. Fields not provided keep their current
     * values (`scope` defaults to the existing list; `rateLimitTpm` set
     * to `null` clears the token cap).
     */
    update(
        id: string,
        fields: {
            name?: string;
            scopes?: string[];
            rateLimitRpm?: number;
            rateLimitTpm?: number | null;
        },
    ): Client {
        const existing = this.repo.findById(id);
        if (!existing) {
            throw new NotFoundException(`Client "${id}" not found`);
        }
        const next = {
            name: fields.name ?? existing.name,
            scopes: fields.scopes ?? existing.scopes,
            rateLimitRpm: fields.rateLimitRpm ?? existing.rateLimitRpm,
            rateLimitTpm:
                fields.rateLimitTpm !== undefined
                    ? fields.rateLimitTpm
                    : existing.rateLimitTpm,
        };
        if (next.scopes.length === 0) {
            throw new Error('client must keep at least one scope');
        }
        if (next.rateLimitRpm <= 0) {
            throw new Error('rate_limit_rpm must be > 0');
        }
        this.repo.update(id, next);
        const updated = this.repo.findById(id);
        if (!updated) {
            // Should never happen — update just succeeded.
            throw new Error(`Failed to load client after update: ${id}`);
        }
        return updated;
    }

    /**
     * Phase 5.5 key rotation. Generates a new plaintext key, hashes it,
     * replaces the api_key_hash + api_key_prefix in the row, and returns
     * the plaintext so the operator can hand it out exactly once.
     * The old key is invalidated immediately; the cache for the old
     * plaintext (if any) expires via TTL within 5 minutes.
     */
    rotateKey(id: string): { client: Client; plaintextApiKey: string } {
        const existing = this.repo.findById(id);
        if (!existing) {
            throw new NotFoundException(`Client "${id}" not found`);
        }
        if (existing.revoked) {
            // Rotating a revoked client resurrects it. That seems wrong —
            // refuse so the operator can create a new client instead.
            throw new Error(
                `Client "${id}" is revoked; create a new client instead`,
            );
        }
        const plaintext = generateApiKey();
        const apiKeyHash = hashApiKey(plaintext, this.pepper);
        const apiKeyPrefix = extractPrefix(plaintext);
        this.repo.update(id, {
            name: existing.name,
            scopes: existing.scopes,
            rateLimitRpm: existing.rateLimitRpm,
            rateLimitTpm: existing.rateLimitTpm,
        });
        // The repo.update above doesn't touch the hash/prefix (it doesn't
        // own those columns). Rotate them via two extra statements.
        this.repo.rotateKey(id, apiKeyHash, apiKeyPrefix);
        const updated = this.repo.findById(id);
        if (!updated) {
            throw new Error(`Failed to load client after rotate: ${id}`);
        }
        return { client: updated, plaintextApiKey: plaintext };
    }

    /** Phase 5.5 hard delete. Idempotent — missing id returns silently. */
    delete(id: string): void {
        this.repo.delete(id);
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
        const apiKeyHash = hashApiKey(plaintext, this.pepper);
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

    /**
     * Touch `last_used_at` for a client at most once per TOUCH_THROTTLE_MS.
     * The `Map` is process-local: a multi-process gateway would need a
     * shared cache to coalesce across workers, but we run as a single
     * process today. Best-effort — never fails the request.
     */
    private touchLastUsedIfStale(id: string): void {
        const nowMs = Date.now();
        const last = this.lastTouchedAt.get(id) ?? 0;
        if (nowMs - last < ClientService.TOUCH_THROTTLE_MS) return;
        this.lastTouchedAt.set(id, nowMs);
        try {
            this.repo.touchLastUsed(id, Math.floor(nowMs / 1000));
        } catch (err: any) {
            this.lastTouchedAt.delete(id); // Let the next request retry.
            this.logger.warn(
                `touch last_used_at failed for client=${id}: ${err?.message ?? err}`,
            );
        }
    }
}
