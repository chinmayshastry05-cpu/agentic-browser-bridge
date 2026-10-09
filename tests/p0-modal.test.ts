/**
 * tests/p0-modal.test.ts — P0-1 modal/occlusion/actionability (real browser).
 *
 * Real-site evidence (v0.1.3, independent): Flipkart's login overlay rendered
 * the underlying page in the tree while the bridge typed/clicked controls
 * BEHIND the modal; BBC's consent modal was visible while underlying search
 * proceeded. The bridge must refuse to act behind an active blocker.
 *
 * Uses real headless Chromium via PlaywrightBackend against local
 * deterministic fixtures (no external network):
 *   Fixture A (pages/modal.html): native <dialog> modal via showModal()
 *   Fixture B (pages/hydration.html): delayed aria-modal overlay (hydration)
 *
 * These are real-browser tests (not mocked): hit-testing runs the actual
 * document.elementFromPoint logic in a real page.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { ActionBlockedError, BrowserSession } from '../src/bridge-core.js';
import { PlaywrightBackend } from '../src/browser/playwright-backend.js';

const PAGES = new URL('./fixtures/pages/', import.meta.url).pathname;
let server: Server;
let base = '';

function page(name: string): string {
  return readFileSync(join(PAGES, name), 'utf8');
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = req.url ?? '/';
    const m = /^\/([a-z0-9-]+\.html)$/.exec(url);
    if (m) {
      try {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(page(m[1]!));
        return;
      } catch {
        // fall through to 404
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
  const s = new BrowserSession(`p0modal-${Date.now()}-${Math.random()}`, new PlaywrightBackend());
  await s.start({ headless: true });
  await s.navigate(`${base}/${path}`);
  return s;
}

async function refByName(s: BrowserSession, name: string): Promise<string> {
  const snap = await s.snapshot();
  const n = snap.nodes.find((x) => x.name === name);
  expect(n, `node named "${name}"`).toBeDefined();
  return n!.ref;
}

describe('P0-1 modal occlusion — native dialog (Fixture A)', () => {
  it('background button is NOT actionable while the modal dialog is open', async () => {
    const s = await sessionOn('modal.html');
    try {
      const backend = (s as unknown as { backend: import('../src/types.js').BrowserBackend }).backend;
      const snap = await s.snapshot();
      const btn = snap.nodes.find((x) => x.name === 'Background action');
      expect(btn, 'background button in snapshot').toBeDefined();
      // Direct backend hit-test: blocked, owned by the dialog.
      const res = await backend.hitTest!(btn!.selector);
      expect(res.actionable).toBe(false);
      expect(res.reason).toBe('outside-active-dialog');
      expect(res.dialog?.modal).toBe(true);
    } finally {
      await s.close();
    }
  });

  it('session.click on a background control throws ActionBlockedError (no click through)', async () => {
    const s = await sessionOn('modal.html');
    try {
      const ref = await refByName(s, 'Background action');
      await expect(s.click(ref)).rejects.toThrow(ActionBlockedError);
      // And the background button was NOT clicked.
      const text = await s.pageText();
      expect(text).not.toContain('background clicked');
    } finally {
      await s.close();
    }
  });

  it('dialog controls ARE actionable while the dialog is open', async () => {
    const s = await sessionOn('modal.html');
    try {
      const ref = await refByName(s, 'Accept');
      await s.click(ref); // must not throw
      const text = await s.pageText();
      expect(text).toContain('dialog accepted');
    } finally {
      await s.close();
    }
  });

  it('background control becomes actionable after the dialog closes', async () => {
    const s = await sessionOn('modal.html');
    try {
      const closeRef = await refByName(s, 'Close');
      await s.click(closeRef);
      const bgRef = await refByName(s, 'Background action');
      await s.click(bgRef); // must not throw now
      const text = await s.pageText();
      expect(text).toContain('background clicked');
    } finally {
      await s.close();
    }
  });

  it('ActionBlockedError carries structured blocked/active_modal detail', async () => {
    const s = await sessionOn('modal.html');
    try {
      const ref = await refByName(s, 'Background action');
      const err = await s.click(ref).catch((e) => e);
      expect(err).toBeInstanceOf(ActionBlockedError);
      expect(err.reason).toBe('active_modal');
      expect(err.detail.modal).toBeDefined();
      expect(err.detail.suggestedNextStep).toContain('User interaction required');
    } finally {
      await s.close();
    }
  });
});

describe('P0-1 modal occlusion — hydrated overlay (Fixture B)', () => {
  it('button is actionable before hydration, blocked after the overlay appears', async () => {
    const s = await sessionOn('hydration.html');
    try {
      // Before the 700ms hydration: no overlay yet.
      const backend = (s as unknown as { backend: import('../src/types.js').BrowserBackend }).backend;
      const snap = await s.snapshot();
      const btn = snap.nodes.find((x) => x.name === 'Early button (hidden behind overlay soon)');
      expect(btn, 'early button in snapshot').toBeDefined();
      const before = await backend.hitTest!(btn!.selector);
      expect(before.actionable).toBe(true);

      // After hydration: the aria-modal overlay covers it.
      await new Promise((r) => setTimeout(r, 1200));
      const after = await backend.hitTest!(btn!.selector);
      expect(after.actionable).toBe(false);
      expect(['occluded', 'outside-active-dialog']).toContain(after.reason);

      // The consent button inside the overlay IS actionable.
      const acceptRef = await refByName(s, 'Accept all');
      await s.click(acceptRef); // must not throw
      const text = await s.pageText();
      expect(text).toContain('consent accepted');
    } finally {
      await s.close();
    }
  });

  it('typing behind the overlay is refused', async () => {
    const s = await sessionOn('hydration.html');
    try {
      await new Promise((r) => setTimeout(r, 1200));
      const ref = await refByName(s, 'Early button (hidden behind overlay soon)');
      // focus() also goes through the occlusion gate.
      await expect(s.focus(ref)).rejects.toThrow(ActionBlockedError);
    } finally {
      await s.close();
    }
  });
});

describe('P0-1 modal occlusion — unmarked div overlay (Fixture C)', () => {
  it('blocks clicks behind a plain-div popup and identifies the occluder', async () => {
    const s = await sessionOn('div-overlay.html');
    try {
      const ref = await refByName(s, 'Background action');
      const err = await s.click(ref).catch((e) => e);
      expect(err).toBeInstanceOf(ActionBlockedError);
      expect(err.detail.hitReason).toBe('occluded');
      // No dialog markup: the occluder is the plain div, reported as-is.
      expect(err.detail.occluder?.tag).toBe('div');
      expect(err.detail.modal).toBeNull();
      expect(err.message).toMatch(/covers the target/);
    } finally {
      await s.close();
    }
  });

  it('the dismiss button inside the unmarked popup is actionable; background works after dismiss', async () => {
    const s = await sessionOn('div-overlay.html');
    try {
      const dismissRef = await refByName(s, 'No thanks');
      await s.click(dismissRef); // must not throw: the button is on top
      const bgRef = await refByName(s, 'Background action');
      await s.click(bgRef); // overlay gone: must not throw
      const text = await s.pageText();
      expect(text).toContain('background clicked');
    } finally {
      await s.close();
    }
  });
});

describe('shadow DOM click/type — Playwright backend (Fixture D)', () => {
  it('clicks and types inside an open shadow root through the session gate', async () => {
    // snapshot.ts pierces open shadow roots; the occlusion gate must resolve
    // in-shadow selectors too (page-backend hitTest now uses Playwright's
    // piercing scope.$ instead of document.querySelector in evaluate()).
    const s = await sessionOn('shadow.html');
    try {
      const inputRef = await refByName(s, 'shadow name');
      const btnRef = await refByName(s, 'Shadow greet');
      await s.type(inputRef, 'Ada');
      // The typed value reached the shadow field (live read-back).
      const live = await s.describeLiveTarget(inputRef);
      expect(live?.value).toContain('Ada');
      await s.click(btnRef);
      // The shadow button's handler ran (mirrored to document.title; the
      // shadow <p> itself is invisible to innerText-based pageText).
      const info = await s.pageInfo();
      expect(info.title).toContain('shadow hello, Ada');
    } finally {
      await s.close();
    }
  });
});
