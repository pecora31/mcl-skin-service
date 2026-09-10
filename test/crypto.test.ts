import { describe, expect, it } from 'vitest';
import { hashAddress } from '../src/crypto';

describe('hashAddress', () => {
  it('never contains the address it was given', async () => {
    const hashed = await hashAddress('203.0.113.7', 'secret');
    expect(hashed).not.toContain('203.0.113.7');
  });

  it('is stable, so a network is counted under the same key all day', async () => {
    expect(await hashAddress('203.0.113.7', 'secret')).toBe(await hashAddress('203.0.113.7', 'secret'));
  });

  it('depends on the secret, so it cannot be reversed by hashing every IPv4 address', async () => {
    expect(await hashAddress('203.0.113.7', 'one')).not.toBe(await hashAddress('203.0.113.7', 'two'));
  });
});
