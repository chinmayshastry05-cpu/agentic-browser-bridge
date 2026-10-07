/**
 * grounding.ts — robust element reference resolution (spec section 6).
 *
 * Refs ("e1", "e2", ...) are only stable within one snapshot. When the DOM
 * changes between observation and action, blindly reusing a selector can
 * click the wrong element. This module implements:
 *
 *   1. Descriptors: every ref is bound to a semantic signature
 *      (role + accessible name + tag + frame) at snapshot time.
 *   2. Stale detection: before acting, the live element behind the stored
 *      selector is described again and compared to the descriptor.
 *   3. Re-grounding: on mismatch, a fresh snapshot is searched for the best
 *      semantic match. The match is accepted only if its score clears a
 *      threshold AND clearly beats the runner-up (duplicate-label safety).
 *      Otherwise the action is refused and the caller must re-observe.
 *
 * We never silently act on a vaguely similar element.
 */
import type { DomNode, ElementDescriptor, PageSnapshot } from '../types.js';

export interface RegroundResult {
  ok: boolean;
  /** Ref in the fresh snapshot, when ok. */
  newRef?: string;
  selector?: string;
  frameId?: string;
  /** 0..1 confidence of the match. */
  confidence?: number;
  /** How the match was established. */
  method?: 'ref-signature' | 'semantic';
  reason?: string;
  candidates?: Array<{ ref: string; role: string; name: string; score: number }>;
}

/** Minimum score to accept a semantic re-grounding. */
export const REGROUND_THRESHOLD = 0.7;
/** Minimum margin over the runner-up (duplicate-label protection). */
export const REGROUND_MARGIN = 0.15;

function tokens(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 1),
  );
}

/** Token Jaccard similarity of two accessible names. */
export function nameSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter += 1;
  return inter / (ta.size + tb.size - inter);
}

/**
 * Semantic similarity between the original descriptor and a fresh candidate.
 * Role match dominates (an element that changed role is a different element);
 * name similarity is next; tag and frame-context are tie-breakers.
 */
export function similarityScore(d: ElementDescriptor, n: DomNode): number {
  let score = 0;
  if (d.role === n.role) score += 0.45;
  score += 0.35 * nameSimilarity(d.name, n.name);
  if (d.tag === n.tag) score += 0.1;
  if ((d.frameId ?? '') === (n.frameId ?? '')) score += 0.05;
  if (d.text && n.text && d.text === n.text) score += 0.05;
  return Math.min(1, score);
}

/**
 * Attempt to re-ground a stale descriptor against a fresh snapshot.
 * Returns ok:false with a reason and the top candidates when the match is
 * ambiguous or absent — the caller must re-observe, never guess.
 */
export function reground(d: ElementDescriptor, fresh: PageSnapshot): RegroundResult {
  // Fast path: same ref still exists and its signature matches.
  const sameRef = fresh.nodes.find((n) => n.ref === d.ref);
  if (sameRef && sameRef.role === d.role && sameRef.tag === d.tag && sameRef.name === d.name) {
    return {
      ok: true,
      newRef: sameRef.ref,
      selector: sameRef.selector,
      frameId: sameRef.frameId,
      confidence: 1,
      method: 'ref-signature',
    };
  }

  const scored = fresh.nodes
    .map((n) => ({ node: n, score: similarityScore(d, n) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  const candidates = scored.slice(0, 3).map((s) => ({
    ref: s.node.ref,
    role: s.node.role,
    name: s.node.name,
    score: Math.round(s.score * 100) / 100,
  }));

  if (scored.length === 0) {
    return { ok: false, reason: 'no candidate elements found', candidates: [] };
  }
  const [best, runnerUp] = [scored[0]!, scored[1]];
  if (best.score < REGROUND_THRESHOLD) {
    return {
      ok: false,
      reason: `best candidate scored ${best.score.toFixed(2)}, below threshold ${REGROUND_THRESHOLD}`,
      candidates,
    };
  }
  const margin = runnerUp ? best.score - runnerUp.score : 1;
  if (margin < REGROUND_MARGIN) {
    return {
      ok: false,
      reason:
        `ambiguous: top candidates "${best.node.name}" and "${runnerUp!.node.name}" ` +
        `are too close (${best.score.toFixed(2)} vs ${runnerUp!.score.toFixed(2)})`,
      candidates,
    };
  }
  return {
    ok: true,
    newRef: best.node.ref,
    selector: best.node.selector,
    frameId: best.node.frameId,
    confidence: Math.round(best.score * 100) / 100,
    method: 'semantic',
  };
}

/** Check whether a live target description still matches the descriptor. */
export function signatureMatches(
  d: ElementDescriptor,
  live: { role: string; name: string; tag: string },
): boolean {
  return d.role === live.role && d.tag === live.tag && d.name === live.name;
}
