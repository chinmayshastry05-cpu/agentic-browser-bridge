/**
 * tests/mcp-server.test.ts — REAL MCP protocol evidence.
 *
 * Spins up the MCP server in-process and drives it with the official SDK
 * client over both transports (Streamable HTTP and stdio). Asserts
 * tools/list returns the full bridge tool registry and that tools/call
 * round-trips with real request/response shapes (not mocked). Also covers
 * the bearer-auth rules and the policy gates (confirmation + upload
 * approval stay intact over MCP).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { BrowserSession } from '../src/bridge-core.js';
import { MockBackend, sampleSnapshot } from './fixtures/mock-backend.js';
import { PolicyEngine } from '../src/security/policy.js';
import { buildMcpServer, startMcpServer, DEFAULT_MCP_HTTP_PORT } from '../src/mcp/server.js';
import { createToolRegistry, listToolDefinitions } from '../src/tools.js';

function newClient(): Client {
  return new Client({ name: 'mcp-protocol-test', version: '0.0.0' }, { capabilities: {} });
}

/** Tool names the bridge registry exposes (built from a live session). */
function registryToolNames(session: BrowserSession): string[] {
  return listToolDefinitions(createToolRegistry(session)).map((d) => d.name).sort();
}

function textOf(result: unknown): string {
  const r = result as { content: Array<{ type: string; text: string }>; isError?: boolean };
  expect(r.content).toHaveLength(1);
  expect(r.content[0]!.type).toBe('text');
  return r.content[0]!.text;
}

function parseText(result: unknown): { ok?: boolean; error?: string; [k: string]: unknown } {
  return JSON.parse(textOf(result)) as Record<string, unknown>;
}

function isErrorResult(result: unknown): boolean {
  return (result as { isError?: boolean }).isError === true;
}

describe('MCP Streamable HTTP transport (in-process, real SDK client)', () => {
  let session: BrowserSession;
  let backend: MockBackend;
  let handle: Awaited<ReturnType<typeof startMcpServer>>;
  let client: Client;
  let transport: StreamableHTTPClientTransport;

  beforeAll(async () => {
    backend = new MockBackend();
    session = new BrowserSession('mcp-http-test', backend);
    await session.start({ headless: true });
    const server = buildMcpServer(session, { policy: new PolicyEngine() });
    handle = await startMcpServer(server, { transport: 'http', host: '127.0.0.1', port: 0 });
    client = newClient();
    transport = new StreamableHTTPClientTransport(new URL(handle.url!));
    await client.connect(transport);
  }, 60_000);

  afterAll(async () => {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
    await handle.close().catch(() => undefined);
    await session.close().catch(() => undefined);
  });

  it('tools/list returns every registered bridge tool', async () => {
    const { tools } = await client.listTools();
    const expected = registryToolNames(session);
    expect(tools.map((t) => t.name).sort()).toEqual(expected);
    // Spot-check a schema shape survived the JSON-Schema -> Zod -> JSON-Schema trip.
    const nav = tools.find((t) => t.name === 'browser_navigate')!;
    expect(nav.inputSchema).toMatchObject({
      type: 'object',
      properties: { url: { type: 'string' } },
      required: ['url'],
    });
  });

  it('tools/call browser_navigate round-trips (real request/response shapes)', async () => {
    const result = await client.callTool({
      name: 'browser_navigate',
      arguments: { url: 'data:text/html,<h1>hi</h1>' },
    });
    const body = parseText(result);
    expect(body.ok).toBe(true);
    expect(backend.navigated).toContain('data:text/html,<h1>hi</h1>');
  });

  it('tools/call browser_snapshot returns the live snapshot JSON', async () => {
    const result = await client.callTool({ name: 'browser_snapshot', arguments: {} });
    const body = parseText(result);
    expect(body.ok).toBe(true);
    const data = body['data'] as { url: string; title: string };
    expect(data.title).toBe(sampleSnapshot().title);
  });

  it('unknown tool surfaces a protocol error', async () => {
    const result = await client.callTool({ name: 'browser_nope', arguments: {} });
    expect(isErrorResult(result)).toBe(true);
    expect(textOf(result)).toMatch(/not found/i);
  });

  it('policy confirm-gate stays intact: browser_type needs confirmation', async () => {
    const strict = new PolicyEngine({ confirmMedium: true });
    const s2 = new BrowserSession('mcp-strict-test', new MockBackend());
    await s2.start({ headless: true });
    const server2 = buildMcpServer(s2, { policy: strict });
    const h2 = await startMcpServer(server2, { transport: 'http', host: '127.0.0.1', port: 0 });
    const c2 = newClient();
    const t2 = new StreamableHTTPClientTransport(new URL(h2.url!));
    await c2.connect(t2);
    try {
      const result = await c2.callTool({
        name: 'browser_type',
        arguments: { ref: 'e2', text: 'hello' },
      });
      expect(isErrorResult(result)).toBe(true);
      expect(textOf(result)).toMatch(/requires human confirmation/i);
    } finally {
      await c2.close().catch(() => undefined);
      await t2.close().catch(() => undefined);
      await h2.close().catch(() => undefined);
      await s2.close().catch(() => undefined);
    }
  });

  it('unapproved browser_upload is refused over MCP (honest recourse: ABB_UPLOAD_ALLOWLIST)', async () => {
    // Contract change (2026-10-08): the old message promised UI/CLI upload
    // approval, but no such path ever existed (approveUpload was unreachable
    // in production). The ONLY recourse is the operator allowlist, so the
    // message — and this test — now pin exactly that.
    const result = await client.callTool({
      name: 'browser_upload',
      arguments: { ref: 'e3', filePath: '/tmp/evil.txt' },
    });
    expect(isErrorResult(result)).toBe(true);
    expect(textOf(result)).toMatch(/ABB_UPLOAD_ALLOWLIST/);
    expect(textOf(result)).not.toMatch(/bridge UI/i);
  });
});

describe('MCP HTTP bearer auth', () => {
  it('requires the token when --public is set; 401 without it', async () => {
    const session = new BrowserSession('mcp-auth-test', new MockBackend());
    await session.start({ headless: true });
    const server = buildMcpServer(session, {});
    const handle = await startMcpServer(server, {
      transport: 'http',
      host: '127.0.0.1',
      port: 0,
      public: true,
    });
    try {
      expect(handle.token).toBeTruthy();
      expect(handle.token).not.toContain('placeholder');
      // No token -> 401.
      const denied = await fetch(handle.url!, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
      });
      expect(denied.status).toBe(401);
      // Full SDK client round-trip with the token (initialize + tools/list),
      // proving a bearer-authenticated client can speak MCP end to end.
      const client = newClient();
      const transport = new StreamableHTTPClientTransport(new URL(handle.url!), {
        requestInit: { headers: { authorization: `Bearer ${handle.token}` } },
      });
      await client.connect(transport);
      const { tools } = await client.listTools();
      expect(tools.length).toBe(registryToolNames(session).length);
      await client.close().catch(() => undefined);
      await transport.close().catch(() => undefined);
    } finally {
      await handle.close().catch(() => undefined);
      await session.close().catch(() => undefined);
    }
  }, 60_000);

  it('loopback without --public needs no token', async () => {
    const session = new BrowserSession('mcp-auth-test-2', new MockBackend());
    await session.start({ headless: true });
    const server = buildMcpServer(session, {});
    const handle = await startMcpServer(server, {
      transport: 'http',
      host: '127.0.0.1',
      port: 0,
    });
    try {
      expect(handle.token).toBeNull();
      const res = await fetch(handle.url!, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
      });
      expect(res.status).not.toBe(401);
    } finally {
      await handle.close().catch(() => undefined);
      await session.close().catch(() => undefined);
    }
  });
});

describe('MCP stdio transport (spawned CLI, real SDK client)', () => {
  const candidates = [join(process.cwd(), 'dist', 'src', 'index.js'), join(process.cwd(), 'dist', 'index.js')];
  const cliPath = candidates.find((p) => existsSync(p));

  it.skipIf(!cliPath)(
    'stdio tools/list + tools/call round-trip against a real browser session',
    async () => {
      const client = newClient();
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [cliPath!, 'mcp', '--transport', 'stdio'],
      });
      await client.connect(transport);
      try {
        const { tools } = await client.listTools();
        expect(tools.map((t) => t.name)).toContain('browser_navigate');
        // Expected names from an unstarted session's registry (no browser needed to build it).
        const probe = new BrowserSession('stdio-count-probe');
        const expected = listToolDefinitions(createToolRegistry(probe)).map((d) => d.name).sort();
        await probe.close().catch(() => undefined);
        expect(tools.map((t) => t.name).sort()).toEqual(expected);
        const result = await client.callTool({
          name: 'browser_navigate',
          arguments: { url: 'data:text/html,<title>stdio</title>' },
        });
        expect(parseText(result).ok).toBe(true);
      } finally {
        await client.close().catch(() => undefined);
        await transport.close().catch(() => undefined);
      }
    },
    120_000,
  );
});

describe('MCP server defaults', () => {
  it('documents the fixed port map (no collisions)', () => {
    expect(DEFAULT_MCP_HTTP_PORT).toBe(8933);
  });
});
