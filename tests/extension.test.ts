/**
 * tests/extension.test.ts — extension relay + backend over a fake peer.
 *
 * No real Chrome: a fake extension peer (ws client) implements the op
 * protocol. Covers: relay listen/connect, op round-trip, op timeout, peer
 * disconnect, backend start/goto/snapshot/click/type/screenshot, frame-id
 * refusal, and the no-peer start error.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { ExtensionRelay } from '../src/browser/extension-relay.js';
import { ExtensionBackend } from '../src/browser/extension-backend.js';

type Handler = (params: Record<string, unknown>) => unknown;

function fakePeer(port: number, handlers: Record<string, Handler>): WebSocket {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/extension`);
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString()) as { id: number | string; op: string; params?: Record<string, unknown> };
    const fn = handlers[msg.op];
    Promise.resolve()
      .then(() => {
        if (!fn) throw new Error(`unknown op "${msg.op}"`);
        return fn(msg.params ?? {});
      })
      .then((result) => ws.send(JSON.stringify({ id: msg.id, ok: true, result })))
      .catch((err: Error) => ws.send(JSON.stringify({ id: msg.id, ok: false, error: err.message })));
  });
  return ws;
}

function waitOpen(ws: WebSocket, ms = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('peer did not connect')), ms);
    ws.once('open', () => {
      clearTimeout(t);
      resolve();
    });
    ws.once('error', (e) => {
      clearTimeout(t);
      reject(e);
    });
  });
}

const NODES = [
  {
    ref: 'e1', role: 'button', name: 'Click me', tag: 'button', text: 'Click me',
    attributes: {}, selector: '#btn', parentRef: null,
    boundingBox: { x: 10, y: 10, width: 100, height: 30 }, visible: true,
  },
  {
    ref: 'e2', role: 'textbox', name: 'Name', tag: 'input', text: '',
    attributes: { type: 'text' }, selector: '#name', parentRef: null,
    boundingBox: { x: 10, y: 50, width: 200, height: 24 }, visible: true,
  },
];

function standardHandlers(log: { ops: string[] }) {
  return {
    goto: (p: Record<string, unknown>) => {
      log.ops.push(`goto:${p['url']}`);
      return {};
    },
    pageInfo: () => ({ url: 'https://example.com/', title: 'Example Domain', description: '' }),
    snapshot: () => ({ nodes: NODES }),
    click: (p: Record<string, unknown>) => {
      log.ops.push(`click:${p['selector']}`);
      return { clicked: p['selector'] };
    },
    type: (p: Record<string, unknown>) => {
      log.ops.push(`type:${p['selector']}=${p['text']}`);
      return {};
    },
    listTabs: () => [{ id: '101', url: 'https://example.com/', title: 'Example Domain', active: true }],
    activeTab: () => ({ id: '101', url: 'https://example.com/', title: 'Example Domain', active: true }),
    viewportSize: () => ({ width: 1280, height: 800 }),
    elementFromPoint: (p: Record<string, unknown>) => {
      const x = p['x'] as number;
      const y = p['y'] as number;
      if (x >= 10 && x <= 110 && y >= 10 && y <= 40) {
        return { tag: 'button', boundingBox: { x: 10, y: 10, width: 100, height: 30 } };
      }
      return null;
    },
    screenshot: () => ({
      // 1x1 transparent PNG
      dataUrl:
        'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
    }),
  } satisfies Record<string, Handler>;
}

describe('ExtensionRelay', () => {
  let relay: ExtensionRelay;
  let peer: WebSocket | null = null;

  beforeEach(async () => {
    relay = new ExtensionRelay();
    await relay.listen(0);
  });

  afterEach(async () => {
    peer?.close();
    peer = null;
    await relay.close();
  });

  const portOf = (r: ExtensionRelay): number =>
    (r as unknown as { listeningPort: number }).listeningPort;

  it('accepts a peer and round-trips an op', async () => {
    peer = fakePeer(portOf(relay), { ping: () => ({ pong: true }) });
    await waitOpen(peer);
    await relay.waitForPeer(2000);
    expect(relay.hasPeer).toBe(true);
    expect(await relay.sendOp('ping')).toEqual({ pong: true });
  });

  it('surfaces extension op errors', async () => {
    peer = fakePeer(portOf(relay), {});
    await waitOpen(peer);
    await relay.waitForPeer(2000);
    await expect(relay.sendOp('bogus')).rejects.toThrow(/unknown op/);
  });

  it('times out when the peer never answers', async () => {
    peer = fakePeer(portOf(relay), {
      hang: () => new Promise(() => undefined), // never resolves
    });
    await waitOpen(peer);
    await relay.waitForPeer(2000);
    await expect(relay.sendOp('hang', {}, 150)).rejects.toThrow(/timed out/);
  });

  it('rejects sends and waitForPeer when no peer is connected', async () => {
    await expect(relay.sendOp('ping', {}, 100)).rejects.toThrow(/not connected/);
    await expect(relay.waitForPeer(100)).rejects.toThrow(/no extension connected/);
  });

  it('fails pending ops when the peer disconnects', async () => {
    peer = fakePeer(portOf(relay), { hang: () => new Promise(() => undefined) });
    await waitOpen(peer);
    await relay.waitForPeer(2000);
    const pending = relay.sendOp('hang', {}, 10_000);
    peer.close();
    await expect(pending).rejects.toThrow(/disconnected|closed/);
    expect(relay.hasPeer).toBe(false);
  });
});

describe('ExtensionBackend (fake peer)', () => {
  let relay: ExtensionRelay;
  let peer: WebSocket | null = null;
  let backend: ExtensionBackend;
  const log = { ops: [] as string[] };

  beforeEach(async () => {
    relay = new ExtensionRelay();
    const { port } = await relay.listen(0);
    log.ops = [];
    peer = fakePeer(port, standardHandlers(log));
    await waitOpen(peer);
    backend = new ExtensionBackend({ relay });
    await backend.start({ headless: true });
  });

  afterEach(async () => {
    await backend.stop().catch(() => undefined);
    peer?.close();
    peer = null;
    await relay.close();
  });

  it('connects and reports as a user browser', () => {
    expect(backend.backendName).toBe('extension');
    expect(backend.connected).toBe(true);
    expect(backend.isUserBrowser).toBe(true);
  });

  it('goto / snapshot round-trip assembles refs', async () => {
    await backend.goto('https://example.com/');
    expect(log.ops).toContain('goto:https://example.com/');
    const snap = await backend.snapshot();
    expect(snap.url).toBe('https://example.com/');
    expect(snap.title).toBe('Example Domain');
    expect(snap.nodes.map((n) => n.ref)).toEqual(['e1', 'e2']);
    expect(snap.nodes[0]!.role).toBe('button');
    expect(backend.currentUrl()).toBe('https://example.com/');
  });

  it('click / type forward selectors to the extension', async () => {
    await backend.click('#btn');
    await backend.type('#name', 'Ada', false);
    expect(log.ops).toEqual(['click:#btn', 'type:#name=Ada']);
  });

  it('screenshot writes a PNG file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'abb-ext-'));
    const path = join(dir, 'shot.png');
    await backend.screenshot(path);
    expect(existsSync(path)).toBe(true);
    const bytes = readFileSync(path);
    expect(bytes.length).toBeGreaterThan(0);
    // PNG magic bytes — real protocol evidence, not a stub.
    expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  });

  it('exposes viewportSize / elementFromPoint for visual grounding', async () => {
    expect(await backend.viewportSize()).toEqual({ width: 1280, height: 800 });
    const hit = await backend.elementFromPoint(50, 20);
    expect(hit?.tag).toBe('button');
    expect(await backend.elementFromPoint(500, 500)).toBeNull();
  });

  it('refuses frame-scoped calls in v1', async () => {
    await expect(backend.click('#btn', 'frame-1')).rejects.toThrow(/top frame only/);
    await expect(backend.frameSnapshot('frame-1')).rejects.toThrow(/not support frame-scoped/);
  });

  it('refuses uploads (no local file access from an extension)', async () => {
    await expect(backend.uploadFile('#f', '/tmp/x')).rejects.toThrow(/no access to local files/);
  });

  it('lists tabs through the extension', async () => {
    const tabs = await backend.listTabs();
    expect(tabs).toHaveLength(1);
    expect(tabs[0]!.url).toBe('https://example.com/');
    expect(tabs[0]!.id).toMatch(/^tab-\d+$/);
  });
});

describe('ExtensionBackend without a peer', () => {
  it('start() fails fast with actionable instructions', async () => {
    const relay = new ExtensionRelay();
    await relay.listen(0);
    const backend = new ExtensionBackend({ relay });
    await expect(backend.start({ headless: true, navigationTimeoutMs: 200 })).rejects.toThrow(
      /no extension connected/,
    );
    await relay.close();
  });
});
