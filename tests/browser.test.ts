/**
 * tests/browser.test.ts — real-browser tests for the expanded tool surface (M2).
 *
 * Runs headless Chromium via PlaywrightBackend against a local deterministic
 * fixture server (no external network). Covers: form controls, waits, frames,
 * open shadow DOM, scrolling, keyboard, file upload, and download tracking.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { readFileSync, mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AddressInfo } from 'node:net';
import { BrowserSession } from '../src/bridge-core.js';
import { PlaywrightBackend } from '../src/browser/playwright-backend.js';

let server: Server;
let baseUrl = '';
const FIX = new URL('./fixtures/', import.meta.url).pathname;

function fixture(name: string): string {
  return readFileSync(join(FIX, name), 'utf8');
}

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/v1.html') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(fixture('v1.html'));
    } else if (req.url === '/frame.html') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(fixture('frame.html'));
    } else if (req.url === '/download') {
      const body = 'agentic-browser-bridge fixture download\n';
      res.writeHead(200, {
        'content-type': 'text/plain',
        'content-disposition': 'attachment; filename="fixture.txt"',
        'content-length': Buffer.byteLength(body),
      });
      res.end(body);
    } else {
      res.writeHead(404);
      res.end('not found');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function makeSession(): Promise<BrowserSession> {
  const session = new BrowserSession(`m2-${Date.now()}`, new PlaywrightBackend());
  await session.start({ headless: true });
  await session.navigate(`${baseUrl}/v1.html`);
  await session.snapshot();
  return session;
}

function refByName(session: BrowserSession, namePart: string, frameId?: string): string {
  const snap = (session as unknown as { lastSnapshot: import('../src/types.js').PageSnapshot | null }).lastSnapshot;
  const nodes = (snap?.nodes ?? []).filter((n) => (frameId ? n.frameId === frameId : !n.frameId));
  const exact = nodes.find((n) => n.name === namePart);
  const node =
    exact ??
    nodes.find((n) => n.name.includes(namePart) && !['form', 'landmark', 'heading'].includes(n.role));
  if (!node) {
    throw new Error(
      `no node containing "${namePart}" (saw: ${nodes.map((n) => `${n.role}:"${n.name}"`).join(' | ')})`,
    );
  }
  return node.ref;
}

describe('M2 browser tool surface (real headless Chromium)', () => {
  it('fills form controls and verifies values', async () => {
    const session = await makeSession();
    try {
      const nameRef = refByName(session, 'e.g. Ada');
      await session.type(nameRef, 'Ada');
      await session.clear(nameRef);
      await session.type(nameRef, 'Grace');

      const colorRef = refByName(session, 'Color');
      const selected = await session.selectOption(colorRef, ['green']);
      expect(selected).toEqual(['green']);

      const agreeRef = refByName(session, 'I agree');
      await session.setChecked(agreeRef, true);
      const proRef = refByName(session, 'Pro');
      await session.setChecked(proRef, true);

      const notesRef = refByName(session, 'Notes');
      await session.type(notesRef, 'hello notes');

      const greetRef = refByName(session, 'Greet me');
      await session.click(greetRef);
      const text = await session.pageText();
      expect(text).toContain('Hello, Grace!');
    } finally {
      await session.close();
    }
  }, 60_000);

  it('double-click, hover, focus, press_key, scroll', async () => {
    const session = await makeSession();
    try {
      const dblRef = refByName(session, 'Double-click me');
      await session.dblclick(dblRef);
      expect(await session.pageText()).toContain('double-clicks: 1');

      await session.hover(dblRef);
      await session.focus(dblRef);
      await session.pressKey('Escape');

      // Scroll down to the bottom marker and verify it is visible.
      await session.scrollBy(0, 4000);
      const marker = refByName(session, 'bottom of page');
      await session.scrollIntoView(marker);
      const snap = await session.snapshot();
      const node = snap.nodes.find((n) => n.name === 'bottom of page');
      expect(node?.boundingBox).toBeTruthy();
    } finally {
      await session.close();
    }
  }, 60_000);

  it('waits for delayed content instead of failing', async () => {
    const session = await makeSession();
    try {
      await session.waitForSelector('#delayed', 'visible', 10_000);
      const text = await session.pageText();
      expect(text).toContain('I appeared after a delay.');
    } finally {
      await session.close();
    }
  }, 60_000);

  it('inspects and interacts with an iframe', async () => {
    const session = await makeSession();
    try {
      const frames = await session.listFrames();
      expect(frames.length).toBeGreaterThanOrEqual(1);
      const inner = frames.find((f) => f.name === 'inner') ?? frames[0]!;
      expect(inner.id).toMatch(/^frame-/);

      const fsnap = await session.frameSnapshot(inner.id);
      expect(fsnap.nodes.some((n) => n.frameId === inner.id)).toBe(true);
      const btn = fsnap.nodes.find((n) => n.name === 'Frame button');
      expect(btn).toBeDefined();

      await session.click(btn!.ref);
      const out = await session.pageText(btn!.ref);
      void out;
      const fsnap2 = await session.frameSnapshot(inner.id);
      const outNode = fsnap2.nodes.find((n) => n.name === 'frame clicked');
      expect(outNode).toBeDefined();
    } finally {
      await session.close();
    }
  }, 60_000);

  it('pierces open shadow DOM', async () => {
    const session = await makeSession();
    try {
      const snap = await session.snapshot();
      const btn = snap.nodes.find((n) => n.name === 'Shadow button');
      expect(btn).toBeDefined();
      await session.click(btn!.ref);
      // Shadow content is not part of body innerText; re-snapshot instead.
      const snap2 = await session.snapshot();
      expect(snap2.nodes.some((n) => n.name === 'shadow clicked')).toBe(true);
    } finally {
      await session.close();
    }
  }, 60_000);

  it('uploads a user-selected file and tracks downloads', async () => {
    const session = await makeSession();
    const tmp = mkdtempSync(join(tmpdir(), 'abb-upload-'));
    try {
      const uploadPath = join(tmp, 'avatar.png');
      writeFileSync(uploadPath, 'fake-png-bytes');

      const fileRef = refByName(session, 'Avatar');
      const res = await session.uploadFile(fileRef, uploadPath);
      expect(res.uploaded).toBe(uploadPath);
      expect(await session.pageText()).toContain('chosen: avatar.png');

      // Missing file must be rejected, not silently ignored.
      await expect(session.uploadFile(fileRef, join(tmp, 'nope.png'))).rejects.toThrow(
        /does not exist/,
      );

      // Download: click the link, wait for completion, verify the file.
      const dlRef = refByName(session, 'Download fixture file');
      const dlPromise = session.waitForDownload(15_000);
      await session.click(dlRef);
      const record = await dlPromise;
      expect(record.suggestedFilename).toBe('fixture.txt');
      expect(existsSync(record.path)).toBe(true);
      expect(readFileSync(record.path, 'utf8')).toContain('fixture download');

      const listed = await session.recentDownloads(false);
      expect(listed.some((d) => d.path === record.path)).toBe(true);
    } finally {
      await session.close();
    }
  }, 90_000);

  it('reports page info', async () => {
    const session = await makeSession();
    try {
      const info = await session.pageInfo();
      expect(info.url).toContain('/v1.html');
      expect(info.title).toBe('ABB v1 fixture');
      expect(info.description).toContain('Deterministic fixture');
    } finally {
      await session.close();
    }
  }, 60_000);

  it('re-grounds a stale ref after the element is replaced', async () => {
    const session = await makeSession();
    try {
      const swapRef = refByName(session, 'Swap me');
      await session.click(swapRef); // replaces the button node (new selector)
      expect(await session.pageText()).toContain('swaps: 1');

      // The old ref's selector is gone; grounding must find the replacement
      // by semantic match and click it — not throw, not click blindly.
      const target = await session.resolveTarget(swapRef);
      expect(target.regrounded).toBe(true);
      expect(target.confidence).toBeGreaterThanOrEqual(0.7);
      await session.click(swapRef);
      expect(await session.pageText()).toContain('swaps: 2');
    } finally {
      await session.close();
    }
  }, 60_000);
});
