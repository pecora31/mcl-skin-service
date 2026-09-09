/**
 * Profile share codes.
 *
 * A player exports a profile and gets a short code; anyone entering that code rebuilds the
 * same profile. Only a manifest is stored — loader, versions, and which mod came from which
 * platform — never the mod files themselves. The importing launcher fetches those from
 * Modrinth and CurseForge exactly as it would for a manual install, so nothing here has to
 * host or redistribute anyone's mod.
 *
 * That keeps a share to a couple of kilobytes, which matters: the free tier allows a
 * thousand writes a day, and a share is one write.
 */

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 7;

/** Long enough to pass a code around, short enough that abandoned ones do not pile up. */
const EXPIRY_SECONDS = 60 * 60 * 24 * 60;

const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_ADDONS = 500;

/** A share is a write, and writes are the scarce half of the free tier. */
const RATE_LIMIT_SHARES_PER_DAY = 20;

export interface SharedAddon {
  source: 'modrinth' | 'curseforge';
  projectId: string;
  versionId?: string;
  addonType: string;
  fileName?: string;
}

export interface ShareManifest {
  name: string;
  gameVersion: string;
  loader: string;
  loaderVersion?: string;
  minRam?: number;
  maxRam?: number;
  addons: SharedAddon[];
}

export function isShareRequest(pathname: string): boolean {
  return pathname === '/v1/shares' || pathname.startsWith('/v1/shares/');
}

/**
 * Omits characters that are misread when a code is copied off a screen or read aloud:
 * no O/0, no I/1.
 */
function generateCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
  return Array.from(bytes, (byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join('');
}

function isValidCode(code: string): boolean {
  return (
    code.length === CODE_LENGTH &&
    [...code].every((character) => CODE_ALPHABET.includes(character))
  );
}

/**
 * Validated rather than trusted: this is written by one player and handed to another, so a
 * malformed or oversized manifest must be refused before it is stored, not after someone
 * imports it.
 */
export function validateManifest(value: unknown): { manifest: ShareManifest } | { error: string } {
  if (typeof value !== 'object' || value === null) return { error: 'Manifest must be an object' };
  const candidate = value as Record<string, unknown>;

  for (const field of ['name', 'gameVersion', 'loader'] as const) {
    if (typeof candidate[field] !== 'string' || !(candidate[field] as string).trim()) {
      return { error: `Missing or empty field: ${field}` };
    }
  }
  if ((candidate.name as string).length > 100) return { error: 'Profile name is too long' };

  if (!Array.isArray(candidate.addons)) return { error: 'addons must be an array' };
  if (candidate.addons.length > MAX_ADDONS) {
    return { error: `A profile may share at most ${MAX_ADDONS} addons` };
  }

  const addons: SharedAddon[] = [];
  for (const entry of candidate.addons) {
    if (typeof entry !== 'object' || entry === null) return { error: 'Malformed addon entry' };
    const addon = entry as Record<string, unknown>;
    if (addon.source !== 'modrinth' && addon.source !== 'curseforge') {
      return { error: 'Addon source must be modrinth or curseforge' };
    }
    if (typeof addon.projectId !== 'string' || !addon.projectId.trim()) {
      return { error: 'Addon is missing a project id' };
    }
    // Ids are echoed straight into API paths by the importing launcher, so anything that
    // is not a plain id is refused here.
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(addon.projectId)) {
      return { error: `Invalid project id: ${addon.projectId}` };
    }
    if (addon.versionId !== undefined && !/^[A-Za-z0-9_-]{1,64}$/.test(String(addon.versionId))) {
      return { error: 'Invalid version id' };
    }
    addons.push({
      source: addon.source,
      projectId: addon.projectId,
      versionId: addon.versionId === undefined ? undefined : String(addon.versionId),
      addonType: typeof addon.addonType === 'string' ? addon.addonType : 'mods',
      fileName: typeof addon.fileName === 'string' ? addon.fileName : undefined,
    });
  }

  return {
    manifest: {
      name: (candidate.name as string).trim(),
      gameVersion: candidate.gameVersion as string,
      loader: candidate.loader as string,
      loaderVersion:
        typeof candidate.loaderVersion === 'string' ? candidate.loaderVersion : undefined,
      minRam: typeof candidate.minRam === 'number' ? candidate.minRam : undefined,
      maxRam: typeof candidate.maxRam === 'number' ? candidate.maxRam : undefined,
      addons,
    },
  };
}

export async function handleShares(
  request: Request,
  kv: KVNamespace,
  pathname: string
): Promise<Response> {
  if (request.method === 'POST' && pathname === '/v1/shares') {
    return createShare(request, kv);
  }
  if (request.method === 'GET' && pathname.startsWith('/v1/shares/')) {
    return readShare(kv, pathname.slice('/v1/shares/'.length));
  }
  return json({ error: 'Method not allowed' }, 405);
}

async function createShare(request: Request, kv: KVNamespace): Promise<Response> {
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const limitKey = `sharelimit:${ip}:${new Date().toISOString().slice(0, 10)}`;
  const used = Number((await kv.get(limitKey)) || '0');
  if (used >= RATE_LIMIT_SHARES_PER_DAY) {
    return json({ error: 'Too many share codes created today. Try again tomorrow.' }, 429);
  }

  const raw = await request.text();
  if (raw.length > MAX_MANIFEST_BYTES) {
    return json({ error: 'Manifest is too large' }, 413);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return json({ error: 'Manifest is not valid JSON' }, 400);
  }

  const result = validateManifest(parsed);
  if ('error' in result) return json({ error: result.error }, 400);

  const code = generateCode();
  await kv.put(`share:${code}`, JSON.stringify(result.manifest), {
    expirationTtl: EXPIRY_SECONDS,
  });
  // TTL a little over a day so a share created near midnight does not reset the count early
  await kv.put(limitKey, String(used + 1), { expirationTtl: 60 * 60 * 26 });

  return json({ code, expiresInDays: Math.round(EXPIRY_SECONDS / 86400) }, 201);
}

async function readShare(kv: KVNamespace, rawCode: string): Promise<Response> {
  const code = decodeURIComponent(rawCode).toUpperCase();
  if (!isValidCode(code)) return json({ error: 'Invalid share code' }, 400);

  const stored = await kv.get(`share:${code}`);
  if (!stored) return json({ error: 'This share code has expired or never existed' }, 404);

  return new Response(stored, {
    headers: {
      'Content-Type': 'application/json',
      // Short: a code is usually read once, and it can expire.
      'Cache-Control': 'public, max-age=60',
    },
  });
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export const _internals = { CODE_ALPHABET, CODE_LENGTH, generateCode, isValidCode };
