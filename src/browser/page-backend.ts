/**
 * page-backend.ts — shared Playwright-Page implementation of BrowserBackend.
 *
 * Both concrete backends (PlaywrightBackend: launched Chromium; CdpBackend:
 * attached user browser over CDP) drive Playwright Page objects, so all tab,
 * frame, interaction, and perception logic lives here exactly once.
 * Subclasses only implement start()/attach()/stop() — i.e. how the browser
 * connection is established and torn down.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import type { Browser, BrowserContext, Download, Frame, Page } from 'playwright';
import {
  type BrowserBackend,
  type DownloadRecord,
  type FrameInfo,
  type PageInfo,
  type PageSnapshot,
  type TabInfo,
} from '../types.js';
import { captureSnapshot, walkDomInFrame, assembleNodes } from './snapshot.js';

const CLICK_TIMEOUT = 10_000;

function safeFilename(name: string): string {
  const base = basename(name).replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120);
  return base || 'download';
}

export abstract class PageBackendBase implements BrowserBackend {
  abstract readonly backendName: string;
  abstract get isUserBrowser(): boolean;

  protected browser: Browser | null = null;
  protected context: BrowserContext | null = null;
  protected page: Page | null = null;
  protected endpoint: string | null = null;
  protected navigationTimeoutMs = 30_000;
  protected downloadDir: string;
  private readonly tabIds = new Map<Page, string>();
  private tabCounter = 0;
  private readonly frameIds = new Map<Frame, string>();
  private frameCounter = 0;
  private readonly downloads: DownloadRecord[] = [];
  private pendingDownload: {
    resolve: (d: DownloadRecord) => void;
    reject: (e: Error) => void;
    timer: NodeJS.Timeout;
  } | null = null;

  constructor(downloadDir?: string) {
    this.downloadDir =
      downloadDir ?? join(process.cwd(), '.abb-downloads');
    mkdirSync(this.downloadDir, { recursive: true });
  }

  abstract start(opts: import('../types.js').BrowserStartOptions): Promise<void>;
  abstract attach(opts: import('../types.js').BrowserAttachOptions): Promise<void>;
  abstract stop(): Promise<void>;

  get connected(): boolean {
    return this.browser !== null;
  }

  /** Wire page defaults + download tracking after (re)connect. */
  protected afterConnect(): void {
    const page = this.page;
    if (page) {
      page.setDefaultNavigationTimeout(this.navigationTimeoutMs);
      page.setDefaultTimeout(Math.min(this.navigationTimeoutMs, 15_000));
      this.assignTabId(page);
    }
    const ctx = this.context;
    if (ctx) {
      ctx.on('page', (p) => {
        this.assignTabId(p);
        p.on('download', (d) => void this.onDownload(d));
      });
      for (const p of ctx.pages()) {
        this.assignTabId(p);
        p.on('download', (d) => void this.onDownload(d));
      }
    }
  }

  private async onDownload(download: Download): Promise<void> {
    try {
      const suggested = safeFilename(download.suggestedFilename());
      const path = join(this.downloadDir, `${Date.now()}-${suggested}`);
      await download.saveAs(path);
      const record: DownloadRecord = {
        url: download.url(),
        suggestedFilename: suggested,
        path: resolve(path),
        finishedAt: new Date().toISOString(),
      };
      this.downloads.push(record);
      this.pendingDownload?.resolve(record);
      this.pendingDownload = null;
    } catch (err) {
      this.pendingDownload?.reject(err as Error);
      this.pendingDownload = null;
    }
  }

  protected requirePage(): Page {
    if (!this.page || this.page.isClosed())
      throw new Error('no active page: start/attach the backend and open a tab first');
    return this.page;
  }

  protected requireContext(): BrowserContext {
    if (!this.context) throw new Error('backend not connected');
    return this.context;
  }

  private assignTabId(page: Page): string {
    let id = this.tabIds.get(page);
    if (!id) {
      this.tabCounter += 1;
      id = `tab-${this.tabCounter}`;
      this.tabIds.set(page, id);
    }
    return id;
  }

  private assignFrameId(frame: Frame): string {
    let id = this.frameIds.get(frame);
    if (!id) {
      this.frameCounter += 1;
      id = `frame-${this.frameCounter}`;
      this.frameIds.set(frame, id);
    }
    return id;
  }

  private frameFor(frameId: string | undefined): { page: Page; frame: Frame | null } {
    const page = this.requirePage();
    if (!frameId) return { page, frame: null };
    for (const [frame, id] of this.frameIds) {
      if (id === frameId && !frame.isDetached()) return { page, frame };
    }
    // Frames may have been recreated by navigation: try to re-bind the id by
    // url+name so previously issued ids keep working.
    const stale = [...this.frameIds].find(([, id]) => id === frameId);
    const staleUrl = stale?.[0].url();
    const staleName = stale?.[0].name();
    for (const [frame, id] of [...this.frameIds]) {
      if (frame.isDetached()) this.frameIds.delete(frame);
    }
    for (const frame of page.frames()) {
      if (frame !== page.mainFrame() && frame.url() === staleUrl && frame.name() === staleName) {
        this.frameIds.delete(stale![0]);
        this.frameIds.set(frame, frameId);
        return { page, frame };
      }
    }
    throw new Error(`unknown frame "${frameId}" — list frames with browser_frames first`);
  }

  private locatorTarget(selector: string, frameId?: string) {
    const { page, frame } = this.frameFor(frameId);
    const scope = frame ?? page;
    return { page, locator: scope.locator(selector).first() };
  }

  /* ---------------- tabs ---------------- */

  private async tabInfo(page: Page): Promise<TabInfo> {
    return {
      id: this.assignTabId(page),
      url: page.url(),
      title: await page.title().catch(() => ''),
      active: page === this.page,
    };
  }

  private reconcileTabs(): Page[] {
    const ctx = this.requireContext();
    const live = ctx.pages();
    const liveSet = new Set(live);
    for (const p of [...this.tabIds.keys()]) {
      if (!liveSet.has(p) || p.isClosed()) this.tabIds.delete(p);
    }
    for (const p of live) this.assignTabId(p);
    if (!this.page || this.page.isClosed() || !liveSet.has(this.page)) {
      this.page = live[0] ?? null;
    }
    return live;
  }

  async listTabs(): Promise<TabInfo[]> {
    return Promise.all(this.reconcileTabs().map((p) => this.tabInfo(p)));
  }

  async activeTab(): Promise<TabInfo> {
    this.reconcileTabs();
    return this.tabInfo(this.requirePage());
  }

  async openTab(url?: string): Promise<TabInfo> {
    const page = await this.requireContext().newPage();
    page.on('download', (d) => void this.onDownload(d));
    this.assignTabId(page);
    this.page = page;
    if (url) await page.goto(url, { waitUntil: 'domcontentloaded' });
    return this.tabInfo(page);
  }

  async switchTab(tabId: string): Promise<TabInfo> {
    this.reconcileTabs();
    for (const [page, id] of this.tabIds) {
      if (id === tabId && !page.isClosed()) {
        this.page = page;
        await page.bringToFront().catch(() => undefined);
        return this.tabInfo(page);
      }
    }
    throw new Error(`unknown tab "${tabId}" — list tabs with browser_tabs first`);
  }

  async closeTab(tabId: string): Promise<void> {
    this.reconcileTabs();
    for (const [page, id] of this.tabIds) {
      if (id === tabId) {
        if (this.requireContext().pages().length <= 1) {
          throw new Error('refusing to close the last tab of the session');
        }
        await page.close().catch(() => undefined);
        this.tabIds.delete(page);
        this.reconcileTabs();
        return;
      }
    }
    throw new Error(`unknown tab "${tabId}"`);
  }

  /* ---------------- navigation ---------------- */

  async goto(url: string): Promise<void> {
    await this.requirePage().goto(url, { waitUntil: 'domcontentloaded' });
  }

  async goBack(): Promise<void> {
    await this.requirePage().goBack({ waitUntil: 'domcontentloaded' }).catch(() => undefined);
  }

  async goForward(): Promise<void> {
    await this.requirePage().goForward({ waitUntil: 'domcontentloaded' }).catch(() => undefined);
  }

  async reload(): Promise<void> {
    await this.requirePage().reload({ waitUntil: 'domcontentloaded' });
  }

  currentUrl(): string {
    return this.page?.url() ?? '';
  }

  async title(): Promise<string> {
    return this.requirePage().title();
  }

  async pageInfo(): Promise<PageInfo> {
    const page = this.requirePage();
    const description = await page
      .locator('meta[name="description"]')
      .first()
      .getAttribute('content')
      .catch(() => null);
    return {
      url: page.url(),
      title: await page.title().catch(() => ''),
      description: (description ?? '').slice(0, 300),
    };
  }

  /* ---------------- element interaction ---------------- */

  async click(selector: string, frameId?: string): Promise<void> {
    const { locator } = this.locatorTarget(selector, frameId);
    await locator.scrollIntoViewIfNeeded().catch(() => undefined);
    await locator.click({ timeout: CLICK_TIMEOUT });
  }

  async dblclick(selector: string, frameId?: string): Promise<void> {
    const { locator } = this.locatorTarget(selector, frameId);
    await locator.scrollIntoViewIfNeeded().catch(() => undefined);
    await locator.dblclick({ timeout: CLICK_TIMEOUT });
  }

  async type(selector: string, text: string, submit: boolean, frameId?: string): Promise<void> {
    const { page, locator } = this.locatorTarget(selector, frameId);
    await locator.scrollIntoViewIfNeeded().catch(() => undefined);
    await locator.fill(text, { timeout: CLICK_TIMEOUT });
    if (submit) await page.keyboard.press('Enter');
  }

  async clear(selector: string, frameId?: string): Promise<void> {
    const { locator } = this.locatorTarget(selector, frameId);
    await locator.fill('', { timeout: CLICK_TIMEOUT });
  }

  async pressKey(key: string, frameId?: string): Promise<void> {
    const { page } = this.locatorTarget('body', frameId);
    await page.keyboard.press(key);
  }

  async hover(selector: string, frameId?: string): Promise<void> {
    const { locator } = this.locatorTarget(selector, frameId);
    await locator.hover({ timeout: CLICK_TIMEOUT });
  }

  async focus(selector: string, frameId?: string): Promise<void> {
    const { locator } = this.locatorTarget(selector, frameId);
    await locator.focus({ timeout: CLICK_TIMEOUT });
  }

  async scrollIntoView(selector: string, frameId?: string): Promise<void> {
    const { locator } = this.locatorTarget(selector, frameId);
    await locator.scrollIntoViewIfNeeded({ timeout: CLICK_TIMEOUT });
  }

  async selectOption(selector: string, values: string[], frameId?: string): Promise<string[]> {
    const { locator } = this.locatorTarget(selector, frameId);
    return locator.selectOption(values, { timeout: CLICK_TIMEOUT });
  }

  async setChecked(selector: string, checked: boolean, frameId?: string): Promise<void> {
    const { locator } = this.locatorTarget(selector, frameId);
    await locator.setChecked(checked, { timeout: CLICK_TIMEOUT });
  }

  async scrollBy(dx: number, dy: number): Promise<void> {
    await this.requirePage().evaluate(
      ({ dx, dy }) => window.scrollBy(dx, dy),
      { dx, dy },
    );
  }

  async waitForSelector(
    selector: string,
    state: 'visible' | 'hidden' | 'attached',
    timeoutMs: number,
    frameId?: string,
  ): Promise<void> {
    const { page, frame } = this.frameFor(frameId);
    const scope = frame ?? page;
    const mapped = state === 'visible' ? 'visible' : state === 'hidden' ? 'hidden' : 'attached';
    await scope.waitForSelector(selector, { state: mapped, timeout: timeoutMs });
  }

  async pageText(selector?: string, frameId?: string): Promise<string> {
    if (selector) {
      const { locator } = this.locatorTarget(selector, frameId);
      return (await locator.innerText().catch(() => '')) ?? '';
    }
    const { page, frame } = this.frameFor(frameId);
    const scope = frame ?? page;
    return ((await scope.locator('body').innerText().catch(() => '')) ?? '').slice(0, 20_000);
  }

  /* ---------------- frames ---------------- */

  async listFrames(): Promise<FrameInfo[]> {
    const page = this.requirePage();
    // Prune detached frames but keep ids stable across calls.
    for (const [frame] of [...this.frameIds]) {
      if (frame.isDetached()) this.frameIds.delete(frame);
    }
    const out: FrameInfo[] = [];
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      const id = this.assignFrameId(frame);
      out.push({ id, url: frame.url(), name: frame.name() });
    }
    return out;
  }

  async frameSnapshot(frameId: string): Promise<PageSnapshot> {
    const { page, frame } = this.frameFor(frameId);
    if (!frame) {
      throw new Error(`"${frameId}" is the main frame — use browser_snapshot instead`);
    }
    const raw = await walkDomInFrame(frame, frameId);
    return {
      snapshotId: `snap-${randomUUID().slice(0, 8)}`,
      url: frame.url(),
      title: await page.title().catch(() => ''),
      capturedAt: new Date().toISOString(),
      nodes: assembleNodes(raw),
    };
  }

  /* ---------------- files ---------------- */

  async uploadFile(selector: string, filePath: string, frameId?: string): Promise<void> {
    const abs = resolve(filePath);
    if (!existsSync(abs)) {
      throw new Error(`upload file does not exist: ${abs}`);
    }
    const { locator } = this.locatorTarget(selector, frameId);
    await locator.setInputFiles(abs, { timeout: CLICK_TIMEOUT });
  }

  async recentDownloads(consume: boolean): Promise<DownloadRecord[]> {
    const out = [...this.downloads];
    if (consume) this.downloads.length = 0;
    return out;
  }

  async waitForDownload(timeoutMs: number): Promise<DownloadRecord> {
    if (this.pendingDownload) {
      this.pendingDownload.reject(new Error('another waitForDownload is already pending'));
    }
    return new Promise<DownloadRecord>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingDownload = null;
        reject(new Error(`timed out after ${timeoutMs}ms waiting for a download`));
      }, timeoutMs);
      this.pendingDownload = {
        resolve: (d) => {
          clearTimeout(timer);
          this.pendingDownload = null;
          resolve(d);
        },
        reject: (e) => {
          clearTimeout(timer);
          this.pendingDownload = null;
          reject(e);
        },
        timer,
      };
    });
  }

  /* ---------------- perception ---------------- */

  async snapshot(): Promise<PageSnapshot> {
    return captureSnapshot(this.requirePage());
  }

  async screenshot(path: string): Promise<void> {
    await this.requirePage().screenshot({ path, fullPage: false });
  }
}
