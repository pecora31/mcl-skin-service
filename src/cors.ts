/**
 * CORS for the whole Worker.
 *
 * The launcher calls this API with the browser's own `fetch()`, from a webview origin
 * (`tauri://localhost` and similar) that never matches this Worker's own origin. Every
 * response — including the CORS preflight the browser sends before a JSON POST — needs the
 * right headers, or the request never reaches application code at all: it fails inside the
 * browser as an opaque "Failed to fetch", indistinguishable from a real network outage.
 *
 * A wildcard origin is fine here: nothing on this API is cookie- or session-based, so there
 * is no ambient credential a hostile page could ride along on.
 */

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

export function isPreflightRequest(request: Request): boolean {
  return request.method === 'OPTIONS';
}

export function preflightResponse(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

/** Adds the CORS headers to a response this Worker is about to return. */
export function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
