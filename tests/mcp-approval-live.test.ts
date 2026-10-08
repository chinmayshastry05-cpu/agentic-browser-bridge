/**
 * tests/mcp-approval-live.test.ts — page-initiated navigation/reload regression.
 *
 * Remaining hole after 112ecb4 (user-verified caveat): pageIdentity() returns
 * the CACHED url/nonce from the last bridge-driven navigation; the backend's
 * live pageLoadId was only re-read in onNavigationCommitted. If the PAGE
 * itself navigated or reloaded (link click, JS redirect, form submit,
 * external reload) without a fresh snapshot, the cached identity was stale:
 * an approval bound to the old identity passed isApproved and then executed
 * against a changed page/DOM, with the stale ref resolving against the wrong
 * element.
 *
 * The fix: BrowserSession.assertLivePageIdentity(expected) re-reads the
 * backend's LIVE identity (actual URL + document load id, via the new
 * optional BrowserBackend.livePageIdentity()) and compares it with the
 * identity the approval was bound to. On mismatch it is treated exactly like
 * a committed navigation (refs cleared, snapshot nulled, navGeneration
 * bumped, fresh nonce) and it throws — nothing acts. The MCP server and the
 * agent loop call it after isApproved passes and BEFORE executing the action,
 * narrowing the TOCTOU window to the check→DOM-write gap.
 *
 * Honest limits (documented in docs/MCP_CHATGPT.md, not covered here):
 * backends without a live pageLoadId degrade to URL comparison only
 * (same-URL reloads not detectable there); pure DOM mutation without any
 * navigation/reload is not detectable by any backend.
 *
 * These tests fail on the pre-fix code (no assertLivePageIdentity at all —
 * the retry would ACT on the rebuilt page) and pass on the fix.
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

/**
 * MockBackend with a controllable LIVE page identity. Flipping liveLoadId /
 * liveUrl simulates a page-initiated reload / navigation with NO
 * bridge-driven call — the session's cached identity stays stale on purpose.
 */
class LiveMockBackend extends MockBackend {
  liveUrl = 'https://example.test/';
  liveLoadId: string | null = 'load-1';
  async livePageIdentity(): Promise<{ url: string; pageLoadId: string | null }> {
    return { url: this.liveUrl, pageLoadId: this.liveLoadId };
  }
}

function newClient(): Client {
  return new Client({ name: 'mcp-approval-live-test', version: '0.0.0' }, { capabilities: {} });
}

function textOf(result: unknown): string {
  const r = result as { content: Array<{ type: string; text: string }> };
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

describe('pre-action live page-identity check (page-initiated nav/reload)', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'abb-approval-live-'));
  const queue = new ConfirmationQueue(dataDir);
  let session: BrowserSession;
  let backend: LiveMockBackend;
  let handle: Awaited<ReturnType<typeof startMcpServer>>;
  let client: Client;
  let transport: StreamableHTTPClientTransport;

  const HOME = 'https://example.test/';
  const snapshot = () => client.callTool({ name: 'browser_snapshot', arguments: {} });
  const type = (text: string) =>
    client.callTool({ name: 'browser_type', arguments: { ref: 'e2', text } });

  beforeAll(async () => {
    backend = new LiveMockBackend();
    session = new BrowserSession('mcp-approval-live-test', backend);
    await session.start({ headless: true });
    // Every browser_type requires confirmation here.
    const policy = new PolicyEngine({ highRiskActions: ['type'] });
    handle = await startMcpServer(() => buildMcpServer(session, { policy, confirmations: queue }), {
      transport: 'http',
      host: '127.0.0.1',
      port: 0,
      token: 'live-test-token',
    });
    client = newClient();
    transport = new StreamableHTTPClientTransport(new URL(handle.url!), {
      requestInit: { headers: { authorization: 'Bearer live-test-token' } },
    });
    await client.connect(transport);
  }, 60_000);

  afterAll(async () => {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
    await handle.close().catch(() => undefined);
    await session.close().catch(() => undefined);
  });

  it('REPRO: page-initiated same-URL reload voids the approval — retry is blocked, nothing acts', async () => {
    await client.callTool({ name: 'browser_navigate', arguments: { url: HOME } });
    await snapshot();
    const r1 = await type('live-A');
    expect(isErrorResult(r1)).toBe(true);
    const t1 = ticketOf(r1);
    queue.resolve(t1, true); // operator approves; the page reloads ITSELF before the retry

    // Simulate the page reloading itself: live document identity changes,
    // NO bridge navigation call happens, cached identity stays stale.
    backend.liveLoadId = 'load-2';

    // Retry the EXACT approved call: isApproved passes on the stale cached
    // identity, but the pre-action live check must void it.
    const r2 = await type('live-A');
    expect(isErrorResult(r2)).toBe(true);
    expect(textOf(r2)).toMatch(/approval voided: page changed since approval/);
    expect(backend.typed.filter((t) => t.text === 'live-A')).toHaveLength(0);

    // The void bumped the generation: a further retry demands a FRESH ticket.
    const r3 = await type('live-A');
    expect(isErrorResult(r3)).toBe(true);
    expect(ticketOf(r3)).not.toBe(t1);
  });

  it('page-initiated cross-URL navigation voids the approval', async () => {
    await client.callTool({ name: 'browser_navigate', arguments: { url: HOME } });
    backend.liveUrl = HOME;
    backend.liveLoadId = 'load-3';
    await snapshot();
    const r1 = await type('live-B');
    const t1 = ticketOf(r1);
    queue.resolve(t1, true);

    // The page navigates itself elsewhere (bridge never called).
    backend.liveUrl = 'https://evil.test/phish';

    const r2 = await type('live-B');
    expect(isErrorResult(r2)).toBe(true);
    expect(textOf(r2)).toMatch(/approval voided: page changed since approval/);
    expect(backend.typed.filter((t) => t.text === 'live-B')).toHaveLength(0);
    backend.liveUrl = HOME; // restore for later tests
  });

  it('no page change: the live check passes and the approved action acts', async () => {
    backend.liveLoadId = 'load-4';
    await client.callTool({ name: 'browser_navigate', arguments: { url: HOME } });
    await snapshot();
    const r1 = await type('live-C');
    const t1 = ticketOf(r1);
    queue.resolve(t1, true);

    const r2 = await type('live-C');
    expect(isErrorResult(r2)).toBe(false);
    expect(backend.typed.filter((t) => t.text === 'live-C')).toHaveLength(1);
  });

  it('session-level: void clears refs — old ref is stale afterwards', async () => {
    const s = new BrowserSession('live-unit', backend);
    await s.start({ headless: true });
    try {
      backend.liveLoadId = 'load-5';
      await s.navigate(HOME);
      await s.snapshot(); // registers e2
      const identity = s.pageIdentity();
      // Sanity: no change → check passes.
      await s.assertLivePageIdentity(identity);
      // Page reloads itself.
      backend.liveLoadId = 'load-6';
      await expect(s.assertLivePageIdentity(identity)).rejects.toThrow(
        /page changed since approval/,
      );
      // Refs were cleared exactly like a committed navigation.
      await expect(s.type('e2', 'x')).rejects.toThrow(/unknown element ref/);
      // And the identity moved on (generation bumped).
      expect(s.pageIdentity().navGeneration).toBeGreaterThan(identity.navGeneration);
    } finally {
      await s.close().catch(() => undefined);
    }
  });

  it('session-level: backend without livePageIdentity degrades to URL comparison', async () => {
    const plain = new MockBackend(); // no livePageIdentity, no pageLoadId
    const s = new BrowserSession('live-degraded', plain);
    await s.start({ headless: true });
    try {
      await s.navigate(HOME);
      const identity = s.pageIdentity();
      await s.assertLivePageIdentity(identity); // no live data → passes
      // URL mismatch is still caught through the fallback path.
      const other = { ...identity, url: 'https://other.test/' };
      await expect(s.assertLivePageIdentity(other)).rejects.toThrow(/page changed since approval/);
    } finally {
      await s.close().catch(() => undefined);
    }
  });
});
