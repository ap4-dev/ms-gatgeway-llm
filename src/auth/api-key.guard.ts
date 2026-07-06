import {
    CanActivate,
    ExecutionContext,
    Injectable,
    UnauthorizedException,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { Client } from './client.repository';
import { ClientService } from './client.service';

/**
 * Phase 6+ auth gate. Reads `Authorization: Bearer <key>` first, falling
 * back to `X-API-Key: <key>` for clients that prefer the header. Awaits
 * `ClientService.verifyApiKey`, attaches the resolved client to the request
 * as `req.client`, or raises 401.
 *
 * Public endpoints (health, metrics) do **not** use this guard. Apply
 * per-controller via `@UseGuards(ApiKeyAuthGuard)`.
 *
 * Async because `verifyApiKey` includes a Redis cache hop on the hot path.
 * NestJS awaits `canActivate` natively, so controllers see no change.
 */
@Injectable()
export class ApiKeyAuthGuard implements CanActivate {
    constructor(private readonly clients: ClientService) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const http = context.switchToHttp();
        const req = http.getRequest<FastifyRequest & { client?: Client }>();
        const token = extractBearerToken(req);
        if (!token) {
            throw new UnauthorizedException('Missing API key (Authorization: Bearer …)');
        }
        const client = await this.clients.verifyApiKey(token);
        if (!client) {
            throw new UnauthorizedException('Invalid or revoked API key');
        }
        (req as any).client = client;
        return true;
    }
}

function extractBearerToken(req: FastifyRequest): string | undefined {
    const h = req.headers as Record<string, string | undefined>;
    const auth = h['authorization'];
    if (auth) {
        const match = /^Bearer\s+(.+)$/i.exec(auth);
        if (match) return match[1].trim();
        // If Authorization exists but isn't Bearer — don't fall through,
        // it's clearly malformed.
        return undefined;
    }
    const fallback = h['x-api-key'];
    return fallback?.trim() || undefined;
}
