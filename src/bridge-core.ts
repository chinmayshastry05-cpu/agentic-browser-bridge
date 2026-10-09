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
  type HitTestResult,
  type PageIdentity,
  type PageInfo,
  type PageSnapshot,
  type TabInfo,
} from './types.js';
import { PlaywrightBackend } from './browser/playwright-backend.js';
import { CdpBackend } from './browser/cdp-backend.js';
import { reground, signatureMatches } from './perception/grounding.js';
import { detectLoginWall } from './security/policy.js';
import { randomUUID } from 'node:crypto';

/**
 * Thrown by the pre-action occlusion gate when a browser-native hit-test
 * finds the target blocked by a visible modal/dialog, overlay, or backdrop.
 * Carries structured detail so tools can report blocked/awaiting_user_input
 * with reason=active_modal instead of a bare error string.
 *
 * The gate NEVER hides, removes, clicks through, or auto-dismisses the
 * blocker — dismissing a dialog is a separate, explicit, policy-gated
 * action (or the operator's job).
 */
export class ActionBlockedError extends Error {
  readonly blocked = true;
  readonly reason = 'active_modal' as const;
  readonly detail: {
    ref: string;
    hitReason: string;
    modal: { role: string; name: string; modal: boolean } | null;
    occluder: { tag: string; role: string; name: string } | null;
    suggestedNextStep: string;
  };

  constructor(ref: string, hit: HitTestResult) {
    const modalName = hit.dialog?.name ? ` "${hit.dialog.name}"` : '';
    const why =
      hit.reason === 'outside-active-dialog'
        ? `an active modal dialog${modalName} owns the page`
        : hit.reason === 'occluded'
          ? `another element${hit.occluder?.name ? ` ("${hit.occluder.name}")` : ''} covers the target`
          : hit.reason === 'disabled'
            ? 'the target is disabled'
            : 'the target is not visible';
    super(
      `action on ref "${ref}" blocked: ${why} — refusing to act behind an active blocker. ` +
        `Handle the dialog explicitly (or ask the user) before using background controls.`,
    );
    this.name = 'ActionBlockedError';
    this.detail = {
      ref,
      hitReason: hit.reason ?? 'unknown',
      modal: hit.dialog ?? null,
      occluder: hit.occluder
        ? { tag: hit.occluder.tag, role: hit.occluder.role, name: hit.occluder.name }
        : null,
      suggestedNextStep:
        'User interaction required — dismiss or complete the blocking dialog explicitly before retrying background controls.',
    };
  }
}

/**
 * Extract the live document load id embedded in a page nonce
 * (`<uuid>:<loadId>`), minted by onNavigationCommitted when the backend
 * could report one. Null for bare nonces (initial session state, or
 * backends without pageLoadId).
 */
function liveLoadIdOfNonce(pageNonce: string): string | null {
  const i = pageNonce.indexOf(':');
  return i >= 0 ? pageNonce.slice(i + 1) : null;
}

/** Same as liveLoadIdOfNonce, for a full PageIdentity. */
function liveLoadIdOf(identity: PageIdentity): string | null {
  return liveLoadIdOfNonce(identity.pageNonce);
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
    const finalUrl = this.backend.currentUrl();
    const title = await this.backend.title();
    // Login-wall gate (fail-closed): refuse to land on a login wall instead
    // of letting the agent attempt credentials it does not have, or worse,
    // pretend it got past one. Both the agent loop and the MCP server route
    // through here, so one check covers both.
    const snap = await this.snapshot().catch(() => null);
    const wall = snap ? detectLoginWall(finalUrl, snap) : null;
    if (wall) {
      throw new Error(
        `login wall detected at ${finalUrl} (${wall}). The bridge holds no credentials ` +
          `and will not attempt to log in anywhere. Stopping here instead of faking ` +
          `success — have the operator log in manually if this page is needed.`,
      );
    }
    return { url: finalUrl, title };
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
    // (link clicks, JS redirects, reloads, SPA pushState/replaceState): any
    // URL change OR document-load-id change is a navigation — clear refs
    // and void approvals bound to the old page. The load-id check catches
    // same-URL reloads, where the URL alone does not change.
    try {
      const live = await this.readLivePageIdentity();
      const knownLoadId = liveLoadIdOfNonce(this.pageNonce);
      const urlChanged =
        live.url !== null && this.lastNavUrl !== null && live.url !== this.lastNavUrl;
      const docChanged =
        live.pageLoadId !== null && knownLoadId !== null && live.pageLoadId !== knownLoadId;
      if (urlChanged || docChanged) {
        await this.onNavigationCommitted();
      }
      if (live.url !== null) this.lastNavUrl = live.url;
    } catch {
      // If the backend cannot report a live identity, keep existing state.
      try {
        this.lastNavUrl = this.backend.currentUrl();
      } catch {
        // Leave lastNavUrl as-is.
      }
    }
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
    // Bind every ref to the document identity observed at snapshot time.
    // resolveTarget() compares the live document against these before
    // acting: a changed document (reload/navigation/SPA replacement)
    // invalidates the ref instead of silently re-grounding against the
    // new document.
    const docLoadId = liveLoadIdOfNonce(this.pageNonce);
    const docGeneration = this.navGeneration;
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
        docGeneration,
        docLoadId,
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
   * 1. If the live document differs from the one the ref was captured
   *    against (reload/navigation/SPA replacement — detected via the
   *    document load id, even when the URL did not change), the ref is
   *    stale: throw, never re-ground against the new document.
   * 2. Describe the live element behind the stored selector; if its
   *    signature still matches the descriptor, act directly (confidence 1.0).
   * 3. Otherwise take a fresh snapshot and attempt semantic re-grounding
   *    WITHIN the same document.
   * 4. If re-grounding is ambiguous or fails, throw — the caller must
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
    const liveDoc = live?.docLoadId ?? null;
    const knownDoc = t.descriptor.docLoadId;
    // The document-generation check is scoped to top-frame targets: the
    // session's live load id is the TOP document's, while a frame target's
    // docLoadId belongs to its own (sub)document. Comparing them would
    // false-positive every iframe interaction. Frame-document navigation is
    // a documented limitation (P1 iframe work deferred); frame targets keep
    // the pre-existing URL-level protection only.
    const isTopFrame = t.frameId === undefined || t.frameId === 'top';
    if (isTopFrame && liveDoc !== null && knownDoc !== null && liveDoc !== knownDoc) {
      throw new Error(
        `stale element ref "${ref}" ("${t.descriptor.name}"): the document changed since the ` +
          `snapshot (reload/navigation) — take a fresh browser_snapshot first`,
      );
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

  /**
   * Pre-action occlusion gate. After a ref resolves, uses the backend's
   * browser-native hit-test (document.elementFromPoint) to verify the
   * target is actually reachable in the current rendered state — not
   * hidden behind a visible modal/dialog, overlay, or backdrop, and not
   * outside the active dialog. Throws ActionBlockedError when blocked.
   * Backends without hitTest() skip the gate (documented degradation;
   * all production backends implement it).
   */
  private async assertActionable(ref: string, selector: string, frameId?: string): Promise<void> {
    if (!this.backend.hitTest) return;
    let hit: HitTestResult;
    try {
      hit = await this.backend.hitTest(selector, frameId);
    } catch {
      // A failed hit-test must not block legitimate actions: the target
      // was already resolved and signature-checked by resolveTarget.
      return;
    }
    if (!hit.actionable) {
      throw new ActionBlockedError(ref, hit);
    }
  }

  async click(ref: string): Promise<void> {
    const t = await this.resolveTarget(ref);
    await this.assertActionable(ref, t.selector, t.frameId);
    await this.backend.click(t.selector, t.frameId);
  }

  async dblclick(ref: string): Promise<void> {
    const t = await this.resolveTarget(ref);
    await this.assertActionable(ref, t.selector, t.frameId);
    await this.backend.dblclick(t.selector, t.frameId);
  }

  async type(ref: string, text: string, submit = false): Promise<void> {
    const t = await this.resolveTarget(ref);
    await this.assertActionable(ref, t.selector, t.frameId);
    await this.backend.type(t.selector, text, submit, t.frameId);
  }

  async clear(ref: string): Promise<void> {
    const t = await this.resolveTarget(ref);
    await this.assertActionable(ref, t.selector, t.frameId);
    await this.backend.clear(t.selector, t.frameId);
  }

  async pressKey(key: string): Promise<void> {
    await this.backend.pressKey(key);
  }

  async hover(ref: string): Promise<void> {
    const t = await this.resolveTarget(ref);
    await this.assertActionable(ref, t.selector, t.frameId);
    await this.backend.hover(t.selector, t.frameId);
  }

  async focus(ref: string): Promise<void> {
    const t = await this.resolveTarget(ref);
    await this.assertActionable(ref, t.selector, t.frameId);
    await this.backend.focus(t.selector, t.frameId);
  }

  async scrollIntoView(ref: string): Promise<void> {
    const t = await this.resolveTarget(ref);
    await this.backend.scrollIntoView(t.selector, t.frameId);
  }

  async selectOption(ref: string, values: string[]): Promise<string[]> {
    const t = await this.resolveTarget(ref);
    await this.assertActionable(ref, t.selector, t.frameId);
    return this.backend.selectOption(t.selector, values, t.frameId);
  }

  async setChecked(ref: string, checked: boolean): Promise<void> {
    const t = await this.resolveTarget(ref);
    await this.assertActionable(ref, t.selector, t.frameId);
    await this.backend.setChecked(t.selector, checked, t.frameId);
  }

  async scrollBy(dx: number, dy: number): Promise<void> {
    await this.backend.scrollBy(dx, dy);
  }

  async waitForSelector(
    selector: string,
    state: 'visible' | 'hidden' | 'attached' = 'visible',
    timeoutMs = 10_000,
    opts: { awaitNewDocument?: boolean } = {},
  ): Promise<void> {
    if (opts.awaitNewDocument) {
      // Generation-aware wait: a selector that already exists on the OLD
      // page must not satisfy a post-navigation wait. Wait for the document
      // to change first, then wait for the selector in the new document.
      await this.waitForDocumentChange(timeoutMs);
    }
    await this.backend.waitForSelector(selector, state, timeoutMs);
  }

  /**
   * Wait until the live document identity differs from the session's
   * baseline — i.e. a navigation, reload, or SPA document replacement
   * happened — or the timeout expires. Polls the backend's live identity
   * (URL + document load id); no arbitrary sleeps, bounded by timeoutMs.
   */
  async waitForDocumentChange(timeoutMs: number): Promise<void> {
    const baselineLoadId = liveLoadIdOfNonce(this.pageNonce);
    const baselineUrl = this.lastNavUrl ?? this.backend.currentUrl();
    const start = Date.now();
    for (;;) {
      const live = await this.readLivePageIdentity().catch(() => null);
      if (live) {
        if (live.url !== null && live.url !== baselineUrl) return;
        if (
          live.pageLoadId !== null &&
          baselineLoadId !== null &&
          live.pageLoadId !== baselineLoadId
        ) {
          return;
        }
      }
      if (Date.now() - start >= timeoutMs) {
        throw new Error(
          `timed out after ${timeoutMs}ms waiting for the document to change ` +
            `(no navigation/reload observed)`,
        );
      }
      await new Promise((r) => setTimeout(r, 100));
    }
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

  /**
   * Screenshot capture coordinator. Serializes captures through a mutex so
   * concurrent callers never hit the browser with simultaneous captures,
   * and enforces the backend's minimum capture interval
   * (screenshotMinIntervalMs — the extension backend sets 1000ms to match
   * Chrome's captureVisibleTab per-second quota) by waiting out the
   * remainder instead of failing. Non-screenshot operations are unaffected;
   * backends without a quota get serialization only, never added delay.
   * A raw browser quota error is mapped to an actionable message.
   */
  private screenshotMutex: Promise<void> = Promise.resolve();
  private lastScreenshotAt = 0;

  async screenshot(path: string): Promise<{ path: string }> {
    const prev = this.screenshotMutex;
    let release!: () => void;
    this.screenshotMutex = new Promise<void>((r) => {
      release = r;
    });
    await prev; // `release` is always called in `finally`, so this never rejects.
    try {
      const minInterval = this.backend.screenshotMinIntervalMs ?? 0;
      if (minInterval > 0) {
        const elapsed = Date.now() - this.lastScreenshotAt;
        if (elapsed < minInterval) {
          await new Promise((r) => setTimeout(r, minInterval - elapsed));
        }
      }
      try {
        await this.backend.screenshot(path);
      } catch (err) {
        const msg = (err as Error).message;
        if (/capture_visible_tab|capturevisibletab|max_capture/i.test(msg)) {
          throw new Error(
            `screenshot rate-limited by the browser (capture quota) — the bridge paces ` +
              `captures${minInterval > 0 ? ` at ${minInterval}ms intervals` : ''}; ` +
              `wait briefly and retry: ${msg}`,
          );
        }
        throw err;
      }
      this.lastScreenshotAt = Date.now();
      return { path };
    } finally {
      release();
    }
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
