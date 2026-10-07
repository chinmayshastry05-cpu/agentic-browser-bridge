/**
 * tests/cdp.test.ts — real-browser test for the CdpBackend (M1).
 *
 * Launches a REAL standalone Chromium process with --remote-debugging-port
 * (NOT via Playwright's launcher), then attaches CdpBackend over CDP exactly
 * the way a user would connect their own Chrome/Edge. Verifies:
 *   - attach to an explicit loopback endpoint
 *   - tab enumeration of the user's real tabs
 *   - open/switch/close tab
 *   - navigate + snapshot + screenshot on the attached browser
 *   - disconnect does NOT kill the user's browser
 *   - non-loopback endpoints are refused
 *
 * No network access required: pages are data: URLs.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { CdpBackend } from '../src/browser/cdp-backend.js';

const CDP_PORT = 19222;
const CDP_ENDPOINT = `http://127.0.0.1:${CDP_PORT}`;

let browserProc: ChildProcess | null = null;
let profileDir = '';

async function waitForEndpoint(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${url}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

beforeAll(async () => {
  profileDir = mkdtempSync(join(tmpdir(), 'abb-cdp-profile-'));
  const exe = chromium.executablePath();
  browserProc = spawn(
    exe,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${profileDir}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  await waitForEndpoint(`${CDP_ENDPOINT}/json/version`, 30_000);
}, 60_000);

afterAll(async () => {
  browserProc?.kill('SIGKILL');
  browserProc = null;
  try {
    rmSync(profileDir, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

describe('CdpBackend against a real standalone browser', () => {
  it('refuses non-loopback endpoints', async () => {
    const backend = new CdpBackend();
    await expect(backend.attach({ cdpEndpoint: 'http://192.168.1.10:9222' })).rejects.toThrow(
      /non-loopback/,
    );
  });

  it('attaches and enumerates the existing tabs', async () => {
    const backend = new CdpBackend();
    await backend.attach({ cdpEndpoint: CDP_ENDPOINT });
    expect(backend.connected).toBe(true);
    expect(backend.isUserBrowser).toBe(true);

    const tabs = await backend.listTabs();
    expect(tabs.length).toBeGreaterThanOrEqual(1);
    expect(tabs[0]!.id).toMatch(/^tab-/);
    await backend.stop();
  });

  it('navigates, snapshots, screenshots and manages tabs on the user browser', async () => {
    const backend = new CdpBackend();
    await backend.attach({ cdpEndpoint: CDP_ENDPOINT });

    const opened = await backend.openTab(
      'data:text/html,<html><head><title>CDP page</title></head><body><h1>Hello CDP</h1><button id="b">Press</button></body></html>',
    );
    expect(opened.url).toContain('data:text/html');

    const snap = await backend.snapshot();
    expect(snap.snapshotId).toMatch(/^snap-/);
    const heading = snap.nodes.find((n) => n.role === 'heading' && n.name === 'Hello CDP');
    expect(heading).toBeDefined();
    const button = snap.nodes.find((n) => n.role === 'button' && n.name === 'Press');
    expect(button).toBeDefined();

    const shotPath = join(tmpdir(), `abb-cdp-shot-${Date.now()}.png`);
    await backend.screenshot(shotPath);
    const { statSync } = await import('node:fs');
    expect(statSync(shotPath).size).toBeGreaterThan(1000);

    // Switch back to the first tab and close the one we opened.
    const tabs = await backend.listTabs();
    const first = tabs.find((t) => t.id !== opened.id)!;
    const switched = await backend.switchTab(first.id);
    expect(switched.id).toBe(first.id);
    await backend.closeTab(opened.id);
    expect((await backend.listTabs()).some((t) => t.id === opened.id)).toBe(false);

    await backend.stop();

    // The user's browser must still be alive after disconnect.
    await waitForEndpoint(`${CDP_ENDPOINT}/json/version`, 5_000);
  }, 60_000);
});
