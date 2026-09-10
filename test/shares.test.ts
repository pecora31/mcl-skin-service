import { describe, expect, it, vi, beforeEach } from 'vitest';
import { handleShares, isShareRequest, validateManifest, _internals } from '../src/shares';

function fakeKv() {
  const store = new Map<string, string>();
  return {
    store,
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
  } as unknown as KVNamespace & { store: Map<string, string> };
}

function post(body: unknown, ip = '1.2.3.4'): Request {
  return new Request('https://worker.example/v1/shares', {
    method: 'POST',
    headers: { 'cf-connecting-ip': ip },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

// What index.ts passes in: the caller's network as a salted hash, never the raw IP
const ADDRESS = 'hashed-address';

const VALID = {
  name: 'Friends SMP',
  gameVersion: '1.21.1',
  loader: 'fabric',
  loaderVersion: '0.16.10',
  addons: [
    { source: 'modrinth', projectId: 'AANobbMI', versionId: 'abc123', addonType: 'mods' },
    { source: 'curseforge', projectId: '238222', addonType: 'mods' },
  ],
};

describe('isShareRequest', () => {
  it('claims its own paths only', () => {
    expect(isShareRequest('/v1/shares')).toBe(true);
    expect(isShareRequest('/v1/shares/ABC2345')).toBe(true);
    expect(isShareRequest('/v1/skins/Steve.png')).toBe(false);
  });
});

describe('generated codes', () => {
  it('omits characters that are misread when copied off a screen', () => {
    expect(_internals.CODE_ALPHABET).not.toMatch(/[O0I1]/);
  });

  it('produces codes of the expected shape', () => {
    for (let attempt = 0; attempt < 50; attempt++) {
      const code = _internals.generateCode();
      expect(code).toHaveLength(_internals.CODE_LENGTH);
      expect(_internals.isValidCode(code)).toBe(true);
    }
  });
});

describe('validateManifest', () => {
  it('accepts a well-formed manifest', () => {
    const result = validateManifest(VALID);
    expect('manifest' in result).toBe(true);
  });

  it.each([
    [{ ...VALID, name: '' }, 'empty name'],
    [{ ...VALID, gameVersion: undefined }, 'missing game version'],
    [{ ...VALID, addons: 'nope' }, 'addons not an array'],
    [{ ...VALID, addons: [{ source: 'pirate-site', projectId: 'x' }] }, 'unknown source'],
  ])('refuses %#: %s', (input) => {
    expect('error' in validateManifest(input)).toBe(true);
  });

  it('refuses a project id that would not be a plain id in an API path', () => {
    const result = validateManifest({
      ...VALID,
      addons: [{ source: 'modrinth', projectId: '../../etc/passwd' }],
    });
    expect('error' in result).toBe(true);
  });

  it('refuses a manifest carrying an implausible number of addons', () => {
    const addons = Array.from({ length: 501 }, () => ({
      source: 'modrinth',
      projectId: 'AANobbMI',
    }));
    expect('error' in validateManifest({ ...VALID, addons })).toBe(true);
  });
});

describe('handleShares', () => {
  let kv: ReturnType<typeof fakeKv>;

  beforeEach(() => {
    kv = fakeKv();
  });

  it('stores a manifest and hands back a code that reads it again', async () => {
    const created = await handleShares(post(VALID), kv, '/v1/shares', ADDRESS);
    expect(created.status).toBe(201);
    const { code } = (await created.json()) as { code: string };
    expect(_internals.isValidCode(code)).toBe(true);

    const read = await handleShares(
      new Request(`https://worker.example/v1/shares/${code}`),
      kv,
      `/v1/shares/${code}`,
      ADDRESS
    );
    expect(read.status).toBe(200);
    const manifest = (await read.json()) as typeof VALID;
    expect(manifest.name).toBe('Friends SMP');
    expect(manifest.addons).toHaveLength(2);
  });

  it('accepts a code typed in lower case', async () => {
    const created = await handleShares(post(VALID), kv, '/v1/shares', ADDRESS);
    const { code } = (await created.json()) as { code: string };
    const lower = code.toLowerCase();
    const read = await handleShares(
      new Request(`https://worker.example/v1/shares/${lower}`),
      kv,
      `/v1/shares/${lower}`,
      ADDRESS
    );
    expect(read.status).toBe(200);
  });

  it('gives a plain answer for a code that has expired or never existed', async () => {
    const path = '/v1/shares/ABC2345';
    const res = await handleShares(new Request(`https://worker.example${path}`), kv, path, ADDRESS);
    expect(res.status).toBe(404);
  });

  it('rejects a malformed code without touching storage', async () => {
    const path = '/v1/shares/oops';
    const res = await handleShares(new Request(`https://worker.example${path}`), kv, path, ADDRESS);
    expect(res.status).toBe(400);
    expect(kv.get).not.toHaveBeenCalled();
  });

  it('sets an expiry so abandoned shares do not accumulate', async () => {
    await handleShares(post(VALID), kv, '/v1/shares', ADDRESS);
    const [, , options] = (kv.put as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(options.expirationTtl).toBeGreaterThan(0);
  });

  it('rate limits one address per day', async () => {
    for (let attempt = 0; attempt < 20; attempt++) {
      const res = await handleShares(post(VALID), kv, '/v1/shares', ADDRESS);
      expect(res.status).toBe(201);
    }
    const blocked = await handleShares(post(VALID), kv, '/v1/shares', ADDRESS);
    expect(blocked.status).toBe(429);
  });

  it('refuses a body that is not JSON rather than throwing', async () => {
    const res = await handleShares(post('{not json'), kv, '/v1/shares', ADDRESS);
    expect(res.status).toBe(400);
  });
});
