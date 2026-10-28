import { describe, expect, it } from 'vitest';
import { networkConfig } from '../scripts/networks.mjs';

describe('deployment networks', () => {
  it('keeps each network in its own state directory and port', () => {
    const preprod = networkConfig('preprod');
    const preview = networkConfig('preview');
    expect(preprod).toMatchObject({ stateDir: '.deployment-preprod', port: 4318, blockfrost: true });
    expect(preview).toMatchObject({ stateDir: '.deployment-preview', port: 4319, blockfrost: false });
    expect(preview.indexer).toBe('https://indexer.preview.midnight.network/api/v4/graphql');
  });
  it('rejects unknown or missing networks', () => {
    expect(() => networkConfig('mainnet')).toThrow('Network must be one of');
    expect(() => networkConfig(undefined)).toThrow('Network must be one of');
    expect(() => networkConfig('__proto__')).toThrow('Network must be one of');
  });
});
