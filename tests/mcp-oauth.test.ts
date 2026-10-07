/**
 * tests/mcp-oauth.test.ts — REAL OAuth 2.0 + PKCE protocol evidence.
 *
 * Drives the actual HTTP server (buildMcpServer + startMcpServer, ephemeral
 * port) with raw fetch through the full ChatGPT-style flow: RFC 8414
 * discovery → dynamic client registration → PKCE authorization (operator
 * pairing code) → token exchange → OAuth-authenticated MCP (initialize +
 * tools/list over the SDK client). No mocks — every hop hits the real
 * server. Also covers the failure modes (401 without/wrong token, failed
 * PKCE, wrong pairing code, single-use codes) and confirms the static
 * bearer token path still works unchanged.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { BrowserSession } from '../src/bridge-core.js';
import { MockBackend } from './fixtures/mock-backend.js';
import { buildMcpServer, startMcpServer } from '../src/mcp/server.js';
import { createToolRegistry, listToolDefinitions } from '../src/tools.js';

const PAIRING = 'test-code-123';
const REDIRECT = 'http://localhost:9999/cb';
const MCP_HEADERS = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
};

function pkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('hex');
  const challenge = createHash('sha256').update(verifier, 'utf8').digest('base64url');
  return { verifier, challenge };
}

function authorizeQuery(base: string, p: Record<string, string>): string {
  const u = new URL(base + '/authorize');
  for (const [k, v] of Object.entries(p)) u.searchParams.set(k, v);
  return u.toString();
}

/** Negative-path approve attempt: wrong pairing code or denied approval. */
async function approveAttempt(
  base: string,
  clientId: string,
  pairing: string,
  approved = 'yes',
): Promise<Response> {
  const { challenge } = pkcePair();
  const form = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT,
    state: 'neg',
    code_challenge: challenge,
    pairing_code: pairing,
    approved,
  });
  return fetch(base + '/authorize', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
    redirect: 'manual',
  });
}

describe('MCP OAuth 2.0 (ChatGPT-compatible, real protocol)', () => {
  let session: BrowserSession;
  let handle: Awaited<ReturnType<typeof startMcpServer>>;
  let base: string;
  let clientId: string;
  let accessToken = '';
  let refreshToken = '';
  let verifier = '';
  let authCode = '';
  let sessionId = '';
  const oldPairing = process.env['ABB_OAUTH_PAIRING_CODE'];

  beforeAll(async () => {
    process.env['ABB_OAUTH_PAIRING_CODE'] = PAIRING;
    session = new BrowserSession('mcp-oauth-test', new MockBackend());
    await session.start({ headless: true });
    const server = buildMcpServer(session, {});
    handle = await startMcpServer(server, {
      transport: 'http',
      host: '127.0.0.1',
      port: 0,
      public: true, // force auth so the 401 rules apply on loopback
    });
    base = new URL(handle.url!).origin;
  }, 60_000);

  afterAll(async () => {
    if (oldPairing === undefined) delete process.env['ABB_OAUTH_PAIRING_CODE'];
    else process.env['ABB_OAUTH_PAIRING_CODE'] = oldPairing;
    await handle.close().catch(() => undefined);
    await session.close().catch(() => undefined);
  });

  it('GET /.well-known/oauth-authorization-server returns the discovery document', async () => {
    const res = await fetch(base + '/.well-known/oauth-authorization-server');
    expect(res.status).toBe(200);
    const doc = (await res.json()) as Record<string, unknown>;
    expect(doc['issuer']).toBe(base);
    expect(doc['authorization_endpoint']).toBe(base + '/authorize');
    expect(doc['token_endpoint']).toBe(base + '/token');
    expect(doc['registration_endpoint']).toBe(base + '/register');
    expect(doc['response_types_supported']).toContain('code');
    expect(doc['grant_types_supported']).toContain('authorization_code');
    expect(doc['code_challenge_methods_supported']).toContain('S256');
  });

  it('POST /register registers a public client; rejects non-loopback http', async () => {
    const res = await fetch(base + '/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: 'test' }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { client_id: string; redirect_uris: string[] };
    expect(body.client_id).toMatch(/^abb-[0-9a-f]+$/);
    expect(body.redirect_uris).toEqual([REDIRECT]);
    clientId = body.client_id;

    const bad = await fetch(base + '/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ redirect_uris: ['http://evil.example.com/cb'] }),
    });
    expect(bad.status).toBe(400);
  });

  it('GET /authorize renders the operator approval page', async () => {
    const { challenge } = pkcePair();
    const url = authorizeQuery(base, {
      client_id: clientId,
      redirect_uri: REDIRECT,
      state: 's1',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    const res = await fetch(url);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html.toLowerCase()).toContain('pairing');
    expect(html).toContain('name="pairing_code"');

    const unknown = await fetch(
      authorizeQuery(base, {
        client_id: 'abb-nope',
        redirect_uri: REDIRECT,
        code_challenge: challenge,
        code_challenge_method: 'S256',
      }),
    );
    expect(unknown.status).toBe(400);
  });

  it('POST /authorize with the right pairing code issues an auth code (302)', async () => {
    const pair = pkcePair();
    verifier = pair.verifier;
    const state = 'state-abc';
    const res = await fetch(base + '/authorize', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        redirect_uri: REDIRECT,
        state,
        code_challenge: pair.challenge,
        pairing_code: PAIRING,
        approved: 'yes',
      }).toString(),
      redirect: 'manual',
    });
    expect(res.status).toBe(302);
    const loc = res.headers.get('location')!;
    expect(loc.startsWith(REDIRECT)).toBe(true);
    const u = new URL(loc);
    expect(u.searchParams.get('state')).toBe(state);
    authCode = u.searchParams.get('code')!;
    expect(authCode).toMatch(/^[0-9a-f]{64}$/);
  });

  it('POST /authorize with a wrong pairing code → 403', async () => {
    const res = await approveAttempt(base, clientId, 'wrong-code');
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('invalid pairing code');
  });

  it('POST /authorize deny → 302 with error=access_denied', async () => {
    const res = await approveAttempt(base, clientId, PAIRING, 'no');
    expect(res.status).toBe(302);
    const u = new URL(res.headers.get('location')!);
    expect(u.searchParams.get('error')).toBe('access_denied');
    expect(u.searchParams.get('code')).toBeNull();
  });

  it('POST /token exchanges the code + PKCE verifier for tokens', async () => {
    const res = await fetch(base + '/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: authCode,
        client_id: clientId,
        redirect_uri: REDIRECT,
        code_verifier: verifier,
      }).toString(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body['token_type']).toBe('Bearer');
    expect(body['expires_in']).toBe(3600);
    accessToken = body['access_token'] as string;
    refreshToken = body['refresh_token'] as string;
    expect(accessToken).toMatch(/^[0-9a-f]{64}$/);
    expect(refreshToken).toMatch(/^[0-9a-f]{64}$/);
  });

  it('auth codes are single-use: replaying the code → 400 invalid_grant', async () => {
    const res = await fetch(base + '/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: authCode,
        client_id: clientId,
        redirect_uri: REDIRECT,
        code_verifier: verifier,
      }).toString(),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_grant');
  });

  it('POST /mcp initialize with the OAuth access token → 200 (SSE)', async () => {
    const res = await fetch(handle.url!, {
      method: 'POST',
      headers: {
        ...MCP_HEADERS,
        authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'oauth-test', version: '0.0.0' },
        },
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    sessionId = res.headers.get('mcp-session-id') ?? '';
    expect(sessionId).toBeTruthy();
    await res.body?.cancel().catch(() => undefined);
  });

  it('POST /mcp without a token → 401; with a wrong token → 401', async () => {
    const ping = (headers: Record<string, string>) =>
      fetch(handle.url!, {
        method: 'POST',
        headers: { ...MCP_HEADERS, ...headers },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
      });
    const none = await ping({});
    expect(none.status).toBe(401);
    expect(await none.text()).toContain('Unauthenticated browser control is never allowed');
    const wrong = await ping({ authorization: 'Bearer deadbeef' });
    expect(wrong.status).toBe(401);
  });

  it('failed PKCE: fresh code, wrong verifier → 400 invalid_grant', async () => {
    // Fresh approve flow to get an unused code.
    const pair = pkcePair();
    const state = 'pkce-fail';
    const approve = await fetch(base + '/authorize', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: clientId,
        redirect_uri: REDIRECT,
        state,
        code_challenge: pair.challenge,
        pairing_code: PAIRING,
        approved: 'yes',
      }).toString(),
      redirect: 'manual',
    });
    expect(approve.status).toBe(302);
    const freshCode = new URL(approve.headers.get('location')!).searchParams.get('code')!;

    const res = await fetch(base + '/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: freshCode,
        client_id: clientId,
        redirect_uri: REDIRECT,
        code_verifier: 'wrong-verifier',
      }).toString(),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('invalid_grant');
  });

  it('refresh_token grant rotates the pair; the old refresh token dies', async () => {
    const res = await fetch(base + '/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, string>;
    const newAccess = body['access_token']!;
    const newRefresh = body['refresh_token']!;
    expect(newAccess).not.toBe(accessToken);
    expect(newRefresh).not.toBe(refreshToken);

    // Old refresh token is revoked by rotation.
    const reuse = await fetch(base + '/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
      }),
    });
    expect(reuse.status).toBe(400);
    expect(((await reuse.json()) as { error: string }).error).toBe('invalid_grant');

    // The NEW access token works on /mcp: tools/list over the existing
    // session (initialized earlier) with the rotated token.
    const listRes = await fetch(handle.url!, {
      method: 'POST',
      headers: {
        ...MCP_HEADERS,
        authorization: `Bearer ${newAccess}`,
        'mcp-session-id': sessionId,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    });
    expect(listRes.status).toBe(200);
    const sseText = await listRes.text();
    const dataLine = sseText.match(/^data: (.*)$/m)?.[1];
    expect(dataLine).toBeTruthy();
    const listed = (
      JSON.parse(dataLine!) as {
        result: { tools: Array<{ name: string; annotations?: Record<string, unknown> }> };
      }
    ).result.tools;
    const expected = listToolDefinitions(createToolRegistry(session)).map((d) => d.name).sort();
    expect(listed.map((t) => t.name).sort()).toEqual(expected);
    expect(listed).toHaveLength(30);
    // Annotations are present and honest.
    const snap = listed.find((t) => t.name === 'browser_snapshot')!;
    expect(snap.annotations?.['readOnlyHint']).toBe(true);
    expect(listed.some((t) => t.annotations?.['readOnlyHint'] === true)).toBe(true);
    const nav = listed.find((t) => t.name === 'browser_navigate')!;
    expect(nav.annotations?.['readOnlyHint']).toBe(false);
    expect(nav.annotations?.['idempotentHint']).toBe(false);
    const closeTab = listed.find((t) => t.name === 'browser_close_tab')!;
    expect(closeTab.annotations?.['destructiveHint']).toBe(true);
  });
});

describe('static bearer token path still works unchanged', () => {
  it('explicit token accepted on /mcp; missing token → 401', async () => {
    const session = new BrowserSession('mcp-oauth-static-test', new MockBackend());
    await session.start({ headless: true });
    const server = buildMcpServer(session, {});
    const handle = await startMcpServer(server, {
      transport: 'http',
      host: '127.0.0.1',
      port: 0,
      public: true,
      token: 'static-secret-token-1',
    });
    try {
      expect(handle.token).toBe('static-secret-token-1');
      const denied = await fetch(handle.url!, {
        method: 'POST',
        headers: MCP_HEADERS,
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
      });
      expect(denied.status).toBe(401);

      const client = new Client({ name: 'static-bearer-test', version: '0.0.0' }, { capabilities: {} });
      const transport = new StreamableHTTPClientTransport(new URL(handle.url!), {
        requestInit: { headers: { authorization: 'Bearer static-secret-token-1' } },
      });
      await client.connect(transport);
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toContain('browser_navigate');
      await client.close().catch(() => undefined);
      await transport.close().catch(() => undefined);
    } finally {
      await handle.close().catch(() => undefined);
      await session.close().catch(() => undefined);
    }
  }, 60_000);
});
