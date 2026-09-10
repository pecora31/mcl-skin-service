// Token generation and hashing. Uses the Web Crypto API, which the Workers
// runtime provides natively — no extra dependency needed.

export function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

// Only the hash is ever stored. If the KV store leaks, no raw token leaks with it.
export async function hashToken(token: string): Promise<string> {
  const data = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return base64UrlEncode(new Uint8Array(digest));
}

// Rate limits count per network, but the address itself is never stored. It is mixed with a
// server-side secret first, so the stored value can't be reversed by hashing every IPv4
// address until one matches.
export async function hashAddress(ip: string, secret = ''): Promise<string> {
  return hashToken(`${secret}:${ip}`);
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
