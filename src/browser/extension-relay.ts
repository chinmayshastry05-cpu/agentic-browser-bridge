/**
 * extension-relay.ts — WebSocket relay between the bridge and the Chrome extension.
 *
 * The companion extension (see extension/) opens a WebSocket *client*
 * connection to ws://127.0.0.1:<port>/extension. This class is the server
 * side: it accepts exactly one extension peer at a time and lets an
 * ExtensionBackend send tab/page operations and await responses.
 *
 * Security: binds to 127.0.0.1 only. The extension is a local companion;
 * nothing here is reachable from the network.
 */
import { randomUUID } from 'node:crypto';
import { WebSocket, WebSocketServer } from 'ws';

export interface ExtensionOpRequest {
  id: number | string;
  op: string;
  params?: Record<string, unknown>;
}

export interface ExtensionOpResponse {
  id: number | string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

/** Default TCP port for the extension relay (bridge HTTP defaults to 8931). */
export const DEFAULT_EXTENSION_RELAY_PORT = 8932;
/** Default per-operation timeout. */
export const DEFAULT_OP_TIMEOUT_MS = 15_000;

interface PendingOp {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export class ExtensionRelay {
  private wss: WebSocketServer | null = null;
  private peer: WebSocket | null = null;
  private readonly pending = new Map<number | string, PendingOp>();
  private readonly peerWaiters: Array<{
    resolve: () => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];
  private idCounter = 0;
  private listeningPort: number | null = null;

  /** Start listening for the extension. Host is always loopback. */
  async listen(port: number = DEFAULT_EXTENSION_RELAY_PORT): Promise<{ port: number }> {
    if (this.wss) return { port: this.listeningPort ?? port };
    await new Promise<void>((resolve, reject) => {
      const wss = new WebSocketServer({ port, host: '127.0.0.1', path: '/extension' });
      wss.once('error', reject);
      wss.once('listening', () => resolve());
      wss.on('connection', (socket) => this.onPeer(socket));
      // Reject non-/extension upgrade paths explicitly.
      wss.on('headers', () => undefined);
      this.wss = wss;
    });
    const addr = this.wss!.address();
    this.listeningPort = typeof addr === 'object' && addr ? addr.port : port;
    return { port: this.listeningPort! };
  }

  private onPeer(socket: WebSocket): void {
    // One peer at a time: replace any stale connection.
    if (this.peer && this.peer.readyState === WebSocket.OPEN) {
      this.peer.close(4000, 'replaced by a new extension connection');
    }
    this.peer = socket;
    socket.on('message', (data) => this.onMessage(data.toString()));
    socket.on('close', () => {
      if (this.peer === socket) this.peer = null;
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new Error(`extension disconnected while op "${id}" was pending`));
      }
      this.pending.clear();
    });
    socket.on('error', () => undefined);
    for (const w of this.peerWaiters.splice(0)) {
      clearTimeout(w.timer);
      w.resolve();
    }
  }

  private onMessage(text: string): void {
    let msg: ExtensionOpResponse & { type?: string };
    try {
      msg = JSON.parse(text) as ExtensionOpResponse & { type?: string };
    } catch {
      return; // ignore malformed frames
    }
    if (msg.type === 'hello' || msg.type === 'event') return; // informational
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(new Error(`extension op failed: ${msg.error ?? 'unknown error'}`));
  }

  get hasPeer(): boolean {
    return this.peer !== null && this.peer.readyState === WebSocket.OPEN;
  }

  /** Resolve once an extension peer is connected (or reject on timeout). */
  async waitForPeer(timeoutMs = 30_000): Promise<void> {
    if (this.hasPeer) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.peerWaiters.findIndex((w) => w.timer === timer);
        if (i >= 0) this.peerWaiters.splice(i, 1);
        reject(
          new Error(
            'no extension connected — load the companion extension (extension/) in ' +
              'chrome://extensions (Developer mode → Load unpacked), then make sure it ' +
              `points at ws://127.0.0.1:${this.listeningPort ?? DEFAULT_EXTENSION_RELAY_PORT}/extension`,
          ),
        );
      }, timeoutMs);
      this.peerWaiters.push({ resolve, reject, timer });
    });
  }

  /** Send one operation to the extension and await its response. */
  async sendOp(
    op: string,
    params: Record<string, unknown> = {},
    timeoutMs: number = DEFAULT_OP_TIMEOUT_MS,
  ): Promise<unknown> {
    if (!this.hasPeer) throw new Error('extension not connected');
    const id: number = (this.idCounter += 1);
    const req: ExtensionOpRequest = { id, op, params };
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`extension op "${op}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.peer!.send(JSON.stringify(req), (err) => {
        if (err) {
          this.pending.delete(id);
          clearTimeout(timer);
          reject(err);
        }
      });
    });
  }

  /** Unique id useful for snapshot ids. */
  newId(): string {
    return randomUUID();
  }

  /**
   * Wait until the extension's content script has announced readiness in the
   * given (extension-level) tab id. Propagates the background's actionable
   * error when the tab never becomes ready (e.g. chrome://, about:, or
   * extension pages where content scripts cannot run).
   */
  async waitForTabReady(tabId: string, timeoutMs = 15_000): Promise<void> {
    await this.sendOp('waitReady', { tabId, timeoutMs }, timeoutMs + 10_000);
  }

  async close(): Promise<void> {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('relay closed'));
    }
    this.pending.clear();
    for (const w of this.peerWaiters.splice(0)) {
      clearTimeout(w.timer);
      w.reject(new Error('relay closed'));
    }
    this.peer?.close();
    this.peer = null;
    if (this.wss) {
      await new Promise<void>((resolve) => this.wss!.close(() => resolve()));
      this.wss = null;
    }
    this.listeningPort = null;
  }
}
