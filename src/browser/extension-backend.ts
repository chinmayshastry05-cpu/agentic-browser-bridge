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
    const raw = (await this.op<{ url: string; title: string; nodes: RawNode[] }>('snapshot')).nodes;
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
    await this.op('click', { selector });
  }

  async dblclick(selector: string, frameId?: string): Promise<void> {
    this.noFrames(frameId);
    await this.op('dblclick', { selector });
  }

  async type(selector: string, text: string, submit: boolean, frameId?: string): Promise<void> {
    this.noFrames(frameId);
    await this.op('type', { selector, text, submit });
  }

  async clear(selector: string, frameId?: string): Promise<void> {
    this.noFrames(frameId);
    await this.op('clear', { selector });
  }

  async pressKey(key: string, frameId?: string): Promise<void> {
    this.noFrames(frameId);
    // Synthetic KeyboardEvent via the content script (untrusted input).
    await this.op('pressKey', { key });
  }

  async hover(selector: string, frameId?: string): Promise<void> {
    this.noFrames(frameId);
    await this.op('hover', { selector });
  }

  async focus(selector: string, frameId?: string): Promise<void> {
    this.noFrames(frameId);
    await this.op('focus', { selector });
  }

  async scrollIntoView(selector: string, frameId?: string): Promise<void> {
    this.noFrames(frameId);
    await this.op('scrollIntoView', { selector });
  }

  async selectOption(selector: string, values: string[], frameId?: string): Promise<string[]> {
    this.noFrames(frameId);
    return this.op<string[]>('selectOption', { selector, values });
  }

  async setChecked(selector: string, checked: boolean, frameId?: string): Promise<void> {
    this.noFrames(frameId);
    await this.op('setChecked', { selector, checked });
  }

  async scrollBy(dx: number, dy: number): Promise<void> {
    await this.op('scrollBy', { dx, dy });
  }

  async waitForSelector(
    selector: string,
    state: 'visible' | 'hidden' | 'attached',
    timeoutMs: number,
    frameId?: string,
  ): Promise<void> {
    this.noFrames(frameId);
    await this.op('waitForSelector', { selector, state, timeoutMs });
  }

  async pageText(selector?: string, frameId?: string): Promise<string> {
    this.noFrames(frameId);
    return this.op<string>('pageText', selector ? { selector } : {});
  }

  async pageInfo(): Promise<PageInfo> {
    const info = await this.op<{ url: string; title: string; description: string }>('pageInfo');
    this.lastUrl = info.url;
    this.lastTitle = info.title;
    return { url: info.url, title: info.title, description: info.description };
  }

  /**
   * Coordinate-grounding surface: viewport size and topmost element at a
   * point (see src/perception/visual.ts). Out-of-viewport points return
   * null instead of throwing.
   */
  async viewportSize(): Promise<{ width: number; height: number }> {
    return this.op<{ width: number; height: number }>('viewportSize');
  }

  async elementFromPoint(x: number, y: number): Promise<PointHit | null> {
    return this.op<PointHit | null>('elementFromPoint', { x, y });
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
    return this.op<TargetDescription | null>('describeTarget', { selector });
  }

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
