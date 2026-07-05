import { BadRequestException } from '@nestjs/common';
import { MetricsController } from './metrics.controller';
import type { MetricsService, MetricsSummary } from '../observability/metrics.service';

const summary: MetricsSummary = {
    window: '1h',
    since: 1000,
    until: 4600,
    totals: { requests: 5, errors: 1, error_rate: 0.2 },
    models: [
        {
            model: 'fast',
            provider: 'openai',
            requests: 5,
            errors: 1,
            error_rate: 0.2,
            latency_ms: { p50: 100, p95: 200, p99: 300, min: 80, max: 400 },
        },
    ],
    providers: [
        {
            id: 'openai',
            requests: 5,
            errors: 1,
            error_rate: 0.2,
            latency_ms: { p50: 100, p95: 200, p99: 300, min: 80, max: 400 },
        },
    ],
};

function makeController(s: MetricsSummary | Error) {
    const summary_ = jest.fn();
    if (s instanceof Error) {
        summary_.mockImplementation(() => {
            throw s;
        });
    } else {
        summary_.mockReturnValue(s);
    }
    const svc = { summary: summary_ } as unknown as MetricsService;
    return { controller: new MetricsController(svc), summary_ };
}

describe('MetricsController', () => {
    it('returns the summary with default window=1h', () => {
        const { controller, summary_ } = makeController(summary);
        const out = controller.get(undefined, '1000');
        expect(out).toEqual(summary);
        // Default window '1h' is passed when not provided.
        expect(summary_).toHaveBeenCalledWith('1h', 1000);
    });

    it('uses a custom window when provided', () => {
        const { controller, summary_ } = makeController(summary);
        controller.get('24h', '2000');
        expect(summary_).toHaveBeenCalledWith('24h', 2000);
    });

    it('parses `now` (unix seconds) from query string', () => {
        const { controller, summary_ } = makeController(summary);
        controller.get('7d', '1234567890');
        expect(summary_).toHaveBeenCalledWith('7d', 1234567890);
    });

    it('rejects an unknown window with BadRequestException', () => {
        const { controller } = makeController(new Error('Unsupported metrics window "bogus". Use one of: 1h, 24h, 7d'));
        expect(() => controller.get('bogus' as any, '0')).toThrow(BadRequestException);
    });

    it('rejects a non-numeric `now` with BadRequestException', () => {
        const { controller } = makeController(summary);
        expect(() => controller.get('1h', 'not-a-number' as any)).toThrow(
            BadRequestException,
        );
    });
});
