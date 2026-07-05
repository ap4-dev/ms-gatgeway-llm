import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import {
    MetricsService,
    type MetricsWindow,
    type MetricsSummary,
} from '../observability/metrics.service';

const VALID_WINDOWS: ReadonlyArray<MetricsWindow> = ['1h', '24h', '7d'];

/**
 * GET /v1/metrics/summary?window=1h|24h|7d&now=<unix-seconds>
 *
 * Returns the JSON aggregate from `MetricsService`. Default window is
 * `1h`; `now` defaults to the current time. Bad window or non-numeric
 * `now` → 400.
 *
 * Path uses `@Controller('metrics/summary')` so the global `/v1` prefix
 * in `main.ts` yields `/v1/metrics/summary`.
 */
@Controller('metrics/summary')
export class MetricsController {
    constructor(private readonly metrics: MetricsService) {}

    @Get()
    get(
        @Query('window') window?: string,
        @Query('now') nowStr?: string,
    ): MetricsSummary {
        const w = (window as MetricsWindow | undefined) ?? '1h';
        if (!VALID_WINDOWS.includes(w)) {
            throw new BadRequestException(
                `Unsupported metrics window "${window}". Use one of: ${VALID_WINDOWS.join(', ')}`,
            );
        }

        let now = Math.floor(Date.now() / 1000);
        if (nowStr !== undefined) {
            const parsed = Number(nowStr);
            if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) {
                throw new BadRequestException(
                    '`now` query param must be a unix-seconds integer',
                );
            }
            now = parsed;
        }

        try {
            return this.metrics.summary(w, now);
        } catch (err: any) {
            // Turn a defensive "unknown window" thrown deeper down into a
            // 400 instead of a 500.
            if (err?.message?.startsWith('Unsupported metrics window')) {
                throw new BadRequestException(err.message);
            }
            throw err;
        }
    }
}
