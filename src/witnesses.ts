import type { WitnessContext } from '@midnight-ntwrk/compact-runtime';
import type { Ledger } from './managed/gopay/contract/index.js';

/**
 * 每个参与方（用户 / 做市商 / 金库 / 管理员 / 适配器）在本地保存的私密状态。
 * 秘密只在本地证明时使用，不发送给报价服务或中继。
 */
export type GoPayPrivateState = {
  /** Note 所有者秘密：ownerPk = ownerPkOf(localSecret) */
  readonly localSecret: Uint8Array;
  /** 管理员秘密：adminCommitment = adminCommitmentOf(adminSecret)，非管理员填全零 */
  readonly adminSecret: Uint8Array;
  /** 适配器秘密：authCommitment = adapterCommitmentOf(adapterSecret)，非适配器填全零 */
  readonly adapterSecret: Uint8Array;
};

export const emptySecret = (): Uint8Array => new Uint8Array(32);

export const createPrivateState = (
  localSecret: Uint8Array,
  roles: { adminSecret?: Uint8Array; adapterSecret?: Uint8Array } = {},
): GoPayPrivateState => ({
  localSecret,
  adminSecret: roles.adminSecret ?? emptySecret(),
  adapterSecret: roles.adapterSecret ?? emptySecret(),
});

type Ctx = WitnessContext<Ledger, GoPayPrivateState>;

export const witnesses = {
  localSecret: ({ privateState }: Ctx): [GoPayPrivateState, Uint8Array] => [
    privateState,
    privateState.localSecret,
  ],
  adminSecret: ({ privateState }: Ctx): [GoPayPrivateState, Uint8Array] => [
    privateState,
    privateState.adminSecret,
  ],
  adapterSecret: ({ privateState }: Ctx): [GoPayPrivateState, Uint8Array] => [
    privateState,
    privateState.adapterSecret,
  ],
};
