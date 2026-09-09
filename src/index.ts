import { generateToken, hashToken } from './crypto';
import { handleCurseForge, isCurseForgeRequest } from './curseforge';
import { isValidUsername, validateSkinPng } from './validate';

export interface Env {
  SKIN_REGISTRY: KVNamespace;
  SKIN_BUCKET: R2Bucket;
  // Set with: wrangler secret put ADMIN_SECRET
  ADMIN_SECRET?: string;
  // Set with: wrangler secret put CURSEFORGE_API_KEY
  CURSEFORGE_API_KEY?: string;
}

interface SkinRecord {
  displayName: string;
  tokenHash: string;
  skinKey: string;
  createdAt: number;
  updatedAt: number;
}

const RATE_LIMIT_CLAIMS_PER_DAY = 5;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (isCurseForgeRequest(url.pathname)) {
      return handleCurseForge(request, env.CURSEFORGE_API_KEY);
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
    if (request.method === 'POST' && !isImageRequest) {
      return handleClaim(request, env, displayName, username);
    }
    if (request.method === 'PUT' && !isImageRequest) return handleUpdate(request, env, username);
    if (request.method === 'DELETE' && !isImageRequest) return handleDelete(request, env, username);

    return new Response('Method not allowed', { status: 405 });
  },
};

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

async function handleClaim(
  request: Request,
  env: Env,
  displayName: string,
  username: string
): Promise<Response> {
  if (await getRecord(env, username)) {
    return json({ error: 'Username already claimed. Use PUT with your token to update it.' }, 409);
  }

  const clientIp = request.headers.get('cf-connecting-ip') || 'unknown';
  if (await isRateLimited(env, clientIp)) {
    return json({ error: 'Too many new skins claimed from this network today. Try again tomorrow.' }, 429);
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
  await bumpRateLimit(env, clientIp);

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

async function isRateLimited(env: Env, ip: string): Promise<boolean> {
  const count = Number((await env.SKIN_REGISTRY.get(rateLimitKey(ip))) || '0');
  return count >= RATE_LIMIT_CLAIMS_PER_DAY;
}

async function bumpRateLimit(env: Env, ip: string): Promise<void> {
  const key = rateLimitKey(ip);
  const count = Number((await env.SKIN_REGISTRY.get(key)) || '0');
  // TTL a little over 24h so a claim near midnight does not reset the counter early
  await env.SKIN_REGISTRY.put(key, String(count + 1), { expirationTtl: 60 * 60 * 26 });
}

function rateLimitKey(ip: string): string {
  return `ratelimit:${ip}:${new Date().toISOString().slice(0, 10)}`;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
