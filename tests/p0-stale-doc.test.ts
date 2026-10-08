/**
 * tests/p0-stale-doc.test.ts — P0-5 stale-document reference protection.
 *
 * Refs are bound to the document identity observed at snapshot time
 * (navigation generation + document load id). A document replacement
 * between snapshot and action — reload, navigation, SPA replacement —
 * invalidates the ref: the bridge throws instead of silently re-grounding
 * against the new document.
 *
 * Regression coverage: same-tab navigation, reload (incl. same-URL, where
 * the URL does not change), SPA route change, DOM replacement, stale
 * snapshot. Frame navigation is a documented limitation (frame document
 * identity is not tracked; top-document identity is).
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
    const m = /^\/([a-z0-9-]+\.html|spa-route-two)$/.exec(req.url ?? '/');
    if (m) {
      try {
        const file = m[1] === 'spa-route-two' ? 'spa.html' : m[1]!;
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(readFileSync(join(PAGES, file), 'utf8'));
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
  const s = new BrowserSession(`p0stale-${Date.now()}-${Math.random()}`, new PlaywrightBackend());
  await s.start({ headless: true });
  await s.navigate(`${base}/${path}`);
  return s;
}

async function refByName(s: BrowserSession, name: string, role?: string): Promise<string> {
  const snap = await s.snapshot();
  const n = snap.nodes.find((x) => x.name === name && (!role || x.role === role));
  expect(n, `node "${name}"${role ? ` (role ${role})` : ''}`).toBeDefined();
  return n!.ref;
}

describe('P0-5 document-bound refs', () => {
  it('page-initiated same-URL reload invalidates the old ref (no blind re-ground)', async () => {
    const s = await sessionOn('nav.html');
    try {
      const ref = await refByName(s, 'Does nothing', 'button');
      // Page-initiated reload WITHOUT any bridge navigation call: the URL
      // does not change, but the document is replaced (new load id).
      const reloadRef = await refByName(s, 'Reload this page', 'button');
      const changed = s.waitForDocumentChange(8000);
      await s.click(reloadRef);
      await changed;
      // The old ref must NOT silently re-ground against the reloaded page.
      await expect(s.click(ref)).rejects.toThrow(/document changed since the snapshot/);
      // A fresh snapshot re-establishes valid refs.
      const ref2 = await refByName(s, 'Does nothing', 'button');
      await s.click(ref2); // must not throw the stale-document error
    } finally {
      await s.close();
    }
  });

  it('bridge-driven navigation still clears refs (unknown ref, not wrong element)', async () => {
    const s = await sessionOn('nav.html');
    try {
      const ref = await refByName(s, 'Does nothing');
      await s.navigate(`${base}/nav2.html`);
      await expect(s.click(ref)).rejects.toThrow(/unknown element ref/);
    } finally {
      await s.close();
    }
  });

  it('SPA route change: replaced element ref cannot act without re-observing', async () => {
    const s = await sessionOn('spa.html');
    try {
      const doomedRef = await refByName(s, 'Route one action', 'button');
      const routeRef = await refByName(s, 'Go to route two', 'button');
      await s.click(routeRef); // SPA pushState + #app replacement (same document)
      expect(s.url).toContain('spa-route-two');
      // WITHOUT taking a new snapshot: the replaced element's ref must not
      // blindly act — resolveTarget re-observes, finds it gone, and the
      // snapshot detects the page-initiated URL change (voiding approvals).
      await expect(s.click(doomedRef)).rejects.toThrow(/stale element ref/);
      // A fresh snapshot establishes the new route's controls.
      const snap = await s.snapshot();
      const routeTwo = snap.nodes.find((n) => n.name === 'Route two action');
      expect(routeTwo, 'route-two control in fresh snapshot').toBeDefined();
      await s.click(routeTwo!.ref); // new ref on the new route works
    } finally {
      await s.close();
    }
  });

  it('repeated target labels: re-grounding still refuses ambiguous matches', async () => {
    const s = await sessionOn('nav.html');
    try {
      // Both pages have h1 "Welcome"; re-grounding across documents is
      // refused outright (document check fires before semantic matching).
      const ref = await refByName(s, 'Does nothing', 'button');
      const reloadRef = await refByName(s, 'Reload this page', 'button');
      const changed = s.waitForDocumentChange(8000);
      await s.click(reloadRef);
      await changed;
      await expect(s.click(ref)).rejects.toThrow(/document changed/);
    } finally {
      await s.close();
    }
  });

  it('same-document DOM change still re-grounds (no false stale)', async () => {
    const s = await sessionOn('spa.html');
    try {
      // Click the route button WITHOUT taking a new snapshot first: the
      // document is the same (pushState does not replace the document),
      // so the ref stays valid and the click dispatches.
      const ref = await refByName(s, 'Go to route two', 'button');
      await s.click(ref);
      expect(s.url).toContain('spa-route-two');
    } finally {
      await s.close();
    }
  });
});
