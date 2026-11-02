import {
    Controller,
    Get,
    Req,
    UnauthorizedException,
    UseGuards,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { ApiKeyAuthGuard } from '../auth/api-key.guard';
import { RateLimitGuard } from '../ratelimit/rate-limit.guard';
import type { Client } from '../auth/client.repository';
import { QuotaService, type ClientQuotaView } from './quota.service';

/**
 * The quota read model as an HTTP body: the client's period envelope plus one
 * view per `(client, alias)` allowance.
 *
 * Shared by the client-facing `/v1/quota` and the admin `/admin/clients/:id/quotas`
 * surface on purpose — both must report the SAME period, reset instant and
 * per-alias numbers, so the projection lives in one exported function instead of
 * being restated in each controller.
 */
export interface ClientQuotasView {
    clientId: string;
    /** UTC calendar month (`YYYY-MM`) the counters belong to. */
    periodKey: string;
    /** Unix SECONDS of the next UTC month start, matching the 429 detail. */
    resetsAt: number;
    /** Seconds until `resetsAt`, for `Retry-After`. */
    retryAfterSeconds: number;
    quotas: ClientQuotaView[];
}

/**
 * Project one client's quotas into the shared HTTP envelope.
 *
 * Every number comes from `QuotaService`: `describeQuotas` already reads the
 * clock ONCE and stamps each view with the period and reset instant, so the
 * controller never re-derives a calendar boundary (that would let the HTTP
 * `resetsAt` drift from the one the 429 body reports for the same client).
 *
 * A client with no quota rows has no view to read the reset instant from. That
 * case still needs a truthful envelope, so it falls back to the service's own
 * `periodKey()` / `retryAfterSeconds()` — the month arithmetic stays inside the
 * service — and projects `resetsAt` from that instant.
 */
export function describeClientQuotas(
    quota: QuotaService,
    clientId: string,
    nowMs: number = Date.now(),
): ClientQuotasView {
    const quotas = quota.describeQuotas(clientId);
    const sample = quotas[0];
    const retryAfterSeconds = sample?.retryAfterSeconds ?? quota.retryAfterSeconds(nowMs);

    return {
        clientId,
        periodKey: sample?.periodKey ?? quota.periodKey(nowMs),
        resetsAt: sample?.resetsAt ?? Math.floor(nowMs / 1000) + retryAfterSeconds,
        retryAfterSeconds,
        quotas,
    };
}

/**
 * Client-facing quota balance: `GET /v1/quota`.
 *
 * Guarded exactly like `/v1/chat` (`ApiKeyAuthGuard` + `RateLimitGuard`).
 * `RequireScopesGuard` is deliberately absent — that guard is the admin-only
 * gate on `/admin/...`; here the API key itself is the whole authorization, and
 * the key's owner can only ever read its OWN balance because the client id is
 * taken from the authenticated request, never from a parameter.
 *
 * Read-only and cache-free, so a mid-month limit raise is visible immediately.
 */
@Controller('v1/quota')
@UseGuards(ApiKeyAuthGuard, RateLimitGuard)
export class QuotaController {
    constructor(private readonly quota: QuotaService) {}

    @Get()
    get(@Req() req: FastifyRequest & { client?: Client }): ClientQuotasView {
        const clientId = req.client?.id;
        if (!clientId) {
            throw new UnauthorizedException(
                'No authenticated client on the request: /v1/quota requires an API key',
            );
        }

        return describeClientQuotas(this.quota, clientId);
    }
}
