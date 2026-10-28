import { createServer } from 'node:http';
import { partialDeploy, insertBatch, checkFees, BATCH_SIZE } from './phased-deploy.mjs';
import { normalizeWalletKeys } from './wallet-keys.mjs';
import { parseAssetAction, describeAssets } from './asset-admin.mjs';
import { networkConfig } from './networks.mjs';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile, mkdir, access, rename } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { CompiledContract } from '@midnight-ntwrk/midnight-js-protocol/compact-js';
import { createUnprovenDeployTx, createUnprovenCallTxFromInitialStates } from '@midnight-ntwrk/midnight-js-contracts';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
import { ecMulGenerator, sampleSigningKey, ContractState } from '@midnight-ntwrk/compact-runtime';
import { Transaction, ContractState as LedgerContractState, LedgerParameters, ZswapChainState } from '@midnight-ntwrk/midnight-js-protocol/ledger';

// Usage: node scripts/deploy-server.mjs <preprod|preview>. Each network has its own state directory, secrets and port.
const network = networkConfig(process.argv[2]);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const stateDir = resolve(root, network.stateDir);
const host = `127.0.0.1:${network.port}`;
const origin = `http://${host}`;
const csrf = randomBytes(32).toString('hex');
const proofUrl = 'http://127.0.0.1:6301';
setNetworkId(network.name);
const info = JSON.parse(await readFile(resolve(root, 'src/managed/gopay/compiler/contract-info.json')));
if (info['compiler-version'] !== '0.31.1' || info['runtime-version'] !== '0.16.0') throw new Error('Ledger 8 compile required');
const { Contract, pureCircuits, ledger } = await import('../src/managed/gopay/contract/index.js');
const witnesses = Object.fromEntries(['localSecret', 'adminSecret', 'adapterSecret'].map(k => [k, ({ privateState }) => [privateState, privateState[k]]]));
const compiled = CompiledContract.withCompiledFileAssets(CompiledContract.withWitnesses(CompiledContract.make('gopay', Contract), witnesses), resolve(root, 'src/managed/gopay'));
const zk = new NodeZkConfigProvider(resolve(root, 'src/managed/gopay'));
for (const circuit of info.circuits.filter(c => c.proof)) {
  const bytes = await zk.getVerifierKey(circuit.name);
  if (!bytes.length) throw new Error('Empty verifier key');
}
await mkdir(stateDir, { recursive: true, mode: 0o700 });
const secretPath = resolve(stateDir, `${network.name}-secrets.json`);
let secrets;
try { secrets = JSON.parse(await readFile(secretPath, 'utf8')); }
catch (error) {
  if (error.code !== 'ENOENT') throw error;
  secrets = { localSecret: randomBytes(32).toString('hex'), adminSecret: randomBytes(32).toString('hex'),
    treasuryOwnerSecret: randomBytes(32).toString('hex'),
    treasuryViewSecret: (BigInt('0x' + randomBytes(31).toString('hex')) || 1n).toString(),
    maintenanceSigningKey: sampleSigningKey(), delaySeconds: '3600' };
  await writeFile(secretPath, JSON.stringify(secrets), { flag: 'wx', mode: 0o600 });
}
const bytes = h => new Uint8Array(Buffer.from(h, 'hex'));
const privateState = { localSecret: bytes(secrets.localSecret), adminSecret: bytes(secrets.adminSecret), adapterSecret: new Uint8Array(32) };
const admin = pureCircuits.adminCommitmentOf(privateState.adminSecret);
const treasury = pureCircuits.ownerPkOf(bytes(secrets.treasuryOwnerSecret));
const viewKey = ecMulGenerator(BigInt(secrets.treasuryViewSecret));
const recordPath = resolve(stateDir, `${network.name}-deployment.json`);
let pending = null;
try { pending = JSON.parse(await readFile(recordPath, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
if (pending && pending.network !== network.name) throw new Error('Deployment record belongs to another network');
let busy = false;
// Blockfrost networks read only the selected endpoint token; never print credential-bearing URLs.
let projectId = null;
if (network.blockfrost) {
  const envPath = process.env.GOPAY_DEPLOY_ENV_FILE || resolve(root, '../GoPay-Payment/.env');
  const env = await readFile(envPath, 'utf8');
  const tokenLine = env.split('\n').find(l => /^PAYMENT_BLOCKFROST_PROJECT_ID\s*=/.test(l));
  projectId = process.env.GOPAY_BLOCKFROST_PROJECT_ID || tokenLine?.split('=').slice(1).join('=').trim().replace(/^['"]|['"]$/g, '');
  if (!projectId) throw new Error(`Missing ${network.label} Blockfrost token`);
}
const indexer = new URL(network.indexer);
if (projectId) indexer.searchParams.set('project_id', projectId);
// Write-then-rename so stopping the service mid-save never leaves a truncated deployment record.
const save = async () => {
  const temporary = `${recordPath}.tmp`;
  await writeFile(temporary, JSON.stringify(pending, null, 2), { mode: 0o600 });
  await rename(temporary, recordPath);
};
const publicRecord = () => pending && ({ contractAddress: pending.contractAddress, status: pending.status, txId: pending.txId,
  transactionBytes: pending.transactionBytes, installedCircuits: pending.installedCircuits, totalCircuits: 29, batchCircuits: pending.batchCircuits, tx: pending.status === 'prepared' ? pending.tx : undefined, network: network.name, ledgerVersion: 8 });
async function query(query, variables = {}) {
  const response = await fetch(indexer, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }), signal: AbortSignal.timeout(20000) });
  const data = await response.json();
  if (!response.ok || data.errors?.length) throw new Error('INDEXER_UNAVAILABLE');
  return data.data;
}
async function chainState(address) {
  const result = await query('query($address: HexEncoded!) { contractAction(address: $address) { state } }', { address });
  return result?.contractAction?.state ? LedgerContractState.deserialize(bytes(result.contractAction.state)) : null;
}
async function parameters() {
  const result = await query('{ block { ledgerParameters } }');
  return LedgerParameters.deserialize(bytes(result.block.ledgerParameters));
}
// Migrate only an unsubmitted legacy deployment after independently checking the chain.
if (pending && !pending.phased && pending.status === 'prepared') {
  if (await chainState(pending.contractAddress)) throw new Error('LEGACY_CONTRACT_ALREADY_ON_CHAIN');
  const old = Transaction.deserialize('signature', 'proof', 'pre-binding', bytes(pending.tx));
  const fullState = [...old.intents.values()][0].actions[0].initialState;
  await writeFile(resolve(stateDir, `${network.name}-deployment-before-phased.json`), JSON.stringify(pending), { flag: 'wx', mode: 0o600 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  const names = fullState.operations().sort().slice(0, BATCH_SIZE);
  const deployment = partialDeploy(fullState, names, network.name);
  const proven = await httpClientProofProvider(proofUrl, zk).proveTx(deployment.tx);
  checkFees(proven, await parameters());
  pending = { ...pending, phased: true, fullState: Buffer.from(fullState.serialize()).toString('hex'),
    contractAddress: deployment.address, batchCircuits: names, installedCircuits: 0,
    tx: Buffer.from(proven.serialize()).toString('hex'), transactionBytes: proven.serialize().length };
  await save();
}
// The page is shared by every network and bundled in memory, so concurrent network servers never overwrite each other.
const app = (await build({ entryPoints: [resolve(root, 'deploy-ui/main.tsx')], bundle: true, write: false, platform: 'browser', jsx: 'automatic', minify: true })).outputFiles[0].contents;
const send = (res, status, data) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)); };
const server = createServer(async (req, res) => {
  try {
    if (req.headers.host !== host) return send(res, 403, { error: 'LOCAL_ONLY' });
    const path = new URL(req.url, origin).pathname;
    if (req.method === 'GET' && path === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>GoPay | ${network.label}</title></head><body><div id="root"></div><script src="/app.js"></script></body></html>`);
    }
    if (req.method === 'GET' && path === '/app.js') {
      res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' }); return res.end(app);
    }
    if (req.method === 'GET' && path === '/config') return send(res, 200, { csrf, ...publicRecord(), network: network.name, networkLabel: network.label, stateDir: network.stateDir,
      adminCommitment: Buffer.from(admin).toString('hex'), treasuryOwnerPk: Buffer.from(treasury).toString('hex'), delaySeconds: secrets.delaySeconds });
    if (req.method !== 'POST' || req.headers.origin !== origin || req.headers['x-gopay-deploy'] !== csrf) return send(res, 403, { error: 'LOCAL_ONLY' });
    let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 2_000_000) return send(res, 413, { error: 'INVALID_REQUEST' }); }
    const data = JSON.parse(body || '{}');
    if (path === '/prepare') {
      if (pending?.status === 'ready') {
        const current = await chainState(pending.contractAddress);
        if (!current) throw new Error('STATE_MISMATCH');
        const full = LedgerContractState.deserialize(bytes(pending.fullState));
        const missing = full.operations().sort().filter(name => !current.operation(name));
        const names = missing.slice(0, BATCH_SIZE);
        if (!names.length) return send(res, 409, { error: 'INVALID_REQUEST' });
        const proven = await httpClientProofProvider(proofUrl, zk).proveTx(insertBatch(pending.contractAddress, current, full, names, secrets.maintenanceSigningKey, network.name));
        checkFees(proven, await parameters());
        pending.batchCircuits = names; pending.status = 'prepared'; pending.txId = null;
        pending.tx = Buffer.from(proven.serialize()).toString('hex'); pending.transactionBytes = proven.serialize().length;
        await save(); return send(res, 200, publicRecord());
      }
      if (pending) return send(res, 200, publicRecord());
      if (busy) return send(res, 409, { error: 'BUSY' });
      if (data.networkId !== network.name) return send(res, 400, { error: 'WRONG_NETWORK' });
      let walletKeys;
      try { walletKeys = normalizeWalletKeys(data.coinPublicKey, data.encryptionPublicKey, network.name); }
      catch { return send(res, 400, { error: 'INVALID_WALLET_KEY' }); }
      busy = true;
      try {
        const deployment = await createUnprovenDeployTx({ zkConfigProvider: zk, walletProvider: {
          getCoinPublicKey: () => walletKeys.coinPublicKey, getEncryptionPublicKey: () => walletKeys.encryptionPublicKey,
        } }, { compiledContract: compiled, initialPrivateState: privateState, signingKey: secrets.maintenanceSigningKey,
          args: [admin, treasury, viewKey, BigInt(secrets.delaySeconds)] });
        const proof = httpClientProofProvider(proofUrl, zk);
        const fullState = LedgerContractState.deserialize(deployment.public.initialContractState.serialize());
        const names = fullState.operations().sort().slice(0, BATCH_SIZE);
        const partial = partialDeploy(fullState, names, network.name);
        const proven = await proof.proveTx(partial.tx);
        checkFees(proven, await parameters());
        const tx = Buffer.from(proven.serialize()).toString('hex');
        pending = { phased: true, fullState: Buffer.from(fullState.serialize()).toString('hex'), batchCircuits: names, installedCircuits: 0, contractAddress: partial.address, network: network.name, ledgerVersion: 8,
          adminCommitment: Buffer.from(admin).toString('hex'), treasuryOwnerPk: Buffer.from(treasury).toString('hex'),
          walletAddress: data.walletAddress, status: 'prepared', transactionBytes: tx.length / 2, tx };
        await save(); return send(res, 200, { ...publicRecord(), tx });
      } finally { busy = false; }
    }
    // Administrator asset registration: the admin proof is built here from the local secret; 1AM only balances and submits.
    if (path === '/asset/list' || path === '/asset/prepare') {
      if (pending?.status !== 'confirmed') return send(res, 409, { error: 'CONTRACT_NOT_READY' });
      const result = await query('query($address: HexEncoded!) { contractAction(address: $address) { state } }', { address: pending.contractAddress });
      if (!result?.contractAction?.state) throw new Error('INDEXER_UNAVAILABLE');
      const runtimeState = ContractState.deserialize(bytes(result.contractAction.state));
      if (path === '/asset/list') return send(res, 200, { assets: describeAssets(ledger(runtimeState.data).assets) });
      if (busy) return send(res, 409, { error: 'BUSY' });
      const { circuitId, args, identity } = parseAssetAction(data.action, data.params);
      let walletKeys;
      try { walletKeys = normalizeWalletKeys(data.coinPublicKey, data.encryptionPublicKey, network.name); }
      catch { return send(res, 400, { error: 'INVALID_WALLET_KEY' }); }
      busy = true;
      try {
        const call = await createUnprovenCallTxFromInitialStates(zk, { compiledContract: compiled, circuitId, contractAddress: pending.contractAddress, args,
          coinPublicKey: walletKeys.coinPublicKey, initialContractState: runtimeState, initialZswapChainState: new ZswapChainState(),
          ledgerParameters: await parameters(), initialPrivateState: privateState }, walletKeys.encryptionPublicKey);
        const proven = await httpClientProofProvider(proofUrl, zk).proveTx(call.private.unprovenTx);
        checkFees(proven, await parameters());
        const tx = Buffer.from(proven.serialize()).toString('hex');
        return send(res, 200, { action: data.action, contractAddress: pending.contractAddress, transactionBytes: tx.length / 2, tx,
          assetId: identity ? Buffer.from(pureCircuits.assetIdOf(identity)).toString('hex') : undefined });
      } finally { busy = false; }
    }
    if (path === '/submitting') {
      if (!pending || pending.status !== 'prepared' || data.contractAddress !== pending.contractAddress || !/^[a-f0-9]+$/i.test(data.tx || '')) return send(res, 400, { error: 'INVALID_REQUEST' });
      const balanced = Transaction.deserialize('signature', 'proof', 'binding', bytes(data.tx));
      pending.txId = balanced.identifiers()[0] || null;
      pending.transactionHash = balanced.transactionHash();
      pending.status = 'submitted';
      await save();
      return send(res, 200, publicRecord());
    }
    if (path === '/submitted') {
      if (!pending || data.contractAddress !== pending.contractAddress) return send(res, 400, { error: 'INVALID_REQUEST' });
      if (pending.status !== 'confirmed') { pending.status = 'submitted'; pending.txId = data.txId || pending.txId || null; await save(); }
      return send(res, 200, publicRecord());
    }
    if (path === '/status') {
      if (!pending) return send(res, 200, { status: 'idle' });
      const result = await query('query($address: HexEncoded!) { contractAction(address: $address) { state } }', { address: pending.contractAddress });
      if (result?.contractAction?.state) {
        const state = ledger(ContractState.deserialize(bytes(result.contractAction.state)) .data);
        if (Buffer.from(state.adminCommitment).toString('hex') !== pending.adminCommitment || Buffer.from(state.treasuryOwnerPk).toString('hex') !== pending.treasuryOwnerPk || state.governanceDelay !== BigInt(secrets.delaySeconds)) throw new Error('STATE_MISMATCH');
        const current = LedgerContractState.deserialize(bytes(result.contractAction.state));
        const full = LedgerContractState.deserialize(bytes(pending.fullState));
        const names = full.operations();
        for (const name of names) {
          const operation = current.operation(name);
          if (operation && !Buffer.from(operation.verifierKey).equals(Buffer.from(full.operation(name).verifierKey))) throw new Error('STATE_MISMATCH');
        }
        pending.installedCircuits = names.filter(name => current.operation(name)).length;
        if (pending.batchCircuits.every(name => current.operation(name))) {
          pending.status = pending.installedCircuits === names.length ? 'confirmed' : 'ready';
          delete pending.tx;
        }
        await save();
      }
      return send(res, 200, publicRecord());
    }
    return send(res, 404, { error: 'NOT_FOUND' });
  } catch (error) {
    // Codes only: SDK errors can contain URLs carrying project tokens.
    const message = String(error?.message || error?.name || 'Error');
    console.error('Deployment request failed:', (projectId ? message.replaceAll(projectId, '[redacted]') : message).replace(/https?:\/\/[^\s]+/g, '[URL]'));
    send(res, 500, { error: ['INDEXER_UNAVAILABLE', 'STATE_MISMATCH', 'INVALID_REQUEST', 'CONTRACT_NOT_READY'].includes(error?.message) ? error.message : 'DEPLOY_FAILED' });
  }
});
const tip = await query('{ block { height } }');
console.log(`${network.label} indexer connected; indexed height:`, tip.block.height);
server.listen(network.port, '127.0.0.1', () => console.log(`GoPay 1AM deployment page (${network.label}): ${origin}`));
