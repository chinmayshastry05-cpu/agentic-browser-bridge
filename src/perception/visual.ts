/**
 * visual.ts — coordinate-based visual grounding (honest baseline).
 *
 * Pluggable VisualPerceptor interface for mapping viewport coordinates to
 * DOM refs. The shipped implementation is COORDINATE-DRIVEN, not a vision
 * model:
 *
 *   groundAtPoint(x, y): document.elementFromPoint(x, y) in the page, then
 *   match the hit against the latest DOM snapshot's bounding boxes.
 *
 * It therefore grounds "what is visually at this point" exactly as the
 * browser's own hit-testing sees it — but it cannot interpret raw pixels, and
 * the optional `screenshot` argument is accepted for future vision-model
 * perceptors and ignored by this baseline. Out-of-viewport points are
 * refused (null), never clamped or guessed.
 */
import type { PageSnapshot } from '../types.js';

export interface PointHit {
  tag: string;
  id?: string;
  text?: string;
  boundingBox: { x: number; y: number; width: number; height: number };
}

export interface PointGrounding {
  ref: string;
  selector: string;
  role: string;
  name: string;
  /** How the grounding was established. */
  method: 'element-from-point';
}

/** Minimal surface a browser backend must expose for coordinate grounding. */
export interface GroundingSource {
  /** Fresh snapshot used to map a hit back to a stable ref. */
  snapshot(): Promise<PageSnapshot>;
  /** Viewport size in CSS pixels. */
  viewportSize(): Promise<{ width: number; height: number }>;
  /**
   * Topmost element at viewport CSS-pixel coords, or null when nothing is
   * hit. Must return null (not throw) for out-of-viewport points.
   */
  elementFromPoint(x: number, y: number): Promise<PointHit | null>;
}

export interface VisualPerceptor {
  readonly name: string;
  /**
   * Resolve viewport coordinates (CSS px) to a DOM ref.
   * `screenshot` is reserved for vision-model perceptors; the coordinate
   * baseline ignores it. Returns null when the point is out of the viewport
   * or hits no snapshotted interactable.
   */
  groundAtPoint(x: number, y: number, screenshot?: Buffer): Promise<PointGrounding | null>;
  /** Refs whose bounding boxes intersect the given viewport rectangle. */
  regionToCandidates(
    x: number,
    y: number,
    width: number,
    height: number,
  ): Promise<PointGrounding[]>;
}

function contains(
  box: { x: number; y: number; width: number; height: number } | null | undefined,
  x: number,
  y: number,
): boolean {
  if (!box) return false;
  return x >= box.x && x <= box.x + box.width && y >= box.y && y <= box.y + box.height;
}

function intersects(
  box: { x: number; y: number; width: number; height: number } | null | undefined,
  x: number,
  y: number,
  width: number,
  height: number,
): boolean {
  if (!box) return false;
  return box.x < x + width && box.x + box.width > x && box.y < y + height && box.y + box.height > y;
}

function area(box: { width: number; height: number }): number {
  return box.width * box.height;
}

/**
 * Coordinate-driven perceptor: browser hit-testing + snapshot box matching.
 * Works with any GroundingSource (extension backend, Playwright, fakes).
 */
export class CoordinateVisualPerceptor implements VisualPerceptor {
  readonly name = 'coordinate';
  constructor(private readonly source: GroundingSource) {}

  async groundAtPoint(x: number, y: number, _screenshot?: Buffer): Promise<PointGrounding | null> {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    const vp = await this.source.viewportSize();
    // Refuse out-of-viewport points instead of clamping them.
    if (x < 0 || y < 0 || x > vp.width || y > vp.height) return null;
    const hit = await this.source.elementFromPoint(x, y);
    if (!hit) return null;
    const snap = await this.source.snapshot();
    const candidates = snap.nodes.filter((n) => n.visible && contains(n.boundingBox, x, y));
    if (candidates.length === 0) return null; // hit a non-interactable region
    candidates.sort((a, b) => area(a.boundingBox!) - area(b.boundingBox!));
    const best = candidates[0]!;
    return {
      ref: best.ref,
      selector: best.selector,
      role: best.role,
      name: best.name,
      method: 'element-from-point',
    };
  }

  async regionToCandidates(
    x: number,
    y: number,
    width: number,
    height: number,
  ): Promise<PointGrounding[]> {
    const snap = await this.source.snapshot();
    return snap.nodes
      .filter((n) => n.visible && intersects(n.boundingBox, x, y, width, height))
      .sort((a, b) => area(a.boundingBox!) - area(b.boundingBox!))
      .map((n) => ({
        ref: n.ref,
        selector: n.selector,
        role: n.role,
        name: n.name,
        method: 'element-from-point' as const,
      }));
  }
}

/**
 * GroundingSource adapter for a Playwright Page. `page` is typed loosely so
 * tests can substitute a fake; in production pass a real playwright Page plus
 * a snapshot provider (e.g. () => backend.snapshot()).
 */
export class PlaywrightGroundingSource implements GroundingSource {
  constructor(
    private readonly page: {
      evaluate<T>(fn: (arg: unknown) => T, arg?: unknown): Promise<T>;
    },
    private readonly snapshotProvider: () => Promise<PageSnapshot>,
  ) {}

  async snapshot(): Promise<PageSnapshot> {
    return this.snapshotProvider();
  }

  async viewportSize(): Promise<{ width: number; height: number }> {
    return this.page.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
    }));
  }

  async elementFromPoint(x: number, y: number): Promise<PointHit | null> {
    return this.page.evaluate((pt: unknown) => {
      const { x, y } = pt as { x: number; y: number };
      const el = document.elementFromPoint(x, y) as HTMLElement | null;
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        tag: el.tagName.toLowerCase(),
        id: el.id || undefined,
        text: (el.textContent || '').trim().slice(0, 120) || undefined,
        boundingBox: { x: r.x, y: r.y, width: r.width, height: r.height },
      };
    }, { x, y });
  }
}
