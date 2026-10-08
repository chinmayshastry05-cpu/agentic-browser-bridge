/**
 * tests/p0-verify.test.ts — P0-3 action acknowledgement vs verified outcome.
 *
 * Real-site evidence (v0.1.3, independent): Flipkart search/suggestion clicks
 * returned "ok" while the page remained unchanged (no navigation, no
 * results). A browser API returning without throwing is NOT proof of
 * user-visible success.
 *
 * Drives the REAL MCP tool registry (src/tools.ts) against real headless
 * Chromium (PlaywrightBackend) and local fixtures:
 *   Fixture D (pages/nav.html): #noopBtn dispatches a click with no effect;
 *     #goLink navigates to nav2.html.
 *
 * Real-browser tests (not mocked).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { BrowserSession } from '../src/bridge-core.js';
import { PlaywrightBackend } from '../src/browser/playwright-backend.js';
import { createToolRegistry } from '../src/tools.js';
import type { ToolResult } from '../src/types.js';

const PAGES = new URL('./fixtures/pages/', import.meta.url).pathname;
let server: Server;
let base = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    const m = /^\/([a-z0-9-]+\.html)$/.exec(req.url ?? '/');
    if (m) {
      try {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(readFileSync(join(PAGES, m[1]!), 'utf8'));
        return;
      } catch {
        // fall through
      }
    }
    res.writeHead(404);
    res.end('not found');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

async function setup(): Promise<{
  session: BrowserSession;
  call: (name: string, args: Record<string, unknown>) => Promise<ToolResult>;
}> {
  const session = new BrowserSession(`p0verify-${Date.now()}-${Math.random()}`, new PlaywrightBackend());
  await session.start({ headless: true });
  await session.navigate(`${base}/nav.html`);
  const registry = createToolRegistry(session);
  const call = async (name: string, args: Record<string, unknown>) => {
    const h = registry.get(name);
    expect(h, `tool ${name}`).toBeDefined();
    return h!.handle(args);
  };
  return { session, call };
}

async function refByName(
  call: (name: string, args: Record<string, unknown>) => Promise<ToolResult>,
  name: string,
): Promise<string> {
  const res = await call('browser_snapshot', {});
  const tree = (res.data as { tree: string }).tree;
  const m = new RegExp(`\\[(e\\d+)\\] \\w+ "${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`).exec(tree);
  expect(m, `ref for "${name}" in tree`).toBeTruthy();
  return m![1]!;
}

describe('P0-3 accepted vs verified (real tool results)', () => {
  it('click that dispatches but changes nothing: accepted=true, verified=false', async () => {
    const { session, call } = await setup();
    try {
      const ref = await refByName(call, 'Does nothing');
      const res = await call('browser_click', { ref });
      expect(res.ok).toBe(true); // dispatched without error
      const data = res.data as { accepted: boolean; verification: { verified: boolean; method: string; detail: string } };
      expect(data.accepted).toBe(true);
      expect(data.verification.verified).toBe(false);
      expect(data.verification.method).toBe('dom-diff');
    } finally {
      await session.close();
    }
  });

  it('click that navigates: accepted=true, verified=true via url-changed', async () => {
    const { session, call } = await setup();
    try {
      const ref = await refByName(call, 'Go to page two');
      const res = await call('browser_click', { ref });
      expect(res.ok).toBe(true);
      const data = res.data as { accepted: boolean; verification: { verified: boolean; method: string } };
      expect(data.accepted).toBe(true);
      expect(data.verification.verified).toBe(true);
      expect(data.verification.method).toBe('url-changed');
    } finally {
      await session.close();
    }
  });

  it('type into a field: verified=true via field-value', async () => {
    const { session, call } = await setup();
    try {
      // nav.html has no input; use the modal fixture page instead via direct session.
      await session.navigate(`${base}/modal.html`);
      // Close the dialog first via its Close control (real flow, no bypass).
      const snap = await session.snapshot();
      const close = snap.nodes.find((n) => n.name === 'Close')!;
      await session.click(close.ref);
      const snap2 = await session.snapshot();
      const input = snap2.nodes.find((n) => n.name === 'background input')!;
      const res = await call('browser_type', { ref: input.ref, text: 'hello' });
      expect(res.ok).toBe(true);
      const data = res.data as { verification: { verified: boolean; method: string } };
      expect(data.verification.verified).toBe(true);
      expect(data.verification.method).toBe('field-value');
    } finally {
      await session.close();
    }
  });

  it('blocked-by-modal click returns structured blocked/active_modal, not ok', async () => {
    const { session, call } = await setup();
    try {
      await session.navigate(`${base}/modal.html`);
      const snap = await session.snapshot();
      const bg = snap.nodes.find((n) => n.name === 'Background action')!;
      const res = await call('browser_click', { ref: bg.ref });
      expect(res.ok).toBe(false);
      const data = res.data as { blocked: boolean; reason: string; modal: unknown; suggestedNextStep: string };
      expect(data.blocked).toBe(true);
      expect(data.reason).toBe('active_modal');
      expect(data.modal).toBeDefined();
      expect(data.suggestedNextStep).toContain('User interaction required');
    } finally {
      await session.close();
    }
  });
});
