import {
  createCircuitContext,
  createConstructorContext,
  encodeContractAddress,
  sampleContractAddress,
  type ChargedState,
  type ContractAddress,
  type JubjubPoint,
} from '@midnight-ntwrk/compact-runtime';
import {
  Contract,
  ledger,
  pureCircuits,
  type ImpureCircuits,
  type Ledger,
  type Note,
  type Order,
} from '../src/managed/gopay/contract/index.js';
import { witnesses, type GoPayPrivateState } from '../src/witnesses.js';

const COIN_PUBLIC_KEY = '0'.repeat(64);

type CircuitName = keyof ImpureCircuits<GoPayPrivateState>;
type CircuitArgs<K extends CircuitName> = Parameters<ImpureCircuits<GoPayPrivateState>[K]> extends [
  unknown,
  ...infer A,
]
  ? A
  : never;
type CircuitReturn<K extends CircuitName> = Awaited<
  ReturnType<ImpureCircuits<GoPayPrivateState>[K]>
>['result'];

/**
 * 本地模拟器：在同一份合约公开状态上，以不同参与方的私密状态依次调用电路。
 * 不生成证明，只执行电路逻辑与账本操作。
 */
export class GoPaySimulator {
  readonly contract = new Contract<GoPayPrivateState>(witnesses);
  readonly address: ContractAddress = sampleContractAddress();
  readonly addressBytes: Uint8Array = encodeContractAddress(this.address);
  /** 模拟区块时间（秒） */
  time = 1_000_000;
  private state!: ChargedState;

  static async deploy(
    deployer: GoPayPrivateState,
    adminCommitment: Uint8Array,
    treasuryOwnerPk: Uint8Array,
    treasuryViewKey: JubjubPoint,
    delaySeconds: bigint,
  ): Promise<GoPaySimulator> {
    const sim = new GoPaySimulator();
    const { currentContractState } = await sim.contract.initialState(
      createConstructorContext(deployer, COIN_PUBLIC_KEY),
      adminCommitment,
      treasuryOwnerPk,
      treasuryViewKey,
      delaySeconds,
    );
    sim.state = currentContractState.data;
    return sim;
  }

  ledger(): Ledger {
    return ledger(this.state);
  }

  async call<K extends CircuitName>(
    caller: GoPayPrivateState,
    name: K,
    ...args: CircuitArgs<K>
  ): Promise<CircuitReturn<K>> {
    const ctx = createCircuitContext(
      this.address,
      COIN_PUBLIC_KEY,
      this.state,
      caller,
      undefined,
      undefined,
      this.time,
    );
    const circuit = this.contract.impureCircuits[name] as unknown as (
      c: typeof ctx,
      ...a: CircuitArgs<K>
    ) => Promise<{ result: CircuitReturn<K>; context: typeof ctx }>;
    const { result, context } = await circuit(ctx, ...args);
    this.state = context.currentQueryContext.state;
    return result;
  }

  // ── 链下辅助：钱包使用导出的 pure circuit 计算承诺并获取 Merkle 路径 ──

  noteCommitment(note: Note): Uint8Array {
    return pureCircuits.noteCommitmentFor(this.addressBytes, note);
  }

  notePath(note: Note) {
    const path = this.ledger().noteCommitments.findPathForLeaf(this.noteCommitment(note));
    if (!path) throw new Error('note commitment not found in tree');
    return path;
  }

  hasNote(note: Note): boolean {
    return this.ledger().noteCommitments.findPathForLeaf(this.noteCommitment(note)) !== undefined;
  }

  noteNullifier(secret: Uint8Array, note: Note): Uint8Array {
    return pureCircuits.noteNullifierFor(this.addressBytes, secret, this.noteCommitment(note));
  }

  orderPath(order: Order) {
    const cm = pureCircuits.orderCommitmentFor(this.addressBytes, order);
    const path = this.ledger().orderCommitments.findPathForLeaf(cm);
    if (!path) throw new Error('order commitment not found in tree');
    return path;
  }

  orderNullifier(order: Order): Uint8Array {
    return pureCircuits.orderNullifierFor(this.addressBytes, order);
  }

  swapAssetPath(assetId: Uint8Array) {
    const path = this.ledger().swapAssets.findPathForLeaf(pureCircuits.swapAssetLeaf(assetId));
    if (!path) throw new Error('asset is not in the tradable set');
    return path;
  }
}
