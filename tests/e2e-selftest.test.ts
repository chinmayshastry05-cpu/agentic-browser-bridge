/**
 * tests/e2e-selftest.test.ts — scripted end-to-end self-test (step 4).
 *
 * A single local "test site set" (no external network) exercised through a
 * real headless Chromium via BrowserSession, covering the phase-2 hardening
 * areas end to end:
 *   1. login popup  -> navigate refuses with a clear login-wall error
 *   2. iframe       -> frame snapshot, click inside the frame, verify effect
 *   3. shadow DOM   -> type + click inside an open shadow root, verify effect
 *   4. SPA          -> route change re-renders; new content found, old refs dead
 *
 * This file IS the CI e2e gate: `npm test` runs it on every push
 * (.github/workflows/bridge.yml). Each scenario logs its steps so the CI
 * log reads as a self-test report.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { BrowserSession } from '../src/bridge-core.js';
import { PlaywrightBackend } from '../src/browser/playwright-backend.js';

const FIX = new URL('./fixtures/', import.meta.url).pathname;
const PAGES = join(FIX, 'pages');

function file(rel: string): string {
  return readFileSync(join(FIX, rel), 'utf8');
}

let server: Server;
let base = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = req.url ?? '/';
    const routes: Record<string, string> = {
      '/login': 'login-wall.html',
      '/framed': 'e2e-framed.html',
      '/frame.html': 'frame.html',
    };
    const pageMatch = /^\/pages\/([a-z0-9-]+\.html)$/.exec(url);
    try {
      if (routes[url]) {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(file(routes[url]!));
        return;
      }
      if (pageMatch) {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(readFileSync(join(PAGES, pageMatch[1]!), 'utf8'));
        return;
      }
    } catch {
      // fall through to 404
    }
    res.writeHead(404);
    res.end('not found');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  console.log(`[e2e-selftest] test site set at ${base} (login, framed, shadow, spa)`);
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
});

async function sessionOn(path: string): Promise<BrowserSession> {
  const s = new BrowserSession(`e2e-${Date.now()}-${Math.random()}`, new PlaywrightBackend());
  await s.start({ headless: true });
  await s.navigate(`${base}${path}`);
  return s;
}

async function refByName(s: BrowserSession, name: string, role?: string): Promise<string> {
  const snap = await s.snapshot();
  const n = snap.nodes.find((x) => x.name === name && (!role || x.role === role));
  expect(n, `node named "${name}"${role ? ` with role ${role}` : ''} in snapshot`).toBeDefined();
  return n!.ref;
}

function step(n: number, text: string): void {
  console.log(`[e2e-selftest] step ${n}: ${text}`);
}

describe('e2e self-test: local site set', () => {
  it('1/4 login popup: navigation is refused with a clear message, never faked', async () => {
    const s = new BrowserSession(`e2e-login-${Date.now()}`, new PlaywrightBackend());
    await s.start({ headless: true });
    try {
      step(1, 'navigate to the login-walled page');
      const err = await s.navigate(`${base}/login`).catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      step(2, 'assert the refusal names the wall and the no-credentials policy');
      expect(err.message).toMatch(/login wall detected/);
      expect(err.message).toMatch(/no credentials/);
      step(3, 'refused — the agent cannot proceed to type credentials or fake success');
    } finally {
      await s.close();
    }
  }, 60_000);

  it('2/4 iframe: frame snapshot, click inside the frame, effect verified', async () => {
    const s = await sessionOn('/framed');
    try {
      step(1, 'list frames and find the inner frame');
      const frames = await s.listFrames();
      const inner = frames.find((f) => f.name === 'inner') ?? frames[0]!;
      expect(inner, 'inner frame listed').toBeDefined();
      step(2, 'snapshot inside the frame and click its button');
      const fsnap = await s.frameSnapshot(inner.id);
      const btn = fsnap.nodes.find((n) => n.name === 'Frame button');
      expect(btn, 'frame button in frame snapshot').toBeDefined();
      await s.click(btn!.ref);
      step(3, 're-snapshot the frame and verify the click effect');
      const fsnap2 = await s.frameSnapshot(inner.id);
      expect(fsnap2.nodes.some((n) => n.name === 'frame clicked')).toBe(true);
    } finally {
      await s.close();
    }
  }, 60_000);

  it('3/4 shadow DOM: type and click inside an open shadow root', async () => {
    const s = await sessionOn('/pages/shadow.html');
    try {
      step(1, 'snapshot pierces the open shadow root');
      const inputRef = await refByName(s, 'shadow name');
      const btnRef = await refByName(s, 'Shadow greet');
      step(2, 'type into the shadow input and read the value back live');
      await s.type(inputRef, 'Ada');
      const live = await s.describeLiveTarget(inputRef);
      expect(live?.value).toContain('Ada');
      step(3, 'click the shadow button and verify its handler ran');
      await s.click(btnRef);
      const info = await s.pageInfo();
      expect(info.title).toContain('shadow hello, Ada');
    } finally {
      await s.close();
    }
  }, 60_000);

  it('4/4 SPA: route change re-renders; new content found, old refs dead', async () => {
    const s = await sessionOn('/pages/spa.html');
    try {
      step(1, 'snapshot route one and take a ref to its button');
      const oldRef = await refByName(s, 'Route one action', 'button');
      const oldSnap = await s.snapshot();
      expect(oldSnap.nodes.some((n) => n.name === 'Route two action')).toBe(false);
      step(2, 'click the route button (pushState + DOM replacement)');
      await s.click(await refByName(s, 'Go to route two', 'button'));
      step(3, 'wait for the new route content (no re-snapshot yet)');
      await s.waitForSelector('#routeTwoBtn', 'visible', 5000);
      step(4, 'the pre-route ref is dead — acting on it throws stale-ref');
      await expect(s.click(oldRef)).rejects.toThrow(/stale element ref/);
      step(5, 'a fresh snapshot establishes the new route controls');
      const snap = await s.snapshot();
      const routeTwo = snap.nodes.find((n) => n.name === 'Route two action');
      expect(routeTwo, 'route-two control in fresh snapshot').toBeDefined();
      await s.click(routeTwo!.ref); // new ref on the new route works
    } finally {
      await s.close();
    }
  }, 60_000);
});
