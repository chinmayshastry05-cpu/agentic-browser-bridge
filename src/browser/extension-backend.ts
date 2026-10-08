/**
 * extension-backend.ts — BrowserBackend that drives a normal user-launched
 * Chrome through the companion MV3 extension (see extension/).
 *
 * Unlike CdpBackend, this needs NO --remote-debugging-port: the user loads
 * the unpacked extension once in chrome://extensions, and its service worker
 * opens a WebSocket client to the ExtensionRelay (loopback only). All tab and
 * page operations are performed with the extension APIs (chrome.tabs,
 * chrome.scripting / content-script DOM) — never CDP.
 *
 * Honest v1 limitations (also in docs/EXTENSION.md):
 *  - Top frame only: frameId-scoped calls throw (no all_frames content script yet).
 *  - No file uploads / download tracking via the extension (uploads throw).
 *  - press_key dispatches synthetic KeyboardEvent (untrusted); not equivalent
 *    to Playwright's trusted input.
 *  - Screenshots use chrome.tabs.captureVisibleTab (viewport PNG).
 *
 * Navigation-readiness guarantee: chrome.tabs.update/reload resolve BEFORE the
 * content script is injected, which used to race the pageInfo call inside
 * BrowserSession.navigate() into "content script unreachable". The extension
 * now handshakes readiness itself: the content script announces `abb-ready`
 * on evaluation, the background tracks ready tab ids (invalidated on
 * navigation via tabs.onUpdated), and goto/reload/openTab-with-url await
 * waitReady() before returning — so page ops issued immediately after
 * navigate() always find a live content script. Bridge callers that navigate
 * by other means can await relay.waitForTabReady(extTabId) explicitly.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  BrowserAttachOptions,
  BrowserBackend,
  BrowserStartOptions,
  DownloadRecord,
  FrameInfo,
  HitTestResult,
  PageInfo,
  PageSnapshot,
  TabInfo,
  TargetDescription,
} from '../types.js';
import { assembleNodes, type RawNode } from './snapshot.js';
import { DEFAULT_EXTENSION_RELAY_PORT, ExtensionRelay } from './extension-relay.js';
import type { GroundingSource, PointHit } from '../perception/visual.js';

interface ExtTab {
  id: string;
  url: string;
  title: string;
  active: boolean;
}

/** Bounded post-click readiness: event-driven, never an arbitrary sleep. */
const POST_ACTION_SETTLE_MS = 4000;
/** Retry budget for one transient-unreachable recovery. */
const READINESS_RETRY_MS = 5000;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * True when the error is the transient "content script is gone because the
 * document is being replaced" failure — as opposed to a real page/op error.
 * Background wraps sendToTab failures as "... (tab may be a chrome:// page
 * where scripting is blocked)"; only the connection-establishment half is
 * transient.
 */
function isTransientUnreachable(err: unknown): boolean {
  const m = err instanceof Error ? err.message : String(err);
  return /could not establish connection|receiving end does not exist|empty response from content script/i.test(m);
}

function asTab(t: unknown): ExtTab {
  const o = t as Record<string, unknown>;
  return {
    id: String(o['id']),
    url: String(o['url'] ?? ''),
    title: String(o['title'] ?? ''),
    active: o['active'] === true,
  };
}

export class ExtensionBackend implements BrowserBackend {
  readonly backendName = 'extension';
  private readonly relay: ExtensionRelay;
  private readonly ownRelay: boolean;
  private readonly relayPort: number;
  /** Bridge tab-N -> extension tab id. */
  private readonly tabIds = new Map<string, string>();
  private tabCounter = 0;
  private activeBridgeTab: string | null = null;
  private lastUrl = '';
  private lastTitle = '';

  /** Pass a shared relay, or let the backend own one on `relayPort`. */
  constructor(opts: { relay?: ExtensionRelay; relayPort?: number } = {}) {
    this.relay = opts.relay ?? new ExtensionRelay();
    this.ownRelay = !opts.relay;
    this.relayPort = opts.relayPort ?? DEFAULT_EXTENSION_RELAY_PORT;
  }

  get isUserBrowser(): boolean {
    return true;
  }

  get connected(): boolean {
    return this.relay.hasPeer;
  }

  async start(_opts: BrowserStartOptions): Promise<void> {
    if (this.ownRelay) await this.relay.listen(this.relayPort);
    const timeoutMs = _opts.navigationTimeoutMs ?? 30_000;
    await this.relay.waitForPeer(timeoutMs);
  }

  async attach(_opts: BrowserAttachOptions): Promise<void> {
    throw new Error(
      'ExtensionBackend does not use CDP — load the companion extension ' +
        '(extension/) in chrome://extensions and it will connect to the relay automatically',
    );
  }

  async stop(): Promise<void> {
    this.tabIds.clear();
    this.activeBridgeTab = null;
    if (this.ownRelay) await this.relay.close();
  }

  private noFrames(frameId?: string): void {
    if (frameId !== undefined) {
      throw new Error(
        'ExtensionBackend v1 supports the top frame only — frame-scoped calls are not implemented',
      );
    }
  }

  private async op<T>(op: string, params: Record<string, unknown> = {}): Promise<T> {
    return (await this.relay.sendOp(op, params)) as T;
  }

  /**
   * Content-script op with transient-readiness recovery. When the document
   * is being replaced (click-driven navigation, reload), the content
   * script briefly disappears and the op fails with a connection error.
   * That transient is not a final failure: poll for the content script to
   * come back (bounded), then retry the op once. Genuine page/op errors
   * are never retried.
   */
  private async pageOp<T>(op: string, params: Record<string, unknown> = {}): Promise<T> {
    try {
      return await this.op<T>(op, params);
    } catch (err) {
      if (!isTransientUnreachable(err)) throw err;
      await this.waitForContentScript(READINESS_RETRY_MS).catch(() => undefined);
      return this.op<T>(op, params);
    }
  }

  /**
   * Wait until the active tab's content script answers again (bounded).
   * Used after actions that may trigger navigation and to recover from
   * transient unreachable failures. Event-driven polling — no arbitrary
   * long sleeps.
   */
  private async waitForContentScript(timeoutMs: number): Promise<void> {
    const start = Date.now();
    for (;;) {
      const ok = await this.op<{ url: string }>('pageInfo').then(
        () => true,
        () => false,
      );
      if (ok) return;
      if (Date.now() - start >= timeoutMs) {
        throw new Error(`content script did not become ready within ${timeoutMs}ms`);
      }
      await sleep(150);
    }
  }

  /**
   * Post-action settle for actions that may trigger navigation (click,
   * dblclick, type-with-submit, pressKey). Polls the live document
   * identity: if the document was replaced, waits for the new content
   * script to be ready; if the same document is still there, returns
   * immediately. Bounded and best-effort — never fails the action that
   * just succeeded.
   */
  private async settleAfterAction(preLoadId: string | null): Promise<void> {
    const start = Date.now();
    for (;;) {
      const live = await this.livePageIdentity().catch(() => null);
      if (live) {
        if (live.pageLoadId !== preLoadId) {
          // New document (or first observation): wait for its content script.
          const remaining = POST_ACTION_SETTLE_MS - (Date.now() - start);
          if (remaining > 0) await this.waitForContentScript(remaining).catch(() => undefined);
        }
        return;
      }
      if (Date.now() - start >= POST_ACTION_SETTLE_MS) return;
      await sleep(150);
    }
  }

  /** Current document load id, or null when the content script is unreachable. */
  private async currentLoadId(): Promise<string | null> {
    try {
      const info = await this.op<{ loadId?: number }>('pageInfo');
      return typeof info?.loadId === 'number' && Number.isFinite(info.loadId)
        ? String(info.loadId)
        : null;
    } catch {
      return null;
    }
  }

  private bridgeTabId(extId: string): string {
    for (const [bridge, ext] of this.tabIds) {
      if (ext === extId) return bridge;
    }
    this.tabCounter += 1;
    const id = `tab-${this.tabCounter}`;
    this.tabIds.set(id, extId);
    return id;
  }

  private toTabInfo(t: ExtTab): TabInfo {
    return { id: this.bridgeTabId(t.id), url: t.url, title: t.title, active: t.active };
  }

  /** Resolve a bridge tab id to the extension tab id (default: active tab). */
  private async extTabId(bridgeId?: string): Promise<string | undefined> {
    if (!bridgeId) return undefined;
    const ext = this.tabIds.get(bridgeId);
    if (!ext) throw new Error(`unknown tab "${bridgeId}"`);
    return ext;
  }

  async goto(url: string): Promise<void> {
    await this.op('goto', { url });
    this.lastUrl = url;
  }

  async goBack(): Promise<void> {
    await this.op('goBack');
  }

  async goForward(): Promise<void> {
    await this.op('goForward');
  }

  async reload(): Promise<void> {
    await this.op('reload');
  }

  async listTabs(): Promise<TabInfo[]> {
    const tabs = (await this.op<unknown[]>('listTabs')).map(asTab);
    const infos = tabs.map((t) => this.toTabInfo(t));
    const active = infos.find((t) => t.active);
    this.activeBridgeTab = active?.id ?? infos[0]?.id ?? null;
    return infos;
  }

  async openTab(url?: string): Promise<TabInfo> {
    const t = asTab(await this.op('openTab', url ? { url } : {}));
    const info = this.toTabInfo(t);
    this.activeBridgeTab = info.id;
    return info;
  }

  async switchTab(tabId: string): Promise<TabInfo> {
    const ext = await this.extTabId(tabId);
    const t = asTab(await this.op('switchTab', { tabId: ext }));
    const info = this.toTabInfo(t);
    this.activeBridgeTab = info.id;
    return info;
  }

  async closeTab(tabId: string): Promise<void> {
    const ext = await this.extTabId(tabId);
    await this.op('closeTab', { tabId: ext });
    this.tabIds.delete(tabId);
    if (this.activeBridgeTab === tabId) this.activeBridgeTab = null;
  }

  async activeTab(): Promise<TabInfo> {
    const t = asTab(await this.op('activeTab'));
    const info = this.toTabInfo(t);
    this.activeBridgeTab = info.id;
    return info;
  }

  async snapshot(): Promise<PageSnapshot> {
    const raw = (await this.pageOp<{ url: string; title: string; nodes: RawNode[] }>('snapshot')).nodes;
    const info = await this.pageInfo().catch(() => null);
    const url = info?.url ?? this.lastUrl;
    const title = info?.title ?? this.lastTitle;
    this.lastUrl = url;
    this.lastTitle = title;
    return {
      snapshotId: `snap-ext-${this.relay.newId().slice(0, 8)}`,
      url,
      title,
      capturedAt: new Date().toISOString(),
      nodes: assembleNodes(raw),
    };
  }

  async click(selector: string, frameId?: string): Promise<void> {
    this.noFrames(frameId);
    const pre = await this.currentLoadId();
    await this.pageOp('click', { selector });
    await this.settleAfterAction(pre);
  }

  async dblclick(selector: string, frameId?: string): Promise<void> {
    this.noFrames(frameId);
    const pre = await this.currentLoadId();
    await this.pageOp('dblclick', { selector });
    await this.settleAfterAction(pre);
  }

  async type(selector: string, text: string, submit: boolean, frameId?: string): Promise<void> {
    this.noFrames(frameId);
    const pre = await this.currentLoadId();
    await this.pageOp('type', { selector, text, submit });
    await this.settleAfterAction(pre);
  }

  async clear(selector: string, frameId?: string): Promise<void> {
    this.noFrames(frameId);
    await this.pageOp('clear', { selector });
  }

  async pressKey(key: string, frameId?: string): Promise<void> {
    this.noFrames(frameId);
    // Synthetic KeyboardEvent via the content script (untrusted input).
    const pre = await this.currentLoadId();
    await this.pageOp('pressKey', { key });
    await this.settleAfterAction(pre);
  }

  async hover(selector: string, frameId?: string): Promise<void> {
    this.noFrames(frameId);
    await this.pageOp('hover', { selector });
  }

  async focus(selector: string, frameId?: string): Promise<void> {
    this.noFrames(frameId);
    await this.pageOp('focus', { selector });
  }

  async scrollIntoView(selector: string, frameId?: string): Promise<void> {
    this.noFrames(frameId);
    await this.pageOp('scrollIntoView', { selector });
  }

  async selectOption(selector: string, values: string[], frameId?: string): Promise<string[]> {
    this.noFrames(frameId);
    return this.pageOp<string[]>('selectOption', { selector, values });
  }

  async setChecked(selector: string, checked: boolean, frameId?: string): Promise<void> {
    this.noFrames(frameId);
    await this.pageOp('setChecked', { selector, checked });
  }

  async scrollBy(dx: number, dy: number): Promise<void> {
    await this.pageOp('scrollBy', { dx, dy });
  }

  async waitForSelector(
    selector: string,
    state: 'visible' | 'hidden' | 'attached',
    timeoutMs: number,
    frameId?: string,
  ): Promise<void> {
    this.noFrames(frameId);
    await this.pageOp('waitForSelector', { selector, state, timeoutMs });
  }

  async pageText(selector?: string, frameId?: string): Promise<string> {
    this.noFrames(frameId);
    return this.pageOp<string>('pageText', selector ? { selector } : {});
  }

  async pageInfo(): Promise<PageInfo> {
    const info = await this.pageOp<{ url: string; title: string; description: string; loadId?: number }>('pageInfo');
    this.lastUrl = info.url;
    this.lastTitle = info.title;
    return { url: info.url, title: info.title, description: info.description };
  }

  /**
   * Live identity of the loaded document, from the content script's
   * performance.timeOrigin. Changes on every committed navigation,
   * including same-URL reloads.
   */
  async pageLoadId(): Promise<string | null> {
    try {
      const info = await this.pageOp<{ loadId?: number }>('pageInfo');
      return typeof info?.loadId === 'number' && Number.isFinite(info.loadId) ? String(info.loadId) : null;
    } catch {
      return null;
    }
  }

  /**
   * Fresh live identity in ONE relay round-trip: the URL the content script
   * actually reports right now plus the document load id
   * (performance.timeOrigin — changes on every committed navigation,
   * including same-URL reload). Backs the session's pre-action live check
   * for page-initiated navigation/reload the bridge did not drive. Refreshes
   * the cached URL as a side effect (currentUrl() alone is cached).
   */
  async livePageIdentity(): Promise<{ url: string; pageLoadId: string | null }> {
    const info = await this.pageOp<{ url?: string; loadId?: number }>('pageInfo');
    const loadId =
      typeof info?.loadId === 'number' && Number.isFinite(info.loadId) ? String(info.loadId) : null;
    if (typeof info?.url === 'string' && info.url) this.lastUrl = info.url;
    return { url: this.lastUrl, pageLoadId: loadId };
  }

  /**
   * Coordinate-grounding surface: viewport size and topmost element at a
   * point (see src/perception/visual.ts). Out-of-viewport points return
   * null instead of throwing.
   */
  async viewportSize(): Promise<{ width: number; height: number }> {
    return this.pageOp<{ width: number; height: number }>('viewportSize');
  }

  async elementFromPoint(x: number, y: number): Promise<PointHit | null> {
    return this.pageOp<PointHit | null>('elementFromPoint', { x, y });
  }

  /** Expose a GroundingSource view of this backend for visual perceptors. */
  asGroundingSource(): GroundingSource {
    return {
      snapshot: () => this.snapshot(),
      viewportSize: () => this.viewportSize(),
      elementFromPoint: (x, y) => this.elementFromPoint(x, y),
    };
  }

  async listFrames(): Promise<FrameInfo[]> {
    const frames = await this.op<Array<{ id: string; url: string; name: string }>>('listFrames');
    return frames.map((f, i) => ({ id: `frame-${i + 1}`, url: f.url, name: f.name }));
  }

  async frameSnapshot(_frameId: string): Promise<PageSnapshot> {
    throw new Error('ExtensionBackend v1 does not support frame-scoped snapshots');
  }

  async describeTarget(selector: string, frameId?: string): Promise<TargetDescription | null> {
    this.noFrames(frameId);
    return this.pageOp<TargetDescription | null>('describeTarget', { selector });
  }

  /**
   * Browser-native actionability check via the content script's hitTest op
   * (document.elementFromPoint at representative points). Reports whether
   * the target is actually reachable or blocked by a modal/overlay —
   * never dismisses anything.
   */
  async hitTest(selector: string, frameId?: string): Promise<HitTestResult> {
    this.noFrames(frameId);
    return this.pageOp<HitTestResult>('hitTest', { selector });
  }

  /** Matches Chrome's captureVisibleTab per-second quota (see screenshot()). */
  readonly screenshotMinIntervalMs = 1000;

  async uploadFile(_selector: string, _filePath: string, _frameId?: string): Promise<void> {
    throw new Error(
      'ExtensionBackend does not support file uploads — the extension has no access to local files',
    );
  }

  async recentDownloads(_consume: boolean): Promise<DownloadRecord[]> {
    return [];
  }

  async waitForDownload(_timeoutMs: number): Promise<DownloadRecord> {
    throw new Error('ExtensionBackend does not track downloads in v1');
  }

  async screenshot(path: string): Promise<void> {
    const { dataUrl } = await this.op<{ dataUrl: string }>('screenshot');
    const m = /^data:image\/png;base64,(.+)$/.exec(dataUrl);
    if (!m) throw new Error('extension returned a non-PNG screenshot');
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, Buffer.from(m[1]!, 'base64'));
  }

  currentUrl(): string {
    return this.lastUrl;
  }

  async title(): Promise<string> {
    return (await this.pageInfo()).title;
  }
}
