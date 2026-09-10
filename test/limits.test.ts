import { describe, expect, it } from 'vitest';
import worker, { type Env } from '../src/index';

const today = new Date().toISOString().slice(0, 10);

function limiter(success: boolean) {
  return { limit: async () => ({ success }) };
}

const throwingLimiter = {
  limit: async () => {
    throw new Error('limiter unavailable');
  },
};

function env(overrides: Partial<Env> = {}, stored: Record<string, string> = {}): Env {
  return {
    SKIN_REGISTRY: { get: async (key: string) => stored[key] ?? null, put: async () => {} },
    ...overrides,
  } as unknown as Env;
}

function get(path: string) {
  return new Request(`https://worker.example${path}`, { headers: { 'cf-connecting-ip': '203.0.113.7' } });
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
    expect(keys[0]).not.toContain('203.0.113.7');
  });
});

describe('daily cap on new names', () => {
  it('stops accepting claims once the day is full', async () => {
    const request = new Request('https://worker.example/v1/skins/Rong', {
      method: 'POST',
      headers: { 'cf-connecting-ip': '203.0.113.7' },
      body: new Uint8Array([0]),
    });
    const response = await worker.fetch(request, env({}, { [`claims:total:${today}`]: '150' }));
    expect(response.status).toBe(429);
  });
});
