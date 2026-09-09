// Matches Minecraft's own username rules, so junk names cannot pollute the registry.
const USERNAME_RE = /^[A-Za-z0-9_]{3,16}$/;

const MAX_SKIN_BYTES = 100 * 1024; // real skins are a few KB; this is a generous cap
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const VALID_SKIN_SIZES: Array<[number, number]> = [
  [64, 64], // modern skin
  [64, 32], // legacy skin
];

export function isValidUsername(name: string): boolean {
  return USERNAME_RE.test(name);
}

// Returns null when the file is a valid skin, or a human-readable reason otherwise.
export function validateSkinPng(bytes: Uint8Array): string | null {
  if (bytes.byteLength === 0) return 'Empty file';
  if (bytes.byteLength > MAX_SKIN_BYTES) {
    return `File too large (max ${MAX_SKIN_BYTES / 1024}KB)`;
  }
  for (let i = 0; i < PNG_MAGIC.length; i++) {
    if (bytes[i] !== PNG_MAGIC[i]) return 'Not a valid PNG file';
  }

  const dims = readPngDimensions(bytes);
  if (!dims) return 'Could not read PNG dimensions';

  const isValidSize = VALID_SKIN_SIZES.some(([w, h]) => w === dims.width && h === dims.height);
  if (!isValidSize) {
    return `Invalid skin dimensions ${dims.width}x${dims.height} (expected 64x64 or 64x32)`;
  }
  return null;
}

// The IHDR chunk always starts right after the 8-byte PNG signature: 4-byte
// chunk length, 4-byte type "IHDR", then 4-byte width + 4-byte height (big-endian).
function readPngDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.byteLength < 24) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16, false);
  const height = view.getUint32(20, false);
  return { width, height };
}
