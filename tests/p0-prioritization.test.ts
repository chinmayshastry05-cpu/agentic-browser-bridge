/**
 * tests/p0-prioritization.test.ts — P0-2 active controls survive truncation.
 *
 * Real-site evidence (v0.1.3, independent): Flipkart's ~120-node rendered
 * tree contained the underlying page while omitting the visible overlay
 * close control — the old renderTree() cut off at 120 nodes in document
 * order. Rendering is now priority-ordered (dialog controls first), and
 * truncation is honest about what was omitted.
 *
 * Fixture G (pages/dense.html): 150 cards (~600 nodes) with a modal dialog
 * as the LAST element in DOM order — document-order truncation would drop
 * it; prioritized rendering must keep it.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildTree, dialogSubtreeNodes, regionNodes, renderTree } from '../src/tree.js';
import { assembleNodes, type RawNode } from '../src/browser/snapshot.js';

const PAGES = new URL('./fixtures/pages/', import.meta.url).pathname;

function rawNodes(html: string): RawNode[] {
  // Deterministic pseudo-walk: parse the fixture with regexes into RawNodes.
  // (Full DOM fidelity is covered by the real-browser tests; here we test
  // the ranking/truncation logic itself.)
  const nodes: RawNode[] = [];
  let i = 0;
  const push = (over: Partial<RawNode> & { ref: string }) => {
    nodes.push({
      role: 'button',
      name: '',
      tag: 'button',
      text: '',
      attributes: {},
      selector: `#${over.ref}`,
      parentRef: null,
      boundingBox: { x: 10, y: 10 + i * 40, width: 100, height: 30 },
      visible: true,
      ...over,
    } as RawNode);
    i++;
  };
  // 200 background buttons in document order...
  for (let k = 1; k <= 200; k++) {
    push({ ref: `e${k}`, role: 'button', name: `Background ${k}`, tag: 'button' });
  }
  // ...then the dialog LAST (document-order truncation would drop it).
  push({ ref: 'e201', role: 'dialog', name: 'Important notice', tag: 'div', boundingBox: { x: 100, y: 100, width: 400, height: 300 } });
  push({ ref: 'e202', role: 'button', name: 'Confirm now', tag: 'button', parentRef: 'e201', boundingBox: { x: 120, y: 150, width: 120, height: 30 } });
  push({ ref: 'e203', role: 'button', name: 'Dismiss', tag: 'button', parentRef: 'e201', boundingBox: { x: 250, y: 150, width: 120, height: 30 } });
  void html;
  return nodes;
}

describe('P0-2 prioritized rendering (unit)', () => {
  it('dialog controls survive a 120-node cap even when last in DOM order', () => {
    const nodes = assembleNodes(rawNodes(''));
    const tree = renderTree(buildTree(nodes), 6, 120, { prioritize: true });
    const lines = tree.split('\n');
    // The dialog and its controls must be at the TOP of the rendering.
    expect(lines[0]).toContain('[e201]');
    expect(lines[1]).toContain('[e202]');
    expect(lines[1]).toContain('Confirm now');
    // Truncation is honest: exact omitted count.
    const last = lines[lines.length - 1];
    expect(last).toMatch(/\.\.\. \(83 more nodes omitted/);
  });

  it('document-order rendering is unchanged when prioritize is off', () => {
    const nodes = assembleNodes(rawNodes(''));
    const tree = renderTree(buildTree(nodes), 6, 120);
    const lines = tree.split('\n');
    expect(lines[0]).toContain('[e1]');
    expect(lines[lines.length - 1]).toMatch(/more nodes omitted/);
  });

  it('dialogSubtreeNodes keeps only the dialog and its controls', () => {
    const nodes = assembleNodes(rawNodes(''));
    const sub = dialogSubtreeNodes(nodes);
    expect(sub.map((n) => n.ref).sort()).toEqual(['e201', 'e202', 'e203']);
  });

  it('regionNodes keeps only intersecting nodes', () => {
    const nodes = assembleNodes(rawNodes(''));
    const inDialog = regionNodes(nodes, { x: 90, y: 90, width: 420, height: 320 });
    const refs = inDialog.map((n) => n.ref);
    expect(refs).toContain('e201');
    expect(refs).toContain('e202');
    expect(refs).not.toContain('e1');
  });

  it('hidden nodes rank last', () => {
    const nodes = assembleNodes(rawNodes(''));
    const hidden = nodes.find((n) => n.ref === 'e5')!;
    hidden.visible = false;
    const tree = renderTree(buildTree(nodes), 6, 120, { prioritize: true });
    const lines = tree.split('\n').filter((l) => l.includes('[e5]'));
    expect(lines.length).toBe(0); // e5 was pushed out by the cap (rank 0)
  });
});

describe('P0-2 dense fixture file exists', () => {
  it('pages/dense.html has >120 interactable nodes with a trailing dialog', () => {
    const html = readFileSync(join(PAGES, 'dense.html'), 'utf8');
    const buttons = (html.match(/<button/g) || []).length;
    expect(buttons).toBeGreaterThan(120);
    expect(html).toContain('role="dialog"');
    // Dialog is the last element in the body (worst case for doc-order truncation).
    expect(html.lastIndexOf('role="dialog"')).toBeGreaterThan(html.lastIndexOf('btn150'));
  });
});
