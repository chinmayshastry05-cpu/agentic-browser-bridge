/**
 * tree.ts — builds a navigable element tree from a flat snapshot node list.
 *
 * The snapshot is flat (each node carries parentRef/childrenRefs); this module
 * materialises a real tree for rendering and targeted queries, which is what
 * the agent loop shows the planner.
 */
import type { DomNode } from './types.js';

export interface TreeNode {
  node: DomNode;
  children: TreeNode[];
  depth: number;
}

/** Build forest of TreeNodes from flat nodes. Orphans become roots. */
export function buildTree(nodes: DomNode[]): TreeNode[] {
  const byRef = new Map<string, TreeNode>();
  for (const n of nodes) {
    byRef.set(n.ref, { node: n, children: [], depth: 0 });
  }
  const roots: TreeNode[] = [];
  for (const t of byRef.values()) {
    const parentRef = t.node.parentRef;
    const parent = parentRef ? byRef.get(parentRef) : undefined;
    if (parent && parent !== t) {
      t.depth = parent.depth + 1;
      parent.children.push(t);
    } else {
      roots.push(t);
    }
  }
  // Fix depths in case of ordering quirks with a second pass.
  const fix = (t: TreeNode, depth: number): void => {
    t.depth = depth;
    for (const c of t.children) fix(c, depth + 1);
  };
  for (const r of roots) fix(r, 0);
  return roots;
}

function oneLine(t: TreeNode): string {
  const n = t.node;
  const label = n.name ? ` "${n.name}"` : '';
  const hidden = n.visible ? '' : ' [hidden]';
  const focused = n.focused ? ' [focused]' : '';
  return `[${n.ref}] ${n.role}${label} <${n.tag}>${hidden}${focused}`;
}

/** Render the tree as indented text for prompts/logs. */
export function renderTree(
  roots: TreeNode[],
  maxDepth = 6,
  maxNodes = 120,
  opts: { prioritize?: boolean } = {},
): string {
  const lines: string[] = [];
  let count = 0;
  const dialogRefs = opts.prioritize ? collectDialogRefs(roots) : new Set<string>();
  const orderedRoots = opts.prioritize ? [...roots].sort((a, b) => scoreOf(b, dialogRefs) - scoreOf(a, dialogRefs)) : roots;
  const walk = (t: TreeNode): void => {
    if (count >= maxNodes) return;
    if (t.depth > maxDepth) return;
    lines.push(`${'  '.repeat(t.depth)}${oneLine(t)}`);
    count += 1;
    const kids = opts.prioritize
      ? [...t.children].sort((a, b) => scoreOf(b, dialogRefs) - scoreOf(a, dialogRefs))
      : t.children;
    for (const c of kids) walk(c);
  };
  for (const r of orderedRoots) walk(r);
  const total = flatten(roots).length;
  const omitted = total - count;
  if (omitted > 0) {
    lines.push(
      `... (${omitted} more node${omitted === 1 ? '' : 's'} omitted — ` +
        `active dialog controls and visible interactables are shown first)`,
    );
  }
  return lines.join('\n');
}

/**
 * Priority model for snapshot rendering (P0: active controls must survive
 * truncation). Higher score renders first; document order breaks ties
 * (Array.sort is stable). Rationale:
 *   - visible dialog + its controls: the agent must see what blocks it
 *   - focused element: the current interaction target
 *   - visible interactables: actionable controls, above-the-fold first
 *   - structural context: headings/landmarks/forms/tables
 *   - everything else, then hidden nodes last
 */
function scoreOf(t: TreeNode, dialogRefs: Set<string>): number {
  const n = t.node;
  if (!n.visible) return 0;
  if (dialogRefs.has(n.ref)) return n.role === 'dialog' ? 100 : 90;
  if (n.focused) return 80;
  if (isInteractableRole(n.role)) {
    // Above-the-fold approximation: smaller y ranks higher within the band.
    const y = n.boundingBox?.y ?? 10000;
    return 60 - Math.min(9, Math.floor(Math.max(0, y) / 1000));
  }
  if (n.role === 'heading' || n.role === 'landmark' || n.role === 'form' || n.role === 'table') {
    return 30;
  }
  return 10;
}

function isInteractableRole(role: string): boolean {
  return (
    role === 'button' ||
    role === 'link' ||
    role === 'textbox' ||
    role === 'checkbox' ||
    role === 'radio' ||
    role === 'switch' ||
    role === 'combobox' ||
    role === 'tab' ||
    role === 'menuitem'
  );
}

/**
 * Refs of visible dialog nodes plus every descendant: the "active UI"
 * that must survive truncation. Uses parentRef chains where available
 * (Playwright walker); falls back to bounding-box containment for flat
 * snapshots (extension walker sets parentRef: null).
 */
export function collectDialogRefs(roots: TreeNode[]): Set<string> {
  const out = new Set<string>();
  const dialogs: TreeNode[] = [];
  const find = (t: TreeNode): void => {
    if (t.node.visible && t.node.role === 'dialog') dialogs.push(t);
    for (const c of t.children) find(c);
  };
  for (const r of roots) find(r);
  for (const d of dialogs) {
    const walk = (t: TreeNode): void => {
      out.add(t.node.ref);
      for (const c of t.children) walk(c);
    };
    walk(d);
    // Flat-snapshot fallback: nodes whose box is inside the dialog's box.
    const box = d.node.boundingBox;
    if (box) {
      const containsAll = (r: TreeNode): void => {
        const b = r.node.boundingBox;
        if (
          b &&
          b.x >= box.x &&
          b.y >= box.y &&
          b.x + b.width <= box.x + box.width &&
          b.y + b.height <= box.y + box.height
        ) {
          out.add(r.node.ref);
        }
        for (const c of r.children) containsAll(c);
      };
      for (const r of roots) containsAll(r);
    }
  }
  return out;
}

/**
 * Keep only the active-dialog subtrees (visible dialogs + descendants).
 * Used for dialog-scoped snapshots so the agent can inspect a blocking
 * modal without background noise.
 */
export function dialogSubtreeNodes(nodes: DomNode[]): DomNode[] {
  const keep = collectDialogRefs(buildTree(nodes));
  return nodes.filter((n) => keep.has(n.ref));
}

/** Keep only nodes whose bounding box intersects the given viewport rect. */
export function regionNodes(
  nodes: DomNode[],
  region: { x: number; y: number; width: number; height: number },
): DomNode[] {
  return nodes.filter((n) => {
    const b = n.boundingBox;
    if (!b) return false;
    return (
      b.x < region.x + region.width &&
      b.x + b.width > region.x &&
      b.y < region.y + region.height &&
      b.y + b.height > region.y
    );
  });
}

/** Depth-first search; returns the first TreeNode matching predicate. */
export function findNode(
  roots: TreeNode[],
  predicate: (n: DomNode) => boolean,
): TreeNode | null {
  for (const r of roots) {
    if (predicate(r.node)) return r;
    const found = findNode(r.children, predicate);
    if (found) return found;
  }
  return null;
}

/** Flatten back to node list in depth-first order. */
export function flatten(roots: TreeNode[]): DomNode[] {
  const out: DomNode[] = [];
  const walk = (t: TreeNode): void => {
    out.push(t.node);
    for (const c of t.children) walk(c);
  };
  for (const r of roots) walk(r);
  return out;
}
