import { describe, expect, it } from 'vitest';
import worker, { type Env } from '../src/index';
import { hashAddress } from '../src/crypto';

const today = new Date().toISOString().slice(0, 10);
const IP = '203.0.113.7';

function limiter(success: boolean) {
  return { limit: async () => ({ success }) };
}

const throwingLimiter = {
  limit: async () => {
    throw new Error('limiter unavailable');
  },
};

/** `counters` holds R2 objects by key, the way the claim counters are stored. */
function env(overrides: Partial<Env> = {}, counters: Record<string, string> = {}): Env {
  return {
    SKIN_REGISTRY: { get: async () => null, put: async () => {} },
    SKIN_BUCKET: {
      get: async (key: string) => (key in counters ? { text: async () => counters[key] } : null),
      put: async () => {},
    },
    ...overrides,
  } as unknown as Env;
}

function get(path: string) {
  return new Request(`https://worker.example${path}`, { headers: { 'cf-connecting-ip': IP } });
}

function claim() {
  return new Request('https://worker.example/v1/skins/Rong', {
    method: 'POST',
    headers: { 'cf-connecting-ip': IP },
    body: new Uint8Array([0]),
  });
}

describe('per-network request limits', () => {
  it('refuses a name check once the network is over its budget', async () => {
    const response = await worker.fetch(get('/v1/skins/Rong'), env({ NAME_CHECK_LIMITER: limiter(false) }));
    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('60');
  });

  it('refuses CurseForge lookups once the network is over its budget', async () => {
    const response = await worker.fetch(
      get('/v1/curseforge/v1/categories'),
      env({ CURSEFORGE_LIMITER: limiter(false) })
    );
    expect(response.status).toBe(429);
  });

  it('keeps answering when the limiter itself is failing', async () => {
    const response = await worker.fetch(get('/v1/skins/Rong'), env({ NAME_CHECK_LIMITER: throwingLimiter }));
    expect(response.status).toBe(200);
  });

  it('never hands the raw IP to the limiter', async () => {
    const keys: string[] = [];
    const recording = {
      limit: async ({ key }: { key: string }) => {
        keys.push(key);
        return { success: true };
      },
    };
    await worker.fetch(get('/v1/skins/Rong'), env({ NAME_CHECK_LIMITER: recording }));
    expect(keys).toHaveLength(1);
    expect(keys[0]).not.toContain(IP);
  });
});

describe('daily limits on new names', () => {
  it('stops one network after fifty claims', async () => {
    const address = await hashAddress(IP);
    const response = await worker.fetch(claim(), env({}, { [`counters/claims/${today}/${address}`]: '50' }));
    expect(response.status).toBe(429);
    expect(((await response.json()) as { error: string }).error).toMatch(/this network/);
  });

  it('stops everyone once five hundred names were taken today', async () => {
    const response = await worker.fetch(claim(), env({}, { [`counters/claims-total/${today}`]: '500' }));
    expect(response.status).toBe(429);
    expect(((await response.json()) as { error: string }).error).toMatch(/for today/);
  });

  it('lets a claim through below both limits', async () => {
    const address = await hashAddress(IP);
    const response = await worker.fetch(
      claim(),
      env({}, { [`counters/claims/${today}/${address}`]: '49', [`counters/claims-total/${today}`]: '499' })
    );
    // Past both limits and on to checking the upload, which this one-byte body fails
    expect(response.status).toBe(400);
  });
});
