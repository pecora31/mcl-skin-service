import { generateToken, hashAddress, hashToken } from './crypto';
import { handleCurseForge, isCurseForgeRequest } from './curseforge';
import { handleShares, isShareRequest } from './shares';
import { alternativeNames, isValidUsername, validateSkinPng } from './validate';
import { isPreflightRequest, preflightResponse, withCors } from './cors';

export interface Env {
  SKIN_REGISTRY: KVNamespace;
  SHARE_REGISTRY: KVNamespace;
  SKIN_BUCKET: R2Bucket;
  // Set with: wrangler secret put ADMIN_SECRET
  ADMIN_SECRET?: string;
  // Set with: wrangler secret put CURSEFORGE_API_KEY
  CURSEFORGE_API_KEY?: string;
  // Declared in wrangler.toml
  CURSEFORGE_LIMITER?: RateLimiter;
  NAME_CHECK_LIMITER?: RateLimiter;
}

interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

interface SkinRecord {
  displayName: string;
  tokenHash: string;
  skinKey: string;
  createdAt: number;
  updatedAt: number;
}

const RATE_LIMIT_CLAIMS_PER_DAY = 50;

/**
 * New names accepted per day across everyone. The free tier allows 1,000 KV writes a day for
 * the whole account and a claim costs one (its counters live in R2), so this keeps half of
 * them for skin updates, deletes and share codes even during a flood of claims.
 */
const MAX_NEW_CLAIMS_PER_DAY = 500;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // Answered before anything else: this is the request the browser sends to ask
    // permission before the real one, and it carries none of the real request's own
    // headers or body to route on.
    if (isPreflightRequest(request)) return preflightResponse();

    return withCors(await route(request, env));
  },
};

async function route(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (isCurseForgeRequest(url.pathname)) {
      if (!(await withinLimit(env.CURSEFORGE_LIMITER, request, env))) return tooManyRequests();
      return handleCurseForge(request, env.CURSEFORGE_API_KEY);
    }

    if (isShareRequest(url.pathname)) {
      return handleShares(request, env.SHARE_REGISTRY, url.pathname, await clientAddress(request, env));
    }

    const match = url.pathname.match(/^\/v1\/skins\/([^/]+?)(\.png)?$/);
    if (!match) return new Response('Not found', { status: 404 });

    const displayName = decodeURIComponent(match[1]);
    const isImageRequest = Boolean(match[2]);

    if (!isValidUsername(displayName)) {
      return json({ error: 'Invalid username format (3-16 letters, digits or underscore)' }, 400);
    }
    const username = displayName.toLowerCase();

    if (request.method === 'GET' && isImageRequest) return handleGet(env, username);
    if (request.method === 'GET' && !isImageRequest) {
      if (!(await withinLimit(env.NAME_CHECK_LIMITER, request, env))) return tooManyRequests();
      return handleCheck(env, displayName, username);
    }
    if (request.method === 'POST' && !isImageRequest) {
      return handleClaim(request, env, displayName, username);
    }
    if (request.method === 'PUT' && !isImageRequest) return handleUpdate(request, env, username);
    if (request.method === 'DELETE' && !isImageRequest) return handleDelete(request, env, username);

    return new Response('Method not allowed', { status: 405 });
}

async function handleGet(env: Env, username: string): Promise<Response> {
  const record = await getRecord(env, username);
  if (!record) return new Response('Skin not found', { status: 404 });

  const object = await env.SKIN_BUCKET.get(record.skinKey);
  if (!object) return new Response('Skin not found', { status: 404 });

  return new Response(object.body, {
    headers: {
      'Content-Type': 'image/png',
      // Matches CustomSkinLoader's cache_expiry (30 days), and lets Cloudflare's
      // edge serve repeat lookups without ever invoking this Worker again.
      'Cache-Control': 'public, max-age=2592000, immutable',
      ETag: String(record.updatedAt),
    },
  });
}

// Lets the launcher warn a player while they are still choosing a name, instead of the
// clash only surfacing as a rejected upload the next time they launch. Read-only, so it is
// not counted against the claim rate limit.
async function handleCheck(env: Env, displayName: string, username: string): Promise<Response> {
  if (!(await getRecord(env, username))) return json({ claimed: false, suggestions: [] });

  const candidates = alternativeNames(displayName);
  const records = await Promise.all(candidates.map((name) => getRecord(env, name.toLowerCase())));
  const suggestions = candidates.filter((_, i) => !records[i]).slice(0, 3);
  return json({ claimed: true, suggestions });
}

async function handleClaim(
  request: Request,
  env: Env,
  displayName: string,
  username: string
): Promise<Response> {
  if (await getRecord(env, username)) {
    return json({ error: 'Username already claimed. Use PUT with your token to update it.' }, 409);
  }

  const address = await clientAddress(request, env);
  if ((await readCounter(env, claimsFromKey(address))) >= RATE_LIMIT_CLAIMS_PER_DAY) {
    return json({ error: 'Too many new skins claimed from this network today. Try again tomorrow.' }, 429);
  }
  if ((await readCounter(env, claimsTotalKey())) >= MAX_NEW_CLAIMS_PER_DAY) {
    return json({ error: 'The skin service has taken all the new names it can for today. Try again tomorrow.' }, 429);
  }

  const bytes = new Uint8Array(await request.arrayBuffer());
  const validationError = validateSkinPng(bytes);
  if (validationError) return json({ error: validationError }, 400);

  const token = generateToken();
  const skinKey = `skins/${username}.png`;

  await env.SKIN_BUCKET.put(skinKey, bytes, { httpMetadata: { contentType: 'image/png' } });

  const record: SkinRecord = {
    displayName,
    tokenHash: await hashToken(token),
    skinKey,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await env.SKIN_REGISTRY.put(`skin:${username}`, JSON.stringify(record));
  await bumpCounter(env, claimsFromKey(address));
  await bumpCounter(env, claimsTotalKey());

  return json(
    {
      token,
      skinUrl: `${new URL(request.url).origin}/v1/skins/${username}.png`,
      warning: 'Save this token now — it will not be shown again and is the only way to update this skin later.',
    },
    201
  );
}

async function handleUpdate(request: Request, env: Env, username: string): Promise<Response> {
  const record = await getRecord(env, username);
  if (!record) {
    return json({ error: 'No skin claimed for this username yet. Use POST to claim it first.' }, 404);
  }
  if (!(await tokenMatches(request, record.tokenHash))) {
    return json({ error: 'Invalid or missing token for this username' }, 403);
  }

  const bytes = new Uint8Array(await request.arrayBuffer());
  const validationError = validateSkinPng(bytes);
  if (validationError) return json({ error: validationError }, 400);

  await env.SKIN_BUCKET.put(record.skinKey, bytes, { httpMetadata: { contentType: 'image/png' } });
  record.updatedAt = Date.now();
  await env.SKIN_REGISTRY.put(`skin:${username}`, JSON.stringify(record));

  return json({ skinUrl: `${new URL(request.url).origin}/v1/skins/${username}.png` });
}

async function handleDelete(request: Request, env: Env, username: string): Promise<Response> {
  const record = await getRecord(env, username);
  if (!record) return json({ error: 'Nothing to delete' }, 404);

  const authHeader = request.headers.get('authorization') || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  const isAdmin = Boolean(env.ADMIN_SECRET) && token === env.ADMIN_SECRET;
  if (!isAdmin && !(await tokenMatches(request, record.tokenHash))) {
    return json({ error: 'Invalid or missing token for this username' }, 403);
  }

  await env.SKIN_BUCKET.delete(record.skinKey);
  await env.SKIN_REGISTRY.delete(`skin:${username}`);
  return json({ deleted: true });
}

async function tokenMatches(request: Request, expectedHash: string): Promise<boolean> {
  const authHeader = request.headers.get('authorization') || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) return false;
  return (await hashToken(token)) === expectedHash;
}

async function getRecord(env: Env, username: string): Promise<SkinRecord | null> {
  const raw = await env.SKIN_REGISTRY.get(`skin:${username}`);
  return raw ? (JSON.parse(raw) as SkinRecord) : null;
}

/** The caller's network, as the salted hash rate limits are counted under — never the raw IP. */
function clientAddress(request: Request, env: Env): Promise<string> {
  return hashAddress(request.headers.get('cf-connecting-ip') || 'unknown', env.ADMIN_SECRET);
}

// Claim counters live in R2 rather than KV: its free tier allows a million writes a month
// against KV's thousand a day, so counting claims no longer eats into the budget claims
// themselves need. Keys carry the date, so a new day starts from zero, and a lifecycle rule
// on the `counters/` prefix deletes old ones:
//   wrangler r2 bucket lifecycle add mcl-skins expire-counters counters/ --expire-days 1

function claimsFromKey(address: string): string {
  return `claims/${today()}/${address}`;
}

function claimsTotalKey(): string {
  return `claims-total/${today()}`;
}

async function readCounter(env: Env, key: string): Promise<number> {
  const object = await env.SKIN_BUCKET.get(`counters/${key}`);
  return object ? Number(await object.text()) || 0 : 0;
}

async function bumpCounter(env: Env, key: string): Promise<void> {
  try {
    const count = await readCounter(env, key);
    await env.SKIN_BUCKET.put(`counters/${key}`, String(count + 1));
  } catch {
    // Two claims landing together can race here. The claim itself already succeeded;
    // the limit just runs one short, which is fine for a guard against floods.
  }
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Lets a request through unless its network is over the limiter's budget. Fails open: a
 * limiter that is missing (local dev, tests) or erroring must not take the service down.
 */
async function withinLimit(limiter: RateLimiter | undefined, request: Request, env: Env): Promise<boolean> {
  if (!limiter) return true;
  try {
    const { success } = await limiter.limit({ key: await clientAddress(request, env) });
    return success;
  } catch {
    return true;
  }
}

function tooManyRequests(): Response {
  const response = json({ error: 'Too many requests from this network. Wait a minute and try again.' }, 429);
  response.headers.set('Retry-After', '60');
  return response;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
