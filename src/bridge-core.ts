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
  type DownloadRecord,
  type ElementDescriptor,
  type FrameInfo,
  type PageIdentity,
  type PageInfo,
  type PageSnapshot,
  type TabInfo,
} from './types.js';
import { PlaywrightBackend } from './browser/playwright-backend.js';
import { CdpBackend } from './browser/cdp-backend.js';
import { reground, signatureMatches } from './perception/grounding.js';
import { randomUUID } from 'node:crypto';

/**
 * Extract the live document load id embedded in a page nonce
 * (`<uuid>:<loadId>`), minted by onNavigationCommitted when the backend
 * could report one. Null for bare nonces (initial session state, or
 * backends without pageLoadId).
 */
function liveLoadIdOf(identity: PageIdentity): string | null {
  const i = identity.pageNonce.indexOf(':');
  return i >= 0 ? identity.pageNonce.slice(i + 1) : null;
}

export { PlaywrightBackend, CdpBackend };

export interface ResolvedTarget {
  selector: string;
  frameId?: string;
  /** 1.0 when the ref was fresh; lower when re-grounded. */
  confidence: number;
  regrounded: boolean;
}

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
  private targetByRef = new Map<string, { descriptor: ElementDescriptor; selector: string; frameId?: string }>();
  private lastSnapshot: PageSnapshot | null = null;
  /**
   * Monotonic navigation generation. Incremented on EVERY committed
   * navigation — goto, reload, back/forward, tab open/switch/close —
   * including same-URL navigations where the URL does not change. Feeds
   * the approval fingerprint so no approval or pending ticket survives
   * any navigation.
   */
  private navGeneration = 0;
  /**
   * Fresh random value per committed navigation, mixed with the backend's
   * live page identity when available. Guarantees the page identity is
   * never replayable, even across process restarts.
   */
  private pageNonce: string = randomUUID();
  /** URL observed at the last committed navigation/snapshot (SPA detection). */
  private lastNavUrl: string | null = null;

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

  /**
   * The exact page identity approvals bind to. Compared field-wise; any
   * navigation changes navGeneration (and pageNonce), voiding approvals.
   */
  pageIdentity(): PageIdentity {
    return {
      url: this.backend.currentUrl(),
      snapshotId: this.lastSnapshot?.snapshotId ?? null,
      navGeneration: this.navGeneration,
      pageNonce: this.pageNonce,
    };
  }

  /**
   * Must run after EVERY committed navigation (including same-URL goto and
   * reload, and tab open/switch/close): bumps the generation, mints a fresh
   * page nonce (mixed with the backend's live document identity when the
   * backend can provide one), and clears all refs — a ref from before a
   * navigation must never resolve against the rebuilt DOM.
   */
  private async onNavigationCommitted(): Promise<void> {
    this.navGeneration += 1;
    this.targetByRef.clear();
    this.lastSnapshot = null;
    // One fresh read: prefers the backend's livePageIdentity() (single
    // round-trip for the extension backend), falls back to currentUrl() +
    // pageLoadId(). The live document id is mixed into the nonce so the
    // pre-action live check has a baseline to compare against.
    const live = await this.readLivePageIdentity();
    this.pageNonce = live.pageLoadId ? `${randomUUID()}:${live.pageLoadId}` : randomUUID();
    if (live.url !== null) {
      this.lastNavUrl = live.url;
    } else {
      try {
        this.lastNavUrl = this.backend.currentUrl();
      } catch {
        this.lastNavUrl = null;
      }
    }
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
    this.targetByRef.clear();
    this.lastSnapshot = null;
  }

  async navigate(url: string): Promise<{ url: string; title: string }> {
    if (!/^https?:\/\//i.test(url) && !/^file:\/\//i.test(url) && !/^data:/i.test(url)) {
      throw new Error(`refusing to navigate to non-web URL: ${url}`);
    }
    await this.backend.goto(url);
    await this.onNavigationCommitted();
    return { url: this.backend.currentUrl(), title: await this.backend.title() };
  }

  async goBack(): Promise<{ url: string }> {
    await this.backend.goBack();
    await this.onNavigationCommitted();
    return { url: this.backend.currentUrl() };
  }

  async goForward(): Promise<{ url: string }> {
    await this.backend.goForward();
    await this.onNavigationCommitted();
    return { url: this.backend.currentUrl() };
  }

  async reload(): Promise<{ url: string }> {
    await this.backend.reload();
    await this.onNavigationCommitted();
    return { url: this.backend.currentUrl() };
  }

  async listTabs(): Promise<TabInfo[]> {
    return this.backend.listTabs();
  }

  async openTab(url?: string): Promise<TabInfo> {
    const tab = await this.backend.openTab(url);
    await this.onNavigationCommitted();
    return tab;
  }

  async switchTab(tabId: string): Promise<TabInfo> {
    const tab = await this.backend.switchTab(tabId);
    await this.onNavigationCommitted();
    return tab;
  }

  async closeTab(tabId: string): Promise<void> {
    await this.backend.closeTab(tabId);
    await this.onNavigationCommitted();
  }

  async snapshot(): Promise<PageSnapshot> {
    const snap = await this.backend.snapshot();
    // Detect page-initiated navigations that bypassed the session methods
    // (SPA pushState/replaceState, link clicks): any URL change is a
    // navigation — clear refs and void approvals bound to the old page.
    if (this.lastNavUrl !== null) {
      try {
        if (this.backend.currentUrl() !== this.lastNavUrl) {
          await this.onNavigationCommitted();
        }
      } catch {
        // If the backend cannot report a URL, keep the existing state.
      }
    }
    this.lastNavUrl = this.backend.currentUrl();
    this.registerSnapshot(snap);
    return snap;
  }

  /**
   * Pre-action live page-identity check. The cached pageIdentity() only
   * reflects bridge-driven navigation; a page that navigates or reloads
   * ITSELF (link click, JS redirect, form submit, external reload) changes
   * the live document without touching the session state. This re-reads the
   * backend's LIVE identity (actual URL + document load id) and compares it
   * with the identity the approval was bound to.
   *
   * On mismatch it is treated EXACTLY like a committed navigation: refs are
   * cleared, the snapshot is nulled, navGeneration is bumped, and a fresh
   * nonce is minted — then it throws, so the caller must demand a fresh
   * snapshot and a new confirmation ticket. Nothing acts on a stale page.
   *
   * Backends without a live pageLoadId degrade to URL comparison only
   * (same-URL reloads are not detectable there). Pure DOM mutation without
   * any navigation/reload is NOT detectable by any backend and remains
   * uncovered — see docs/MCP_CHATGPT.md.
   *
   * Residual TOCTOU: a navigation in the microseconds between this check
   * and the DOM write is not covered.
   */
  async assertLivePageIdentity(expected: PageIdentity): Promise<void> {
    const live = await this.readLivePageIdentity();
    const urlChanged = live.url !== null && live.url !== expected.url;
    const knownLoadId = liveLoadIdOf(expected);
    const loadChanged =
      live.pageLoadId !== null && knownLoadId !== null && live.pageLoadId !== knownLoadId;
    if (urlChanged || loadChanged) {
      await this.onNavigationCommitted();
      throw new Error(
        'page changed since approval (page-initiated navigation or reload detected): ' +
          'take a fresh browser_snapshot and request a new confirmation ticket',
      );
    }
  }

  /** Best-effort fresh identity: livePageIdentity() when the backend has it, else currentUrl() + pageLoadId(). */
  private async readLivePageIdentity(): Promise<{ url: string | null; pageLoadId: string | null }> {
    try {
      if (this.backend.livePageIdentity) {
        const live = await this.backend.livePageIdentity();
        return { url: live.url ?? null, pageLoadId: live.pageLoadId ?? null };
      }
    } catch {
      // Fall through to the legacy fallback.
    }
    let url: string | null = null;
    try {
      url = this.backend.currentUrl();
    } catch {
      // Leave null: URL comparison is skipped, load-id comparison may apply.
    }
    let pageLoadId: string | null = null;
    try {
      pageLoadId = (await this.backend.pageLoadId?.()) ?? null;
    } catch {
      // Leave null: backends without a live load id degrade to URL-only.
    }
    return { url, pageLoadId };
  }

  /** Snapshot scoped to one iframe; refs carry that frame's id. */
  async frameSnapshot(frameId: string): Promise<PageSnapshot> {
    const snap = await this.backend.frameSnapshot(frameId);
    if (this.lastNavUrl !== null) {
      try {
        if (this.backend.currentUrl() !== this.lastNavUrl) {
          await this.onNavigationCommitted();
        }
      } catch {
        // If the backend cannot report a URL, keep the existing state.
      }
    }
    this.lastNavUrl = this.backend.currentUrl();
    this.registerSnapshot(snap);
    return snap;
  }

  private registerSnapshot(snap: PageSnapshot): void {
    this.targetByRef.clear();
    for (const n of snap.nodes) {
      const descriptor: ElementDescriptor = {
        ref: n.ref,
        snapshotId: snap.snapshotId,
        frameId: n.frameId,
        role: n.role,
        name: n.name,
        tag: n.tag,
        selector: n.selector,
        text: n.text,
      };
      this.targetByRef.set(n.ref, { descriptor, selector: n.selector, frameId: n.frameId });
    }
    this.lastSnapshot = snap;
  }

  private targetFor(ref: string): { descriptor: ElementDescriptor; selector: string; frameId?: string } {
    const t = this.targetByRef.get(ref);
    if (!t) {
      throw new Error(
        `unknown element ref "${ref}" — take a fresh browser_snapshot first (refs expire per snapshot)`,
      );
    }
    return t;
  }

  /**
   * Resolve a ref to a live target, detecting staleness.
   *
   * 1. Describe the live element behind the stored selector; if its signature
   *    still matches the descriptor, act directly (confidence 1.0).
   * 2. Otherwise take a fresh snapshot and attempt semantic re-grounding.
   * 3. If re-grounding is ambiguous or fails, throw — the caller must
   *    re-observe. We never act on a guess.
   */
  async resolveTarget(ref: string): Promise<ResolvedTarget> {
    const t = this.targetFor(ref);
    let live: import('./types.js').TargetDescription | null = null;
    try {
      live = await this.backend.describeTarget(t.selector, t.frameId);
    } catch {
      live = null;
    }
    if (live && signatureMatches(t.descriptor, live)) {
      return { selector: t.selector, frameId: t.frameId, confidence: 1, regrounded: false };
    }
    const fresh = await this.snapshot();
    const result = reground(t.descriptor, fresh);
    if (!result.ok) {
      throw new Error(
        `stale element ref "${ref}" ("${t.descriptor.name}") and re-grounding failed: ${result.reason}. ` +
          `Take a fresh browser_snapshot and pick a new ref.`,
      );
    }
    const nt = this.targetFor(result.newRef!);
    return {
      selector: nt.selector,
      frameId: nt.frameId,
      confidence: result.confidence ?? 0,
      regrounded: true,
    };
  }

  async click(ref: string): Promise<void> {
    const t = await this.resolveTarget(ref);
    await this.backend.click(t.selector, t.frameId);
  }

  async dblclick(ref: string): Promise<void> {
    const t = await this.resolveTarget(ref);
    await this.backend.dblclick(t.selector, t.frameId);
  }

  async type(ref: string, text: string, submit = false): Promise<void> {
    const t = await this.resolveTarget(ref);
    await this.backend.type(t.selector, text, submit, t.frameId);
  }

  async clear(ref: string): Promise<void> {
    const t = await this.resolveTarget(ref);
    await this.backend.clear(t.selector, t.frameId);
  }

  async pressKey(key: string): Promise<void> {
    await this.backend.pressKey(key);
  }

  async hover(ref: string): Promise<void> {
    const t = await this.resolveTarget(ref);
    await this.backend.hover(t.selector, t.frameId);
  }

  async focus(ref: string): Promise<void> {
    const t = await this.resolveTarget(ref);
    await this.backend.focus(t.selector, t.frameId);
  }

  async scrollIntoView(ref: string): Promise<void> {
    const t = await this.resolveTarget(ref);
    await this.backend.scrollIntoView(t.selector, t.frameId);
  }

  async selectOption(ref: string, values: string[]): Promise<string[]> {
    const t = await this.resolveTarget(ref);
    return this.backend.selectOption(t.selector, values, t.frameId);
  }

  async setChecked(ref: string, checked: boolean): Promise<void> {
    const t = await this.resolveTarget(ref);
    await this.backend.setChecked(t.selector, checked, t.frameId);
  }

  async scrollBy(dx: number, dy: number): Promise<void> {
    await this.backend.scrollBy(dx, dy);
  }

  async waitForSelector(
    selector: string,
    state: 'visible' | 'hidden' | 'attached' = 'visible',
    timeoutMs = 10_000,
  ): Promise<void> {
    await this.backend.waitForSelector(selector, state, timeoutMs);
  }

  /**
   * Resolve a ref and describe the live element behind it. Null when the
   * target is gone or cannot be grounded — used by the verifier.
   */
  async describeLiveTarget(ref: string): Promise<import('./types.js').TargetDescription | null> {
    try {
      const t = await this.resolveTarget(ref);
      return await this.backend.describeTarget(t.selector, t.frameId);
    } catch {
      return null;
    }
  }

  async pageText(ref?: string): Promise<string> {    if (!ref) return this.backend.pageText();
    const t = await this.resolveTarget(ref);
    return this.backend.pageText(t.selector, t.frameId);
  }

  async pageInfo(): Promise<PageInfo> {
    return this.backend.pageInfo();
  }

  async listFrames(): Promise<FrameInfo[]> {
    return this.backend.listFrames();
  }

  async uploadFile(ref: string, filePath: string): Promise<{ uploaded: string; to: string }> {
    const t = await this.resolveTarget(ref);
    await this.backend.uploadFile(t.selector, filePath, t.frameId);
    return { uploaded: filePath, to: ref };
  }

  async recentDownloads(consume = true): Promise<DownloadRecord[]> {
    return this.backend.recentDownloads(consume);
  }

  async waitForDownload(timeoutMs = 30_000): Promise<DownloadRecord> {
    return this.backend.waitForDownload(timeoutMs);
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
