import { describe, expect, it } from 'vitest';
import { field32, parseAssetAction, label32 } from '../scripts/asset-admin.mjs';
const form = { sourceChain: 'midnight-preprod', sourceToken: 'NIGHT', issuerOrBridge: 'gopay', assetVersion: '1', representation: 'unshieldedReserve',
  adapterId: '', reserveColor: 'ab'.repeat(32), decimals: '6', depositCap: '1000000' };
describe('asset administration requests', () => {
  it('pads text and accepts raw hex for Bytes<32>', () => {
    expect(field32('NIGHT')).toHaveLength(32);
    expect(label32(field32('NIGHT'))).toBe('NIGHT');
    expect(Buffer.from(field32('ab'.repeat(32))).toString('hex')).toBe('ab'.repeat(32));
    expect(() => field32('x'.repeat(33))).toThrow('INVALID_REQUEST');
  });
  it('maps registerAsset arguments in contract order', () => {
    const { circuitId, args } = parseAssetAction('registerAsset', form);
    expect(circuitId).toBe('registerAsset');
    expect(args.slice(1, 2)).toEqual([0]);
    expect(args[4]).toBe(6n);
    expect(args[5]).toBe(1_000_000n);
    expect(Buffer.from(args[2] as Uint8Array)).toEqual(Buffer.alloc(32));
  });
  it('rejects overflow, unknown actions and malformed ids', () => {
    expect(() => parseAssetAction('registerAsset', { ...form, decimals: '256' })).toThrow('INVALID_REQUEST');
    expect(() => parseAssetAction('registerAsset', { ...form, depositCap: (1n << 128n).toString() })).toThrow('INVALID_REQUEST');
    expect(() => parseAssetAction('registerAsset', { ...form, representation: 'x' })).toThrow('INVALID_REQUEST');
    expect(() => parseAssetAction('setPaused', {})).toThrow('INVALID_REQUEST');
    expect(() => parseAssetAction('setAssetOperations', { assetId: '12', depositEnabled: true, swapEnabled: true, withdrawEnabled: true, depositCap: '0' })).toThrow('INVALID_REQUEST');
  });
});
