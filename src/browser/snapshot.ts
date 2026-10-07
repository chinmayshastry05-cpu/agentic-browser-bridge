/**
 * snapshot.ts — shared in-page DOM snapshot walker.
 *
 * Used by every browser backend (Playwright-launched, CDP-attached, ...).
 * The walk runs inside the page via page.evaluate: it assigns stable
 * `data-abb-ref` attributes ("e1", "e2", ...) and returns flat node records
 * with unique CSS selectors so actions can re-locate elements later.
 *
 * Shadow DOM: open shadow roots are pierced during the walk. Closed shadow
 * roots are NOT accessible to page JavaScript — that is a documented v1
 * limitation (see README).
 *
 * Frames: the walk runs in the top frame only. Frame-scoped snapshots are
 * captured separately via captureFrameSnapshot() so refs carry frame context.
 */
import type { Page } from 'playwright';
import { randomUUID } from 'node:crypto';
import type { DomNode, PageSnapshot } from '../types.js';

export const REF_ATTR = 'data-abb-ref';

/** Roles we consider interactable for the agent. */
export const INTERACTABLE_SELECTOR = [
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
export const STRUCTURAL_SELECTOR = [
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
  /** Present when the node lives inside a frame or shadow root. */
  frameId?: string;
}

/**
 * Evaluate the DOM walk in the given root document scope. `scopeLabel` is
 * recorded on each node so refs from frames can be distinguished.
 */
export async function walkDom(
  page: Page,
  scopeLabel?: string,
): Promise<RawNode[]> {
  return page.evaluate(
    ({ interactableSel, structuralSel, refAttr, scopeLabel }) => {
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
        frameId?: string;
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
        for (const a of [
          'type',
          'href',
          'placeholder',
          'value',
          'name',
          'alt',
          'title',
          'target',
          'checked',
          'disabled',
          'readonly',
        ]) {
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
          ...(scopeLabel ? { frameId: scopeLabel } : {}),
        });
        // Recurse into nested interactables/structural elements, and pierce
        // open shadow roots (closed shadow roots are invisible to the page).
        const kids = el.querySelectorAll(`${interactableSel},${structuralSel}`);
        const shadowKids =
          el.shadowRoot != null
            ? Array.from(el.shadowRoot.querySelectorAll(`${interactableSel},${structuralSel}`))
            : [];
        for (const kid of [...Array.from(kids), ...shadowKids]) {
          if (kid === el || seen.has(kid)) continue;
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
    { interactableSel: INTERACTABLE_SELECTOR, structuralSel: STRUCTURAL_SELECTOR, refAttr: REF_ATTR, scopeLabel },
  );
}

function assembleNodes(raw: RawNode[]): DomNode[] {
  const byRef = new Map<string, RawNode>(raw.map((n) => [n.ref, n]));
  const nodes: DomNode[] = raw.map((n) => ({
    ref: n.ref,
    role: n.role,
    name: n.name,
    tag: n.tag,
    text: n.text,
    attributes: n.attributes,
    selector: n.selector,
    parentRef: n.parentRef,
    childrenRefs: raw.filter((c) => c.parentRef === n.ref).map((c) => c.ref),
    boundingBox: n.boundingBox,
    visible: n.visible,
    ...(n.frameId ? { frameId: n.frameId } : {}),
  }));
  for (const n of nodes) {
    if (n.parentRef && !byRef.has(n.parentRef)) n.parentRef = null;
  }
  return nodes;
}

/** Capture a full PageSnapshot for the given Playwright page. */
export async function captureSnapshot(page: Page): Promise<PageSnapshot> {
  const raw = await walkDom(page);
  return {
    snapshotId: `snap-${randomUUID().slice(0, 8)}`,
    url: page.url(),
    title: await page.title().catch(() => ''),
    capturedAt: new Date().toISOString(),
    nodes: assembleNodes(raw),
  };
}
