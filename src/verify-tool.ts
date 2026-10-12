/**
 * verify-tool.ts — browser_verify: agent-declared postconditions checked
 * against live page state (ported idea: cua-driver's verify_state).
 *
 * Honesty rules:
 *  - absence is unprovable from a ref, so exists:false is rejected
 *  - a transient read failure is "unknown", never "unsatisfied"
 *  - satisfied needs 2 consecutive passing samples (no flicker passes)
 */
import type { BrowserSession } from './bridge-core.js';
import { RefusalError } from './effects.js';

export interface Predicate {
  kind: 'url' | 'title' | 'element';
  ref?: string;
  equals?: string;
  contains?: string;
  matches?: string;
  role?: string;
  name?: string;
  name_contains?: string;
  value?: string;
  value_contains?: string;
  checked?: boolean;
  visible?: boolean;
}

export type PredicateState = 'pass' | 'fail' | 'unknown';

export interface PredicateResult {
  index: number;
  kind: string;
  state: PredicateState;
  observed?: string;
  unknown_reason?: string;
}

export interface VerifyResult {
  status: 'satisfied' | 'unsatisfied' | 'unknown';
  samples: number;
  elapsed_ms: number;
  predicates: PredicateResult[];
}

const MAX_PREDICATES = 8;
const STABLE_SAMPLES = 2;
const POLL_MS = 100;

function bad(message: string): never {
  throw new RefusalError(
    { code: 'invalid_argument', message, hint: 'Fix the predicate and call browser_verify again.' },
    { target: 'user', reason: 'the verification request itself is malformed' },
  );
}

export function parsePredicates(raw: unknown): Predicate[] {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_PREDICATES) {
    bad(`predicates must be an array of 1-${MAX_PREDICATES} objects`);
  }
  return (raw as unknown[]).map((p, i) => {
    if (!p || typeof p !== 'object') bad(`predicate ${i} must be an object`);
    const o = p as Record<string, unknown>;
    if (o['exists'] === false) {
      bad(`predicate ${i}: exists:false is rejected - absence cannot be proven from a ref`);
    }
    const kind = o['kind'];
    if (kind !== 'url' && kind !== 'title' && kind !== 'element') {
      bad(`predicate ${i}: kind must be "url", "title" or "element"`);
    }
    if (kind === 'element' && (typeof o['ref'] !== 'string' || !o['ref'])) {
      bad(`predicate ${i}: element predicates need a "ref"`);
    }
    if (kind === 'url' || kind === 'title') {
      if (o['equals'] === undefined && o['contains'] === undefined && !(kind === 'url' && o['matches'] !== undefined)) {
        bad(`predicate ${i}: ${kind} needs equals or contains${kind === 'url' ? ' or matches' : ''}`);
      }
    }
    if (typeof o['matches'] === 'string') {
      try {
        new RegExp(o['matches']);
      } catch {
        bad(`predicate ${i}: "matches" is not a valid regular expression`);
      }
    }
    if (kind === 'element') {
      const checks = ['role', 'name', 'name_contains', 'value', 'value_contains', 'checked', 'visible'];
      if (!checks.some((k) => o[k] !== undefined)) {
        bad(`predicate ${i}: element predicate needs at least one of ${checks.join(', ')}`);
      }
    }
    return o as unknown as Predicate;
  });
}

async function evalOne(session: BrowserSession, p: Predicate, index: number): Promise<PredicateResult> {
  const base = { index, kind: p.kind };
  if (p.kind === 'url') {
    const u = session.url;
    const ok =
      (p.equals === undefined || u.replace(/\/$/, '') === p.equals.replace(/\/$/, '')) &&
      (p.contains === undefined || u.includes(p.contains)) &&
      (p.matches === undefined || new RegExp(p.matches).test(u));
    return { ...base, state: ok ? 'pass' : 'fail', observed: u };
  }
  if (p.kind === 'title') {
    let t: string;
    try {
      t = (await session.pageInfo()).title ?? '';
    } catch (err) {
      return { ...base, state: 'unknown', unknown_reason: `title not readable: ${(err as Error).message}` };
    }
    const ok =
      (p.equals === undefined || t === p.equals) && (p.contains === undefined || t.includes(p.contains));
    return { ...base, state: ok ? 'pass' : 'fail', observed: t };
  }
  const live = await session.describeLiveTarget(p.ref as string);
  if (!live) {
    return {
      ...base,
      state: 'unknown',
      unknown_reason:
        'ref_unresolvable: the ref no longer resolves to a live element (stale or replaced); absence is not proven',
    };
  }
  const fails: string[] = [];
  if (p.role !== undefined && live.role !== p.role) fails.push(`role=${live.role}`);
  if (p.name !== undefined && live.name !== p.name) fails.push(`name=${live.name}`);
  if (p.name_contains !== undefined && !live.name.includes(p.name_contains)) fails.push(`name=${live.name}`);
  if (p.value !== undefined && (live.value ?? '') !== p.value) fails.push(`value=${live.value ?? ''}`);
  if (p.value_contains !== undefined && !(live.value ?? '').includes(p.value_contains)) {
    fails.push(`value=${live.value ?? ''}`);
  }
  if (p.checked !== undefined) {
    if (live.checked === undefined) {
      return { ...base, state: 'unknown', unknown_reason: 'checked_unreadable: element has no checked state' };
    }
    if (live.checked !== p.checked) fails.push(`checked=${live.checked}`);
  }
  if (p.visible !== undefined && live.visible !== p.visible) fails.push(`visible=${live.visible}`);
  return {
    ...base,
    state: fails.length === 0 ? 'pass' : 'fail',
    observed: fails.length === 0 ? 'matches' : fails.join(', '),
  };
}

export async function runVerify(
  session: BrowserSession,
  preds: Predicate[],
  timeoutMs: number,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<VerifyResult> {
  const start = Date.now();
  let samples = 0;
  let stable = 0;
  let last: PredicateResult[] = [];
  for (;;) {
    last = [];
    for (let i = 0; i < preds.length; i++) last.push(await evalOne(session, preds[i]!, i));
    samples += 1;
    const allPass = last.every((r) => r.state === 'pass');
    stable = allPass ? stable + 1 : 0;
    if (stable >= STABLE_SAMPLES) {
      return { status: 'satisfied', samples, elapsed_ms: Date.now() - start, predicates: last };
    }
    if (Date.now() - start >= timeoutMs) break;
    await sleep(POLL_MS);
  }
  const anyFail = last.some((r) => r.state === 'fail');
  const anyUnknown = last.some((r) => r.state === 'unknown');
  // A definite failure at the deadline is unsatisfied; otherwise we could not tell.
  const status: VerifyResult['status'] = anyFail ? 'unsatisfied' : anyUnknown ? 'unknown' : 'unsatisfied';
  return { status, samples, elapsed_ms: Date.now() - start, predicates: last };
}
