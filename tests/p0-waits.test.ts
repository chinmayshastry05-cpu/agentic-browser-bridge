/**
 * tests/p0-waits.test.ts — P0-6 false-positive generic waits.
 *
 * Real-site evidence pattern: a generic "wait for h1" falsely passed
 * because the OLD page's h1 still existed after a click-driven navigation.
 * Waits must be generation-aware: a selector left over on the old page
 * must not satisfy a post-navigation wait.
 *
 * Fixture D/E: nav.html and nav2.html BOTH contain <h1>Welcome</h1> — the
 * old selector exists on both pages, which is exactly the false-positive
 * trap.
 *
 * Real-browser tests (headless Chromium, local fixtures).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { BrowserSession } from '../src/bridge-core.js';
import { PlaywrightBackend } from '../src/browser/playwright-backend.js';

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

async function sessionOn(path: string): Promise<BrowserSession> {
  const s = new BrowserSession(`p0wait-${Date.now()}-${Math.random()}`, new PlaywrightBackend());
  await s.start({ headless: true });
  await s.navigate(`${base}/${path}`);
  return s;
}

describe('P0-6 generation-aware waits', () => {
  it('DOCUMENTS the trap: plain waitForSelector(h1) passes immediately on the old page', async () => {
    const s = await sessionOn('nav.html');
    try {
      // h1 already exists on nav.html — a post-navigation wait for h1
      // would falsely succeed without any navigation happening.
      const t0 = Date.now();
      await s.waitForSelector('h1', 'visible', 5000);
      expect(Date.now() - t0).toBeLessThan(2000); // immediate: the trap
    } finally {
      await s.close();
    }
  });

  it('expectNewDocument: old h1 does NOT satisfy the wait; resolves only after navigation', async () => {
    const s = await sessionOn('nav.html');
    try {
      const snap = await s.snapshot();
      const link = snap.nodes.find((n) => n.name === 'Go to page two')!;
      // Kick off the generation-aware wait BEFORE clicking.
      const waited = s.waitForSelector('h1', 'visible', 8000, { awaitNewDocument: true });
      // Give the waiter a moment to establish its baseline, then navigate
      // via a real click (page-initiated navigation).
      await new Promise((r) => setTimeout(r, 300));
      await s.click(link.ref);
      await waited; // must resolve: nav2.html loaded (also has h1)
      expect(s.url).toContain('nav2.html');
    } finally {
      await s.close();
    }
  });

  it('expectNewDocument times out when no navigation happens', async () => {
    const s = await sessionOn('nav.html');
    try {
      await expect(
        s.waitForSelector('h1', 'visible', 1200, { awaitNewDocument: true }),
      ).rejects.toThrow(/timed out.*document to change/);
    } finally {
      await s.close();
    }
  });

  it('waitForDocumentChange resolves on same-URL reload (loadId, not URL)', async () => {
    const s = await sessionOn('nav.html');
    try {
      const changed = s.waitForDocumentChange(8000);
      await new Promise((r) => setTimeout(r, 200));
      await s.reload(); // bridge-driven reload also changes the document
      await changed;
    } finally {
      await s.close();
    }
  });
});

describe('slow pages — late hydration (Fixture E)', () => {
  it('snapshot right after navigate misses late content; browser_wait_for catches up', async () => {
    const s = await sessionOn('slow.html');
    try {
      // Immediately after navigate (domcontentloaded): shell only.
      const early = await s.snapshot();
      expect(early.nodes.some((n) => n.name === 'Late action')).toBe(false);
      // The documented slow-page workflow: wait for the late selector.
      await s.waitForSelector('#late-content h2', 'visible', 10_000);
      const late = await s.snapshot();
      const btn = late.nodes.find((n) => n.name === 'Late action');
      expect(btn, 'late button appears after hydration').toBeDefined();
      await s.click(btn!.ref); // must not throw
    } finally {
      await s.close();
    }
  });

  it('waiting for content that never arrives fails with a clear, actionable error', async () => {
    const s = await sessionOn('slow.html');
    try {
      const err = await s.waitForSelector('#never-appears', 'visible', 1500).catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toMatch(/waited 1500ms/);
      expect(err.message).toMatch(/raise timeoutMs/);
    } finally {
      await s.close();
    }
  });
});
