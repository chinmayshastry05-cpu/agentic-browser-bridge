/**
 * tests/mcp-confirm.test.ts — confirmation-error honesty over MCP.
 *
 * Guards the rule: a policy/confirmation error must not promise an approval
 * path that does not exist. The MCP "confirm" path now implements a REAL
 * ticket continuation (ConfirmationQueue shared with the CLI/UI), and the
 * upload gate's ONLY recourse is ABB_UPLOAD_ALLOWLIST — the messages say
 * exactly that, and these tests pin them.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { BrowserSession } from '../src/bridge-core.js';
import { MockBackend } from './fixtures/mock-backend.js';
import { PolicyEngine } from '../src/security/policy.js';
import { ConfirmationQueue } from '../src/security/confirm.js';
import { buildMcpServer, startMcpServer } from '../src/mcp/server.js';

function newClient(): Client {
  return new Client({ name: 'mcp-confirm-test', version: '0.0.0' }, { capabilities: {} });
}

function textOf(result: unknown): string {
  const r = result as { content: Array<{ type: string; text: string }>; isError?: boolean };
  return r.content[0]!.text;
}

function isErrorResult(result: unknown): boolean {
  return (result as { isError?: boolean }).isError === true;
}

describe('MCP confirmation ticket continuation (real, not promised)', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'abb-confirm-'));
  const queue = new ConfirmationQueue(dataDir);
  let session: BrowserSession;
  let backend: MockBackend;
  let handle: Awaited<ReturnType<typeof startMcpServer>>;
  let client: Client;
  let transport: StreamableHTTPClientTransport;
  let ticketId: string;

  beforeAll(async () => {
    backend = new MockBackend();
    session = new BrowserSession('mcp-confirm-test', backend);
    await session.start({ headless: true });
    // navigate is high-risk here so the policy returns "confirm".
    const policy = new PolicyEngine({ highRiskActions: ['navigate'] });
    handle = await startMcpServer(() => buildMcpServer(session, { policy, confirmations: queue }), {
      transport: 'http',
      host: '127.0.0.1',
      port: 0,
      token: 'mcp-confirm-token-1',
    });
    client = newClient();
    transport = new StreamableHTTPClientTransport(new URL(handle.url!), {
      requestInit: { headers: { authorization: 'Bearer mcp-confirm-token-1' } },
    });
    await client.connect(transport);
  });

  afterAll(async () => {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
    await handle.close().catch(() => undefined);
    await session.close().catch(() => undefined);
  });

  it('registers a real ticket and names the real approval commands', async () => {
    const result = await client.callTool({
      name: 'browser_navigate',
      arguments: { url: 'https://example.com/' },
    });
    expect(isErrorResult(result)).toBe(true);
    const text = textOf(result);
    expect(text).toMatch(/requires human confirmation/i);
    const m = /Confirmation ticket (confirm-[0-9a-f-]+)/.exec(text);
    expect(m).not.toBeNull();
    ticketId = m![1]!;
    // The promised recourse must exist: the ticket is in the shared queue…
    expect(queue.get(ticketId)).not.toBeNull();
    // …and the message names the real CLI command with the real id.
    expect(text).toContain(`node dist/index.js approve ${ticketId} --yes`);
  });

  it('does not spam tickets when the blocked call is retried', async () => {
    const result = await client.callTool({
      name: 'browser_navigate',
      arguments: { url: 'https://example.com/' },
    });
    expect(isErrorResult(result)).toBe(true);
    expect(textOf(result)).toContain(ticketId);
    expect(queue.listUnresolved().filter((c) => c.taskId === 'mcp')).toHaveLength(1);
  });

  it('operator approval unblocks the retried tool (ticket continuation works)', async () => {
    queue.resolve(ticketId, true);
    const result = await client.callTool({
      name: 'browser_navigate',
      arguments: { url: 'https://example.com/' },
    });
    expect(isErrorResult(result)).toBe(false);
    expect(backend.navigated).toContain('https://example.com/');
  });
});

describe('MCP upload gate honesty', () => {
  let session: BrowserSession;
  let handle: Awaited<ReturnType<typeof startMcpServer>>;
  let client: Client;
  let transport: StreamableHTTPClientTransport;

  beforeAll(async () => {
    session = new BrowserSession('mcp-upload-test', new MockBackend());
    await session.start({ headless: true });
    handle = await startMcpServer(() => buildMcpServer(session, {}), {
      transport: 'http',
      host: '127.0.0.1',
      port: 0,
      token: 'mcp-confirm-token-2',
    });
    client = newClient();
    transport = new StreamableHTTPClientTransport(new URL(handle.url!), {
      requestInit: { headers: { authorization: 'Bearer mcp-confirm-token-2' } },
    });
    await client.connect(transport);
  });

  afterAll(async () => {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
    await handle.close().catch(() => undefined);
    await session.close().catch(() => undefined);
  });

  it('block message names the ONLY real recourse (no phantom UI/CLI approval)', async () => {
    const result = await client.callTool({
      name: 'browser_upload',
      arguments: { ref: 'e3', filePath: '/tmp/not-allowed.txt' },
    });
    expect(isErrorResult(result)).toBe(true);
    const text = textOf(result);
    expect(text).toContain('ABB_UPLOAD_ALLOWLIST');
    // There is no UI/CLI upload-approval path — the message must not promise one.
    expect(text).not.toMatch(/bridge UI/i);
  });

  it('ABB_UPLOAD_ALLOWLIST pre-approval lets the upload through', async () => {
    const s2 = new BrowserSession('mcp-upload-allow', new MockBackend());
    await s2.start({ headless: true });
    const h2 = await startMcpServer(() => buildMcpServer(s2, { uploadAllowlist: ['/tmp/allowed.txt'] }), {
      transport: 'http',
      host: '127.0.0.1',
      port: 0,
      token: 'mcp-confirm-token-3',
    });
    const c2 = newClient();
    const t2 = new StreamableHTTPClientTransport(new URL(h2.url!), {
      requestInit: { headers: { authorization: 'Bearer mcp-confirm-token-3' } },
    });
    await c2.connect(t2);
    try {
      // Register live refs first (uploadFile resolves the ref through the session).
      await c2.callTool({ name: 'browser_snapshot', arguments: {} });
      const result = await c2.callTool({
        name: 'browser_upload',
        arguments: { ref: 'e2', filePath: '/tmp/allowed.txt' },
      });
      expect(isErrorResult(result)).toBe(false);
    } finally {
      await c2.close().catch(() => undefined);
      await t2.close().catch(() => undefined);
      await h2.close().catch(() => undefined);
      await s2.close().catch(() => undefined);
    }
  });
});
