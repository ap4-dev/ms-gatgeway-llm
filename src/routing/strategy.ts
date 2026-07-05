import type { RoutingPolicy } from '../providers/provider.model';

/**
 * Phase 6-ish: turn the `routing_policy.strategy` enum into a concrete
 * ordering of chain indices. Pure function — no DB, no shared state.
 * Cursor state lives in `RoundRobinCursor`.
 *
 *   - 'primary' / 'fallback' : chain order (chain[0] first, chain[1] if it
 *                              fails, etc.). Phase 3 behaviour.
 *   - 'round-robin'          : start at the cursor's last-returned position
 *                              and walk forward. Cursor advances on every
 *                              route call so the next alias call gets the
 *                              next index.
 *
 * The cursor is keyed by the *requested model string* (alias or
 * 'provider/model' path). Two different aliases have independent cursors
 * so each alias spreads its own load.
 */
export function pickOrder(
    strategy: RoutingPolicy['strategy'],
    chainLength: number,
    cursorNext: () => number,
): number[] {
    if (chainLength <= 1) return chainLength === 1 ? [0] : [];

    if (strategy === 'round-robin') {
        // Walk forward from the cursor's pick. The cursor advances once
        // per *call* (we model this at the caller by invoking
        // `cursorNext` once), then walk deterministically.
        const start = cursorNext();
        const indices = new Array<number>(chainLength);
        for (let i = 0; i < chainLength; i++) {
            indices[i] = (start + i) % chainLength;
        }
        return indices;
    }

    // 'primary' and 'fallback' both mean: always chain order.
    return Array.from({ length: chainLength }, (_, i) => i);
}
