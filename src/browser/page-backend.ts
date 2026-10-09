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

  /**
   * Live identity of the loaded document: the document's creation
   * timestamp. A new document (any navigation, including same-URL reload)
   * always gets a new value, so a fingerprint containing it cannot be
   * replayed against a rebuilt page.
   */
  async pageLoadId(): Promise<string | null> {
    try {
      const t = await this.requirePage().evaluate(() => performance.timeOrigin);
      return typeof t === 'number' && Number.isFinite(t) ? String(t) : null;
    } catch {
      return null;
    }
  }

  /**
   * Fresh live identity in one call: the live page URL plus the document
   * load id. Backs the session's pre-action live check for page-initiated
   * navigation/reload the bridge did not drive.
   */
  async livePageIdentity(): Promise<{ url: string; pageLoadId: string | null }> {
    return { url: this.currentUrl(), pageLoadId: await this.pageLoadId() };
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

  async describeTarget(
    selector: string,
    frameId?: string,
  ): Promise<import('../types.js').TargetDescription | null> {
    const { page, frame } = this.frameFor(frameId);
    const scope = frame ?? page;
    const locator = scope.locator(selector).first();
    let count = 0;
    try {
      count = await locator.count();
    } catch {
      return null;
    }
    if (count === 0) return null;
    try {
      return await locator.evaluate((el) => {
        const tag = el.tagName.toLowerCase();
        const explicit = el.getAttribute('role');
        let role = explicit ? explicit.toLowerCase() : tag;
        if (!explicit) {
          if (tag === 'a') role = 'link';
          else if (tag === 'button') role = 'button';
          else if (tag === 'input') {
            const t = (el.getAttribute('type') ?? 'text').toLowerCase();
            role =
              t === 'checkbox'
                ? 'checkbox'
                : t === 'radio'
                  ? 'radio'
                  : t === 'submit' || t === 'button'
                    ? 'button'
                    : 'textbox';
          } else if (tag === 'select') role = 'combobox';
          else if (tag === 'textarea') role = 'textbox';
          else if (/^h[1-6]$/.test(tag)) role = 'heading';
          else if (tag === 'img') role = 'img';
        }
        let name = '';
        const aria = el.getAttribute('aria-label');
        if (aria) name = aria.trim();
        else if (el instanceof HTMLImageElement && el.alt) name = el.alt.trim();
        else if (
          el instanceof HTMLInputElement ||
          el instanceof HTMLTextAreaElement ||
          el instanceof HTMLSelectElement
        ) {
          if (el instanceof HTMLInputElement && el.placeholder) name = el.placeholder.trim();
          else {
            const labels = (el as HTMLInputElement).labels;
            if (labels && labels.length > 0 && labels[0].textContent) {
              if (el instanceof HTMLInputElement) {
                name = (labels[0].textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
              } else {
                // Mirror the walker: label's own text nodes, not nested control text.
                const labelText = Array.from(labels[0].childNodes)
                  .filter((n) => n.nodeType === 3)
                  .map((n) => n.textContent ?? '')
                  .join(' ')
                  .replace(/\s+/g, ' ')
                  .trim();
                name = (labelText || (labels[0].textContent ?? '').replace(/\s+/g, ' ').trim()).slice(0, 120);
              }
            }
          }
          if (!name) name = (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
        } else {
          name = (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
        }
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        const out: {
          role: string;
          name: string;
          tag: string;
          visible: boolean;
          value?: string;
          checked?: boolean;
          inputType?: string;
        } = {
          role,
          name,
          tag,
          visible:
            rect.width > 0 &&
            rect.height > 0 &&
            style.visibility !== 'hidden' &&
            style.display !== 'none',
        };
        if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
          out.value = (el.value ?? '').slice(0, 500);
        }
        if (el instanceof HTMLSelectElement) {
          out.value = (el.value ?? '').slice(0, 500);
        }
        if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
          out.checked = el.checked;
        }
        if (el.getAttribute('role') === 'checkbox' || el.getAttribute('role') === 'switch') {
          out.checked = el.getAttribute('aria-checked') === 'true';
        }
        const inputType = el.getAttribute('type');
        if (inputType) out.inputType = inputType.toLowerCase();
        // Document identity owning this element: lets the session detect a
        // document replacement (reload/navigation) between snapshot and
        // action even when the URL did not change.
        (out as { docLoadId?: string | null }).docLoadId =
          typeof performance !== 'undefined' && Number.isFinite(performance.timeOrigin)
            ? String(performance.timeOrigin)
            : null;
        return out;
      });
    } catch {
      return null;
    }
  }

  /**
   * Browser-native actionability check via document.elementFromPoint,
   * mirroring the extension content script's hitTest op. Reports whether
   * the target is actually reachable or blocked by a visible modal/dialog,
   * overlay, or backdrop — never dismisses anything.
   */
  async hitTest(
    selector: string,
    frameId?: string,
  ): Promise<import('../types.js').HitTestResult> {
    const { page, frame } = this.frameFor(frameId);
    const scope = frame ?? page;
    // Resolve with Playwright's selector engine, which pierces open shadow
    // roots; document.querySelector inside evaluate() cannot cross shadow
    // boundaries, so resolving there would silently miss in-shadow targets
    // (the session's occlusion gate would then degrade to a no-op for them).
    const handle = await scope.$(selector);
    if (!handle) throw new Error(`no element matches selector "${selector}"`);
    try {
      return (await handle.evaluate((el) => {
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        const visible =
          r.width > 0 &&
          r.height > 0 &&
          cs.display !== 'none' &&
          cs.visibility !== 'hidden' &&
          cs.opacity !== '0';
        const disabled =
          (el as HTMLInputElement).disabled === true || el.getAttribute('aria-disabled') === 'true';
        const accName = (n: Element): string => {
          const a = n.getAttribute('aria-label');
          if (a) return a.trim().slice(0, 120);
          return ((n.textContent ?? '').replace(/\s+/g, ' ').trim()).slice(0, 120);
        };
        const info = (n: Element | null) =>
          n
            ? { tag: n.tagName.toLowerCase(), role: (n.getAttribute('role') || n.tagName).toLowerCase(), name: accName(n) }
            : null;
        const dialogInfo = (d: Element | null) => {
          if (!d) return null;
          const modal =
            d.tagName === 'DIALOG'
              ? (d as HTMLDialogElement).open === true
              : d.getAttribute('aria-modal') === 'true';
          return {
            role: (d.getAttribute('role') || 'dialog').toLowerCase(),
            name: accName(d),
            modal,
          };
        };
        const isVis = (n: Element): boolean => {
          const b = n.getBoundingClientRect();
          if (b.width === 0 && b.height === 0) return false;
          const s = getComputedStyle(n);
          return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
        };
        const base = {
          target: info(el)!,
          targetVisible: visible,
          targetDisabled: disabled,
        };
        if (!visible) return { actionable: false, reason: 'not-visible', ...base };
        if (disabled) return { actionable: false, reason: 'disabled', ...base };
        const topModal =
          Array.from(document.querySelectorAll('dialog[open], [role="dialog"]'))
            .filter(isVis)
            .find((d) => d.tagName === 'DIALOG' || d.getAttribute('aria-modal') === 'true') || null;
        const ownDialog = el.closest('dialog, [role="dialog"]');
        if (topModal && ownDialog !== topModal && !(ownDialog && topModal.contains(ownDialog))) {
          return {
            actionable: false,
            reason: 'outside-active-dialog',
            dialog: dialogInfo(topModal),
            ...base,
          };
        }
        const inset = 2;
        const pts: Array<[number, number]> = [
          [r.x + r.width / 2, r.y + r.height / 2],
          [r.x + inset, r.y + inset],
          [r.x + r.width - inset, r.y + inset],
          [r.x + inset, r.y + r.height - inset],
          [r.x + r.width - inset, r.y + r.height - inset],
        ];
        // Shadow-aware hit check: document.elementFromPoint does not pierce
        // shadow roots — over an in-shadow target it returns the shadow host.
        // Walk the target's composed ancestors (through shadow hosts) so a
        // hit on the host counts as a hit on the target.
        const composedAncestors = (node: Element): Element[] => {
          const out: Element[] = [];
          let cur: Element | null = node;
          while (cur) {
            out.push(cur);
            const root = cur.getRootNode();
            cur = root instanceof ShadowRoot ? (root.host as Element) : cur.parentElement;
          }
          return out;
        };
        const ancestors = composedAncestors(el);
        let occluder: {
          tag: string;
          role: string;
          name: string;
          dialog: { role: string; name: string; modal: boolean } | null;
        } | null = null;
        let centerHit = false;
        for (let i = 0; i < pts.length; i++) {
          const [x, y] = pts[i]!;
          if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) continue;
          const top = document.elementFromPoint(x, y);
          const hit = !!top && (top === el || el.contains(top) || ancestors.includes(top));
          if (i === 0) centerHit = hit;
          if (!hit && !occluder && top) {
            const od = top.closest('dialog, [role="dialog"]');
            occluder = { ...info(top)!, dialog: dialogInfo(od) };
          }
        }
        if (!centerHit) {
          return {
            actionable: false,
            reason: 'occluded',
            occluder,
            dialog: (occluder && occluder.dialog) || dialogInfo(ownDialog),
            ...base,
          };
        }
        return { actionable: true, dialog: dialogInfo(ownDialog), ...base };
      })) as unknown as import('../types.js').HitTestResult;
    } finally {
      await handle.dispose().catch(() => undefined);
    }
  }

  async screenshot(path: string): Promise<void> {
    await this.requirePage().screenshot({ path, fullPage: false });
  }
}
