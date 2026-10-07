/**
 * playwright-backend.ts — BrowserBackend that launches an isolated Chromium.
 *
 * This is the testing/demo backend. It launches its own browser instance via
 * Playwright and is NOT a substitute for controlling the user's own browser —
 * for that, see cdp-backend.ts (CdpBackend).
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

export class PlaywrightBackend implements BrowserBackend {
  readonly backendName = 'playwright';
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private page: Page | null = null;
  private readonly tabIds = new Map<Page, string>();
  private tabCounter = 0;
  private navigationTimeoutMs = 30_000;

  get connected(): boolean {
    return this.browser !== null;
  }

  get isUserBrowser(): boolean {
    return false;
  }

  async start(opts: BrowserStartOptions): Promise<void> {
    if (this.browser) return;
    this.navigationTimeoutMs = opts.navigationTimeoutMs ?? 30_000;
    this.browser = await chromium.launch({ headless: opts.headless });
    this.context = await this.browser.newContext({
      viewport: opts.viewport ?? { width: 1280, height: 800 },
    });
    this.page = await this.context.newPage();
    this.page.setDefaultNavigationTimeout(this.navigationTimeoutMs);
    this.page.setDefaultTimeout(Math.min(this.navigationTimeoutMs, 15_000));
    this.assignTabId(this.page);
  }

  async attach(_opts: BrowserAttachOptions): Promise<void> {
    throw new Error(
      'PlaywrightBackend cannot attach to an existing browser — use CdpBackend for that',
    );
  }

  async stop(): Promise<void> {
    await this.browser?.close().catch(() => undefined);
    this.browser = null;
    this.context = null;
    this.page = null;
    this.tabIds.clear();
  }

  private requirePage(): Page {
    if (!this.page) throw new Error('backend not started: call start() first');
    return this.page;
  }

  private requireContext(): BrowserContext {
    if (!this.context) throw new Error('backend not started: call start() first');
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

  private async tabInfo(page: Page): Promise<TabInfo> {
    return {
      id: this.assignTabId(page),
      url: page.url(),
      title: await page.title().catch(() => ''),
      active: page === this.page,
    };
  }

  async listTabs(): Promise<TabInfo[]> {
    const pages = this.requireContext().pages();
    return Promise.all(pages.map((p) => this.tabInfo(p)));
  }

  async activeTab(): Promise<TabInfo> {
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
    for (const [page, id] of this.tabIds) {
      if (id === tabId) {
        if (this.requireContext().pages().length <= 1) {
          throw new Error('refusing to close the last tab of the session');
        }
        await page.close().catch(() => undefined);
        this.tabIds.delete(page);
        if (this.page === page || this.page?.isClosed()) {
          const remaining = this.requireContext().pages();
          this.page = remaining[remaining.length - 1] ?? null;
        }
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
