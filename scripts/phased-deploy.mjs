import { ContractState, ContractDeploy, Transaction, Intent, MaintenanceUpdate,
  VerifierKeyInsert, ContractOperationVersionedVerifierKey, signData, LedgerParameters } from '@midnight-ntwrk/midnight-js-protocol/ledger';

export const BATCH_SIZE = 5;
const ttl = () => new Date(Date.now() + 50 * 60_000);
// The network id is required: a transaction built for the wrong network is rejected only after the wallet signs it.
const networkId = network => { if (!network) throw new Error('Network id required'); return network; };
export function partialDeploy(fullState, names, network) {
  const state = new ContractState();
  state.data = fullState.data;
  state.balance = fullState.balance;
  state.maintenanceAuthority = fullState.maintenanceAuthority;
  for (const name of names) state.setOperation(name, fullState.operation(name));
  const deploy = new ContractDeploy(state);
  return { address: deploy.address, tx: Transaction.fromParts(networkId(network), undefined, undefined, Intent.new(ttl()).addDeploy(deploy)) };
}
export function insertBatch(address, chainState, fullState, names, signingKey, network) {
  const update = new MaintenanceUpdate(address, names.map(name => new VerifierKeyInsert(name,
    new ContractOperationVersionedVerifierKey('v3', fullState.operation(name).verifierKey))), chainState.maintenanceAuthority.counter);
  const signed = update.addSignature(0n, signData(signingKey, update.dataToSign));
  return Transaction.fromParts(networkId(network), undefined, undefined, Intent.new(ttl()).addMaintenanceUpdate(signed));
}
export function checkFees(tx, params = LedgerParameters.initialParameters()) {
  // Reject oversized work before asking the user to authorize the wallet.
  const fee = tx.fees(params);
  return { fee: fee.toString(), cost: Object.fromEntries(Object.entries(tx.cost(params)).map(([k,v]) => [k, v.toString()])) };
}
