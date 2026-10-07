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
 * All tab/frame/interaction logic lives in the shared PageBackendBase.
 *
 * Security notes (see README "Security model"):
 *  - The bridge never launches or scans for browsers on its own; attach()
 *    is only called when the user explicitly provides a CDP endpoint.
 *  - Only loopback endpoints (127.0.0.1 / localhost / ::1) are accepted —
 *    attaching to a remote machine's debugging port is refused.
 *  - Connection state (which endpoint, which tabs) is exposed via
 *    browser_status so it is always visible to the user.
 */
import { chromium, type Browser } from 'playwright';
import type { BrowserAttachOptions, BrowserStartOptions } from '../types.js';
import { PageBackendBase } from './page-backend.js';

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

export class CdpBackend extends PageBackendBase {
  readonly backendName = 'cdp';
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
    this.endpoint = opts.cdpEndpoint;
    this.afterConnect();
  }

  async stop(): Promise<void> {
    // IMPORTANT: do NOT close the user's browser. Just disconnect —
    // dropping our references lets the CDP connection finalize.
    this.browser = null;
    this.context = null;
    this.page = null;
    this.endpoint = null;
  }
}
