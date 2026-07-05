import {
    CanActivate,
    ExecutionContext,
    ForbiddenException,
    Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import type { Client } from './client.repository';

/**
 * Phase 5.5 scope gate. Reads metadata set by `@RequireScopes(...)` and
 * checks `req.client.scopes`. Used in combination with `ApiKeyAuthGuard`,
 * which sets `req.client` in the first place.
 *
 * Convention: the decorator's argument is an array of scope strings; ALL
 * must be present in the client's `scopes` for the gate to pass.
 */
@Injectable()
export class RequireScopesGuard implements CanActivate {
    constructor(private readonly reflector: Reflector) {}

    canActivate(context: ExecutionContext): boolean {
        const required = this.reflector.getAllAndOverride<string[] | undefined>(
            'scopes',
            [context.getHandler(), context.getClass()],
        );
        if (!required || required.length === 0) return true;

        const req = context
            .switchToHttp()
            .getRequest<FastifyRequest & { client?: Client }>();
        const client = req.client;
        if (!client) {
            // Auth guard should have set this; refuse anyway rather than
            // silently letting the request through.
            throw new ForbiddenException(
                'Authentication required before scope check',
            );
        }
        const have = new Set(client.scopes);
        const missing = required.filter((s) => !have.has(s));
        if (missing.length > 0) {
            throw new ForbiddenException(
                `Missing required scope(s): ${missing.join(', ')}`,
            );
        }
        return true;
    }
}
