import { describe, expect, it } from 'vitest';
import { isPreflightRequest, preflightResponse, withCors } from '../src/cors';

describe('CORS', () => {
  it('recognises a preflight request by method alone', () => {
    const req = new Request('https://worker.example/v1/shares', { method: 'OPTIONS' });
    expect(isPreflightRequest(req)).toBe(true);
    expect(isPreflightRequest(new Request('https://worker.example/v1/shares'))).toBe(false);
  });

  it('answers a preflight with no body and the headers a browser checks', () => {
    const res = preflightResponse();
    expect(res.status).toBe(204);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(res.headers.get('Access-Control-Allow-Methods')).toContain('POST');
    expect(res.headers.get('Access-Control-Allow-Headers')).toContain('Content-Type');
  });

  it('adds CORS headers to a response while keeping its status and body', async () => {
    const original = new Response(JSON.stringify({ ok: true }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    });
    const wrapped = withCors(original);
    expect(wrapped.status).toBe(201);
    expect(wrapped.headers.get('Content-Type')).toBe('application/json');
    expect(wrapped.headers.get('Access-Control-Allow-Origin')).toBe('*');
    expect(await wrapped.json()).toEqual({ ok: true });
  });
});
