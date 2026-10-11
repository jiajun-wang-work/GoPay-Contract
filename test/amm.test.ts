import { describe, expect, it } from 'vitest';
import { initialShares, quoteExactIn, quoteLiquidity, quoteRemoval } from '../src/amm.js';
describe('exact AMM wallet quotes', () => {
  it('bounds the integer root at maximum supported amounts and non-square products', () => {
    for (const [a, b] of [[9n, 17n], [(1n << 64n) - 1n, (1n << 64n) - 1n]]) {
      const root = initialShares(a, b);
      expect(root * root <= a * b && (root + 1n) ** 2n > a * b).toBe(true);
    }
  });
  it('quotes full-range positions and rejects donations, zero output and overflow', () => {
    expect(quoteLiquidity(10000n, 40000n, 0n, 0n, 0n)).toBe(20000n);
    expect(quoteLiquidity(1000n, 4000n, 10000n, 40000n, 20000n)).toBe(2000n);
    expect(quoteRemoval(20000n, 10000n, 40000n, 20000n)).toEqual({ amountA: 10000n, amountB: 40000n });
    expect(() => quoteLiquidity(1000n, 4001n, 10000n, 40000n, 20000n)).toThrow('ratio');
    expect(() => quoteExactIn(1n, 10000n, 1n)).toThrow('zero');
    expect(() => quoteExactIn(1n, (1n << 64n) - 1n, 100n)).toThrow('Uint<64>');
    expect(quoteExactIn(100n, 10000n, 40000n)).toBe(394n);
  });
});
