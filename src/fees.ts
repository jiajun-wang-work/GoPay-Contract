import { ecMul, maxField, type JubjubPoint } from '@midnight-ntwrk/compact-runtime';
import { pureCircuits, type FeeReceipt } from './managed/gopay/contract/index.js';

export const FEE_BPS = 50n;
export const BPS_DENOMINATOR = 10_000n;

/** 平台费 = ceil(inputAmount × 50 / 10000)，与 fillOrder 中的电路约束一致。 */
export const computeFee = (inputAmount: bigint): bigint =>
  (inputAmount * FEE_BPS + BPS_DENOMINATOR - 1n) / BPS_DENOMINATOR;

/** 做市商与收款人看到的报价拆分。 */
export const splitInput = (inputAmount: bigint) => {
  const fee = computeFee(inputAmount);
  return { fee, principal: inputAmount - fee };
};

/**
 * 金库用查看私钥 tsk 解密手续费收据，得到恢复手续费 Note 所需的数量和随机数。
 * S = tsk·R = r·viewKey
 */
export const decryptFeeReceipt = (
  receipt: FeeReceipt,
  treasuryViewSecret: bigint,
): { amount: bigint; nonce: Uint8Array } => {
  const shared: JubjubPoint = ecMul(receipt.ephemeralKey, treasuryViewSecret);
  const [nonce, mask] = pureCircuits.feeReceiptSecrets(receipt.orderNullifier, shared);
  const p = maxField() + 1n;
  const amount = (((receipt.encryptedAmount - mask) % p) + p) % p;
  return { amount, nonce };
};
