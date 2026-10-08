/**
 * tests/mcp-approval-nav.test.ts — same-URL/reload approval bypass regression.
 *
 * Independently reproduced defect (05:35 at 9f30278): the approval
 * fingerprint bound `<url>::<snapshotId>` only. On same-URL navigation or
 * reload (or any navigation that did not rotate the snapshot), the
 * fingerprint did not change, refs were not cleared, and an approval (or a
 * pending ticket scope) issued before the navigation still matched after it
 * — so the old ref replayed against the rebuilt DOM.
 *
 * The fix: BrowserSession bumps a monotonic navGeneration and mints a fresh
 * pageNonce on EVERY committed navigation (goto, reload, back/forward, tab
 * open/switch/close), clears the per-snapshot ref registry, and approvals
 * bind the structured PageIdentity {url, snapshotId, navGeneration,
 * pageNonce} compared field-wise. Any navigation — even to the identical
 * URL — voids prior approvals and pending tickets.
 *
 * These tests fail on the old code and pass on the fix.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { BrowserSession } from '../src/bridge-core.js';
import { MockBackend } from './fixtures/mock-backend.js';
import { PolicyEngine } from '../src/security/policy.js';
import { ConfirmationQueue } from '../src/security/confirm.js';
import { buildMcpServer, startMcpServer } from '../src/mcp/server.js';

const execFileAsync = promisify(execFile);
/** Absolute file:// URL of the TS source, imported directly by child node processes (type stripping). */
const CONFIRM_TS_URL = pathToFileURL(
  fileURLToPath(new URL('../src/security/confirm.ts', import.meta.url)),
).href;

/**
 * Child program run via `node --input-type=module --eval`. Waits for the
 * goFile barrier (so N racers fire at once), then attempts to consume the
 * single approved 'race' ticket exactly once, printing WIN or LOSE.
 */
const RACE_CHILD = `
import { existsSync } from 'node:fs';
import { ConfirmationQueue } from ${JSON.stringify(CONFIRM_TS_URL)};
const [queueDir, goFile] = process.argv.slice(1);
const deadline = Date.now() + 15000;
while (!existsSync(goFile)) {
  if (Date.now() > deadline) { console.error('barrier timeout'); process.exit(3); }
  await new Promise((r) => setTimeout(r, 5));
}
const q = new ConfirmationQueue(queueDir);
const won = q.isApproved(
  { scopeKey: 'race', page: { url: 'https://example.test/', snapshotId: 's', navGeneration: 1, pageNonce: 'n' } },
  { action: 'type', ref: 'e9', text: 'race' },
);
process.stdout.write(won ? 'WIN' : 'LOSE');
`;

function newClient(): Client {
  return new Client({ name: 'mcp-approval-nav-test', version: '0.0.0' }, { capabilities: {} });
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

describe('MCP approval void-on-navigation (same-URL/reload bypass)', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'abb-approval-nav-'));
  const queue = new ConfirmationQueue(dataDir);
  let session: BrowserSession;
  let backend: MockBackend;
  let handle: Awaited<ReturnType<typeof startMcpServer>>;
  let client: Client;
  let transport: StreamableHTTPClientTransport;

  const HOME = 'https://example.test/';
  const snapshot = () => client.callTool({ name: 'browser_snapshot', arguments: {} });
  const type = (text: string) =>
    client.callTool({ name: 'browser_type', arguments: { ref: 'e2', text } });

  beforeAll(async () => {
    backend = new MockBackend();
    session = new BrowserSession('mcp-approval-nav-test', backend);
    await session.start({ headless: true });
    // Every browser_type requires confirmation here.
    const policy = new PolicyEngine({ highRiskActions: ['type'] });
    handle = await startMcpServer(() => buildMcpServer(session, { policy, confirmations: queue }), {
      transport: 'http',
      host: '127.0.0.1',
      port: 0,
      token: 'mcp-approval-nav-token',
    });
    client = newClient();
    transport = new StreamableHTTPClientTransport(new URL(handle.url!), {
      requestInit: { headers: { authorization: 'Bearer mcp-approval-nav-token' } },
    });
    await client.connect(transport);
  }, 60_000);

  afterAll(async () => {
    await client.close().catch(() => undefined);
    await transport.close().catch(() => undefined);
    await handle.close().catch(() => undefined);
    await session.close().catch(() => undefined);
  });

  it('REPRO: same-URL navigation voids the approval — retry needs a fresh ticket', async () => {
    await snapshot();
    const r1 = await type('sameurl-A');
    expect(isErrorResult(r1)).toBe(true);
    const t1 = ticketOf(r1);
    queue.resolve(t1, true); // operator approves, model has not retried yet

    // Navigate to the IDENTICAL url (no snapshot rotation on reload-style paths).
    await client.callTool({ name: 'browser_navigate', arguments: { url: HOME } });

    // Retry the EXACT approved call: must NOT silently act on the rebuilt page.
    const r2 = await type('sameurl-A');
    expect(isErrorResult(r2)).toBe(true);
    const t2 = ticketOf(r2);
    expect(t2).not.toBe(t1); // a FRESH ticket bound to the new page state
    expect(backend.typed.filter((t) => t.text === 'sameurl-A')).toHaveLength(0);
  });

  it('REPRO: reload voids the approval — retry needs a fresh ticket', async () => {
    await snapshot();
    const r1 = await type('reload-A');
    const t1 = ticketOf(r1);
    queue.resolve(t1, true);

    await client.callTool({ name: 'browser_reload', arguments: {} });

    const r2 = await type('reload-A');
    expect(isErrorResult(r2)).toBe(true);
    expect(ticketOf(r2)).not.toBe(t1);
    expect(backend.typed.filter((t) => t.text === 'reload-A')).toHaveLength(0);
  });

  it('back/forward navigation voids the approval', async () => {
    await snapshot();
    const r1 = await type('backfwd-A');
    const t1 = ticketOf(r1);
    queue.resolve(t1, true);

    await client.callTool({ name: 'browser_navigate', arguments: { url: 'https://other.test/page' } });
    await client.callTool({ name: 'browser_back', arguments: {} });

    const r2 = await type('backfwd-A');
    expect(isErrorResult(r2)).toBe(true);
    expect(ticketOf(r2)).not.toBe(t1);
    expect(backend.typed.filter((t) => t.text === 'backfwd-A')).toHaveLength(0);
  });

  it('tab open/switch voids the approval', async () => {
    await snapshot();
    const r1 = await type('tabswitch-A');
    const t1 = ticketOf(r1);
    queue.resolve(t1, true);

    await client.callTool({ name: 'browser_open_tab', arguments: { url: 'https://other.test/' } });
    await client.callTool({ name: 'browser_switch_tab', arguments: { tabId: 'tab-1' } });

    const r2 = await type('tabswitch-A');
    expect(isErrorResult(r2)).toBe(true);
    expect(ticketOf(r2)).not.toBe(t1);
    expect(backend.typed.filter((t) => t.text === 'tabswitch-A')).toHaveLength(0);
  });

  it('an old ref after navigation fails with the stale-ref error, never the old DOM', async () => {
    await snapshot(); // registers e2
    await client.callTool({ name: 'browser_reload', arguments: {} });
    // browser_get_text is NOT confirmation-gated, so this reaches ref resolution.
    const r = await client.callTool({ name: 'browser_get_text', arguments: { ref: 'e2' } });
    expect(isErrorResult(r)).toBe(true);
    expect(textOf(r)).toMatch(/unknown element ref|fresh browser_snapshot/i);
  });

  it('a fresh snapshot after navigation re-registers refs and approvals work again', async () => {
    await snapshot();
    const r1 = await type('recovery-A');
    const t1 = ticketOf(r1);
    queue.resolve(t1, true);
    await client.callTool({ name: 'browser_reload', arguments: {} });
    await snapshot(); // operator/model takes a fresh snapshot of the rebuilt page
    const r2 = await type('recovery-A');
    expect(isErrorResult(r2)).toBe(true); // still needs a FRESH ticket (new page identity)
    const t2 = ticketOf(r2);
    expect(t2).not.toBe(t1);
    queue.resolve(t2, true);
    const r3 = await type('recovery-A');
    expect(isErrorResult(r3)).toBe(false); // the fresh ticket authorizes the new page
    expect(backend.typed.at(-1)?.text).toBe('recovery-A');
  });

  it('cross-process consume race: exactly one of N processes wins the ticket', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'abb-race-'));
    const q = new ConfirmationQueue(dir);
    const action = { action: 'type', ref: 'e9', text: 'race' } as const;
    const page = { url: HOME, snapshotId: 's', navGeneration: 1, pageNonce: 'n' };
    const c = q.request('race', action, 'r', 'high', page);
    q.resolve(c.id, true);

    const goFile = join(dir, 'go');
    // 32 racers: on the pre-lock code this reliably produced multiple
    // winners (3 of 32 observed); the lock must serialize to exactly one.
    const N = 32;
    const racers = Array.from({ length: N }, () =>
      execFileAsync(process.execPath, ['--input-type=module', '--eval', RACE_CHILD, dir, goFile]),
    );
    // Let every child reach the start barrier, then release them at once.
    await new Promise((r) => setTimeout(r, 2500));
    writeFileSync(goFile, 'go');
    const results = await Promise.all(racers);
    const outcomes = results.map((r) => r.stdout.trim());
    expect(outcomes).toHaveLength(N);
    expect(outcomes.every((o) => o === 'WIN' || o === 'LOSE')).toBe(true);
    expect(outcomes.filter((o) => o === 'WIN')).toHaveLength(1);
  }, 60_000);
});
