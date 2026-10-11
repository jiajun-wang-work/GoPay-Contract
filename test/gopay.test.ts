import { randomBytes } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  ecMulGenerator,
  encodeRawTokenType,
  encodeUserAddress,
  sampleRawTokenType,
  sampleUserAddress,
} from '@midnight-ntwrk/compact-runtime';
import {
  pureCircuits,
  RedemptionStatus,
  Representation,
  UpdateKind,
  type AssetIdentity,
  type Note,
  type Order,
} from '../src/managed/gopay/contract/index.js';
import { createPrivateState, type GoPayPrivateState } from '../src/witnesses.js';
import { computeFee, decryptFeeReceipt, splitInput } from '../src/fees.js';
import { GoPaySimulator } from './simulator.js';

// Test scalars use 248 random bits, within the ledger 8 Field/scalar range.
const jubjubSampleScalar = (): bigint => BigInt('0x' + randomBytes(31).toString('hex')) || 1n;
const rand = (): Uint8Array => new Uint8Array(randomBytes(32));
const text32 = (s: string): Uint8Array => {
  const out = new Uint8Array(32);
  // 0x 开头按十六进制地址编码（如 ERC-20 合约地址），其他按 UTF-8
  out.set(s.startsWith('0x') ? Buffer.from(s.slice(2), 'hex') : new TextEncoder().encode(s));
  return out;
};
const ZERO = new Uint8Array(32);
const DELAY = 3_600n;
const CAP = 10n ** 30n;

// 参与方
const admin = createPrivateState(rand(), { adminSecret: rand() });
const adapterOperator = createPrivateState(rand(), { adapterSecret: rand() });
const alice = createPrivateState(rand());
const bob = createPrivateState(rand());
const maker = createPrivateState(rand());
const treasury = createPrivateState(rand());
const mallory = createPrivateState(rand(), { adminSecret: rand(), adapterSecret: rand() });
const treasuryViewSecret = jubjubSampleScalar();

const pk = (p: GoPayPrivateState) => pureCircuits.ownerPkOf(p.localSecret);

const identity = (symbol: string, chain = 'midnight-test'): AssetIdentity => ({
  sourceChain: text32(chain),
  sourceToken: text32(symbol),
  issuerOrBridge: text32('gopay-test'),
  assetVersion: 1n,
});

const note = (assetId: Uint8Array, amount: bigint, owner: GoPayPrivateState): Note => ({
  assetId,
  amount,
  ownerPk: pk(owner),
  nonce: rand(),
});

describe('GoPay contract', () => {
  let sim: GoPaySimulator;
  let usdc: Uint8Array;
  let jpyc: Uint8Array;
  let usdcColor: Uint8Array;
  let jpycColor: Uint8Array;

  const registerReserveAsset = async (symbol: string, color: Uint8Array, decimals: bigint) => {
    const id = await sim.call(
      admin, 'registerAsset', identity(symbol), Representation.unshieldedReserve, ZERO, color, decimals, CAP,
    );
    await sim.call(admin, 'setAssetOperations', id, true, true, true, CAP);
    return id;
  };

  const deposit = async (assetId: Uint8Array, amount: bigint, owner: GoPayPrivateState) => {
    const n = note(assetId, amount, owner);
    const cm = await sim.call(owner, 'depositUnshielded', assetId, amount, n.ownerPk, n.nonce);
    expect(cm).toEqual(sim.noteCommitment(n));
    return n;
  };

  const makeOrder = (input: bigint, netOutput: bigint, overrides: Partial<Order> = {}): Order => ({
    ownerPk: pk(alice),
    makerPk: pk(maker),
    recipientPk: pk(alice),
    inputAssetId: usdc,
    inputAmount: input,
    outputAssetId: jpyc,
    netOutputAmount: netOutput,
    recipientNonce: rand(),
    expiry: BigInt(sim.time + 600),
    quoteId: rand(),
    treasuryConfigVersion: sim.ledger().treasuryConfigVersion,
    orderNonce: rand(),
    ...overrides,
  });

  /** 用户存入输入资产并下单，返回订单及找零 Note。 */
  const placeOrder = async (order: Order, depositAmount = order.inputAmount) => {
    const input = await deposit(order.inputAssetId, depositAmount, alice);
    const change = note(order.inputAssetId, depositAmount - order.inputAmount, alice);
    await sim.call(alice, 'createOrder', input, sim.notePath(input), order, change.nonce);
    return { order, change };
  };

  const fill = async (
    order: Order,
    inventory: Note,
    opts: { fee?: bigint; caller?: GoPayPrivateState } = {},
  ) => {
    const fee = opts.fee ?? computeFee(order.inputAmount);
    const makerChange = note(order.outputAssetId, inventory.amount - order.netOutputAmount, maker);
    const makerReceive = note(order.inputAssetId, order.inputAmount - fee, maker);
    await sim.call(
      opts.caller ?? maker,
      'fillOrder',
      order,
      sim.orderPath(order),
      inventory,
      sim.notePath(inventory),
      fee,
      makerChange.nonce,
      makerReceive.nonce,
      sim.swapAssetPath(order.inputAssetId),
      sim.swapAssetPath(order.outputAssetId),
      jubjubSampleScalar(),
    );
    return { makerChange, makerReceive, fee };
  };

  beforeEach(async () => {
    sim = await GoPaySimulator.deploy(
      admin,
      pureCircuits.adminCommitmentOf(admin.adminSecret),
      pk(treasury),
      ecMulGenerator(treasuryViewSecret),
      DELAY,
    );
    usdcColor = encodeRawTokenType(sampleRawTokenType());
    jpycColor = encodeRawTokenType(sampleRawTokenType());
    usdc = await registerReserveAsset('USDC', usdcColor, 6n);
    jpyc = await registerReserveAsset('JPYC', jpycColor, 0n);
  });

  // ───────────────────────── Registry & governance ─────────────────────────

  describe('AMM full-range LP positions', () => {
    const seed = async () => {
      await sim.call(alice, 'createPool', usdc, jpyc);
      const id = pureCircuits.poolIdOf(usdc, jpyc);
      const a = await deposit(usdc, 10000n, alice);
      const b = await deposit(jpyc, 40000n, alice);
      const lp = note(pureCircuits.lpAssetOf(id), 20000n, alice);
      await sim.call(alice, 'addLiquidity', id, a, sim.notePath(a), b, sim.notePath(b),
        10000n, 40000n, lp.amount, lp.amount, rand(), rand(), lp.nonce, BigInt(sim.time + 60));
      expect(sim.hasNote(lp)).toBe(true);
      return { id, lp };
    };
    it('adds proportional liquidity, swaps both ways and exits during pause', async () => {
      const { id, lp } = await seed();
      const a = await deposit(usdc, 1000n, bob);
      const b = await deposit(jpyc, 4000n, bob);
      const bobLp = note(lp.assetId, 2000n, bob);
      await sim.call(bob, 'addLiquidity', id, a, sim.notePath(a), b, sim.notePath(b),
        1000n, 4000n, 2000n, 2000n, rand(), rand(), bobLp.nonce, BigInt(sim.time + 60));
      for (const forward of [true, false]) {
        const p = sim.ledger().pools.lookup(id);
        const input = await deposit(forward ? usdc : jpyc, 100n, bob);
        const x = forward ? p.reserveA : p.reserveB;
        const y = forward ? p.reserveB : p.reserveA;
        const out = 100n * 9970n * y / (x * 10000n + 100n * 9970n);
        const output = note(forward ? jpyc : usdc, out, bob);
        await sim.call(bob, 'swapExactIn', id, forward, input, sim.notePath(input),
          100n, out, out, rand(), output.nonce, BigInt(sim.time + 60));
        expect(sim.hasNote(output)).toBe(true);
        const next = sim.ledger().pools.lookup(id);
        expect(next.reserveA * next.reserveB).toBeGreaterThanOrEqual(p.reserveA * p.reserveB);
      }
      await sim.call(admin, 'setPaused', { deposit: true, transfer: true, swap: true, withdraw: true });
      const p = sim.ledger().pools.lookup(id);
      const outA = note(usdc, lp.amount * p.reserveA / p.shares, alice);
      const outB = note(jpyc, lp.amount * p.reserveB / p.shares, alice);
      await sim.call(alice, 'removeLiquidity', id, lp, sim.notePath(lp), lp.amount,
        outA.amount, outB.amount, outA.amount, outB.amount, rand(), outA.nonce, outB.nonce,
        BigInt(sim.time + 60));
      expect(sim.hasNote(outA)).toBe(true);
      expect(sim.hasNote(outB)).toBe(true);
      expect(sim.ledger().pools.lookup(id).shares).toBe(2000n);
    });
    it('rejects LP theft, repeated burns and incorrect proportional deposits', async () => {
      const { id, lp } = await seed();
      const remove = (caller: GoPayPrivateState) => sim.call(caller, 'removeLiquidity', id,
        lp, sim.notePath(lp), 20000n, 10000n, 40000n, 0n, 0n,
        rand(), rand(), rand(), BigInt(sim.time + 60));
      await expect(remove(mallory)).rejects.toThrow('not note owner');
      const a = await deposit(usdc, 1000n, bob);
      const b = await deposit(jpyc, 4001n, bob);
      const add = (amountB: bigint, minted: bigint) => sim.call(bob, 'addLiquidity', id,
        a, sim.notePath(a), b, sim.notePath(b), 1000n, amountB, minted, 0n,
        rand(), rand(), rand(), BigInt(sim.time + 60));
      await expect(add(4001n, 2000n)).rejects.toThrow('ratio mismatch');
      await expect(add(4000n, 2001n)).rejects.toThrow('quotient');
      await remove(alice);
      // Reseed so the second burn reaches Note validation with nonzero reserves.
      const nextA = await deposit(usdc, 10000n, bob);
      const nextB = await deposit(jpyc, 40000n, bob);
      await sim.call(bob, 'addLiquidity', id, nextA, sim.notePath(nextA), nextB,
        sim.notePath(nextB), 10000n, 40000n, 20000n, 0n,
        rand(), rand(), rand(), BigInt(sim.time + 60));
      await expect(remove(alice)).rejects.toThrow('already spent');
    });
    it('rejects reverse duplicate pools, forged output, slippage and expired requests', async () => {
      const { id } = await seed();
      await expect(sim.call(bob, 'createPool', jpyc, usdc)).rejects.toThrow('pool exists');
      const input = await deposit(usdc, 100n, bob);
      const out = 100n * 9970n * 40000n / (10000n * 10000n + 100n * 9970n);
      const swap = (amountOut: bigint, minimum: bigint, deadline = BigInt(sim.time + 60)) =>
        sim.call(bob, 'swapExactIn', id, true, input, sim.notePath(input), 100n,
          amountOut, minimum, rand(), rand(), deadline);
      await expect(swap(out + 1n, 0n)).rejects.toThrow('quotient');
      await expect(swap(out, out + 1n)).rejects.toThrow('slippage');
      await expect(swap(out, 0n, BigInt(sim.time - 1))).rejects.toThrow('expired');
      await sim.call(admin, 'setAssetOperations', usdc, true, false, true, CAP);
      await expect(swap(out, 0n)).rejects.toThrow('not tradable');
    });
    it('rejects incorrect initial shares and allows full withdrawal then reseeding', async () => {
      const { id, lp } = await seed();
      await sim.call(alice, 'removeLiquidity', id, lp, sim.notePath(lp), 20000n,
        10000n, 40000n, 0n, 0n, rand(), rand(), rand(), BigInt(sim.time + 60));
      expect(sim.ledger().pools.lookup(id).shares).toBe(0n);
      const a = await deposit(usdc, 9n, bob);
      const b = await deposit(jpyc, 16n, bob);
      const add = (m: bigint) => sim.call(bob, 'addLiquidity', id, a, sim.notePath(a),
        b, sim.notePath(b), 9n, 16n, m, 0n, rand(), rand(), rand(), BigInt(sim.time + 60));
      await expect(add(13n)).rejects.toThrow('initial shares');
      await add(12n);
      expect(sim.ledger().pools.lookup(id).shares).toBe(12n);
    });
  });

  describe('Note checkout payments', () => {
    const checkout = async () => {
      const id = await sim.call(bob, 'createPayment', usdc, 100n, BigInt(sim.time + 60), rand());
      const input = await deposit(usdc, 150n, alice);
      const merchant = note(usdc, 100n, bob);
      const change = note(usdc, 50n, alice);
      const refundNonce = rand();
      const pay = () => sim.call(alice, 'payPayment', id, input, sim.notePath(input),
        merchant.nonce, change.nonce, refundNonce);
      return { id, input, merchant, change, refundNonce, pay };
    };
    it('pays once and supports cumulative partial then full refunds during pause', async () => {
      const c = await checkout();
      expect(await c.pay()).toEqual(sim.noteCommitment(c.merchant));
      expect(sim.hasNote(c.change)).toBe(true);
      await expect(c.pay()).rejects.toThrow('not open');
      await expect(sim.call(bob, 'cancelPayment', c.id)).rejects.toThrow('not open');
      await sim.call(admin, 'setPaused', { deposit: true, transfer: true, swap: true, withdraw: true });
      const remaining = note(usdc, 60n, bob);
      const refund = note(usdc, 40n, alice);
      await sim.call(bob, 'refundPayment', c.id, c.merchant, sim.notePath(c.merchant),
        40n, pk(alice), c.refundNonce, refund.nonce, remaining.nonce);
      expect(sim.hasNote(refund)).toBe(true);
      expect(sim.ledger().payments.lookup(c.id).refundedAmount).toBe(40n);
      await expect(sim.call(bob, 'refundPayment', c.id, remaining, sim.notePath(remaining),
        61n, pk(alice), c.refundNonce, rand(), rand())).rejects.toThrow('refund amount');
      await sim.call(bob, 'refundPayment', c.id, remaining, sim.notePath(remaining),
        60n, pk(alice), c.refundNonce, rand(), rand());
      expect(sim.ledger().payments.lookup(c.id).refundedAmount).toBe(100n);
      await expect(sim.call(bob, 'refundPayment', c.id, remaining, sim.notePath(remaining),
        1n, pk(alice), c.refundNonce, rand(), rand())).rejects.toThrow('not refundable');
    });
    it('rejects refund theft and non-merchant authorization', async () => {
      const c = await checkout();
      await c.pay();
      await expect(sim.call(bob, 'refundPayment', c.id, c.merchant, sim.notePath(c.merchant),
        10n, pk(mallory), c.refundNonce, rand(), rand())).rejects.toThrow('refund recipient');
      await expect(sim.call(mallory, 'refundPayment', c.id, c.merchant, sim.notePath(c.merchant),
        10n, pk(alice), c.refundNonce, rand(), rand())).rejects.toThrow('not merchant');
    });
    it('enforces expiry, merchant cancellation, pause and exact asset', async () => {
      const c = await checkout();
      await expect(sim.call(mallory, 'cancelPayment', c.id)).rejects.toThrow('not merchant');
      const wrong = await deposit(jpyc, 150n, alice);
      await expect(sim.call(alice, 'payPayment', c.id, wrong, sim.notePath(wrong),
        rand(), rand(), rand())).rejects.toThrow('payment input');
      sim.time += 60;
      await expect(c.pay()).rejects.toThrow('expired');
      await sim.call(bob, 'cancelPayment', c.id);
      await expect(c.pay()).rejects.toThrow('not open');
    });
    it('rejects duplicate IDs, zero amounts and paused payment', async () => {
      const nonce = rand();
      await sim.call(bob, 'createPayment', usdc, 100n, BigInt(sim.time + 60), nonce);
      await expect(sim.call(bob, 'createPayment', usdc, 100n, BigInt(sim.time + 60), nonce))
        .rejects.toThrow('payment exists');
      await expect(sim.call(bob, 'createPayment', usdc, 0n, BigInt(sim.time + 60), rand()))
        .rejects.toThrow('zero payment');
      const c = await checkout();
      await sim.call(admin, 'setPaused', { deposit: false, transfer: true, swap: false, withdraw: false });
      await expect(c.pay()).rejects.toThrow('paused');
      await sim.call(bob, 'cancelPayment', c.id);
    });
  });

  describe('registry & governance', () => {
    it('derives assetId from source identity and registers assets disabled by default', async () => {
      expect(usdc).toEqual(pureCircuits.assetIdOf(identity('USDC')));
      const xsgd = await sim.call(
        admin, 'registerAsset', identity('XSGD'), Representation.unshieldedReserve, ZERO,
        encodeRawTokenType(sampleRawTokenType()), 6n, CAP,
      );
      const cfg = sim.ledger().assets.lookup(xsgd);
      expect(cfg.depositEnabled || cfg.swapEnabled || cfg.withdrawEnabled).toBe(false);
      expect(cfg.swapSlot).toBe(2n);
      expect(sim.ledger().assetSupply.lookup(xsgd)).toBe(0n);
    });

    it('treats the same symbol from another bridge / version as a different asset', async () => {
      const bridged = await sim.call(
        admin, 'registerAsset', { ...identity('USDC'), assetVersion: 2n }, Representation.unshieldedReserve,
        ZERO, encodeRawTokenType(sampleRawTokenType()), 6n, CAP,
      );
      expect(bridged).not.toEqual(usdc);
      await expect(
        sim.call(admin, 'registerAsset', identity('USDC'), Representation.unshieldedReserve, ZERO, usdcColor, 6n, CAP),
      ).rejects.toThrow(/asset already registered/);
    });

    it('rejects governance calls without the admin secret', async () => {
      await expect(
        sim.call(mallory, 'registerAsset', identity('EVIL'), Representation.unshieldedReserve, ZERO, usdcColor, 6n, CAP),
      ).rejects.toThrow(/not admin/);
      await expect(
        sim.call(mallory, 'setPaused', { deposit: true, transfer: true, swap: true, withdraw: true }),
      ).rejects.toThrow(/not admin/);
      await expect(
        sim.call(mallory, 'scheduleTreasuryRotation', pk(mallory), ecMulGenerator(1n), BigInt(sim.time) + DELAY),
      ).rejects.toThrow(/not admin/);
    });

    it('applies treasury rotation only after the governance delay and bumps the config version', async () => {
      const newView = ecMulGenerator(jubjubSampleScalar());
      await expect(
        sim.call(admin, 'scheduleTreasuryRotation', pk(bob), newView, BigInt(sim.time) + DELAY - 1n),
      ).rejects.toThrow(/governance delay/);

      const effectiveAt = BigInt(sim.time) + DELAY;
      await sim.call(admin, 'scheduleTreasuryRotation', pk(bob), newView, effectiveAt);
      expect(sim.ledger().pendingUpdate.kind).toBe(UpdateKind.rotateTreasury);
      await expect(sim.call(bob, 'applyPendingUpdate')).rejects.toThrow(/not yet effective/);

      sim.time = Number(effectiveAt);
      await sim.call(bob, 'applyPendingUpdate');
      expect(sim.ledger().treasuryOwnerPk).toEqual(pk(bob));
      expect(sim.ledger().treasuryConfigVersion).toBe(2n);
      expect(sim.ledger().pendingUpdate.kind).toBe(UpdateKind.none);
    });

    it('rejects an insecure all-zero admin secret and does not overwrite a pending update', async () => {
      await expect(
        GoPaySimulator.deploy(admin, pureCircuits.adminCommitmentOf(ZERO), pk(treasury), ecMulGenerator(1n), DELAY),
      ).rejects.toThrow(/insecure admin commitment/);
      await expect(
        GoPaySimulator.deploy(admin, pureCircuits.adminCommitmentOf(admin.adminSecret), pk(treasury), ecMulGenerator(1n), 0n),
      ).rejects.toThrow(/governance delay must be positive/);

      const effectiveAt = BigInt(sim.time) + DELAY;
      await sim.call(admin, 'scheduleTreasuryRotation', pk(bob), ecMulGenerator(2n), effectiveAt);
      await expect(
        sim.call(admin, 'scheduleTreasuryRotation', pk(mallory), ecMulGenerator(3n), effectiveAt),
      ).rejects.toThrow(/another update is pending/);
      await sim.call(admin, 'cancelPendingUpdate');
      await sim.call(admin, 'scheduleTreasuryRotation', pk(mallory), ecMulGenerator(3n), effectiveAt);
    });

    it('rotates the admin through the timelock', async () => {
      const newAdmin = createPrivateState(rand(), { adminSecret: rand() });
      const effectiveAt = BigInt(sim.time) + DELAY;
      await sim.call(admin, 'scheduleAdminRotation', pureCircuits.adminCommitmentOf(newAdmin.adminSecret), effectiveAt);
      sim.time = Number(effectiveAt);
      await sim.call(alice, 'applyPendingUpdate');
      await expect(sim.call(admin, 'setPaused', { deposit: true, transfer: false, swap: false, withdraw: false }))
        .rejects.toThrow(/not admin/);
      await sim.call(newAdmin, 'setPaused', { deposit: true, transfer: false, swap: false, withdraw: false });
      expect(sim.ledger().paused.deposit).toBe(true);
    });
  });

  // ───────────────────────── Vault & private transfer ─────────────────────────

  describe('unshielded reserve vault & private notes', () => {
    it('deposits create a hidden note and track outstanding supply against the cap', async () => {
      await deposit(usdc, 1_000_000_000n, alice);
      expect(sim.ledger().assetSupply.lookup(usdc)).toBe(1_000_000_000n);

      await sim.call(admin, 'setAssetOperations', usdc, true, true, true, 1_500_000_000n);
      await expect(deposit(usdc, 600_000_000n, alice)).rejects.toThrow(/deposit cap exceeded/);
    });

    it('rejects deposits when the asset or global deposit switch is off', async () => {
      await sim.call(admin, 'setAssetOperations', usdc, false, true, true, CAP);
      await expect(deposit(usdc, 1n, alice)).rejects.toThrow(/asset deposits disabled/);
      await sim.call(admin, 'setAssetOperations', usdc, true, true, true, CAP);
      await sim.call(admin, 'setPaused', { deposit: true, transfer: false, swap: false, withdraw: false });
      await expect(deposit(usdc, 1n, alice)).rejects.toThrow(/deposits paused/);
    });

    it('transfers privately and prevents double spending', async () => {
      const input = await deposit(usdc, 100n, alice);
      const toBob = note(usdc, 30n, bob);
      const change = note(usdc, 70n, alice);
      await sim.call(alice, 'transfer', input, sim.notePath(input), toBob.ownerPk, 30n, toBob.nonce, change.nonce);

      expect(sim.hasNote(toBob)).toBe(true);
      expect(sim.hasNote(change)).toBe(true);
      expect(sim.ledger().spentNullifiers.member(sim.noteNullifier(alice.localSecret, input))).toBe(true);

      await expect(
        sim.call(alice, 'transfer', input, sim.notePath(input), pk(bob), 1n, rand(), rand()),
      ).rejects.toThrow(/note already spent/);
    });

    it('rejects spending another owner\'s note, tampered notes and overspending', async () => {
      const input = await deposit(usdc, 100n, alice);
      await expect(
        sim.call(bob, 'transfer', input, sim.notePath(input), pk(bob), 100n, rand(), rand()),
      ).rejects.toThrow(/not note owner/);
      await expect(
        sim.call(alice, 'transfer', { ...input, amount: 1_000n }, sim.notePath(input), pk(bob), 1_000n, rand(), rand()),
      ).rejects.toThrow(/note\/path mismatch/);
      await expect(
        sim.call(alice, 'transfer', input, sim.notePath(input), pk(bob), 101n, rand(), rand()),
      ).rejects.toThrow(/insufficient note amount/);
    });

    it('rejects zero-amount transfers (note tree spam)', async () => {
      const input = await deposit(usdc, 100n, alice);
      await expect(
        sim.call(alice, 'transfer', input, sim.notePath(input), pk(bob), 0n, rand(), rand()),
      ).rejects.toThrow(/zero transfer/);
    });

    it('a payment that reuses an existing note nonce does not invalidate that note', async () => {
      const held = await deposit(usdc, 100n, alice);
      const payer = await deposit(usdc, 50n, bob);
      // bob 以与 alice 已有 Note 相同的随机数向 alice 付款
      await sim.call(bob, 'transfer', payer, sim.notePath(payer), pk(alice), 50n, held.nonce, rand());
      const received: Note = { ...held, amount: 50n };
      await sim.call(alice, 'transfer', received, sim.notePath(received), pk(bob), 50n, rand(), rand());
      await sim.call(alice, 'transfer', held, sim.notePath(held), pk(bob), 100n, rand(), rand());
    });

    it('merges two notes of the same asset only', async () => {
      const a = await deposit(usdc, 40n, alice);
      const b = await deposit(usdc, 60n, alice);
      const j = await deposit(jpyc, 5n, alice);
      await expect(
        sim.call(alice, 'merge', a, sim.notePath(a), j, sim.notePath(j), rand()),
      ).rejects.toThrow(/asset mismatch/);
      const merged = note(usdc, 100n, alice);
      await sim.call(alice, 'merge', a, sim.notePath(a), b, sim.notePath(b), merged.nonce);
      expect(sim.hasNote(merged)).toBe(true);
    });

    it('withdraws to an unshielded address and returns change', async () => {
      const input = await deposit(usdc, 100n, alice);
      const change = note(usdc, 25n, alice);
      const to = { bytes: encodeUserAddress(sampleUserAddress()) };
      await sim.call(alice, 'withdrawUnshielded', usdc, 75n, to, input, sim.notePath(input), change.nonce);
      expect(sim.hasNote(change)).toBe(true);
      expect(sim.ledger().assetSupply.lookup(usdc)).toBe(25n);

      const other = await deposit(usdc, 10n, alice);
      await expect(
        sim.call(alice, 'withdrawUnshielded', jpyc, 10n, to, other, sim.notePath(other), rand()),
      ).rejects.toThrow(/asset mismatch/);
    });
  });

  // ───────────────────────── RFQ swap & fees ─────────────────────────

  describe('RFQ swap with fixed 50 bps platform fee', () => {
    it('settles 1,000 USDC → JPYC: user gets net output, maker gets 995 USDC, treasury gets 5 USDC', async () => {
      const input = 1_000_000_000n; // 1,000 USDC (6 decimals)
      const { fee, principal } = splitInput(input);
      expect(fee).toBe(5_000_000n);
      expect(principal).toBe(995_000_000n);
      const netOutput = 149_250n; // 995 × 150 JPYC

      const inventory = await deposit(jpyc, 1_000_000n, maker);
      const { order, change } = await placeOrder(makeOrder(input, netOutput), input + 123n);
      expect(sim.hasNote(change)).toBe(true);
      expect(change.amount).toBe(123n);

      const { makerChange, makerReceive } = await fill(order, inventory);

      const userOutput: Note = { assetId: jpyc, amount: netOutput, ownerPk: pk(alice), nonce: order.recipientNonce };
      expect(sim.hasNote(userOutput)).toBe(true);
      expect(sim.hasNote({ ...makerChange, amount: 1_000_000n - netOutput })).toBe(true);
      expect(sim.hasNote({ ...makerReceive, amount: principal })).toBe(true);
      expect(sim.ledger().orderNullifiers.member(sim.orderNullifier(order))).toBe(true);

      // 金库用查看私钥解密收据，恢复 5 USDC 手续费 Note 并可以花费
      const receipts = [...sim.ledger().feeReceipts];
      expect(receipts).toHaveLength(1);
      const [feeCm, receipt] = receipts[0];
      const { amount, nonce } = decryptFeeReceipt(receipt, treasuryViewSecret);
      expect(amount).toBe(5_000_000n);
      const feeNote: Note = { assetId: usdc, amount, ownerPk: pk(treasury), nonce };
      expect(sim.noteCommitment(feeNote)).toEqual(feeCm);

      const to = { bytes: encodeUserAddress(sampleUserAddress()) };
      await sim.call(treasury, 'withdrawUnshielded', usdc, amount, to, feeNote, sim.notePath(feeNote), rand());

      // 用户可以继续花费兑换得到的 JPYC
      await sim.call(alice, 'transfer', userOutput, sim.notePath(userOutput), pk(bob), 1n, rand(), rand());
    });

    it('rounds the fee up so small orders still pay', async () => {
      expect(computeFee(1n)).toBe(1n);
      expect(computeFee(199n)).toBe(1n);
      expect(computeFee(200n)).toBe(1n);
      expect(computeFee(201n)).toBe(2n);

      const inventory = await deposit(jpyc, 1_000n, maker);
      const { order } = await placeOrder(makeOrder(201n, 30n));
      const { fee } = await fill(order, inventory);
      expect(fee).toBe(2n);
    });

    it('rejects a zero principal (input of 1 unit is consumed entirely by the fee)', async () => {
      const inventory = await deposit(jpyc, 1_000n, maker);
      const { order } = await placeOrder(makeOrder(1n, 1n));
      await expect(fill(order, inventory)).rejects.toThrow(/zero swap principal/);
    });

    it('rejects forged fees: zero, floor-rounded, or inflated', async () => {
      const inventory = await deposit(jpyc, 1_000_000n, maker);
      const { order } = await placeOrder(makeOrder(201n, 30n));
      for (const fee of [0n, 1n, 3n]) {
        await expect(fill(order, inventory, { fee })).rejects.toThrow(/fee must be ceil/);
      }
    });

    it('only the quoted maker can fill, and the fill needs enough inventory of the output asset', async () => {
      const { order } = await placeOrder(makeOrder(10_000n, 1_500n));
      const bobInventory = await deposit(jpyc, 1_000_000n, bob);
      await expect(fill(order, bobInventory, { caller: bob })).rejects.toThrow(/not the quoted maker/);

      const small = await deposit(jpyc, 1_000n, maker);
      await expect(fill(order, small)).rejects.toThrow(/insufficient inventory/);

      const wrongAsset = await deposit(usdc, 1_000_000n, maker);
      await expect(fill(order, wrongAsset)).rejects.toThrow(/maker asset mismatch/);
    });

    it('cannot fill the same order twice', async () => {
      const inv1 = await deposit(jpyc, 1_000_000n, maker);
      const inv2 = await deposit(jpyc, 1_000_000n, maker);
      const { order } = await placeOrder(makeOrder(10_000n, 1_500n));
      await fill(order, inv1);
      await expect(fill(order, inv2)).rejects.toThrow(/already filled or cancelled/);
    });

    it('fill and cancel are mutually exclusive', async () => {
      const inventory = await deposit(jpyc, 1_000_000n, maker);
      const { order } = await placeOrder(makeOrder(10_000n, 1_500n));
      const refund = note(usdc, 10_000n, alice);
      await sim.call(alice, 'cancelOrder', order, sim.orderPath(order), refund.nonce);
      expect(sim.hasNote(refund)).toBe(true);
      await expect(fill(order, inventory)).rejects.toThrow(/already filled or cancelled/);

      const { order: order2 } = await placeOrder(makeOrder(10_000n, 1_500n));
      await fill(order2, inventory);
      await expect(
        sim.call(alice, 'cancelOrder', order2, sim.orderPath(order2), rand()),
      ).rejects.toThrow(/already filled or cancelled/);
    });

    it('a party that knows the orderNonce cannot burn the victim order nullifier', async () => {
      const inventory = await deposit(jpyc, 1_000_000n, maker);
      const { order } = await placeOrder(makeOrder(1_000_000n, 150_000n));
      // 做市商复用受害者的 orderNonce 创建并撤销自己的小额订单
      const makerFunds = await deposit(usdc, 2n, maker);
      const griefOrder = makeOrder(2n, 1n, { ownerPk: pk(maker), recipientPk: pk(maker), orderNonce: order.orderNonce });
      await sim.call(maker, 'createOrder', makerFunds, sim.notePath(makerFunds), griefOrder, rand());
      await sim.call(maker, 'cancelOrder', griefOrder, sim.orderPath(griefOrder), rand());
      // 受害者订单仍可成交
      await fill(order, inventory);
    });

    it('rejects the identity point as the fee receipt ephemeral key', async () => {
      const inventory = await deposit(jpyc, 1_000_000n, maker);
      const { order } = await placeOrder(makeOrder(10_000n, 1_500n));
      await expect(
        sim.call(maker, 'fillOrder', order, sim.orderPath(order), inventory, sim.notePath(inventory),
          computeFee(10_000n), rand(), rand(), sim.swapAssetPath(usdc), sim.swapAssetPath(jpyc), 0n),
      ).rejects.toThrow(/invalid ephemeral key/);
    });

    it('only the order owner can cancel', async () => {
      const { order } = await placeOrder(makeOrder(10_000n, 1_500n));
      await expect(
        sim.call(maker, 'cancelOrder', order, sim.orderPath(order), rand()),
      ).rejects.toThrow(/not order owner/);
    });

    it('rejects expired orders using block time, but still allows cancel', async () => {
      const inventory = await deposit(jpyc, 1_000_000n, maker);
      const { order } = await placeOrder(makeOrder(10_000n, 1_500n));
      sim.time = Number(order.expiry);
      await expect(fill(order, inventory)).rejects.toThrow(/order expired/);
      await sim.call(alice, 'cancelOrder', order, sim.orderPath(order), rand());
    });

    it('rejects tampered orders (e.g. maker swaps the recipient)', async () => {
      const inventory = await deposit(jpyc, 1_000_000n, maker);
      const { order } = await placeOrder(makeOrder(10_000n, 1_500n));
      const path = sim.orderPath(order);
      const tampered = { ...order, recipientPk: pk(maker) };
      await expect(
        sim.call(maker, 'fillOrder', tampered, path, inventory, sim.notePath(inventory), computeFee(10_000n),
          rand(), rand(), sim.swapAssetPath(usdc), sim.swapAssetPath(jpyc), jubjubSampleScalar()),
      ).rejects.toThrow(/order\/path mismatch/);
    });

    it('rejects orders bound to a stale treasury config version', async () => {
      const inventory = await deposit(jpyc, 1_000_000n, maker);
      await expect(placeOrder(makeOrder(10_000n, 1_500n, { treasuryConfigVersion: 99n })))
        .rejects.toThrow(/stale treasury config/);
      const { order } = await placeOrder(makeOrder(10_000n, 1_500n, { expiry: BigInt(sim.time + 10000) }));
      const effectiveAt = BigInt(sim.time) + DELAY;
      await sim.call(admin, 'scheduleTreasuryRotation', pk(treasury), ecMulGenerator(treasuryViewSecret), effectiveAt);
      sim.time = Number(effectiveAt);
      await sim.call(admin, 'applyPendingUpdate');
      await expect(fill(order, inventory)).rejects.toThrow(/stale treasury config/);
    });

    it('rejects swaps when either asset is not tradable, without blocking cancel', async () => {
      const inventory = await deposit(jpyc, 1_000_000n, maker);
      const { order } = await placeOrder(makeOrder(10_000n, 1_500n));
      const oldJpycPath = sim.swapAssetPath(jpyc);
      await sim.call(admin, 'setAssetOperations', jpyc, true, false, true, CAP);
      expect(() => sim.swapAssetPath(jpyc)).toThrow(/not in the tradable set/);
      await expect(
        sim.call(maker, 'fillOrder', order, sim.orderPath(order), inventory, sim.notePath(inventory),
          computeFee(10_000n), rand(), rand(), sim.swapAssetPath(usdc), oldJpycPath, jubjubSampleScalar()),
      ).rejects.toThrow(/asset not tradable/);
      await sim.call(alice, 'cancelOrder', order, sim.orderPath(order), rand());
    });

    it('pausing swaps blocks new orders and fills but not cancellation', async () => {
      const inventory = await deposit(jpyc, 1_000_000n, maker);
      const { order } = await placeOrder(makeOrder(10_000n, 1_500n));
      await sim.call(admin, 'setPaused', { deposit: false, transfer: false, swap: true, withdraw: false });
      await expect(fill(order, inventory)).rejects.toThrow(/swaps paused/);
      await expect(placeOrder(makeOrder(10_000n, 1_500n))).rejects.toThrow(/swaps paused/);
      await sim.call(alice, 'cancelOrder', order, sim.orderPath(order), rand());
    });

    it('rejects same-asset swaps and zero net output at order creation', async () => {
      await expect(placeOrder(makeOrder(10_000n, 1_500n, { outputAssetId: usdc }))).rejects.toThrow(/same-asset swap/);
      await expect(placeOrder(makeOrder(10_000n, 0n))).rejects.toThrow(/zero amount/);
    });
  });

  // ───────────────────────── Bridge adapter ─────────────────────────

  describe('bridge adapter mint & redemption', () => {
    const adapterId = text32('eth-usdc-bridge');
    let gpUsdc: Uint8Array;
    const ethIdentity = identity('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', 'ethereum');

    beforeEach(async () => {
      await sim.call(admin, 'registerAdapter', adapterId, pureCircuits.adapterCommitmentOf(adapterOperator.adapterSecret), 1n);
      gpUsdc = await sim.call(admin, 'registerAsset', ethIdentity, Representation.bridgeAdapter, adapterId, ZERO, 6n, CAP);
      await sim.call(admin, 'setAssetOperations', gpUsdc, true, true, true, CAP);
    });

    const evidenceFor = (recipient: Note, overrides = {}) => ({
      sourceChain: ethIdentity.sourceChain,
      sourceToken: ethIdentity.sourceToken,
      uniqueDepositId: rand(),
      actualReceivedAmount: recipient.amount,
      destinationContract: sim.addressBytes,
      destinationAssetId: gpUsdc,
      recipientCommitment: sim.noteCommitment(recipient),
      adapterVersion: 1n,
      ...overrides,
    });

    const mint = async (recipient: Note, overrides = {}, caller = adapterOperator) => {
      const ev = evidenceFor(recipient, overrides);
      await sim.call(caller, 'adapterMint', gpUsdc, ev, recipient.ownerPk, recipient.nonce);
      return ev;
    };

    it('mints a note once per external deposit', async () => {
      const recipient = note(gpUsdc, 500n, alice);
      const ev = await mint(recipient);
      expect(sim.hasNote(recipient)).toBe(true);
      expect(sim.ledger().assetSupply.lookup(gpUsdc)).toBe(500n);

      const again = note(gpUsdc, 500n, alice);
      await expect(mint(again, { uniqueDepositId: ev.uniqueDepositId })).rejects.toThrow(/deposit already minted/);
    });

    it('rejects unauthorized adapters and evidence for another asset / contract / version', async () => {
      const r = note(gpUsdc, 1n, alice);
      await expect(mint(r, {}, mallory)).rejects.toThrow(/not adapter/);
      await expect(mint(r, { destinationAssetId: usdc })).rejects.toThrow(/evidence for another asset/);
      await expect(mint(r, { destinationContract: rand() })).rejects.toThrow(/wrong destination contract/);
      await expect(mint(r, { adapterVersion: 2n })).rejects.toThrow(/stale adapter version/);
      await expect(mint(r, { sourceChain: text32('bsc') })).rejects.toThrow(/wrong source chain/);
      await expect(mint(r, { recipientCommitment: rand() })).rejects.toThrow(/recipient commitment mismatch/);
      await expect(
        sim.call(adapterOperator, 'adapterMint', usdc, evidenceFor(r, { destinationAssetId: usdc }), r.ownerPk, r.nonce),
      ).rejects.toThrow(/not a bridge asset/);

      await sim.call(admin, 'setAdapterEnabled', adapterId, false);
      await expect(mint(r)).rejects.toThrow(/adapter disabled/);
    });

    it('redeems through an async request that the adapter completes', async () => {
      const held = note(gpUsdc, 500n, alice);
      await mint(held);
      const change = note(gpUsdc, 200n, alice);
      const rid = await sim.call(
        alice, 'requestRedemption', gpUsdc, 300n, rand(), held, sim.notePath(held), change.nonce, rand(),
      );
      expect(sim.hasNote(change)).toBe(true);
      expect(sim.ledger().redemptions.lookup(rid).status).toBe(RedemptionStatus.pending);
      expect(sim.ledger().assetSupply.lookup(gpUsdc)).toBe(200n);

      await expect(sim.call(mallory, 'completeRedemption', rid, rand())).rejects.toThrow(/not adapter/);
      await sim.call(adapterOperator, 'completeRedemption', rid, text32('0xpayout'));
      expect(sim.ledger().redemptions.lookup(rid).status).toBe(RedemptionStatus.completed);
      await expect(sim.call(adapterOperator, 'refundRedemption', rid)).rejects.toThrow(/not pending/);
    });

    it('restores the pre-committed refund note when the adapter confirms no payout', async () => {
      const held = note(gpUsdc, 500n, alice);
      await mint(held);
      const refund = note(gpUsdc, 500n, alice);
      const rid = await sim.call(
        alice, 'requestRedemption', gpUsdc, 500n, rand(), held, sim.notePath(held), rand(), refund.nonce,
      );
      await sim.call(adapterOperator, 'refundRedemption', rid);
      expect(sim.hasNote(refund)).toBe(true);
      expect(sim.ledger().assetSupply.lookup(gpUsdc)).toBe(500n);
      await expect(sim.call(adapterOperator, 'completeRedemption', rid, rand())).rejects.toThrow(/not pending/);
    });

    it('a disabled adapter cannot mint but can still settle pending redemptions', async () => {
      const held = note(gpUsdc, 500n, alice);
      await mint(held);
      const rid = await sim.call(alice, 'requestRedemption', gpUsdc, 500n, rand(), held, sim.notePath(held), rand(), rand());
      await sim.call(admin, 'setAdapterEnabled', adapterId, false);
      await expect(mint(note(gpUsdc, 1n, alice))).rejects.toThrow(/adapter disabled/);
      await sim.call(adapterOperator, 'completeRedemption', rid, rand());
    });

    it('rotates a compromised adapter key through the timelock', async () => {
      const newOperator = createPrivateState(rand(), { adapterSecret: rand() });
      const effectiveAt = BigInt(sim.time) + DELAY;
      await sim.call(admin, 'scheduleAdapterRotation', adapterId,
        pureCircuits.adapterCommitmentOf(newOperator.adapterSecret), 2n, effectiveAt);
      sim.time = Number(effectiveAt);
      await sim.call(alice, 'applyPendingUpdate');
      expect(sim.ledger().adapters.lookup(adapterId).adapterVersion).toBe(2n);

      const r = note(gpUsdc, 10n, alice);
      await expect(mint(r, { adapterVersion: 2n })).rejects.toThrow(/not adapter/);
      await mint(r, { adapterVersion: 2n }, newOperator);
      expect(sim.hasNote(r)).toBe(true);
    });

    it('bridged assets swap through the same core without code changes', async () => {
      const inventory = await deposit(jpyc, 1_000_000n, maker);
      const held = note(gpUsdc, 20_000n, alice);
      await mint(held);
      const order = makeOrder(20_000n, 2_985n, { inputAssetId: gpUsdc });
      await sim.call(alice, 'createOrder', held, sim.notePath(held), order, rand());
      await fill(order, inventory);
      const out: Note = { assetId: jpyc, amount: 2_985n, ownerPk: pk(alice), nonce: order.recipientNonce };
      expect(sim.hasNote(out)).toBe(true);
    });
  });
});
