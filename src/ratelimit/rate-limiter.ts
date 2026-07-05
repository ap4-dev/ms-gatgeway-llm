/**
 * Phase 5 rate-limiter abstraction. The production implementation lives
 * in `redis-rate-limiter.service.ts`; tests use an in-memory fake that
 * satisfies the same interface. Keeps the rate-limit guard decoupled
 * from the storage choice (Redis today, in-memory or token-bucket later).
 */

export interface RateLimitResult {
    /** True when the request is allowed. */
    allowed: boolean;
    /** Count of requests currently in the window. After the increment,
     *  when allowed: between 1 and the limit (inclusive). When denied:
     *  the limit or higher. */
    current: number;
    /** Echo of the effective limit (per-client `rate_limit_rpm`). */
    limit: number;
    /** When denied: time until the oldest in-window entry exits the
     *  window. Undefined when allowed. */
    retryAfterMs?: number;
}

export interface RateLimitDecision {
    allowed: boolean;
    limit: number;
    current: number;
    retryAfterMs?: number;
}

export interface RateLimiter {
    /**
     * Decide whether `clientId` may make another request right now under
     * a `limitRpm` sliding window. Implementations MUST swallow Redis /
     * storage errors and return `{ allowed: true }` (fail-open) — never
     * block legitimate traffic on infra failures.
     */
    allowRequest(
        clientId: string,
        limitRpm: number,
        nowMs?: number,
    ): Promise<RateLimitResult>;
}

export const WINDOW_MS = 60_000; // 1 minute sliding window
