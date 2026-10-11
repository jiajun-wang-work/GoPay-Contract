// Offline wallet identity only: builds and proves, never balances or submits.
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { setNetworkId } from '@midnight-ntwrk/midnight-js-network-id';
import { CompiledContract } from '@midnight-ntwrk/midnight-js-protocol/compact-js';
import { partialDeploy, insertBatch, checkFees, BATCH_SIZE } from './phased-deploy.mjs';
import { ZswapSecretKeys, ContractState, ContractMaintenanceAuthority } from '@midnight-ntwrk/midnight-js-protocol/ledger';
import { ecMulGenerator, sampleSigningKey } from '@midnight-ntwrk/compact-runtime';
import { createUnprovenDeployTx } from '@midnight-ntwrk/midnight-js-contracts';
import { NodeZkConfigProvider } from '@midnight-ntwrk/midnight-js-node-zk-config-provider';
import { httpClientProofProvider } from '@midnight-ntwrk/midnight-js-http-client-proof-provider';
const root = fileURLToPath(new URL('..', import.meta.url));
const path = resolve(root, 'src/managed/gopay');
const info = JSON.parse(await readFile(resolve(path, 'compiler/contract-info.json')));
if (info['compiler-version'] !== '0.31.1' || info['runtime-version'] !== '0.16.0') throw new Error('Ledger 8 compile required');
const { Contract, pureCircuits } = await import('../src/managed/gopay/contract/index.js');
setNetworkId('preprod');
const state = { localSecret: randomBytes(32), adminSecret: randomBytes(32), adapterSecret: new Uint8Array(32) };
const witnesses = Object.fromEntries(Object.keys(state).map(k => [k, ({ privateState }) => [privateState, privateState[k]]]));
const compiledContract = CompiledContract.withCompiledFileAssets(CompiledContract.withWitnesses(CompiledContract.make('gopay', Contract), witnesses), path);
const keys = ZswapSecretKeys.fromSeed(randomBytes(32));
try {
  const zkConfigProvider = new NodeZkConfigProvider(path);
  const signingKey = sampleSigningKey();
  const result = await createUnprovenDeployTx({ zkConfigProvider, walletProvider: {
    getCoinPublicKey: () => keys.coinPublicKey, getEncryptionPublicKey: () => keys.encryptionPublicKey,
  } }, { compiledContract, initialPrivateState: state, signingKey, args: [
    pureCircuits.adminCommitmentOf(state.adminSecret), pureCircuits.ownerPkOf(randomBytes(32)),
    ecMulGenerator(BigInt('0x' + randomBytes(31).toString('hex')) || 1n), 3600n,
  ] });
  const proven = await httpClientProofProvider('http://127.0.0.1:6301', zkConfigProvider).proveTx(result.private.unprovenTx);
  let oversizedRejected = false;
  try { checkFees(proven); } catch (error) { if (!error.message.includes('exceeded block limit')) throw error; oversizedRejected = true; }
  if (!oversizedRejected) throw new Error('Expected full deployment to exceed the initial ledger limits');
  const full = ContractState.deserialize(result.public.initialContractState.serialize());
  const names = full.operations().sort();
  const first = partialDeploy(full, names.slice(0, BATCH_SIZE));
  const proof = httpClientProofProvider('http://127.0.0.1:6301', zkConfigProvider);
  const batches = [];
  const firstProven = await proof.proveTx(first.tx);
  batches.push({ circuits: BATCH_SIZE, bytes: firstProven.serialize().length, ...checkFees(firstProven) });
  const simulated = [...first.tx.intents.values()][0].actions[0].initialState;
  for (let offset = BATCH_SIZE; offset < names.length; offset += BATCH_SIZE) {
    const batch = names.slice(offset, offset + BATCH_SIZE);
    const tx = await proof.proveTx(insertBatch(first.address, simulated, full, batch, signingKey));
    batches.push({ circuits: batch.length, bytes: tx.serialize().length, ...checkFees(tx) });
    for (const name of batch) simulated.setOperation(name, full.operation(name));
    const authority = simulated.maintenanceAuthority;
    simulated.maintenanceAuthority = new ContractMaintenanceAuthority(authority.committee, authority.threshold, authority.counter + 1n);
  }
  if (simulated.operations().length !== names.length) throw new Error('Incomplete circuit installation');
  console.log(JSON.stringify({ network: 'preprod', ledgerVersion: 8, circuits: info.circuits.filter(c=>c.proof).length,
    fullDeploymentExceedsLimits: oversizedRejected, batches, initialStateBytes: result.public.initialContractState.serialize().length,
    provenUnbalancedTransactionBytes: proven.serialize().length, submitted: false }, null, 2));
} finally { keys.clear(); }
