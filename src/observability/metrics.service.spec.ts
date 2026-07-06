import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MetricsService, type MetricsWindow } from './metrics.service';

function makeDb(): Database.Database {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(
        readFileSync(join(process.cwd(), 'migrations/0002_request_logs.sql'), 'utf-8'),
    );
    db.exec(
        readFileSync(join(process.cwd(), 'migrations/0003_request_logs_tokens.sql'), 'utf-8'),
    );
    return db;
}

function seedRow(
    db: Database.Database,
    r: {
        requested_at: number;
        model_requested: string;
        resolved_provider?: string | null;
        resolved_model?: string | null;
        attempts?: number;
        latency_ms: number;
        status: 'ok' | 'error' | 'circuit_open';
        error?: string | null;
    },
) {
    db.prepare(
        `INSERT INTO request_logs
         (requested_at, model_requested, resolved_provider, resolved_model,
          attempts, latency_ms, status, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
        r.requested_at,
        r.model_requested,
        r.resolved_provider ?? null,
        r.resolved_model ?? null,
        r.attempts ?? 1,
        r.latency_ms,
        r.status,
        r.error ?? null,
    );
}

describe('MetricsService', () => {
    let db: Database.Database;
    let svc: MetricsService;

    beforeEach(() => {
        db = makeDb();
        svc = new MetricsService(db);
    });

    afterEach(() => {
        db.close();
    });

    it('returns zeroed totals and empty models when no rows exist', () => {
        const out = svc.summary('1h', 1000);
        expect(out.totals.requests).toBe(0);
        expect(out.totals.errors).toBe(0);
        expect(out.totals.error_rate).toBe(0);
        expect(out.models).toEqual([]);
        // No provider dimension in the public API anymore.
        expect((out as any).providers).toBeUndefined();
    });

    it('filters rows older than the window cutoff', () => {
        seedRow(db, { requested_at: 1_000, model_requested: 'fast', latency_ms: 200, status: 'ok' });
        seedRow(db, { requested_at: 4_500, model_requested: 'fast', latency_ms: 300, status: 'ok' });
        seedRow(db, { requested_at: 7_500, model_requested: 'fast', latency_ms: 400, status: 'ok' });
        // window=1h around now=10000 → since = 10000 - 3600 = 6400.
        const out = svc.summary('1h', 10_000);
        expect(out.totals.requests).toBe(1);
        expect(out.models[0]?.latency_ms.min).toBe(400);
    });

    it('separates ok vs error rows in totals and per-group counts', () => {
        seedRow(db, { requested_at: 9_000, model_requested: 'fast', latency_ms: 200, status: 'ok' });
        seedRow(db, { requested_at: 9_001, model_requested: 'fast', latency_ms: 300, status: 'error' });
        seedRow(db, { requested_at: 9_002, model_requested: 'fast', latency_ms: 400, status: 'circuit_open' });
        const out = svc.summary('1h', 10_000);
        expect(out.totals.requests).toBe(3);
        expect(out.totals.errors).toBe(2); // error + circuit_open
        expect(out.totals.error_rate).toBeCloseTo(2 / 3, 3);
        const fast = out.models.find((m) => m.model === 'fast');
        expect(fast?.requests).toBe(3);
        expect(fast?.errors).toBe(2);
    });

    it('computes p50/p95/p99 with correct ordering', () => {
        // 21 rows with latency 100, 110, 120, …, 300. Sorted ascending:
        // index 0 → 100, index 10 → 200 (p50 ceil-1 of 21*0.5 = 11 - 1 = 10),
        // index 19 → 290 (p95 ceil-1 of 21*0.95 = 20 - 1 = 19),
        // index 20 → 300 (p99 ceil-1 of 21*0.99 = 21 - 1 = 20).
        const base = 9_000;
        for (let i = 0; i < 21; i++) {
            seedRow(db, {
                requested_at: base + i,
                model_requested: 'fast',
                latency_ms: 100 + i * 10,
                status: 'ok',
            });
        }
        const out = svc.summary('1h', 10_000);
        const fast = out.models.find((m) => m.model === 'fast')!;
        expect(fast.latency_ms.p50).toBe(200);
        expect(fast.latency_ms.p95).toBe(290);
        expect(fast.latency_ms.p99).toBe(300);
        expect(fast.latency_ms.min).toBe(100);
        expect(fast.latency_ms.max).toBe(300);
    });

    it('groups per-alias regardless of which upstream provider served', () => {
        // Two requests for alias "fast": one landed on openai, one on nan.
        seedRow(db, {
            requested_at: 9_000, model_requested: 'fast',
            resolved_provider: 'openai', resolved_model: 'gpt-4o-mini',
            latency_ms: 100, status: 'ok',
        });
        seedRow(db, {
            requested_at: 9_001, model_requested: 'fast',
            resolved_provider: 'nan', resolved_model: 'qwen3.6',
            latency_ms: 300, status: 'ok',
        });
        const out = svc.summary('1h', 10_000);
        const fast = out.models.find((m) => m.model === 'fast');
        // Aggregated into ONE row even though the underlying provider differed.
        expect(fast?.requests).toBe(2);
        expect((out as any).providers).toBeUndefined();
    });

    it('separates different aliases with their own counts', () => {
        seedRow(db, {
            requested_at: 9_000, model_requested: 'fast',
            resolved_provider: 'openai', resolved_model: 'gpt-4o-mini',
            latency_ms: 100, status: 'ok',
        });
        seedRow(db, {
            requested_at: 9_001, model_requested: 'fast',
            resolved_provider: 'openai', resolved_model: 'gpt-4o-mini',
            latency_ms: 200, status: 'ok',
        });
        seedRow(db, {
            requested_at: 9_002, model_requested: 'coder',
            resolved_provider: 'nan', resolved_model: 'qwen3-coder',
            latency_ms: 500, status: 'ok',
        });

        const out = svc.summary('1h', 10_000);
        expect(out.models.find((m) => m.model === 'fast')?.requests).toBe(2);
        expect(out.models.find((m) => m.model === 'coder')?.requests).toBe(1);
    });

    it('window parameter selects the right cutoff for 24h and 7d', () => {
        // Now = 1_000_000. 23h ago → 917_200 (in 1h/24h cutoff? 24h yes, 1h no).
        seedRow(db, { requested_at: 917_200, model_requested: 'fast', latency_ms: 200, status: 'ok' });
        // 25h ago → out of 24h window but in 7d window.
        seedRow(db, { requested_at: 900_000, model_requested: 'fast', latency_ms: 200, status: 'ok' });
        // 8d ago → out of everything.
        seedRow(db, { requested_at: 1_000_000 - 8 * 86_400, model_requested: 'fast', latency_ms: 200, status: 'ok' });

        expect(svc.summary('1h', 1_000_000).totals.requests).toBe(0);
        expect(svc.summary('24h', 1_000_000).totals.requests).toBe(1);
        expect(svc.summary('7d', 1_000_000).totals.requests).toBe(2);
    });

    it('rejects an unknown window with a clear error', () => {
        expect(() => svc.summary('bogus' as MetricsWindow, 0)).toThrow(
            /Unsupported metrics window/,
        );
    });

    describe('alias-only (no real-model leak)', () => {
        it('does not carry a `provider` field on ModelSummary', () => {
            seedRow(db, {
                requested_at: 9_000, model_requested: 'fast',
                resolved_provider: 'nan', latency_ms: 100, status: 'ok',
            });
            const out = svc.summary('1h', 10_000);
            for (const m of out.models) {
                expect(m).not.toHaveProperty('provider');
            }
        });

        it('serialized payload does not include upstream provider / model names', () => {
            seedRow(db, {
                requested_at: 9_000, model_requested: 'fast',
                resolved_provider: 'anthropic', resolved_model: 'claude-3',
                latency_ms: 100, status: 'ok',
            });
            seedRow(db, {
                requested_at: 9_001, model_requested: 'fast',
                resolved_provider: 'nan', resolved_model: 'qwen3-coder',
                latency_ms: 200, status: 'ok',
            });
            const out = svc.summary('1h', 10_000);
            const payload = JSON.stringify(out);
            // Every seed row's real provider/model must be absent.
            expect(payload).not.toContain('anthropic');
            expect(payload).not.toContain('claude-3');
            expect(payload).not.toContain('qwen3-coder');
            // Provider dimension array shouldn't exist.
            expect(payload).not.toContain('"providers"');
        });
    });
});
