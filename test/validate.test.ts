import { describe, expect, it } from 'vitest';
import { alternativeNames, isValidUsername, validateSkinPng } from '../src/validate';

describe('alternativeNames', () => {
  it('offers the same name with a numeric suffix', () => {
    expect(alternativeNames('Rong', 3)).toEqual(['Rong_2', 'Rong_3', 'Rong_4']);
  });

  it('trims long names so every candidate is still a valid username', () => {
    for (const name of alternativeNames('a'.repeat(16), 12)) {
      expect(isValidUsername(name)).toBe(true);
    }
  });
});

describe('isValidUsername', () => {
  it('accepts standard Minecraft usernames', () => {
    expect(isValidUsername('Player_Hero')).toBe(true);
    expect(isValidUsername('abc')).toBe(true);
    expect(isValidUsername('a'.repeat(16))).toBe(true);
  });

  it('rejects invalid usernames', () => {
    expect(isValidUsername('ab')).toBe(false); // too short
    expect(isValidUsername('a'.repeat(17))).toBe(false); // too long
    expect(isValidUsername('bad name')).toBe(false); // space
    expect(isValidUsername('bad/name')).toBe(false); // path separator, would break R2 keys
    expect(isValidUsername('')).toBe(false);
  });
});

describe('validateSkinPng', () => {
  function makePng(width: number, height: number): Uint8Array {
    const bytes = new Uint8Array(24);
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    const view = new DataView(bytes.buffer);
    view.setUint32(16, width, false);
    view.setUint32(20, height, false);
    return bytes;
  }

  it('accepts valid 64x64 and 64x32 skin dimensions', () => {
    expect(validateSkinPng(makePng(64, 64))).toBeNull();
    expect(validateSkinPng(makePng(64, 32))).toBeNull();
  });

  it('rejects dimensions that are not a real skin size', () => {
    expect(validateSkinPng(makePng(128, 128))).not.toBeNull();
    expect(validateSkinPng(makePng(1, 1))).not.toBeNull();
  });

  it('rejects data that is not a PNG', () => {
    expect(validateSkinPng(new Uint8Array([1, 2, 3, 4]))).not.toBeNull();
    expect(validateSkinPng(new TextEncoder().encode('<html>not an image</html>'))).not.toBeNull();
  });

  it('rejects an empty file', () => {
    expect(validateSkinPng(new Uint8Array(0))).not.toBeNull();
  });

  it('rejects files larger than the cap', () => {
    const big = new Uint8Array(200 * 1024);
    big.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    const view = new DataView(big.buffer);
    view.setUint32(16, 64, false);
    view.setUint32(20, 64, false);
    expect(validateSkinPng(big)).not.toBeNull();
  });
});
