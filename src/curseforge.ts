/**
 * CurseForge API proxy.
 *
 * CurseForge's terms forbid disclosing an API key to third parties, and a key shipped
 * inside an open-source launcher is disclosed to everyone who reads the repository. The key
 * therefore lives here as a Worker secret and never leaves Cloudflare: the launcher asks
 * this Worker, and this Worker asks CurseForge.
 *
 * That makes the Worker the one holding the key, so it must not become a free CurseForge
 * API for the whole internet. Only the read-only endpoints the launcher actually uses are
 * forwarded, and answers are cached at the edge so repeated lookups never reach CurseForge.
 */

const CURSEFORGE_ROOT = 'https://api.curseforge.com';

/**
 * Only what the launcher calls. Anything else is refused rather than forwarded, so a new
 * endpoint has to be added here deliberately.
 */
const ALLOWED_PATHS: RegExp[] = [
  /^\/v1\/mods\/search$/,
  /^\/v1\/mods\/\d+$/,
  /^\/v1\/mods\/\d+\/files$/,
  /^\/v1\/categories$/,
];

/** Long enough to blunt repeat traffic, short enough that new mod files show up the same day. */
const CACHE_SECONDS = 900;

export function isCurseForgeRequest(pathname: string): boolean {
  return pathname.startsWith('/v1/curseforge/');
}

export async function handleCurseForge(
  request: Request,
  apiKey: string | undefined
): Promise<Response> {
  if (!apiKey) {
    // Deploying without the secret set should say so plainly rather than looking like
    // CurseForge is down.
    return json({ error: 'This launcher service has no CurseForge key configured' }, 503);
  }

  // Reads only: nothing the launcher does needs to write to CurseForge.
  if (request.method !== 'GET') {
    return json({ error: 'Only GET is proxied' }, 405);
  }

  const incoming = new URL(request.url);
  const upstreamPath = incoming.pathname.replace('/v1/curseforge', '');

  if (!ALLOWED_PATHS.some((allowed) => allowed.test(upstreamPath))) {
    return json({ error: `Endpoint not proxied: ${upstreamPath}` }, 403);
  }

  const upstreamUrl = `${CURSEFORGE_ROOT}${upstreamPath}${incoming.search}`;

  // Keyed on the upstream URL so every caller shares one cached answer; the key itself is
  // never part of the key, since it is identical for all of them.
  const cache = caches.default;
  const cacheKey = new Request(upstreamUrl, { method: 'GET' });
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  let upstream: Response;
  try {
    upstream = await fetch(upstreamUrl, {
      headers: { Accept: 'application/json', 'x-api-key': apiKey },
    });
  } catch (err) {
    return json({ error: `Could not reach CurseForge: ${String(err)}` }, 502);
  }

  // Pass the status through so the launcher can tell "no results" from "key rejected",
  // but never pass the upstream headers, which would leak rate-limit state per key.
  const body = await upstream.text();
  const response = new Response(body, {
    status: upstream.status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': upstream.ok ? `public, max-age=${CACHE_SECONDS}` : 'no-store',
    },
  });

  if (upstream.ok) {
    // Failures are deliberately not cached: a rate-limited minute should not become a
    // rate-limited quarter of an hour for everyone.
    await cache.put(cacheKey, response.clone());
  }
  return response;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Exported for tests. */
export const _internals = { ALLOWED_PATHS, CACHE_SECONDS };
