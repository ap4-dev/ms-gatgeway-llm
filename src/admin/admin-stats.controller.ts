import {
    BadRequestException,
    Controller,
    Get,
    Query,
    UseGuards,
} from '@nestjs/common';
import {
    ApiBadRequestResponse,
    ApiBearerAuth,
    ApiForbiddenResponse,
    ApiOkResponse,
    ApiOperation,
    ApiQuery,
    ApiTags,
    ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { z } from 'zod';
import { ApiKeyAuthGuard } from '../auth/api-key.guard';
import { RequireScopesGuard } from '../auth/require-scopes.guard';
import { RateLimitGuard } from '../ratelimit/rate-limit.guard';
import { RequireScopes } from '../auth/require-scopes.decorator';
import {
    RequestLogRepository,
    type SummaryClientBucket,
    type SummaryDayBucket,
    type SummaryFilters,
    type SummaryModelBucket,
    type SummaryTotals,
} from '../database/repositories/request-log.repository';

/**
 * Query schema for `GET /admin/stats/summary`. Unlike `GET /admin/logs`,
 * `from` and `to` are REQUIRED: the dashboard always renders a bounded
 * window, and an unbounded aggregate over the whole table would stall the
 * single better-sqlite3 event loop. `model`/`client`/`provider` are
 * optional AND-combined filters. ISO timestamps are converted to
 * unix-seconds before hitting SQL.
 */
const SummaryQuerySchema = z
    .object({
        from: z.string().datetime({ offset: true }),
        to: z.string().datetime({ offset: true }),
        model: z.string().min(1).max(120).optional(),
        client: z.string().min(1).max(64).optional(),
        provider: z.string().min(1).max(64).optional(),
    })
    .strict();

type SummaryQuery = z.infer<typeof SummaryQuerySchema>;

/** Echo of the applied filters; `null` means "no filter on this axis". */
interface SummaryFiltersView {
    model: string | null;
    client: string | null;
    provider: string | null;
}

interface SummaryResponse {
    /** Inclusive lower bound actually applied, in unix seconds. */
    from: number;
    /** Inclusive upper bound actually applied, in unix seconds. */
    to: number;
    filters: SummaryFiltersView;
    totals: SummaryTotals;
    byDay: SummaryDayBucket[];
    byModel: SummaryModelBucket[];
    byClient: SummaryClientBucket[];
}

/**
 * Admin dashboard aggregation endpoint: `GET /admin/stats/summary`.
 *
 * Thin by design — parse/validate the query, delegate the four
 * aggregations to {@link RequestLogRepository}, and echo the applied
 * range/filters so the dashboard can label the chart. All grouping and
 * coalescing (NULL tokens/AVG → 0) lives in SQL.
 *
 * Failed attempts are stored as their own `status = 'error'` rows; the
 * counts here are row counts and are intentionally NOT deduplicated.
 *
 * Auth mirrors `GET /admin/logs`: `admin` scope required, rate-limited
 * per client by `RateLimitGuard`.
 */
@Controller('admin/stats')
@UseGuards(ApiKeyAuthGuard, RequireScopesGuard, RateLimitGuard)
@RequireScopes('admin')
@ApiTags('admin · stats')
@ApiBearerAuth('admin-bearer')
@ApiUnauthorizedResponse({ description: 'Missing or invalid API key.' })
@ApiForbiddenResponse({
    description: 'Client authenticated but lacks the `admin` scope.',
})
export class AdminStatsController {
    constructor(private readonly repo: RequestLogRepository) {}

    @Get('summary')
    @ApiOperation({
        summary:
            'Aggregated request metrics for a required [from, to] range, split by day / model / client.',
    })
    @ApiQuery({
        name: 'from',
        required: true,
        description: 'Inclusive lower bound on `requested_at`. ISO-8601 datetime.',
        example: '2026-09-21T00:00:00Z',
    })
    @ApiQuery({
        name: 'to',
        required: true,
        description: 'Inclusive upper bound on `requested_at`. ISO-8601 datetime.',
        example: '2026-09-22T23:59:59Z',
    })
    @ApiQuery({
        name: 'model',
        required: false,
        description: 'Filters on `model_requested`. 1–120 chars.',
        example: 'code',
    })
    @ApiQuery({
        name: 'client',
        required: false,
        description: 'Filters on `client_key`. 1–64 chars.',
        example: 'tenant-acme',
    })
    @ApiQuery({
        name: 'provider',
        required: false,
        description: 'Filters on `resolved_provider`. 1–64 chars.',
        example: 'nan',
    })
    @ApiOkResponse({
        description: 'Dashboards totals plus per-day / per-model / per-client breakdowns.',
        schema: {
            example: {
                from: 1789862400,
                to: 1790035199,
                filters: { model: null, client: null, provider: null },
                totals: {
                    requests: 1234,
                    ok: 1200,
                    errors: 30,
                    circuitOpen: 4,
                    promptTokens: 456789,
                    completionTokens: 123456,
                    totalTokens: 580245,
                    avgLatencyMs: 1523,
                },
                byDay: [
                    {
                        day: '2026-09-21',
                        requests: 100,
                        ok: 95,
                        errors: 4,
                        circuitOpen: 1,
                        totalTokens: 50000,
                        avgLatencyMs: 1400,
                    },
                ],
                byModel: [
                    {
                        model: 'code',
                        requests: 300,
                        ok: 290,
                        errors: 8,
                        circuitOpen: 2,
                        totalTokens: 100000,
                        avgLatencyMs: 1700,
                    },
                ],
                byClient: [
                    {
                        client: 'alex',
                        requests: 500,
                        ok: 490,
                        errors: 10,
                        circuitOpen: 0,
                        totalTokens: 200000,
                        avgLatencyMs: 1300,
                    },
                ],
            },
        },
    })
    @ApiBadRequestResponse({
        description:
            'Malformed query (missing/invalid ISO, unknown parameter, or `from` > `to`).',
    })
    summary(@Query() raw: Record<string, string | undefined>): SummaryResponse {
        const parsed = SummaryQuerySchema.safeParse(raw);
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

        const q: SummaryQuery = parsed.data;
        const fromTs = Math.floor(Date.parse(q.from) / 1000);
        const toTs = Math.floor(Date.parse(q.to) / 1000);
        if (fromTs > toTs) {
            throw new BadRequestException(
                'Invalid range: `from` must be <= `to`.',
            );
        }

        const filters: SummaryFilters = {
            model: q.model,
            client: q.client,
            provider: q.provider,
        };

        return {
            from: fromTs,
            to: toTs,
            filters: {
                model: q.model ?? null,
                client: q.client ?? null,
                provider: q.provider ?? null,
            },
            totals: this.repo.summaryTotals(fromTs, toTs, filters),
            byDay: this.repo.summaryByDay(fromTs, toTs, filters),
            byModel: this.repo.summaryByModel(fromTs, toTs, filters),
            byClient: this.repo.summaryByClient(fromTs, toTs, filters),
        };
    }
}
