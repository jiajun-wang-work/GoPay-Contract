import { MidnightBech32m, ShieldedCoinPublicKey, ShieldedEncryptionPublicKey } from '@midnight-ntwrk/wallet-sdk-address-format';

/** Connector API v4 returns Bech32m keys; legacy hex keys remain accepted. */
export function normalizeWalletKeys(coinPublicKey, encryptionPublicKey, network = 'preprod') {
  const decode = (value, type) => {
    if (typeof value !== 'string') throw new Error('INVALID_WALLET_KEY');
    if (/^[a-f0-9]{64}$/i.test(value)) return value.toLowerCase();
    try { return type.codec.decode(network, MidnightBech32m.parse(value)).toHexString(); }
    catch { throw new Error('INVALID_WALLET_KEY'); }
  };
  return { coinPublicKey: decode(coinPublicKey, ShieldedCoinPublicKey),
    encryptionPublicKey: decode(encryptionPublicKey, ShieldedEncryptionPublicKey) };
}
