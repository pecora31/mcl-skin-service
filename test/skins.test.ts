import { describe, expect, it } from 'vitest';
import worker, { type Env } from '../src/index';

function envWithClaims(...names: string[]): Env {
  const store = new Map(
    names.map((name) => [
      `skin:${name.toLowerCase()}`,
      JSON.stringify({ displayName: name, tokenHash: 'x', skinKey: 'k', createdAt: 0, updatedAt: 0 }),
    ])
  );
  return {
    SKIN_REGISTRY: { get: async (key: string) => store.get(key) ?? null },
  } as unknown as Env;
}

async function check(name: string, env: Env) {
  const response = await worker.fetch(new Request(`https://worker.example/v1/skins/${name}`), env);
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

describe('GET /v1/skins/{name} (availability)', () => {
  it('reports an unclaimed name as free', async () => {
    const { status, body } = await check('Rong', envWithClaims());
    expect(status).toBe(200);
    expect(body).toEqual({ claimed: false, suggestions: [] });
  });

  it('matches claims regardless of letter case', async () => {
    const { body } = await check('RONG', envWithClaims('Rong'));
    expect(body.claimed).toBe(true);
  });

  it('suggests only alternatives that are themselves free', async () => {
    const { body } = await check('Rong', envWithClaims('Rong', 'Rong_2', 'Rong_4'));
    expect(body).toEqual({ claimed: true, suggestions: ['Rong_3', 'Rong_5', 'Rong_6'] });
  });

  it('rejects names that are not valid usernames', async () => {
    const { status } = await check('bad%20name', envWithClaims());
    expect(status).toBe(400);
  });
});
