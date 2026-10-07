/**
 * tests/mcp-approval-scope.test.ts — approval-scope bypass regression.
 *
 * Independently reproduced defect (v0.1.2): ConfirmationQueue.isApproved
 * matched on taskId/action/ref/url only, ignoring the action's text and
 * full args. Approving `browser_type e2 "first-harmless-test"` silently
 * authorized `browser_type e2 "different-unapproved-test"` on the same ref.
 *
 * These tests fail on the old code and pass on the fix. Approvals now bind
 * the canonical FULL args + page/target fingerprint + MCP session, expire
 * after a TTL, and are single-use.
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
  return new Client({ name: 'mcp-approval-scope-test', version: '0.0.0' }, { capabilities: {} });
}

function textOf(result: unknown): string {
  const r = result as { content: Array<{ type: string; text: string }>; isError?: boolean };
  return r.content[0]!.text;
}

function isErrorResult(result: unknown): boolean {
  return (result as { isError?: boolean }).isError === true;
}

function ticketOf(result: unknown): string {
  const m = /Confirmation ticket (confirm-[0-9a-f-]+)/.exec(textOf(result));
  if (!m) throw new Error(`expected a confirmation ticket, got: ${textOf(result).slice(0, 200)}`);
  return m[1]!;
}

describe('MCP approval scope (exact args, session, page, TTL, one-time)', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'abb-approval-scope-'));
  const queue = new ConfirmationQueue(dataDir);
  let session: BrowserSession;
  let backend: MockBackend;
  let handle: Awaited<ReturnType<typeof startMcpServer>>;
  let client: Client;
  let transport: StreamableHTTPClientTransport;

  const type = (text: string, c: Client = client) =>
    c.callTool({ name: 'browser_type', arguments: { ref: 'e2', text } });

  beforeAll(async () => {
    backend = new MockBackend();
    session = new BrowserSession('mcp-approval-scope-test', backend);
    await session.start({ headless: true });
    // Every browser_type requires confirmation here.
    const policy = new PolicyEngine({ highRiskActions: ['type'] });
    handle = await startMcpServer(() => buildMcpServer(session, { policy, confirmations: queue }), {
      transport: 'http',
      host: '127.0.0.1',
      port: 0,
token: 'mcp-approval-scope-token'
    });
    client = newClient();
    transport = new StreamableHTTPClientTransport(new URL(handle.url!), {
      requestInit: { headers: { authorization: 'Bearer mcp-approval-scope-token' } },
    });
    await client.connect(transport);
    // Populate the snapshot registry so ref e2 resolves.
    await client.callTool({ name: 'browser_snapshot', arguments: {} });
  }, 60_000);

  afterAll(async () => {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
    await handle.close().catch(() => undefined);
    await session.close().catch(() => undefined);
  });

  it('REPRO: approving text A does not authorize text B on the same ref', async () => {
    const r1 = await type('first-harmless-test');
    expect(isErrorResult(r1)).toBe(true);
    const t1 = ticketOf(r1);
    queue.resolve(t1, true);

    // The bypass: same ref, DIFFERENT text must require its own ticket.
    const r2 = await type('different-unapproved-test');
    expect(isErrorResult(r2)).toBe(true);
    const t2 = ticketOf(r2);
    expect(t2).not.toBe(t1);
    // The unapproved text was never typed.
    expect(backend.typed.map((t) => t.text)).not.toContain('different-unapproved-test');

    // Approving the exact call unblocks exactly that call.
    queue.resolve(t2, true);
    const r3 = await type('different-unapproved-test');
    expect(isErrorResult(r3)).toBe(false);
    expect(backend.typed.at(-1)?.text).toBe('different-unapproved-test');
  });

  it('the same exact call a second time needs a fresh ticket (one-time use)', async () => {
    const r = await type('different-unapproved-test');
    expect(isErrorResult(r)).toBe(true);
    expect(ticketOf(r)).toMatch(/^confirm-/);
  });

  it('dedup: two pending confirms with different text get two tickets', async () => {
    const ra = await type('alpha-text');
    const rb = await type('beta-text');
    expect(isErrorResult(ra)).toBe(true);
    expect(isErrorResult(rb)).toBe(true);
    const ta = ticketOf(ra);
    const tb = ticketOf(rb);
    expect(ta).not.toBe(tb);
    expect(queue.get(ta)).not.toBeNull();
    expect(queue.get(tb)).not.toBeNull();
  });

  it("session A's approval does not authorize session B", async () => {
    const clientB = newClient();
    const transportB = new StreamableHTTPClientTransport(new URL(handle.url!), {
      requestInit: { headers: { authorization: 'Bearer mcp-approval-scope-token' } },
    });
    await clientB.connect(transportB);
    try {
      // B requests the action and gets its own ticket.
      const rB1 = await type('session-b-text', clientB);
      expect(isErrorResult(rB1)).toBe(true);
      const tB = ticketOf(rB1);

      // A requests and approves the IDENTICAL action in A's session.
      const rA1 = await type('session-b-text', client);
      expect(isErrorResult(rA1)).toBe(true);
      queue.resolve(ticketOf(rA1), true);
      const rA2 = await type('session-b-text', client);
      expect(isErrorResult(rA2)).toBe(false);

      // B retries without approving tB: still blocked, same pending ticket.
      const rB2 = await type('session-b-text', clientB);
      expect(isErrorResult(rB2)).toBe(true);
      expect(ticketOf(rB2)).toBe(tB);
      expect(backend.typed.filter((t) => t.text === 'session-b-text')).toHaveLength(1);
    } finally {
      await clientB.close().catch(() => undefined);
      await transportB.close().catch(() => undefined);
    }
  });
});
