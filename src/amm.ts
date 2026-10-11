/** AMM amounts are raw asset units, never the webapp's universal display scale. */
export const AMM_FEE_BPS = 30n;
const BPS = 10000n;
const MAX = (1n << 64n) - 1n;
function uint64(value: bigint): void {
  if (value < 0n || value > MAX) throw new RangeError('AMM amount exceeds Uint<64>');
}
function positive(value: bigint): void {
  uint64(value);
  if (value === 0n) throw new RangeError('AMM amount must be positive');
}
/** Integer square root, with no floating-point conversion. */
export function initialShares(a: bigint, b: bigint): bigint {
  positive(a); positive(b);
  const product = a * b;
  let root = product;
  let next = (root + 1n) / 2n;
  while (next < root) { root = next; next = (root + product / root) / 2n; }
  return root;
}
export function quoteExactIn(amount: bigint, reserveIn: bigint, reserveOut: bigint): bigint {
  positive(amount); positive(reserveIn); positive(reserveOut);
  uint64(reserveIn + amount);
  const weighted = amount * (BPS - AMM_FEE_BPS);
  const out = weighted * reserveOut / (reserveIn * BPS + weighted);
  if (out === 0n) throw new RangeError('AMM output rounds to zero');
  return out;
}
export function quoteLiquidity(a: bigint, b: bigint, reserveA: bigint, reserveB: bigint,
  shares: bigint): bigint {
  positive(a); positive(b); uint64(reserveA); uint64(reserveB); uint64(shares);
  uint64(reserveA + a); uint64(reserveB + b);
  if (shares === 0n) {
    if (reserveA !== 0n || reserveB !== 0n) throw new RangeError('Invalid empty pool');
    return initialShares(a, b);
  }
  positive(reserveA); positive(reserveB);
  if (a * reserveB !== b * reserveA) throw new RangeError('Liquidity ratio mismatch');
  const minted = a * shares / reserveA;
  positive(minted); uint64(shares + minted);
  return minted;
}
export function quoteRemoval(burn: bigint, reserveA: bigint, reserveB: bigint, shares: bigint) {
  positive(burn); positive(reserveA); positive(reserveB); positive(shares);
  if (burn > shares) throw new RangeError('LP burn exceeds supply');
  const amountA = burn * reserveA / shares;
  const amountB = burn * reserveB / shares;
  positive(amountA); positive(amountB);
  return { amountA, amountB };
}
