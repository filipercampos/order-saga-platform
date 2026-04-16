import { backoffWithJitter } from './worker';

describe('backoffWithJitter', () => {
  it('grows exponentially up to the cap', () => {
    const max = () => 0.999999;
    expect(backoffWithJitter(0, 100, 5_000, max)).toBe(99);
    expect(backoffWithJitter(3, 100, 5_000, max)).toBe(799);
    expect(backoffWithJitter(10, 100, 5_000, max)).toBe(4_999);
  });

  it('spreads retries across the whole window (full jitter)', () => {
    expect(backoffWithJitter(3, 100, 5_000, () => 0)).toBe(0);
    expect(backoffWithJitter(3, 100, 5_000, () => 0.5)).toBe(400);
  });
});
