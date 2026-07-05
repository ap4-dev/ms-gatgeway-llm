import { pickOrder, sampleWeightedIndex } from './strategy';
import type { ResolvedModel } from '../providers/provider.model';

function mk(idx: number, priority = 0): ResolvedModel {
    return {
        requestedAs: 'f',
        providerId: `p${idx}`,
        modelKey: `m${idx}`,
        upstreamModel: `real-m${idx}`,
        apiKey: 'k',
        baseURL: 'https://x',
        overrides: {},
        supportsStream: true,
        timeoutMs: 1000,
        priority,
    };
}

describe('pickOrder', () => {
    it('returns an empty array for an empty chain', () => {
        const cur = () => 0;
        expect(pickOrder('round-robin', [], cur)).toEqual([]);
        expect(pickOrder('primary', [], cur)).toEqual([]);
        expect(pickOrder('weighted', [], cur)).toEqual([]);
        expect(pickOrder('priority-grouped', [], cur)).toEqual([]);
    });

    it('returns [0] for a single-element chain (regardless of strategy)', () => {
        const chain = [mk(0)];
        const cur = () => 0;
        expect(pickOrder('primary', chain, cur)).toEqual([0]);
        expect(pickOrder('fallback', chain, cur)).toEqual([0]);
        expect(pickOrder('round-robin', chain, () => 7)).toEqual([0]);
        expect(pickOrder('weighted', chain, cur, [5])).toEqual([0]);
        expect(pickOrder('priority-grouped', chain, cur)).toEqual([0]);
    });

    it('primary / fallback always start at 0 and walk forward', () => {
        const cur = () => 0;
        expect(pickOrder('primary', [mk(0), mk(1), mk(2)], cur)).toEqual([0, 1, 2]);
        expect(pickOrder('fallback', [mk(0), mk(1), mk(2)], cur)).toEqual([0, 1, 2]);
    });

    it('round-robin starts at the cursor value and wraps', () => {
        const cur = () => 2;
        expect(pickOrder('round-robin', [mk(0), mk(1), mk(2), mk(3)], cur)).toEqual([
            2, 3, 0, 1,
        ]);
    });

    it('round-robin invokes the cursor exactly once per call', () => {
        let calls = 0;
        const cur = () => {
            calls += 1;
            return 0;
        };
        pickOrder('round-robin', [mk(0), mk(1), mk(2), mk(3), mk(4)], cur);
        expect(calls).toBe(1);
    });

    it('round-robin + cursor advance = successive rotations', () => {
        const cur = (() => {
            let v = 0;
            return () => (v++) % 4;
        })();
        expect(pickOrder('round-robin', [mk(0), mk(1), mk(2), mk(3)], cur)).toEqual([0, 1, 2, 3]);
        expect(pickOrder('round-robin', [mk(0), mk(1), mk(2), mk(3)], cur)).toEqual([1, 2, 3, 0]);
        expect(pickOrder('round-robin', [mk(0), mk(1), mk(2), mk(3)], cur)).toEqual([2, 3, 0, 1]);
        expect(pickOrder('round-robin', [mk(0), mk(1), mk(2), mk(3)], cur)).toEqual([3, 0, 1, 2]);
    });

    it('priority-grouped sorts indices by (priority asc, position asc)', () => {
        const chain = [mk(0, 5), mk(1, 1), mk(2, 5), mk(3, 0), mk(4, 1)];
        expect(pickOrder('priority-grouped', chain, () => 0)).toEqual([3, 1, 4, 0, 2]);
    });

    it('priority-grouped leaves a single-element group in position order', () => {
        const chain = [mk(0, 0), mk(1, 0)];
        expect(pickOrder('priority-grouped', chain, () => 0)).toEqual([0, 1]);
    });

    it('weighted walks forward from the sampled index', () => {
        // weights [0]=1, [1]=1, [2]=1 → uniform. We just check the
        // function returns a permutation of [0..n-1] over many calls.
        const chain = [mk(0), mk(1), mk(2)];
        const seen = new Set<string>();
        for (let i = 0; i < 200; i++) {
            const ord = pickOrder('weighted', chain, () => 0, [1, 1, 1]);
            expect(ord.length).toBe(3);
            // Each ordering is a rotation of [0, 1, 2].
            const offset = ord[0];
            expect(ord).toEqual([offset, (offset + 1) % 3, (offset + 2) % 3]);
            seen.add(String(offset));
        }
        // With 200 trials against a 3-way uniform distribution it's
        // astronomically unlikely to miss every offset — keeps the test
        // honest if sampling broke (e.g. always returns 0).
        expect(seen.size).toBeGreaterThan(1);
    });

    it('weighted leans heavily toward the high-weight index', () => {
        const chain = [mk(0), mk(1), mk(2)];
        let zero = 0;
        for (let i = 0; i < 1000; i++) {
            const ord = pickOrder('weighted', chain, () => 0, [1, 99, 1]);
            if (ord[0] === 1) zero += 1;
        }
        // Roughly 98% should start at idx 1 (weight 99); give it slack.
        expect(zero).toBeGreaterThan(900);
    });

    it('weighted uses uniform sampling when no weights are passed', () => {
        const chain = [mk(0), mk(1), mk(2)];
        // Smoke call — should not throw, returns a valid permutation.
        const ord = pickOrder('weighted', chain, () => 0);
        expect(ord.length).toBe(3);
        expect(ord).toEqual([ord[0], (ord[0] + 1) % 3, (ord[0] + 2) % 3]);
    });
});

describe('sampleWeightedIndex', () => {
    it('returns a value in [0, n)', () => {
        for (let i = 0; i < 100; i++) {
            const idx = sampleWeightedIndex([1, 1, 1, 1], 4);
            expect(idx).toBeGreaterThanOrEqual(0);
            expect(idx).toBeLessThan(4);
        }
    });

    it('treats missing weights as 1 (so [5, undefined, 5] is ~45/9/45)', () => {
        const counts = [0, 0, 0];
        for (let i = 0; i < 1000; i++) {
            const idx = sampleWeightedIndex([5, undefined, 5] as any, 3);
            counts[idx] += 1;
        }
        // idx 0 and 2 are heavy (weight 5 each), idx 1 is light (default 1).
        expect(counts[0]).toBeGreaterThan(350);
        expect(counts[2]).toBeGreaterThan(350);
        expect(counts[1]).toBeLessThan(200);
    });

    it('all-equal weights approximate uniform distribution', () => {
        const counts = [0, 0, 0, 0];
        for (let i = 0; i < 4000; i++) {
            counts[sampleWeightedIndex([1, 1, 1, 1], 4)] += 1;
        }
        for (const c of counts) {
            expect(c).toBeGreaterThan(800);
            expect(c).toBeLessThan(1200);
        }
    });
});
