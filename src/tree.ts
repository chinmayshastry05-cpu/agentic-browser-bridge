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
  return `[${n.ref}] ${n.role}${label} <${n.tag}>${hidden}`;
}

/** Render the tree as indented text for prompts/logs. */
export function renderTree(roots: TreeNode[], maxDepth = 6, maxNodes = 120): string {
  const lines: string[] = [];
  let count = 0;
  const walk = (t: TreeNode): void => {
    if (count >= maxNodes) return;
    if (t.depth > maxDepth) return;
    lines.push(`${'  '.repeat(t.depth)}${oneLine(t)}`);
    count += 1;
    for (const c of t.children) walk(c);
  };
  for (const r of roots) walk(r);
  if (count >= maxNodes) lines.push('... (truncated)');
  return lines.join('\n');
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
