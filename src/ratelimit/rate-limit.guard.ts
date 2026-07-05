import {
    CanActivate,
    ExecutionContext,
    HttpException,
    HttpStatus,
    Injectable,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { Client } from '../auth/client.repository';
import { ClientService } from '../auth/client.service';
import { RedisRateLimiterService } from './redis-rate-limiter.service';

/**
 * Phase 5 rate-limit guard. Reads `req.client` (set by ApiKeyAuthGuard,
 * which MUST run before this one in the chain — NestJS runs guards in
 * declaration order on `@UseGuards(...)`), asks the limiter whether to
 * allow the request under the client's `rate_limit_rpm`, and on deny
 * raises 429 + sets a `Retry-After` header.
 *
 * If `req.client` is missing (guard ran without ApiKeyAuthGuard), this
 * guard passes through silently. The intent is that ApiKeyAuthGuard
 * owns "is this request authenticated" and RateLimitGuard owns "are we
 * under the per-client budget"; running either alone is fine.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
    constructor(
        private readonly limiter: RedisRateLimiterService,
        // Kept in the constructor for symmetry with ApiKeyAuthGuard and
        // so the guard has a single API to look up clients in the future
        // (e.g., when scopes/feature flags start affecting the limit).
        // Marked unused for now via underscore.
        _clients: ClientService,
    ) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const http = context.switchToHttp();
        const req = http.getRequest<FastifyRequest & { client?: Client }>();
        const client = req.client;
        if (!client) return true;

        const result = await this.limiter.allowRequest(
            client.id,
            client.rateLimitRpm,
        );

        if (result.allowed) return true;

        // HTTP convention: Retry-After is in *seconds* (integer).
        const retryAfterSec = Math.max(
            1,
            Math.ceil((result.retryAfterMs ?? 60_000) / 1000),
        );
        const reply = http.getResponse();
        if (reply && typeof reply.setHeader === 'function') {
            reply.setHeader('Retry-After', String(retryAfterSec));
        }
        throw new HttpException(
            {
                statusCode: HttpStatus.TOO_MANY_REQUESTS,
                error: 'Too Many Requests',
                message: 'Rate limit exceeded. Retry after the indicated time.',
                retryAfterMs: result.retryAfterMs,
            },
            HttpStatus.TOO_MANY_REQUESTS,
        );
    }
}
