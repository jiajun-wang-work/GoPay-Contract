// Strict request parsing for the administrator-only asset circuits. Errors are codes, never SDK text.
const INVALID = 'INVALID_REQUEST';
const HEX32 = /^[a-f0-9]{64}$/i;
const UINT = /^(0|[1-9][0-9]*)$/;
const REPRESENTATIONS = { unshieldedReserve: 0, bridgeAdapter: 1 };
const ZERO = '0'.repeat(64);

/** Bytes<32> from 64 hex characters, or from UTF-8 text of at most 32 bytes, right-padded with zeros. */
export function field32(value) {
  if (typeof value !== 'string' || !value) throw new Error(INVALID);
  if (HEX32.test(value)) return new Uint8Array(Buffer.from(value, 'hex'));
  const text = Buffer.from(value, 'utf8');
  if (text.length > 32) throw new Error(INVALID);
  const out = new Uint8Array(32);
  out.set(text);
  return out;
}

const optional32 = value => (value === undefined || value === '' ? new Uint8Array(Buffer.from(ZERO, 'hex')) : field32(value));

function uint(value, bits) {
  if (typeof value !== 'string' || !UINT.test(value)) throw new Error(INVALID);
  const n = BigInt(value);
  if (n >= 1n << BigInt(bits)) throw new Error(INVALID);
  return n;
}

const flag = value => { if (typeof value !== 'boolean') throw new Error(INVALID); return value; };

/** Maps a whitelisted action to the circuit id and arguments (contract argument order). */
export function parseAssetAction(action, p) {
  if (!p || typeof p !== 'object') throw new Error(INVALID);
  if (action === 'registerAsset') {
    if (!Object.hasOwn(REPRESENTATIONS, p.representation)) throw new Error(INVALID);
    const identity = { sourceChain: field32(p.sourceChain), sourceToken: field32(p.sourceToken),
      issuerOrBridge: field32(p.issuerOrBridge), assetVersion: uint(p.assetVersion, 32) };
    return { circuitId: 'registerAsset', identity, args: [identity, REPRESENTATIONS[p.representation],
      optional32(p.adapterId), optional32(p.reserveColor), uint(p.decimals, 8), uint(p.depositCap, 128)] };
  }
  if (action === 'setAssetOperations') {
    if (typeof p.assetId !== 'string' || !HEX32.test(p.assetId)) throw new Error(INVALID);
    return { circuitId: 'setAssetOperations', args: [new Uint8Array(Buffer.from(p.assetId, 'hex')),
      flag(p.depositEnabled), flag(p.swapEnabled), flag(p.withdrawEnabled), uint(p.depositCap, 128)] };
  }
  throw new Error(INVALID);
}

const hex = bytes => Buffer.from(bytes).toString('hex');
/** Readable text when the 32 bytes are zero-padded printable ASCII, otherwise the hex string. */
export const label32 = bytes => {
  const end = bytes.findIndex(b => b === 0);
  const used = end === -1 ? bytes : bytes.slice(0, end);
  const rest = end === -1 ? [] : bytes.slice(end);
  return used.length && used.every(b => b >= 0x20 && b < 0x7f) && rest.every(b => b === 0) ? Buffer.from(used).toString('ascii') : hex(bytes);
};

/** JSON-safe view of the on-chain asset table. */
export function describeAssets(assets) {
  return [...assets].map(([id, c]) => ({ assetId: hex(id), sourceChain: label32(c.identity.sourceChain), sourceToken: label32(c.identity.sourceToken),
    issuerOrBridge: label32(c.identity.issuerOrBridge), assetVersion: c.identity.assetVersion.toString(),
    representation: c.representation === 0 ? 'unshieldedReserve' : 'bridgeAdapter', adapterId: hex(c.adapterId), reserveColor: hex(c.reserveColor),
    decimals: Number(c.decimals), depositCap: c.depositCap.toString(), depositEnabled: c.depositEnabled, swapEnabled: c.swapEnabled,
    withdrawEnabled: c.withdrawEnabled, swapSlot: c.swapSlot.toString(), configVersion: c.configVersion.toString() }));
}
