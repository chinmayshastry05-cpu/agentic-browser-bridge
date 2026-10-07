/**
 * tests/public-sites.test.ts — REAL public-site smoke test.
 *
 * Harmless public fixture ONLY: https://example.com (no logins, no forms
 * submitted, no purchases, no uploads, no private data). Uses a DISPOSABLE
 * browser profile: Playwright's chromium.launch() always creates a fresh
 * isolated temporary user-data-dir — the user's real profile is never
 * touched.
 *
 * SKIPPABLE OFFLINE: a module-level probe launches a real Chromium and
 * tries to reach the fixture; the whole file is skipped when the browser
 * cannot reach it (offline CI, or sandboxes whose egress proxy refuses
 * Chromium), so the suite stays green.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserSession } from '../src/bridge-core.js';
import { PlaywrightBackend } from '../src/browser/playwright-backend.js';
import type { BrowserStartOptions } from '../src/types.js';

/** Egress proxy from env, split into Playwright's {server, username, password} shape. */
function proxyFromEnv(): BrowserStartOptions['proxy'] | undefined {
  const raw =
    process.env['HTTPS_PROXY'] ??
    process.env['https_proxy'] ??
    process.env['HTTP_PROXY'] ??
    process.env['http_proxy'];
  if (!raw) return undefined;
  try {
    const u = new URL(raw);
    return {
      server: `${u.protocol}//${u.host}`,
      ...(u.username ? { username: decodeURIComponent(u.username) } : {}),
      ...(u.password ? { password: decodeURIComponent(u.password) } : {}),
    };
  } catch {
    return undefined;
  }
}

const PROXY = proxyFromEnv();

// Module-level probe: can a REAL disposable-profile Chromium reach the fixture?
// (Node's fetch may succeed through a proxy that still refuses Chromium, so
// probing with fetch alone would give false confidence.)
let browserOnline = false;
try {
  const { chromium } = await import('playwright');
  const probe = await chromium.launch({
    headless: true,
    ...(PROXY ? { proxy: PROXY } : {}),
  });
  const page = await probe.newPage();
  await page.goto('https://example.com/', { waitUntil: 'domcontentloaded', timeout: 25_000 });
  browserOnline = (await page.title()).includes('Example Domain');
  await probe.close().catch(() => undefined);
} catch {
  browserOnline = false;
}
if (!browserOnline) {
  console.log(
    '[public-sites] browser cannot reach https://example.com from here (offline or proxy-blocked Chromium) — skipping real public-site tests',
  );
}

describe.skipIf(!browserOnline)('public sites (https://example.com)', () => {
  let session: BrowserSession;
  const shotsDir = mkdtempSync(join(tmpdir(), 'abb-public-'));

  beforeAll(async () => {
    // Disposable profile: Playwright launch() uses a fresh temporary
    // user-data-dir per instance (never the user's real profile).
    session = new BrowserSession('public-sites-test', new PlaywrightBackend());
    await session.start({ headless: true, ...(PROXY ? { proxy: PROXY } : {}) });
  });

  afterAll(async () => {
    await session.close().catch(() => undefined);
  });

  it('navigates, snapshots, and verifies title', async () => {
    await session.navigate('https://example.com/');
    const snap = await session.snapshot();
    expect(snap.title).toBe('Example Domain');
    expect(snap.url).toContain('example.com');
    // NOTE (2026-10-08, verified via curl): example.com no longer renders an
    // <h1> — the live <body> is a single <p> plus <script src=/s.js>. The DOM
    // walker only captures interactable/structural elements (a[href], button,
    // input, h1-h3, img[alt], form, table, landmarks), so no heading node is
    // expected from the current live DOM. Title + URL are the stable contract.
    expect(Array.isArray(snap.nodes)).toBe(true);
  });

  it('takes a screenshot that is a real PNG file', async () => {
    await session.navigate('https://example.com/');
    const path = join(shotsDir, 'example.png');
    await session.screenshot(path);
    expect(existsSync(path)).toBe(true);
    expect(statSync(path).size).toBeGreaterThan(1000);
  });

  it('reports the live page URL', async () => {
    await session.navigate('https://example.com/');
    expect(session.url).toContain('example.com');
  });
});
