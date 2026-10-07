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

/** Launch Chromium with the extension and wait for the relay peer. */
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
  const relay = new ExtensionRelay();
  try {
    await relay.listen(DEFAULT_EXTENSION_RELAY_PORT);
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
});
