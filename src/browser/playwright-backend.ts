/**
 * playwright-backend.ts — BrowserBackend that launches an isolated Chromium.
 *
 * This is the testing/demo backend. It launches its own browser instance via
 * Playwright and is NOT a substitute for controlling the user's own browser —
 * for that, see cdp-backend.ts (CdpBackend). All tab/frame/interaction logic
 * lives in the shared PageBackendBase.
 */
import { chromium } from 'playwright';
import type { BrowserAttachOptions, BrowserStartOptions } from '../types.js';
import { PageBackendBase } from './page-backend.js';

export class PlaywrightBackend extends PageBackendBase {
  readonly backendName = 'playwright';
  get isUserBrowser(): boolean {
    return false;
  }

  async start(opts: BrowserStartOptions): Promise<void> {
    if (this.browser) return;
    this.navigationTimeoutMs = opts.navigationTimeoutMs ?? 30_000;
    this.browser = await chromium.launch({ headless: opts.headless });
    this.context = await this.browser.newContext({
      viewport: opts.viewport ?? { width: 1280, height: 800 },
      acceptDownloads: true,
    });
    this.page = await this.context.newPage();
    this.afterConnect();
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
  }
}
