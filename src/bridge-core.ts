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
 */
import { chromium, type Browser, type Page } from 'playwright';
import {
  type BrowserBackend,
  type BrowserStartOptions,
  type DomNode,
  type PageSnapshot,
} from './types.js';

const REF_ATTR = 'data-abb-ref';

/** Roles we consider interactable for the agent. */
const INTERACTABLE_SELECTOR = [
  'a[href]',
  'button',
  'input',
  'select',
  'textarea',
  '[role="button"]',
  '[role="link"]',
  '[role="textbox"]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="tab"]',
  '[role="menuitem"]',
  '[onclick]',
].join(',');

/** Structural roles we also capture so the tree has headings/landmarks. */
const STRUCTURAL_SELECTOR = [
  'h1',
  'h2',
  'h3',
  'img[alt]',
  'form',
  'table',
  'main',
  'nav',
  'header',
  'footer',
].join(',');

interface RawNode {
  ref: string;
  role: string;
  name: string;
  tag: string;
  text: string;
  attributes: Record<string, string>;
  selector: string;
  parentRef: string | null;
  boundingBox: { x: number; y: number; width: number; height: number } | null;
  visible: boolean;
}

/**
 * Playwright-backed implementation of BrowserBackend.
 * Snapshotting is done with an in-page DOM walk (page.evaluate) that assigns
 * stable `data-abb-ref` attributes, so refs are resolvable later by selector.
 */
export class PlaywrightBackend implements BrowserBackend {
  private browser: Browser | null = null;
  private page: Page | null = null;
  private navigationTimeoutMs = 30_000;

  async start(opts: BrowserStartOptions): Promise<void> {
    if (this.browser) return;
    this.navigationTimeoutMs = opts.navigationTimeoutMs ?? 30_000;
    this.browser = await chromium.launch({ headless: opts.headless });
    const context = await this.browser.newContext({
      viewport: opts.viewport ?? { width: 1280, height: 800 },
    });
    this.page = await context.newPage();
    this.page.setDefaultNavigationTimeout(this.navigationTimeoutMs);
    this.page.setDefaultTimeout(Math.min(this.navigationTimeoutMs, 15_000));
  }

  async stop(): Promise<void> {
    await this.browser?.close().catch(() => undefined);
    this.browser = null;
    this.page = null;
  }

  private requirePage(): Page {
    if (!this.page) throw new Error('backend not started: call start() first');
    return this.page;
  }

  async goto(url: string): Promise<void> {
    await this.requirePage().goto(url, { waitUntil: 'domcontentloaded' });
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
    const page = this.requirePage();
    const raw = await page.evaluate(
      ({ interactableSel, structuralSel, refAttr }) => {
        const seen = new WeakSet<Element>();
        const nodes: Array<{
          ref: string;
          role: string;
          name: string;
          tag: string;
          text: string;
          attributes: Record<string, string>;
          selector: string;
          parentRef: string | null;
          boundingBox: { x: number; y: number; width: number; height: number } | null;
          visible: boolean;
        }> = [];
        let counter = 0;

        const cssEscape = (s: string): string => {
          if (typeof CSS !== 'undefined' && CSS.escape) return CSS.escape(s);
          return s.replace(/[^a-zA-Z0-9_-]/g, '\\$&');
        };

        /** Build a unique CSS selector for an element. */
        const uniqueSelector = (el: Element): string => {
          if (el.id) return `#${cssEscape(el.id)}`;
          const parts: string[] = [];
          let cur: Element | null = el;
          while (cur && cur !== document.documentElement && parts.length < 8) {
            let part = cur.tagName.toLowerCase();
            const parent: Element | null = cur.parentElement;
            if (parent) {
              const tagName = cur.tagName;
              const self: Element = cur;
              const siblings = Array.from(parent.children).filter(
                (c) => c.tagName === tagName,
              );
              if (siblings.length > 1) {
                part += `:nth-of-type(${siblings.indexOf(self) + 1})`;
              }
            }
            parts.unshift(part);
            cur = parent;
          }
          return parts.join(' > ');
        };

        const accessibleName = (el: Element): string => {
          const aria = el.getAttribute('aria-label');
          if (aria) return aria.trim();
          const labelledBy = el.getAttribute('aria-labelledby');
          if (labelledBy) {
            const labelEl = document.getElementById(labelledBy);
            if (labelEl?.textContent) return labelEl.textContent.trim().slice(0, 120);
          }
          if (el instanceof HTMLImageElement && el.alt) return el.alt.trim();
          if (el instanceof HTMLInputElement) {
            if (el.placeholder) return el.placeholder.trim();
            const labels = (el as HTMLInputElement).labels;
            if (labels && labels.length > 0 && labels[0].textContent) {
              return labels[0].textContent.trim().slice(0, 120);
            }
          }
          const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
          return text.slice(0, 120);
        };

        const roleOf = (el: Element): string => {
          const explicit = el.getAttribute('role');
          if (explicit) return explicit.toLowerCase();
          const tag = el.tagName.toLowerCase();
          if (tag === 'a') return 'link';
          if (tag === 'button') return 'button';
          if (tag === 'input') {
            const t = (el.getAttribute('type') ?? 'text').toLowerCase();
            if (t === 'checkbox') return 'checkbox';
            if (t === 'radio') return 'radio';
            if (t === 'submit' || t === 'button') return 'button';
            return 'textbox';
          }
          if (tag === 'select') return 'combobox';
          if (tag === 'textarea') return 'textbox';
          if (/^h[1-6]$/.test(tag)) return 'heading';
          if (tag === 'img') return 'img';
          if (tag === 'form') return 'form';
          if (tag === 'table') return 'table';
          if (tag === 'main' || tag === 'nav' || tag === 'header' || tag === 'footer')
            return 'landmark';
          return tag;
        };

        const interestingAttrs = (el: Element): Record<string, string> => {
          const out: Record<string, string> = {};
          for (const a of ['type', 'href', 'placeholder', 'value', 'name', 'alt', 'title', 'target']) {
            const v = el.getAttribute(a);
            if (v !== null && v !== '') out[a] = v.slice(0, 200);
          }
          return out;
        };

        const visit = (el: Element, parentRef: string | null): void => {
          if (seen.has(el)) return;
          seen.add(el);
          counter += 1;
          const ref = `e${counter}`;
          el.setAttribute(refAttr, ref);
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          const visible =
            rect.width > 0 &&
            rect.height > 0 &&
            style.visibility !== 'hidden' &&
            style.display !== 'none';
          nodes.push({
            ref,
            role: roleOf(el),
            name: accessibleName(el),
            tag: el.tagName.toLowerCase(),
            text:
              el.tagName.toLowerCase() === 'input' ||
              el.tagName.toLowerCase() === 'textarea'
                ? (el as HTMLInputElement).value.slice(0, 200)
                : (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 200),
            attributes: interestingAttrs(el),
            selector: uniqueSelector(el),
            parentRef,
            boundingBox:
              rect.width > 0
                ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
                : null,
            visible,
          });
          // Recurse only into nested interactables/structural elements to keep
          // snapshots compact.
          const kids = el.querySelectorAll(`${interactableSel},${structuralSel}`);
          for (const kid of Array.from(kids)) {
            if (kid === el || seen.has(kid)) continue;
            // Only treat as a child if no intermediate interesting ancestor exists.
            let p: Element | null = kid.parentElement;
            let nested = false;
            while (p && p !== el) {
              if (seen.has(p)) {
                nested = true;
                break;
              }
              p = p.parentElement;
            }
            if (!nested) visit(kid, ref);
          }
        };

        const roots = document.querySelectorAll(`${interactableSel},${structuralSel}`);
        for (const root of Array.from(roots)) {
          if (seen.has(root)) continue;
          // Skip if an ancestor is already captured (it will recurse into this).
          let p: Element | null = root.parentElement;
          let covered = false;
          while (p) {
            if (seen.has(p)) {
              covered = true;
              break;
            }
            p = p.parentElement;
          }
          if (!covered) visit(root, null);
        }
        return nodes;
      },
      { interactableSel: INTERACTABLE_SELECTOR, structuralSel: STRUCTURAL_SELECTOR, refAttr: REF_ATTR },
    );

    const byRef = new Map<string, RawNode>(raw.map((n) => [n.ref, n]));
    const nodes: DomNode[] = raw.map((n) => ({
      ...n,
      childrenRefs: raw.filter((c) => c.parentRef === n.ref).map((c) => c.ref),
    }));
    // Sanity: every parentRef must exist.
    for (const n of nodes) {
      if (n.parentRef && !byRef.has(n.parentRef)) n.parentRef = null;
    }

    return {
      url: this.currentUrl(),
      title: await this.title().catch(() => ''),
      capturedAt: new Date().toISOString(),
      nodes,
    };
  }
}

/**
 * BrowserSession — one named agent-driven browser session.
 * Owns the ref→selector resolution so tools and the agent loop only ever
 * handle short refs ("e12") while actions resolve to unique selectors.
 */
export class BrowserSession {
  readonly id: string;
  private readonly backend: BrowserBackend;
  private selectorByRef = new Map<string, string>();
  private lastSnapshotAt: string | null = null;

  constructor(id: string, backend: BrowserBackend = new PlaywrightBackend()) {
    this.id = id;
    this.backend = backend;
  }

  async start(opts: BrowserStartOptions): Promise<void> {
    await this.backend.start(opts);
  }

  async close(): Promise<void> {
    await this.backend.stop();
    this.selectorByRef.clear();
  }

  async navigate(url: string): Promise<{ url: string; title: string }> {
    if (!/^https?:\/\//i.test(url) && !/^file:\/\//i.test(url) && !/^data:/i.test(url)) {
      throw new Error(`refusing to navigate to non-web URL: ${url}`);
    }
    await this.backend.goto(url);
    return { url: this.backend.currentUrl(), title: await this.backend.title() };
  }

  async snapshot(): Promise<PageSnapshot> {
    const snap = await this.backend.snapshot();
    this.selectorByRef.clear();
    for (const n of snap.nodes) this.selectorByRef.set(n.ref, n.selector);
    this.lastSnapshotAt = snap.capturedAt;
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

  get lastSnapshot(): string | null {
    return this.lastSnapshotAt;
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
