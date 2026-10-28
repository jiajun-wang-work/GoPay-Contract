import { describe, expect, it } from 'vitest';
import { ShieldedCoinPublicKey, ShieldedEncryptionPublicKey } from '@midnight-ntwrk/wallet-sdk-address-format';
import { normalizeWalletKeys } from '../scripts/wallet-keys.mjs';
const coin = '11'.repeat(32);
const encryption = '22'.repeat(32);
const encode = (network: string) => ({
  coin: ShieldedCoinPublicKey.codec.encode(network, ShieldedCoinPublicKey.fromHexString(coin)).asString(),
  encryption: ShieldedEncryptionPublicKey.codec.encode(network, ShieldedEncryptionPublicKey.fromHexString(encryption)).asString(),
});
describe('Gero connector public keys', () => {
  it('decodes API v4 Preprod Bech32m keys to ledger hex', () => {
    const keys = encode('preprod');
    expect(normalizeWalletKeys(keys.coin, keys.encryption)).toEqual({ coinPublicKey: coin, encryptionPublicKey: encryption });
  });
  it('rejects another network and swapped key types', () => {
    const keys = encode('preview');
    expect(() => normalizeWalletKeys(keys.coin, keys.encryption)).toThrow('INVALID_WALLET_KEY');
    const correct = encode('preprod');
    expect(() => normalizeWalletKeys(correct.encryption, correct.coin)).toThrow('INVALID_WALLET_KEY');
  });
  it('decodes Preview keys only when Preview is selected', () => {
    const keys = encode('preview');
    expect(normalizeWalletKeys(keys.coin, keys.encryption, 'preview')).toEqual({ coinPublicKey: coin, encryptionPublicKey: encryption });
    const preprod = encode('preprod');
    expect(() => normalizeWalletKeys(preprod.coin, preprod.encryption, 'preview')).toThrow('INVALID_WALLET_KEY');
  });
  it('accepts legacy hex and rejects malformed keys', () => {
    expect(normalizeWalletKeys(coin, encryption)).toEqual({ coinPublicKey: coin, encryptionPublicKey: encryption });
    expect(() => normalizeWalletKeys('invalid', encryption)).toThrow('INVALID_WALLET_KEY');
  });
});
