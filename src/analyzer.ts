/**
 * analyzer.ts — turns a raw PageSnapshot into a planner-friendly analysis.
 *
 * The agent loop feeds the LLM a compact textual summary rather than the full
 * node list; this module produces that summary plus the query helpers the
 * loop and tools use (find by name/role, rank interactables).
 */
import type { DomNode, PageSnapshot } from './types.js';

export interface AnalysisSummary {
  url: string;
  title: string;
  capturedAt: string;
  totalNodes: number;
  visibleNodes: number;
  countsByRole: Record<string, number>;
  /** Short human-readable outline: headings and landmarks. */
  outline: string[];
  /** Up to N most salient interactables, in document order. */
  topInteractables: Array<{ ref: string; role: string; name: string }>;
  /** Compact one-paragraph brief for the planner prompt. */
  brief: string;
}

const INTERACTABLE_ROLES = new Set([
  'button',
  'link',
  'textbox',
  'combobox',
  'checkbox',
  'radio',
  'switch',
  'tab',
  'menuitem',
]);

export function isInteractable(node: DomNode): boolean {
  return INTERACTABLE_ROLES.has(node.role);
}

/** Case-insensitive substring search over accessible names. */
export function findByName(snapshot: PageSnapshot, query: string): DomNode[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return snapshot.nodes.filter((n) => n.name.toLowerCase().includes(q));
}

/** All nodes of a given role, e.g. "textbox". */
export function findByRole(snapshot: PageSnapshot, role: string): DomNode[] {
  const r = role.trim().toLowerCase();
  return snapshot.nodes.filter((n) => n.role === r);
}

/** Interactable nodes sorted: visible first, then by name length (shorter = crisper labels). */
export function rankInteractables(snapshot: PageSnapshot, limit = 40): DomNode[] {
  return snapshot.nodes
    .filter(isInteractable)
    .sort((a, b) => {
      if (a.visible !== b.visible) return a.visible ? -1 : 1;
      return a.name.length - b.name.length;
    })
    .slice(0, limit);
}

export function analyze(snapshot: PageSnapshot): AnalysisSummary {
  const countsByRole: Record<string, number> = {};
  for (const n of snapshot.nodes) {
    countsByRole[n.role] = (countsByRole[n.role] ?? 0) + 1;
  }

  const outline: string[] = [];
  for (const n of snapshot.nodes) {
    if (n.role === 'heading' && n.name) outline.push(`H: ${n.name}`);
    else if (n.role === 'landmark' && n.name) outline.push(`[${n.tag}] ${n.name}`);
    if (outline.length >= 12) break;
  }

  const topInteractables = rankInteractables(snapshot, 15).map((n) => ({
    ref: n.ref,
    role: n.role,
    name: n.name || '(unnamed)',
  }));

  const visible = snapshot.nodes.filter((n) => n.visible).length;
  const roleBits = Object.entries(countsByRole)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([r, c]) => `${c} ${r}${c === 1 ? '' : 's'}`)
    .join(', ');

  const brief =
    `Page "${snapshot.title || '(untitled)'}" at ${snapshot.url}: ` +
    `${snapshot.nodes.length} elements (${visible} visible). ` +
    (roleBits ? `Composition: ${roleBits}. ` : '') +
    (outline.length > 0 ? `Outline: ${outline.slice(0, 5).join(' | ')}.` : 'No headings found.');

  return {
    url: snapshot.url,
    title: snapshot.title,
    capturedAt: snapshot.capturedAt,
    totalNodes: snapshot.nodes.length,
    visibleNodes: visible,
    countsByRole,
    outline,
    topInteractables,
    brief,
  };
}
