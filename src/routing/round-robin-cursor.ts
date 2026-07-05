/**
 * Phase 6-ish in-memory round-robin cursor. Stateful, per-process. Keys
 * the cursor by the requested model string (alias or 'provider/model'
 * path) so distinct aliases rotate independently.
 *
 * Production caveat: with multiple gateway processes behind a load
 * balancer, each process has its own cursor — the rotation is
 * approximate, not strictly global. For strict global round-robin move
 * the cursor to Redis (ZADD-style counter per alias key). For POC /
 * single-instance this is fine.
 */
export class RoundRobinCursor {
    private readonly cursors = new Map<string, number>();

    /**
     * Returns the next starting index for the given key, advancing
     * internally. Pass `length` so we can wrap modulo correctly.
     */
    next(key: string, length: number): number {
        if (length <= 0) return 0;
        const current = this.cursors.get(key) ?? 0;
        const idx = ((current % length) + length) % length;
        this.cursors.set(key, current + 1);
        return idx;
    }

    /** Test helper — wipe state between cases. */
    reset(): void {
        this.cursors.clear();
    }
}
