/**
 * bridge-core.ts — core session/transport abstraction over a browser automation backend.
 *
 * Design choice: plain `playwright` (the npm package) rather than `@playwright/mcp`.
 * Rationale (also documented in README.md):
 *   1. The bridge runs the browser in-process and exposes its own MCP-style tool
 *      layer, so the external @playwright/mcp server would be a redundant hop.
 *   2. We need per-snapshot stable element refs ("e1", "e2", ...) that survive
 *      across our own observe->plan->act loop; implementing snapshotting with a
 *      DOM walk inside the page gives us exactly the refs, selectors, and roles
 *      our analyzer/tree modules consume.
 *   3. Fewer moving parts for a local-only bridge: one process, one dependency.
 *
 * The `BrowserBackend` interface (see types.ts) keeps the session layer
 * backend-agnostic: to drive a different automation stack, implement the
 * interface and pass it to BrowserSession — no other module changes.
 *
 * Backends live in src/browser/:
 *   - PlaywrightBackend: launches an isolated Chromium (testing/demo).
 *   - CdpBackend: attaches to the user's existing Chrome/Edge over CDP.
 */
import {
  type BrowserAttachOptions,
  type BrowserBackend,
  type BrowserStartOptions,
  type PageSnapshot,
  type TabInfo,
} from './types.js';
import { PlaywrightBackend } from './browser/playwright-backend.js';
import { CdpBackend } from './browser/cdp-backend.js';

export { PlaywrightBackend, CdpBackend };

/**
 * BrowserSession — one named agent-driven browser session.
 * Owns the ref→selector resolution so tools and the agent loop only ever
 * handle short refs ("e12") while actions resolve to unique selectors.
 *
 * Refs are scoped to a snapshot: each snapshot() call assigns a snapshotId,
 * and refs from older snapshots are rejected (stale refs must be re-taken).
 */
export class BrowserSession {
  readonly id: string;
  private readonly backend: BrowserBackend;
  private selectorByRef = new Map<string, string>();
  private lastSnapshot: PageSnapshot | null = null;

  constructor(id: string, backend: BrowserBackend = new PlaywrightBackend()) {
    this.id = id;
    this.backend = backend;
  }

  get backendName(): string {
    return this.backend.backendName;
  }

  get isUserBrowser(): boolean {
    return this.backend.isUserBrowser;
  }

  async start(opts: BrowserStartOptions): Promise<void> {
    await this.backend.start(opts);
  }

  /** Attach this session to the user's existing browser over CDP. */
  async attach(opts: BrowserAttachOptions): Promise<void> {
    await this.backend.attach(opts);
  }

  async close(): Promise<void> {
    await this.backend.stop();
    this.selectorByRef.clear();
    this.lastSnapshot = null;
  }

  async navigate(url: string): Promise<{ url: string; title: string }> {
    if (!/^https?:\/\//i.test(url) && !/^file:\/\//i.test(url) && !/^data:/i.test(url)) {
      throw new Error(`refusing to navigate to non-web URL: ${url}`);
    }
    await this.backend.goto(url);
    return { url: this.backend.currentUrl(), title: await this.backend.title() };
  }

  async goBack(): Promise<{ url: string }> {
    await this.backend.goBack();
    return { url: this.backend.currentUrl() };
  }

  async goForward(): Promise<{ url: string }> {
    await this.backend.goForward();
    return { url: this.backend.currentUrl() };
  }

  async reload(): Promise<{ url: string }> {
    await this.backend.reload();
    return { url: this.backend.currentUrl() };
  }

  async listTabs(): Promise<TabInfo[]> {
    return this.backend.listTabs();
  }

  async openTab(url?: string): Promise<TabInfo> {
    return this.backend.openTab(url);
  }

  async switchTab(tabId: string): Promise<TabInfo> {
    return this.backend.switchTab(tabId);
  }

  async closeTab(tabId: string): Promise<void> {
    await this.backend.closeTab(tabId);
  }

  async snapshot(): Promise<PageSnapshot> {
    const snap = await this.backend.snapshot();
    this.selectorByRef.clear();
    for (const n of snap.nodes) this.selectorByRef.set(n.ref, n.selector);
    this.lastSnapshot = snap;
    return snap;
  }

  private selectorFor(ref: string): string {
    const sel = this.selectorByRef.get(ref);
    if (!sel) {
      throw new Error(
        `unknown element ref "${ref}" — take a fresh browser_snapshot first (refs expire per snapshot)`,
      );
    }
    return sel;
  }

  async click(ref: string): Promise<void> {
    await this.backend.click(this.selectorFor(ref));
  }

  async type(ref: string, text: string, submit = false): Promise<void> {
    await this.backend.type(this.selectorFor(ref), text, submit);
  }

  async screenshot(path: string): Promise<{ path: string }> {
    await this.backend.screenshot(path);
    return { path };
  }

  get url(): string {
    return this.backend.currentUrl();
  }

  get lastSnapshotAt(): string | null {
    return this.lastSnapshot?.capturedAt ?? null;
  }

  get lastSnapshotId(): string | null {
    return this.lastSnapshot?.snapshotId ?? null;
  }
}

/**
 * SessionManager — registry of live sessions for the bridge server.
 * Caps concurrent sessions to protect a small local machine.
 */
export class SessionManager {
  private readonly sessions = new Map<string, BrowserSession>();
  private counter = 0;
  constructor(private readonly maxSessions = 4) {}

  create(backend?: BrowserBackend): BrowserSession {
    if (this.sessions.size >= this.maxSessions) {
      throw new Error(`session limit reached (${this.maxSessions})`);
    }
    this.counter += 1;
    const session = new BrowserSession(`sess-${this.counter}`, backend);
    this.sessions.set(session.id, session);
    return session;
  }

  get(id: string): BrowserSession {
    const s = this.sessions.get(id);
    if (!s) throw new Error(`unknown session "${id}"`);
    return s;
  }

  ids(): string[] {
    return [...this.sessions.keys()];
  }

  async close(id: string): Promise<void> {
    const s = this.sessions.get(id);
    if (s) {
      await s.close().catch(() => undefined);
      this.sessions.delete(id);
    }
  }

  async closeAll(): Promise<void> {
    for (const id of this.ids()) await this.close(id);
  }
}
