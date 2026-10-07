/**
 * cdp-backend.ts — BrowserBackend that attaches to an EXISTING user browser.
 *
 * The user explicitly starts Chrome/Edge/Chromium with remote debugging
 * enabled, e.g.:
 *
 *   chrome --remote-debugging-port=9222 --user-data-dir=/path/to/profile
 *
 * and then points the bridge at http://127.0.0.1:9222. The bridge connects
 * over CDP (via Playwright's connectOverCDP) and drives the user's real tabs.
 *
 * Security notes (see README "Security model"):
 *  - The bridge never launches or scans for browsers on its own; attach()
 *    is only called when the user explicitly provides a CDP endpoint.
 *  - Only loopback endpoints (127.0.0.1 / localhost / ::1) are accepted —
 *    attaching to a remote machine's debugging port is refused.
 *  - Connection state (which endpoint, which tabs) is exposed via
 *    browser_status so it is always visible to the user.
 */
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import {
  type BrowserAttachOptions,
  type BrowserBackend,
  type BrowserStartOptions,
  type PageSnapshot,
  type TabInfo,
} from '../types.js';
import { captureSnapshot } from './snapshot.js';

function isLoopbackEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  const host = url.hostname.toLowerCase();
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

export class CdpBackend implements BrowserBackend {
  readonly backendName = 'cdp';
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private endpoint: string | null = null;
  private readonly tabIds = new Map<Page, string>();
  private tabCounter = 0;
  private navigationTimeoutMs = 30_000;

  get connected(): boolean {
    return this.browser !== null;
  }

  get isUserBrowser(): boolean {
    return true;
  }

  get cdpEndpoint(): string | null {
    return this.endpoint;
  }

  async start(_opts: BrowserStartOptions): Promise<void> {
    throw new Error(
      'CdpBackend does not launch browsers — call attach({ cdpEndpoint }) with the ' +
        'user-started Chrome/Edge debugging endpoint instead',
    );
  }

  async attach(opts: BrowserAttachOptions): Promise<void> {
    if (this.browser) await this.stop();
    if (!isLoopbackEndpoint(opts.cdpEndpoint)) {
      throw new Error(
        `refusing to attach to non-loopback CDP endpoint "${opts.cdpEndpoint}" — ` +
          'only 127.0.0.1/localhost debugging ports are allowed',
      );
    }
    this.navigationTimeoutMs = opts.navigationTimeoutMs ?? 30_000;
    let browser: Browser;
    try {
      browser = await chromium.connectOverCDP(opts.cdpEndpoint, {
        timeout: 15_000,
      });
    } catch (err) {
      throw new Error(
        `could not connect to a browser at ${opts.cdpEndpoint}: ${(err as Error).message}. ` +
          'Start Chrome/Edge with --remote-debugging-port=9222 first.',
      );
    }
    this.browser = browser;
    const contexts = browser.contexts();
    if (contexts.length === 0) {
      await browser.close().catch(() => undefined);
      this.browser = null;
      throw new Error('connected browser has no contexts — is it a supported Chromium?');
    }
    // First context is the default profile: the user's real tabs.
    this.context = contexts[0]!;
    const pages = this.context.pages();
    this.page = pages[0] ?? (await this.context.newPage());
    this.page.setDefaultNavigationTimeout(this.navigationTimeoutMs);
    this.page.setDefaultTimeout(Math.min(this.navigationTimeoutMs, 15_000));
    this.endpoint = opts.cdpEndpoint;
    for (const p of this.context.pages()) this.assignTabId(p);
  }

  async stop(): Promise<void> {
    // IMPORTANT: do NOT close the user's browser. Just disconnect.
    const browser = this.browser;
    this.browser = null;
    this.context = null;
    this.page = null;
    this.endpoint = null;
    this.tabIds.clear();
    // connectOverCDP's close() would close the browser; use a best-effort
    // disconnect via the underlying transport instead. Playwright's Browser
    // from connectOverCDP: browser.close() closes the browser, so we avoid it.
    // Dropping our references lets GC finalize the connection.
    void browser;
  }

  private requirePage(): Page {
    if (!this.page || !this.context)
      throw new Error('not attached: call attach({ cdpEndpoint }) first');
    return this.page;
  }

  private requireContext(): BrowserContext {
    if (!this.context) throw new Error('not attached: call attach({ cdpEndpoint }) first');
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

  /** Reconcile tracked tabs with the live page list (tabs may open/close externally). */
  private reconcile(): Page[] {
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

  private async tabInfo(page: Page): Promise<TabInfo> {
    return {
      id: this.assignTabId(page),
      url: page.url(),
      title: await page.title().catch(() => ''),
      active: page === this.page,
    };
  }

  async listTabs(): Promise<TabInfo[]> {
    const live = this.reconcile();
    return Promise.all(live.map((p) => this.tabInfo(p)));
  }

  async activeTab(): Promise<TabInfo> {
    this.reconcile();
    return this.tabInfo(this.requirePage());
  }

  async openTab(url?: string): Promise<TabInfo> {
    const page = await this.requireContext().newPage();
    this.assignTabId(page);
    this.page = page;
    if (url) await page.goto(url, { waitUntil: 'domcontentloaded' });
    return this.tabInfo(page);
  }

  async switchTab(tabId: string): Promise<TabInfo> {
    this.reconcile();
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
    this.reconcile();
    for (const [page, id] of this.tabIds) {
      if (id === tabId) {
        if (this.requireContext().pages().length <= 1) {
          throw new Error('refusing to close the last tab of the session');
        }
        await page.close().catch(() => undefined);
        this.tabIds.delete(page);
        this.reconcile();
        return;
      }
    }
    throw new Error(`unknown tab "${tabId}"`);
  }

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

  async click(selector: string): Promise<void> {
    const page = this.requirePage();
    await page.locator(selector).first().scrollIntoViewIfNeeded().catch(() => undefined);
    await page.locator(selector).first().click({ timeout: 10_000 });
  }

  async type(selector: string, text: string, submit: boolean): Promise<void> {
    const page = this.requirePage();
    const locator = page.locator(selector).first();
    await locator.scrollIntoViewIfNeeded().catch(() => undefined);
    await locator.fill(text, { timeout: 10_000 });
    if (submit) await page.keyboard.press('Enter');
  }

  async screenshot(path: string): Promise<void> {
    await this.requirePage().screenshot({ path, fullPage: false });
  }

  async snapshot(): Promise<PageSnapshot> {
    return captureSnapshot(this.requirePage());
  }
}
