import { pickOrder } from './strategy';

describe('pickOrder', () => {
    it('returns an empty array for an empty chain', () => {
        const cur = () => 0;
        expect(pickOrder('round-robin', 0, cur)).toEqual([]);
        expect(pickOrder('primary', 0, cur)).toEqual([]);
    });

    it('returns [0] for a single-element chain (regardless of strategy)', () => {
        expect(pickOrder('primary', 1, () => 0)).toEqual([0]);
        expect(pickOrder('fallback', 1, () => 0)).toEqual([0]);
        expect(pickOrder('round-robin', 1, () => 7)).toEqual([0]);
    });

    it('primary / fallback always start at 0 and walk forward', () => {
        const cur = () => 0;
        expect(pickOrder('primary', 3, cur)).toEqual([0, 1, 2]);
        expect(pickOrder('fallback', 3, cur)).toEqual([0, 1, 2]);
    });

    it('round-robin starts at the cursor value and wraps', () => {
        const cur = () => 2;
        expect(pickOrder('round-robin', 4, cur)).toEqual([2, 3, 0, 1]);
    });

    it('round-robin invokes the cursor exactly once per call', () => {
        let calls = 0;
        const cur = () => {
            calls += 1;
            return 0;
        };
        pickOrder('round-robin', 5, cur);
        expect(calls).toBe(1);
    });

    it('round-robin + cursor advance = successive rotations', () => {
        const cur = (() => {
            let v = 0;
            return () => (v++) % 4;
        })();
        // Simulate 4 successive calls — each advances the cursor once.
        expect(pickOrder('round-robin', 4, cur)).toEqual([0, 1, 2, 3]);
        expect(pickOrder('round-robin', 4, cur)).toEqual([1, 2, 3, 0]);
        expect(pickOrder('round-robin', 4, cur)).toEqual([2, 3, 0, 1]);
        expect(pickOrder('round-robin', 4, cur)).toEqual([3, 0, 1, 2]);
    });
});
