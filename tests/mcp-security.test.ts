/**
 * tests/mcp-security.test.ts — round-3 security regression tests (real protocol).
 *
 * 1. Always-auth on /mcp: covered in tests/mcp-server.test.ts (default
 *    loopback 401 regression). Here: issuer validation, discovery with the
 *    operator-configured public issuer, RFC 9728 protected-resource
 *    metadata, WWW-Authenticate on 401s, forwarded-header spoofing, and
 *    per-client MCP session isolation over Streamable HTTP.
 *
 * No mocks of the server itself — every test drives the real HTTP server
 * built by buildMcpServer + startMcpServer.
 */
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { BrowserSession } from '../src/bridge-core.js';
import { MockBackend } from './fixtures/mock-backend.js';
import { buildMcpServer, startMcpServer, validatePublicIssuer } from '../src/mcp/server.js';

const TOKEN = 'mcp-security-token-1';

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    authorization: `Bearer ${TOKEN}`,
    ...extra,
  };
}

async function startSession(
  name: string,
): Promise<{ session: BrowserSession; handle: Awaited<ReturnType<typeof startMcpServer>> }> {
  const session = new BrowserSession(name, new MockBackend());
  await session.start({ headless: true });
  const handle = await startMcpServer(() => buildMcpServer(session, {}), {
    transport: 'http',
    host: '127.0.0.1',
    port: 0,
    token: TOKEN,
  });
  return { session, handle };
}

describe('public issuer validation (fail fast)', () => {
  it('accepts a public https tunnel URL', () => {
    expect(validatePublicIssuer('https://abc123.trycloudflare.com')).toBe(
      'https://abc123.trycloudflare.com',
    );
  });

  it('strips trailing slashes', () => {
    expect(validatePublicIssuer('https://abc123.trycloudflare.com/')).toBe(
      'https://abc123.trycloudflare.com',
    );
  });

  it('rejects non-https public hosts', () => {
    expect(() => validatePublicIssuer('http://example.com/x')).toThrow(/https/);
  });

  it('rejects private-network IPv4 literals', () => {
    for (const raw of [
      'https://192.168.1.10/',
      'https://10.0.0.5:8933/',
      'https://172.20.4.9/',
    ]) {
      expect(() => validatePublicIssuer(raw)).toThrow(/not reachable from the internet/);
    }
  });

  it('rejects unspecified hosts', () => {
    expect(() => validatePublicIssuer('https://0.0.0.0/')).toThrow();
  });

  it('rejects IPv6 ULA', () => {
    expect(() => validatePublicIssuer('https://[fd00::1]/')).toThrow(
      /not reachable from the internet/,
    );
  });

  it('rejects non-URLs', () => {
    expect(() => validatePublicIssuer('not-a-url')).toThrow(/not a URL/);
  });

  it('allows http for loopback/.localhost (local testing)', () => {
    expect(validatePublicIssuer('http://localhost:8933')).toBe('http://localhost:8933');
  });
});

describe('OAuth discovery with operator-configured public issuer', () => {
  const PUBLIC = 'https://bridge-test-123.trycloudflare.com';

  it('discovery documents use the public issuer; startup rejects a bad issuer', async () => {
    const session = new BrowserSession('mcp-issuer-test', new MockBackend());
    await session.start({ headless: true });
    // Fail fast: invalid issuer rejects before serving anything.
    await expect(
      startMcpServer(() => buildMcpServer(session, {}), {
        transport: 'http',
        host: '127.0.0.1',
        port: 0,
        token: TOKEN,
        issuer: 'http://example.com/',
      }),
    ).rejects.toThrow(/https/);

    const handle = await startMcpServer(() => buildMcpServer(session, {}), {
      transport: 'http',
      host: '127.0.0.1',
      port: 0,
      token: TOKEN,
      issuer: PUBLIC,
    });
    try {
      const base = new URL(handle.url!).origin;
      const disc = (await (
        await fetch(base + '/.well-known/oauth-authorization-server')
      ).json()) as Record<string, string>;
      expect(disc['issuer']).toBe(PUBLIC);
      expect(disc['authorization_endpoint']).toBe(PUBLIC + '/authorize');
      expect(disc['token_endpoint']).toBe(PUBLIC + '/token');
      expect(disc['registration_endpoint']).toBe(PUBLIC + '/register');

      const prm = (await (
        await fetch(base + '/.well-known/oauth-protected-resource')
      ).json()) as Record<string, unknown>;
      expect(prm['resource']).toBe(PUBLIC + '/mcp');
      expect(prm['authorization_servers']).toEqual([PUBLIC]);

      // Forwarded-header spoofing must not change discovery output: the
      // issuer is never derived from Host / X-Forwarded-*.
      const spoofed = (await (
        await fetch(base + '/.well-known/oauth-authorization-server', {
          headers: { 'x-forwarded-host': 'evil.example.com', 'x-forwarded-proto': 'http' },
        })
      ).json()) as Record<string, string>;
      expect(spoofed['issuer']).toBe(PUBLIC);
      expect(spoofed['authorization_endpoint']).toBe(PUBLIC + '/authorize');
    } finally {
      await handle.close().catch(() => undefined);
      await session.close().catch(() => undefined);
    }
  }, 60_000);

  it('401 on /mcp carries the WWW-Authenticate resource_metadata challenge', async () => {
    const { session, handle } = await startSession('mcp-issuer-401');
    try {
      const res = await fetch(handle.url!, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
      });
      expect(res.status).toBe(401);
      const www = res.headers.get('www-authenticate') ?? '';
      expect(www).toMatch(/^Bearer /);
      expect(www).toContain('resource_metadata="http://127.0.0.1:');
      expect(www).toContain('/.well-known/oauth-protected-resource"');
    } finally {
      await handle.close().catch(() => undefined);
      await session.close().catch(() => undefined);
    }
  }, 60_000);
});

describe('per-client MCP sessions (Streamable HTTP)', () => {
  it('two concurrent clients get isolated sessions; closing one does not break the other', async () => {
    const { session, handle } = await startSession('mcp-sessions-test');
    const mkClient = () => {
      const client = new Client({ name: 'mcp-session-test', version: '0.0.0' }, { capabilities: {} });
      const transport = new StreamableHTTPClientTransport(new URL(handle.url!), {
        requestInit: { headers: { authorization: `Bearer ${TOKEN}` } },
      });
      return { client, transport };
    };
    const a = mkClient();
    const b = mkClient();
    try {
      await a.client.connect(a.transport);
      await b.client.connect(b.transport);
      const sidA = a.transport.sessionId;
      const sidB = b.transport.sessionId;
      expect(sidA).toBeTruthy();
      expect(sidB).toBeTruthy();
      expect(sidA).not.toBe(sidB);

      // Concurrent calls on both sessions (read-only tools; MockBackend).
      const [ra, rb] = await Promise.all([
        a.client.callTool({ name: 'browser_status', arguments: {} }),
        b.client.callTool({ name: 'browser_tabs', arguments: {} }),
      ]);
      expect((ra as { isError?: boolean }).isError).not.toBe(true);
      expect((rb as { isError?: boolean }).isError).not.toBe(true);

      // Terminating A's session must not break B.
      await a.transport.terminateSession();
      const { tools } = await b.client.listTools();
      expect(tools.length).toBeGreaterThan(0);

      // A's old session id is gone: raw POST with it -> 404.
      const stale = await fetch(handle.url!, {
        method: 'POST',
        headers: authHeaders({ 'mcp-session-id': sidA! }),
        body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'ping' }),
      });
      expect(stale.status).toBe(404);
    } finally {
      await a.client.close().catch(() => undefined);
      await a.transport.close().catch(() => undefined);
      await b.client.close().catch(() => undefined);
      await b.transport.close().catch(() => undefined);
      await handle.close().catch(() => undefined);
      await session.close().catch(() => undefined);
    }
  }, 90_000);

  it('a second initialize without a session id starts a new session (no "already initialized")', async () => {
    const { session, handle } = await startSession('mcp-sessions-init');
    const mkRawInit = (id: number) =>
      fetch(handle.url!, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          jsonrpc: '2.0',
          id,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'raw', version: '0' },
          },
        }),
      });
    try {
      const r1 = await mkRawInit(1);
      const r2 = await mkRawInit(2);
      expect(r1.status).toBe(200);
      expect(r2.status).toBe(200);
      const s1 = r1.headers.get('mcp-session-id');
      const s2 = r2.headers.get('mcp-session-id');
      expect(s1).toBeTruthy();
      expect(s2).toBeTruthy();
      expect(s1).not.toBe(s2);
    } finally {
      await handle.close().catch(() => undefined);
      await session.close().catch(() => undefined);
    }
  }, 60_000);
});
