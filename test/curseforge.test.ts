import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { handleCurseForge, isCurseForgeRequest } from '../src/curseforge';

const KEY = 'test-key';

function get(path: string): Request {
  return new Request(`https://worker.example${path}`, { method: 'GET' });
}

beforeEach(() => {
  // The Worker runtime provides this; the test only needs it to miss and record.
  (globalThis as any).caches = {
    default: {
      match: vi.fn(async () => undefined),
      put: vi.fn(async () => undefined),
    },
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('isCurseForgeRequest', () => {
  it('claims only its own prefix', () => {
    expect(isCurseForgeRequest('/v1/curseforge/v1/mods/search')).toBe(true);
    expect(isCurseForgeRequest('/v1/skins/Steve.png')).toBe(false);
  });
});

describe('handleCurseForge', () => {
  it('says so plainly when no key is configured', async () => {
    const res = await handleCurseForge(get('/v1/curseforge/v1/mods/search'), undefined);
    expect(res.status).toBe(503);
  });

  it('refuses anything but GET, so the key cannot be used to write', async () => {
    const req = new Request('https://worker.example/v1/curseforge/v1/mods/search', {
      method: 'POST',
    });
    const res = await handleCurseForge(req, KEY);
    expect(res.status).toBe(405);
  });

  it('refuses endpoints outside the allowlist', async () => {
    const res = await handleCurseForge(get('/v1/curseforge/v1/games'), KEY);
    expect(res.status).toBe(403);
  });

  it('forwards an allowed path with the key attached and the query preserved', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response('{"data":[]}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await handleCurseForge(
      get('/v1/curseforge/v1/mods/search?gameId=432&searchFilter=sodium'),
      KEY
    );

    expect(res.status).toBe(200);
    const [calledUrl, init] = fetchMock.mock.calls[0];
    expect(calledUrl).toBe(
      'https://api.curseforge.com/v1/mods/search?gameId=432&searchFilter=sodium'
    );
    expect((init.headers as Record<string, string>)['x-api-key']).toBe(KEY);
  });

  it('never returns the key or upstream rate-limit headers to the caller', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('{"data":[]}', {
          status: 200,
          headers: { 'x-ratelimit-remaining': '3', 'x-api-key': KEY },
        })
      )
    );

    const res = await handleCurseForge(get('/v1/curseforge/v1/mods/123/files'), KEY);
    expect(res.headers.get('x-ratelimit-remaining')).toBeNull();
    expect(res.headers.get('x-api-key')).toBeNull();
    expect(await res.text()).not.toContain(KEY);
  });

  it('does not cache a failed upstream answer', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('{"error":"rate limited"}', { status: 429 }))
    );

    const res = await handleCurseForge(get('/v1/curseforge/v1/mods/123/files'), KEY);
    expect(res.status).toBe(429);
    expect(res.headers.get('Cache-Control')).toBe('no-store');
    expect((globalThis as any).caches.default.put).not.toHaveBeenCalled();
  });

  it('reports a network failure as a gateway error rather than throwing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('socket closed')));
    const res = await handleCurseForge(get('/v1/curseforge/v1/categories'), KEY);
    expect(res.status).toBe(502);
  });
});
