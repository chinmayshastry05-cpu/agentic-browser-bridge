/**
 * tests/extension-installed.test.ts — GENUINE installed-extension smoke test.
 *
 * NOT a fake peer: launches REAL headless Chromium (full build — headless
 * shell does not support extensions) with the actual extension/ directory
 * loaded via --load-extension, connects an ExtensionRelay, and drives the
 * local v1.html fixture through BrowserSession.
 *
 * This is the test for the navigation-readiness race: session.navigate()
 * used to fail with "content script unreachable" because chrome.tabs.update
 * resolves before the content script is injected. The background now waits
 * for the content script's `abb-ready` announcement (see extension/); the
 * navigate below must not throw that error.
 *
 * Availability guard: a short probe (launch + peer wait) runs at module
 * load; if full Chromium with extensions is unavailable in this environment
 * the whole suite skips with a loud console line — never silently.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { chromium, type BrowserContext } from 'playwright';
import { BrowserSession } from '../src/bridge-core.js';
import { ExtensionBackend } from '../src/browser/extension-backend.js';
import { ExtensionRelay, DEFAULT_EXTENSION_RELAY_PORT } from '../src/browser/extension-relay.js';

const HERE = new URL('./', import.meta.url).pathname;
const EXT_DIR = resolve(HERE, '../extension');
const FIXTURE_URL = `file://${resolve(HERE, './fixtures/v1.html')}`;

/**
 * Unpacked-extension id Chromium derives from the extension's absolute path:
 * first 16 bytes of SHA256(path), each byte as two 'a'-'p' chars. Needed to
 * seed the "allow access to file URLs" preference before first launch, so
 * content scripts run on file:// fixtures.
 */
function unpackedExtensionId(absPath: string): string {
  const digest = createHash('sha256').update(absPath, 'utf8').digest();
  let id = '';
  for (let i = 0; i < 16; i++) {
    const b = digest[i]!;
    id += String.fromCharCode(0x61 + (b >> 4), 0x61 + (b & 0xf));
  }
  return id;
}

/** Pairing token the test relay expects; seeded into the extension below. */
const EXT_TEST_TOKEN = 'ext-installed-test-token-123';

/** Find the extension's service worker (it hosts background.js). */
async function extensionWorker(ctx: BrowserContext) {
  const found = ctx.serviceWorkers().find((w) => w.url().includes('background'));
  if (found) return found;
  return ctx.waitForEvent('serviceworker', { timeout: 20_000 });
}

/**
 * Seed the relay pairing token into the extension's chrome.storage and
 * force a reconnect. The background's eager first connect has no token and
 * is rejected (401) by design; this pairs it for real, like the popup flow.
 */
async function seedPairingToken(ctx: BrowserContext, token: string): Promise<void> {
  const sw = await extensionWorker(ctx);
  await sw.evaluate(
    `(async () => {
      await chrome.storage.local.set({ pairingToken: ${JSON.stringify(token)} });
      try { ws.close(); } catch (e) {}
      await connect();
    })()`,
  );
}

/** Launch Chromium with the extension and wait for the paired relay peer. */
async function launchWithExtension(opts: {
  userDataDir: string;
  seedFileAccess: boolean;
  peerTimeoutMs: number;
}): Promise<{ ctx: BrowserContext; relay: ExtensionRelay } | null> {
  if (opts.seedFileAccess) {
    writeFileSync(
      join(opts.userDataDir, 'Preferences'),
      JSON.stringify({
        extensions: { settings: { [unpackedExtensionId(EXT_DIR)]: { file_access: true } } },
      }),
    );
  }
  const ctx = await chromium.launchPersistentContext(opts.userDataDir, {
    channel: 'chromium', // full build — headless shell cannot load extensions
    headless: true,
    timeout: 60_000,
    args: [
      `--disable-extensions-except=${EXT_DIR}`,
      `--load-extension=${EXT_DIR}`,
      '--no-first-run',
    ],
  });
  const relay = new ExtensionRelay({ pairingToken: EXT_TEST_TOKEN });
  try {
    await relay.listen(DEFAULT_EXTENSION_RELAY_PORT);
    await seedPairingToken(ctx, EXT_TEST_TOKEN);
    await relay.waitForPeer(opts.peerTimeoutMs);
    return { ctx, relay };
  } catch {
    await relay.close().catch(() => undefined);
    await ctx.close().catch(() => undefined);
    return null;
  }
}

// ---- availability probe (short timeouts) ---------------------------------
const probeDir = mkdtempSync(join(tmpdir(), 'abb-ext-probe-'));
const probe = await launchWithExtension({
  userDataDir: probeDir,
  seedFileAccess: false,
  peerTimeoutMs: 12_000,
}).catch(() => null);
const extAvailable = probe !== null;
if (probe) {
  await probe.relay.close().catch(() => undefined);
  await probe.ctx.close().catch(() => undefined);
}
rmSync(probeDir, { recursive: true, force: true });

if (!extAvailable) {
  // Loud skip — never silent.
  console.log(
    '[extension-installed] full Chromium with extensions unavailable here — skipping genuine smoke test',
  );
}

describe.skipIf(!extAvailable)('installed extension smoke (genuine)', () => {
  let ctx: BrowserContext;
  let relay: ExtensionRelay;
  let session: BrowserSession;
  let userDataDir: string;
  let shotDir: string;

  beforeAll(async () => {
    userDataDir = mkdtempSync(join(tmpdir(), 'abb-ext-smoke-'));
    shotDir = mkdtempSync(join(tmpdir(), 'abb-ext-shot-'));
    const launched = await launchWithExtension({
      userDataDir,
      seedFileAccess: true,
      peerTimeoutMs: 20_000,
    });
    if (!launched) throw new Error('extension peer did not connect in the smoke run');
    ctx = launched.ctx;
    relay = launched.relay;
    const backend = new ExtensionBackend({ relay });
    session = new BrowserSession('ext-smoke', backend);
    await session.start({ headless: true });
  }, 90_000);

  afterAll(async () => {
    await session?.close().catch(() => undefined);
    await relay?.close().catch(() => undefined);
    await ctx?.close().catch(() => undefined);
    if (userDataDir) rmSync(userDataDir, { recursive: true, force: true });
    if (shotDir) rmSync(shotDir, { recursive: true, force: true });
  });

  it('navigate() does not throw "content script unreachable"', async () => {
    // The old race: tabs.update resolved before content-script injection and
    // the immediate pageInfo inside navigate() threw "content script
    // unreachable". The background's waitReady handshake must prevent that.
    const nav = await session.navigate(FIXTURE_URL);
    expect(nav.title).toBe('ABB v1 fixture');
    expect(nav.url).toBe(FIXTURE_URL);
  }, 30_000);

  it('snapshot() sees the fixture heading', async () => {
    const snap = await session.snapshot();
    const heading = snap.nodes.find(
      (n) => n.role === 'heading' && (n.name || '').includes('ABB v1 fixture'),
    );
    expect(heading).toBeDefined();
    expect(snap.url).toBe(FIXTURE_URL);
  }, 30_000);

  it('click round-trip: button changes page text', async () => {
    const snap = await session.snapshot();
    const greet = snap.nodes.find((n) => n.role === 'button' && n.name === 'Greet me');
    expect(greet).toBeDefined();
    await session.click(greet!.ref);
    const text = await session.pageText();
    expect(text).toContain('Hello, stranger!');
  }, 30_000);

  it('type round-trip: typed value reaches the page', async () => {
    const snap = await session.snapshot();
    const name = snap.nodes.find((n) => n.role === 'textbox' && n.selector === '#name');
    const greet = snap.nodes.find((n) => n.role === 'button' && n.name === 'Greet me');
    expect(name).toBeDefined();
    expect(greet).toBeDefined();
    await session.type(name!.ref, 'Ada');
    await session.click(greet!.ref);
    const text = await session.pageText();
    expect(text).toContain('Hello, Ada!');
  }, 30_000);

  it('screenshot writes a real PNG (>1KB)', async () => {
    const path = join(shotDir, 'smoke.png');
    await session.screenshot(path);
    expect(existsSync(path)).toBe(true);
    const bytes = readFileSync(path);
    expect(bytes.length).toBeGreaterThan(1024);
    expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  }, 30_000);

  it('navigate to the SAME url twice: stale readiness cannot leak, ops succeed', async () => {
    // Reproduced race: the second goto resolved via the stale readyTabs
    // entry before the new content script loaded, and the immediate
    // pageInfo threw "content script unreachable". The background now
    // invalidates readiness synchronously before chrome.tabs.update.
    await session.navigate(FIXTURE_URL);
    await session.navigate(FIXTURE_URL);
    const snap = await session.snapshot();
    const greet = snap.nodes.find((n) => n.role === 'button' && n.name === 'Greet me');
    expect(greet).toBeDefined();
    await session.click(greet!.ref);
    const text = await session.pageText();
    expect(text).toContain('Hello, stranger!');
  }, 30_000);

  it('reload invalidates readiness: type round-trip succeeds after reload', async () => {
    await session.navigate(FIXTURE_URL);
    await session.reload();
    const snap = await session.snapshot();
    const name = snap.nodes.find((n) => n.role === 'textbox' && n.selector === '#name');
    const greet = snap.nodes.find((n) => n.role === 'button' && n.name === 'Greet me');
    expect(name).toBeDefined();
    expect(greet).toBeDefined();
    await session.type(name!.ref, 'Ada');
    await session.click(greet!.ref);
    const text = await session.pageText();
    expect(text).toContain('Hello, Ada!');
  }, 30_000);

  it('hitTest op: real content script reports occlusion behind a modal', async () => {
    // Genuine content.js hitTest coverage (P0-1): the modal fixture's
    // native dialog blocks the background button; the dialog's own
    // button stays actionable.
    const modalUrl = `file://${resolve(HERE, './fixtures/pages/modal.html')}`;
    await session.navigate(modalUrl);
    const backend = (session as unknown as { backend: ExtensionBackend }).backend;
    const snap = await session.snapshot();
    const bg = snap.nodes.find((n) => n.name === 'Background action');
    const accept = snap.nodes.find((n) => n.name === 'Accept');
    expect(bg).toBeDefined();
    expect(accept).toBeDefined();
    const blocked = await backend.hitTest(bg!.selector);
    expect(blocked.actionable).toBe(false);
    expect(blocked.reason).toBe('outside-active-dialog');
    const open = await backend.hitTest(accept!.selector);
    expect(open.actionable).toBe(true);
    // And the session gate refuses the click without dismissing the dialog.
    await expect(session.click(bg!.ref)).rejects.toThrow(/blocked/);
  }, 30_000);

  it('shadow DOM: real content script snapshots, clicks and types inside an open shadow root', async () => {
    // Item 4: document.querySelector(All) cannot cross shadow boundaries, so
    // the content script needs its own piercing walk (walkDom) and resolver
    // (deepQuerySelector). This drives the REAL content.js in real Chromium.
    const shadowUrl = `file://${resolve(HERE, './fixtures/pages/shadow.html')}`;
    await session.navigate(shadowUrl);
    const snap = await session.snapshot();
    const shadowBtn = snap.nodes.find((n) => n.name === 'Shadow greet');
    const shadowInput = snap.nodes.find((n) => n.name === 'shadow name');
    expect(shadowBtn, 'shadow button in snapshot').toBeDefined();
    expect(shadowInput, 'shadow input in snapshot').toBeDefined();
    // The button has an id, so the selector is the id shortcut — resolved
    // through the shadow-piercing deepGetElementById (document.querySelector
    // cannot see it).
    expect(shadowBtn!.selector).toBe('#shadowBtn');
    await session.type(shadowInput!.ref, 'Ada');
    // The typed value reached the shadow field (live read-back).
    const live = await session.describeLiveTarget(shadowInput!.ref);
    expect(live?.value).toContain('Ada');
    await session.click(shadowBtn!.ref);
    // The shadow button's handler ran (mirrored to document.title; the
    // shadow <p> itself is invisible to innerText-based pageText).
    const info = await session.pageInfo();
    expect(info.title).toContain('shadow hello, Ada');
    // Light-DOM controls on the same page still work.
    const lightBtn = snap.nodes.find((n) => n.name === 'Light DOM button');
    await session.click(lightBtn!.ref);
    expect(await session.pageText()).toContain('light clicked');
  }, 30_000);
});
