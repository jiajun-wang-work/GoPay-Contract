// Public networks for deployment tooling (docs.midnight.network/relnotes/network). Both run ledger 8 with
// Compact 0.31.1 / runtime 0.16.0, so the same compiled contract deploys to either. Preprod is served by
// Blockfrost and needs a project token; Preview is Midnight-hosted and open.
const NETWORKS = {
  preprod: { label: 'Midnight Preprod', port: 4318, indexer: 'https://midnight-preprod.blockfrost.io/api/v0', blockfrost: true },
  preview: { label: 'Midnight Preview', port: 4319, indexer: 'https://indexer.preview.midnight.network/api/v4/graphql', blockfrost: false },
};

/** Validated network settings; each network keeps its deployment record and secrets in `.deployment-<name>/`. */
export function networkConfig(name) {
  if (typeof name !== 'string' || !Object.hasOwn(NETWORKS, name)) throw new Error(`Network must be one of: ${Object.keys(NETWORKS).join(', ')}`);
  return { name, ...NETWORKS[name], stateDir: `.deployment-${name}` };
}
