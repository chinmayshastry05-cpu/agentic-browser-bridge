/**
 * tests/visual.test.ts — coordinate-based visual grounding.
 *
 * CoordinateVisualPerceptor maps viewport (x,y) to DOM refs via a
 * GroundingSource (element-from-point hit testing). This is honest
 * coordinate-driven grounding — not a vision model.
 *
 * Covers: fake-source unit tests (hit, miss, out-of-viewport refusal,
 * regionToCandidates), and a real Playwright page asserting
 * groundAtPoint resolves the correct ref through actual elementFromPoint.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CoordinateVisualPerceptor,
  PlaywrightGroundingSource,
  type GroundingSource,
  type PointHit,
} from '../src/perception/visual.js';
import type { PageSnapshot } from '../src/types.js';
type ViewportSize = { width: number; height: number };

const VIEWPORT: ViewportSize = { width: 800, height: 600 };

function node(
  ref: string,
  role: string,
  name: string,
  box: { x: number; y: number; width: number; height: number },
) {
  return {
    ref, role, name, tag: role, text: name, attributes: {},
    selector: `#${ref}`, parentRef: null, childrenRefs: [],
    boundingBox: box, visible: true,
  };
}

const SNAPSHOT: PageSnapshot = {
  snapshotId: 's1',
  url: 'https://example.com/',
  title: 'Test',
  capturedAt: new Date().toISOString(),
  nodes: [
    node('e1', 'button', 'One', { x: 100, y: 100, width: 120, height: 40 }),
    node('e2', 'button', 'Two', { x: 300, y: 100, width: 120, height: 40 }),
  ],
};

class FakeSource implements GroundingSource {
  readonly backendName = 'fake';
  async viewportSize(): Promise<ViewportSize> {
    return VIEWPORT;
  }
  async elementFromPoint(x: number, y: number): Promise<PointHit | null> {
    // Topmost match: iterate in reverse document order (e2 above e1).
    for (const n of [...SNAPSHOT.nodes].reverse()) {
      const b = n.boundingBox;
      if (b && x >= b.x && x <= b.x + b.width && y >= b.y && y <= b.y + b.height) {
        return { tag: n.tag, text: n.name, boundingBox: b };
      }
    }
    return null;
  }
  async snapshot(): Promise<PageSnapshot> {
    return SNAPSHOT;
  }
}

describe('CoordinateVisualPerceptor (fake source)', () => {
  const perceptor = new CoordinateVisualPerceptor(new FakeSource());

  it('resolves the right ref for each coordinate', async () => {
    const g1 = await perceptor.groundAtPoint(160, 120);
    expect(g1?.ref).toBe('e1');
    expect(g1?.method).toBe('element-from-point');

    const g2 = await perceptor.groundAtPoint(360, 120);
    expect(g2?.ref).toBe('e2');
  });

  it('returns null for an in-viewport point with no hit', async () => {
    expect(await perceptor.groundAtPoint(700, 500)).toBeNull();
  });

  it('refuses out-of-viewport points', async () => {
    expect(await perceptor.groundAtPoint(-10, 100)).toBeNull();
    expect(await perceptor.groundAtPoint(100, -5)).toBeNull();
    expect(await perceptor.groundAtPoint(800, 100)).toBeNull();
    expect(await perceptor.groundAtPoint(100, 600)).toBeNull();
  });

  it('regionToCandidates returns intersecting refs only', async () => {
    const all = await perceptor.regionToCandidates(0, 0, 800, 600);
    expect(all.map((c) => c.ref).sort()).toEqual(['e1', 'e2']);
    expect(all[0]!.method).toBe('element-from-point');

    const one = await perceptor.regionToCandidates(0, 0, 220, 140);
    expect(one.map((c) => c.ref)).toEqual(['e1']);

    const none = await perceptor.regionToCandidates(0, 0, 50, 50);
    expect(none).toEqual([]);
  });
});

describe('CoordinateVisualPerceptor (real Playwright page)', () => {
  let browser: import('playwright').Browser | null = null;
  let page: import('playwright').Page | null = null;

  beforeAll(async () => {
    const { chromium } = await import('playwright');
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 800, height: 600 } });
    await page.goto(
      'data:text/html,' +
        encodeURIComponent(
          '<button id="a" style="position:absolute;left:100px;top:100px;width:120px;height:40px">One</button>' +
            '<button id="b" style="position:absolute;left:300px;top:100px;width:120px;height:40px">Two</button>',
        ),
    );
  });

  afterAll(async () => {
    await page?.close().catch(() => undefined);
    await browser?.close().catch(() => undefined);
  });

  it('groundAtPoint resolves the correct ref through real elementFromPoint', async () => {
    if (!page) throw new Error('no page');
    const rects = await page.evaluate(() => {
      const pick = (id: string) => {
        const el = document.getElementById(id)!;
        const r = el.getBoundingClientRect();
        return { ref: id, box: { x: r.x, y: r.y, width: r.width, height: r.height } };
      };
      return [pick('a'), pick('b')];
    });
    const snapshot: PageSnapshot = {
      snapshotId: 's-live',
      url: page.url(),
      title: await page.title(),
      capturedAt: new Date().toISOString(),
      nodes: rects.map((r) => ({
        ref: r.ref, role: 'button', name: r.ref, tag: 'button', text: r.ref,
        attributes: {}, selector: `#${r.ref}`, parentRef: null, childrenRefs: [],
        boundingBox: r.box, visible: true,
      })),
    };
    const source = new PlaywrightGroundingSource(page, async () => snapshot);
    const perceptor = new CoordinateVisualPerceptor(source);

    // Center of button #a (CSS coords == viewport coords here).
    const cx = rects[0]!.box.x + rects[0]!.box.width / 2;
    const cy = rects[0]!.box.y + rects[0]!.box.height / 2;
    const g = await perceptor.groundAtPoint(cx, cy);
    expect(g?.ref).toBe('a');
    expect(g?.selector).toBe('#a');
    expect(g?.method).toBe('element-from-point');

    // Between the buttons: no hit.
    expect(await perceptor.groundAtPoint(250, 120)).toBeNull();
    // Out of viewport: refused without calling elementFromPoint.
    expect(await perceptor.groundAtPoint(900, 100)).toBeNull();
  });
});
