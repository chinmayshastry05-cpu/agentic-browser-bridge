/**
 * effects.ts — structured action outcomes (ported ideas from cua-driver's
 * ActionResult contract, adapted to the bridge's DOM/accessibility-first model).
 *
 * Every mutating browser tool reports ONE effect code:
 *   confirmed     - an observable readback proves the intended change (needs evidence)
 *   partial       - something changed but not fully as intended (e.g. field truncated)
 *   unverifiable  - dispatched, but no reliable signal exists to check it
 *   suspected_noop- dispatched, but no observable change where one was expected
 *   refused       - the bridge did NOT perform the action (carries a refusal + error only)
 *
 * Refused actions are never retried automatically. The refusal envelope tells
 * the caller what to do next (escalation) in a machine-readable way, while
 * suggestedNextStep stays as human text.
 */

export type EffectCode = 'confirmed' | 'partial' | 'unverifiable' | 'suspected_noop' | 'refused';

/** What kind of observation backs a `confirmed` effect. */
export type EvidenceKind = 'value_readback' | 'window_change';

export type InputRoute = 'trusted_input' | 'dom_event';
export type DeliveryMode = 'background' | 'foreground';

export type RefusalCode =
  | 'blocked_by_modal'
  | 'stale_ref'
  | 'unknown_ref'
  | 'stale_capture'
  | 'unknown_capture'
  | 'unsupported_route'
  | 'unsupported_delivery'
  | 'unsupported_backend'
  | 'invalid_argument'
  | 'out_of_bounds';

export interface Refusal {
  code: RefusalCode;
  message: string;
  hint: string;
}

export type EscalationTarget =
  | 'user'
  | 'fresh_snapshot'
  | 'foreground'
  | 'different_route'
  | 'different_backend';

export interface Escalation {
  target: EscalationTarget;
  reason: string;
}

/** Fields every mutating tool result carries (inside ToolResult.data). */
export interface ActionEnvelope {
  effect: EffectCode;
  route?: InputRoute;
  delivery?: DeliveryMode;
  evidence?: EvidenceKind;
  escalation?: Escalation;
  /** Present ONLY on refused results. */
  error?: string;
  status?: 'refused';
  refusal?: Refusal;
}

/** Thrown to refuse an action with a machine-readable envelope. */
export class RefusalError extends Error {
  readonly refusal: Refusal;
  readonly escalation: Escalation;
  constructor(refusal: Refusal, escalation: Escalation) {
    super(refusal.message);
    this.name = 'RefusalError';
    this.refusal = refusal;
    this.escalation = escalation;
  }
}

/** Build the `data` payload of a refused result. */
export function refusedData(
  refusal: Refusal,
  escalation: Escalation,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ...extra,
    status: 'refused',
    effect: 'refused',
    error: refusal.message,
    refusal,
    escalation,
  };
}

/**
 * Check the ActionEnvelope invariants. Returns a list of violations (empty = valid).
 *  - confirmed REQUIRES evidence
 *  - only confirmed may carry evidence
 *  - refused carries error + refusal and NOTHING about delivery/route/evidence
 *  - non-refused results never carry an error or refusal
 */
export function validateActionResult(d: Partial<ActionEnvelope> | undefined | null): string[] {
  const v: string[] = [];
  if (!d || typeof d !== 'object') return ['result data missing'];
  const effects: EffectCode[] = ['confirmed', 'partial', 'unverifiable', 'suspected_noop', 'refused'];
  if (!d.effect || !effects.includes(d.effect)) return [`unknown effect "${String(d.effect)}"`];
  if (d.effect === 'confirmed' && !d.evidence) v.push('confirmed requires evidence');
  if (d.effect !== 'confirmed' && d.evidence) v.push(`${d.effect} must not carry evidence`);
  if (d.effect === 'refused') {
    if (!d.error) v.push('refused requires error');
    if (!d.refusal) v.push('refused requires refusal');
    if (d.delivery) v.push('refused must not carry delivery');
    if (d.route) v.push('refused must not carry route');
    if (d.evidence) v.push('refused must not carry evidence');
  } else {
    if (d.error) v.push('only refused may carry error');
    if (d.refusal) v.push('only refused may carry refusal');
    if (d.status === 'refused') v.push('only refused may carry status=refused');
  }
  return v;
}

/** Backend capability table: which input routes each backend can honestly deliver. */
export function routesFor(backendName: string): { routes: InputRoute[]; default: InputRoute } {
  if (backendName === 'extension') return { routes: ['dom_event'], default: 'dom_event' };
  return { routes: ['trusted_input', 'dom_event'], default: 'trusted_input' };
}

export function parseRoute(v: unknown): InputRoute | 'auto' {
  if (v === undefined || v === 'auto') return 'auto';
  if (v === 'trusted' || v === 'trusted_input') return 'trusted_input';
  if (v === 'dom_event') return 'dom_event';
  throw new RefusalError(
    {
      code: 'invalid_argument',
      message: `input_route must be "trusted", "dom_event" or "auto", got ${JSON.stringify(v)}`,
      hint: 'Omit input_route to use the backend default.',
    },
    { target: 'different_route', reason: 'unrecognised input_route value' },
  );
}

export function parseDelivery(v: unknown): DeliveryMode {
  if (v === undefined || v === 'background') return 'background';
  if (v === 'foreground') return 'foreground';
  throw new RefusalError(
    {
      code: 'invalid_argument',
      message: `delivery_mode must be "background" or "foreground", got ${JSON.stringify(v)}`,
      hint: 'Omit delivery_mode to act without bringing the tab to the front.',
    },
    { target: 'foreground', reason: 'unrecognised delivery_mode value' },
  );
}

/** Map a thrown error to a refusal, or null when it is an ordinary failure. */
export function refusalFromError(err: unknown): { refusal: Refusal; escalation: Escalation } | null {
  if (err instanceof RefusalError) return { refusal: err.refusal, escalation: err.escalation };
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes('stale element ref')) {
    return {
      refusal: {
        code: 'stale_ref',
        message: msg,
        hint: 'The page changed since the snapshot. Take a fresh browser_snapshot and use the new ref.',
      },
      escalation: { target: 'fresh_snapshot', reason: 'ref no longer matches the live page' },
    };
  }
  if (msg.includes('unknown element ref')) {
    return {
      refusal: {
        code: 'unknown_ref',
        message: msg,
        hint: 'Refs expire per snapshot. Take a fresh browser_snapshot and use a ref from it.',
      },
      escalation: { target: 'fresh_snapshot', reason: 'ref was never issued or has expired' },
    };
  }
  return null;
}
