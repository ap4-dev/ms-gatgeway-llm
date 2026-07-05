import type { ResolvedModel, RoutingStrategyKind } from '../providers/provider.model';

/**
 * Phase-after-5.5: turn the per-alias `strategy` into a concrete
 * ordering of chain indices. Pure function — no DB, no shared state.
 * Cursor state lives in `RoundRobinCursor`.
 *
 * Strategy semantics:
 *   - 'primary' / 'fallback' : chain order (chain[0] first, chain[1] if
 *                              it fails, etc.). Phase 3 behaviour.
 *   - 'round-robin'          : start at the cursor's last-returned
 *                              position and walk forward. Cursor advances
 *                              once per call (the `cursorNext` closure
 *                              only fires here).
 *   - 'weighted'             : sample one starting index per call using
 *                              `weights[i]` (positions without an entry
 *                              default to 1). Then walk forward from
 *                              the sampled index.
 *   - 'priority-grouped'     : order entries by (chain[i].priority asc,
 *                              position asc). Lower-priority groups are
 *                              tried only after higher-priority groups
 *                              fail; within a group, position order
 *                              decides.
 */
export function pickOrder(
    strategy: RoutingStrategyKind,
    chain: readonly ResolvedModel[],
    cursorNext: () => number,
    weights?: readonly number[],
): number[] {
    const n = chain.length;
    if (n === 0) return [];
    if (n === 1) return [0];

    if (strategy === 'round-robin') {
        const start = cursorNext();
        return walkForwardFrom(start, n);
    }

    if (strategy === 'weighted') {
        const start = sampleWeightedIndex(weights, n);
        return walkForwardFrom(start, n);
    }

    if (strategy === 'priority-grouped') {
        // Sort indices by (priority asc, position asc). Stable sort
        // ensures ties resolve to chain order.
        return chain
            .map((entry, idx) => ({ idx, priority: entry.priority ?? 0 }))
            .sort((a, b) => {
                if (a.priority !== b.priority) return a.priority - b.priority;
                return a.idx - b.idx;
            })
            .map((p) => p.idx);
    }

    // 'primary' and 'fallback' both mean: always chain order.
    return Array.from({ length: n }, (_, i) => i);
}

/** Walk forward from `start`, wrapping at end. Always returns all `n` indices. */
function walkForwardFrom(start: number, n: number): number[] {
    return Array.from({ length: n }, (_, i) => (start + i) % n);
}

/**
 * Sample one starting index weighted by `weights[i]`. Returns
 * positions without an explicit weight as `weight=1` (uniform mix).
 * Invalid / empty weight arrays degrade to uniform sampling.
 */
export function sampleWeightedIndex(
    weights: readonly number[] | undefined,
    n: number,
): number {
    const effective: number[] = new Array(n);
    let total = 0;
    for (let i = 0; i < n; i++) {
        const w = weights?.[i];
        const value = typeof w === 'number' && Number.isFinite(w) && w > 0 ? w : 1;
        effective[i] = value;
        total += value;
    }
    if (total <= 0) return Math.floor(Math.random() * n);
    const target = Math.random() * total;
    let acc = 0;
    for (let i = 0; i < n; i++) {
        acc += effective[i];
        if (target < acc) return i;
    }
    return n - 1;
}
