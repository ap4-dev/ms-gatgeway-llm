import {
    BadRequestException,
    Controller,
    Get,
    Query,
    UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { ApiKeyAuthGuard } from '../auth/api-key.guard';
import { RequireScopesGuard } from '../auth/require-scopes.guard';
import { RateLimitGuard } from '../ratelimit/rate-limit.guard';
import { RequireScopes } from '../auth/require-scopes.decorator';
import {
    RequestLogRepository,
    type RequestLogRow,
    type RequestLogStatus,
} from '../database/repositories/request-log.repository';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

const StatusSchema = z.enum(['ok', 'error', 'circuit_open']);

/**
 * Query schema for `GET /admin/logs`. All filters optional; combined
 * with AND. ISO timestamps converted to unix-seconds before SQL.
 *
 * `model` is the *alias* the client requested, e.g. `coder`.
 * The underlying provider/model the gateway actually routed to
 * is **NOT** exposed in this endpoint — it would leak vendor
 * relationships. The repository still has the data for internal use;
 * we just don't return it. Because of that we don't expose a
 * `?provider=` filter either (would be inert).
 */
const ListLogsQuerySchema = z
    .object({
        client_id: z.string().min(1).max(64).optional(),
        model: z.string().min(1).max(120).optional(),
        status: StatusSchema.optional(),
        from: z.string().datetime({ offset: true }).optional(),
        to: z.string().datetime({ offset: true }).optional(),
        limit: z.coerce.number().int().positive().max(MAX_LIMIT).optional(),
    })
    .strict();

type ListLogsQuery = z.infer<typeof ListLogsQuerySchema>;

interface LogItemView {
    requestedAt: number;
    /** The alias the client sent (e.g. `coder`). Real upstream model NOT exposed. */
    modelRequested: string;
    attempts: number;
    latencyMs: number;
    status: RequestLogStatus;
    error: string | null;
    clientKey: string | null;
    promptHash: string | null;
    promptTokens: number | null;
    completionTokens: number | null;
    totalTokens: number | null;
}

interface ListLogsResponse {
    items: LogItemView[];
    count: number;
    limit: number;
    hasMore: boolean;
}

/**
 * Phase 6+ admin endpoint for reading recent request_logs.
 *
 * Backed by `request_logs` (SQLite via better-sqlite3). The first
 * production scale is one gateway replica; if that grows we move this
 * table to Postgres without changing the response shape.
 *
 * Filters (`?client_id=`, `?model=`, `?status=`, `?from=ISO`, `?to=ISO`)
 * are AND-combined. `limit` defaults to 100 and is capped at 500 — the
 * cap exists because better-sqlite3 is sync and a runaway admin query
 * must not stall the event loop.
 *
 * Pagination is intentionally minimal: `hasMore: true` indicates
 * there is at least one more matching row after `items`. Adding a
 * cursor parameter is the next step if production volume makes this
 * endpoint visibly slow to scroll through.
 *
 * The response intentionally OMITS `resolvedProvider` and
 * `resolvedModel`. Operators with admin scope see the alias the
 * client used (`modelRequested`) and metadata — never which upstream
 * provider/model handled the request. Real-model visibility stays
 * inside the gateway (the structured `LlmLoggingService` log emits it
 * to the server stdout, which isn't externally accessible).
 *
 * Auth: `admin` scope required. Rate-limit per `RateLimitGuard`,
 * which already enforces per-client RPM.
 */
@Controller('admin/logs')
@UseGuards(ApiKeyAuthGuard, RequireScopesGuard, RateLimitGuard)
@RequireScopes('admin')
export class AdminLogsController {
    constructor(private readonly repo: RequestLogRepository) {}

    @Get()
    list(@Query() raw: Record<string, string | undefined>): ListLogsResponse {
        const parsed = ListLogsQuerySchema.safeParse(raw);
        if (!parsed.success) {
            throw new BadRequestException({
                error: {
                    message: 'Invalid query parameters',
                    type: 'invalid_request_error',
                    code: 'invalid_query',
                    issues: parsed.error.issues.map((i) => ({
                        path: i.path.join('.'),
                        message: i.message,
                    })),
                },
            });
        }

        const q = parsed.data;
        const limit = q.limit ?? DEFAULT_LIMIT;

        const fromTs = q.from !== undefined ? Math.floor(Date.parse(q.from) / 1000) : undefined;
        const toTs = q.to !== undefined ? Math.floor(Date.parse(q.to) / 1000) : undefined;
        if (fromTs !== undefined && toTs !== undefined && fromTs > toTs) {
            throw new BadRequestException(
                'Invalid range: `from` must be <= `to`.',
            );
        }

        const page = this.repo.list({
            clientKey: q.client_id,
            modelRequested: q.model,
            status: q.status,
            fromTs,
            toTs,
            limit,
        });

        return {
            items: page.items.map(toView),
            count: page.items.length,
            limit,
            hasMore: page.hasMore,
        };
    }
}

function toView(r: RequestLogRow): LogItemView {
    return {
        requestedAt: r.requestedAt,
        modelRequested: r.modelRequested,
        // resolvedProvider / resolvedModel deliberately omitted.
        attempts: r.attempts,
        latencyMs: r.latencyMs,
        status: r.status,
        error: r.error ?? null,
        clientKey: r.clientKey ?? null,
        promptHash: r.promptHash ?? null,
        promptTokens: r.promptTokens ?? null,
        completionTokens: r.completionTokens ?? null,
        totalTokens: r.totalTokens ?? null,
    };
}
