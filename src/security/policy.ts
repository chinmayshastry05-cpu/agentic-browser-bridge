/**
 * policy.ts — explicit permission/policy layer (spec section 11).
 *
 * Sits between agent planning and browser execution:
 *
 *   Agent proposes action -> PolicyEngine.decide() -> allow | confirm | deny
 *
 * Risk classification:
 *   low    read-only or reversible navigation: snapshot, screenshot, get_text,
 *          page_info, tabs, frames, scroll, hover, focus, navigate, back,
 *          forward, reload, wait_for, clicks on innocuous labels
 *   medium ordinary state changes: type, clear, select_option, check,
 *          double_click, press_key, upload, tab open/close/switch
 *   high   consequential or credential-adjacent: typing into password fields,
 *          uploads of not-yet-approved files, anything in highRiskActions,
 *          clicks whose target label matches a consequential keyword
 *          (buy/purchase/pay/checkout/place order/subscribe/delete/remove/
 *          transfer/withdraw/send money — heuristic TEXT matching only;
 *          icon-only buttons with no accessible name are NOT caught)
 *
 * High-risk actions require explicit user confirmation by default. The model
 * can never approve its own risky action: a "confirm" verdict stops the loop
 * with status awaiting_confirmation and records a PendingConfirmation that
 * only the operator (CLI/UI) can resolve.
 */
import type { AgentAction, PageSnapshot } from '../types.js';

export type RiskLevel = 'low' | 'medium' | 'high';

export interface PolicyContext {
  /** Current page URL (for URL-sensitive rules). */
  url?: string;
  /** The target input's type attribute, e.g. "password" (for type/clear). */
  inputType?: string;
  /** The target element's role. */
  targetRole?: string;
  /**
   * The target control's accessible name / visible text (for click /
   * double_click). Resolved from the snapshot registry at decision time.
   */
  targetText?: string;
  /** Local file path for upload actions. */
  filePath?: string;
}

export type PolicyVerdict =
  | { verdict: 'allow'; risk: RiskLevel }
  | { verdict: 'confirm'; risk: RiskLevel; reason: string }
  | { verdict: 'deny'; risk: RiskLevel; reason: string };

export interface PolicyEngineOptions {
  /** Require confirmation for medium-risk actions too (default: allow). */
  confirmMedium?: boolean;
  /** Extra action names to treat as high risk. */
  highRiskActions?: AgentAction['action'][];
}

const MEDIUM_ACTIONS: Set<AgentAction['action']> = new Set([
  'type',
  'clear',
  'select_option',
  'check',
  'double_click',
  'press_key',
]);

/**
 * Consequential-click keywords. HEURISTIC TEXT MATCHING ONLY: classify()
 * checks the click target's accessible name / visible label against these
 * word-boundary patterns. This is NOT semantic understanding — an icon-only
 * button with no accessible name (empty targetText) is NOT caught, a
 * misleading label can evade it, and a benign label containing one of these
 * words (e.g. "Remove filter") will over-trigger. The list is deliberately
 * tight and financial/irreversible-focused.
 */
const CONSEQUENTIAL_CLICK_PATTERNS: { re: RegExp; label: string }[] = [
  { re: /\bbuy\b/i, label: 'buy' },
  { re: /\bpurchase\b/i, label: 'purchase' },
  { re: /\bpay\b/i, label: 'pay' },
  { re: /\bcheckout\b/i, label: 'checkout' },
  { re: /\bplace\s+order\b/i, label: 'place order' },
  { re: /\bsubscribe\b/i, label: 'subscribe' },
  { re: /\bdelete\b/i, label: 'delete' },
  { re: /\bremove\b/i, label: 'remove' },
  { re: /\btransfer\b/i, label: 'transfer' },
  { re: /\bwithdraw\b/i, label: 'withdraw' },
  { re: /\bsend\s+money\b/i, label: 'send money' },
];

/** Which keyword (if any) the target text matches; undefined when clean. */
export function consequentialClickKeyword(targetText: string | undefined): string | undefined {
  if (!targetText) return undefined;
  for (const { re, label } of CONSEQUENTIAL_CLICK_PATTERNS) {
    if (re.test(targetText)) return label;
  }
  return undefined;
}

/**
 * Login-wall detection (fail-closed).
 *
 * A login wall is a page whose purpose is to gate access behind credentials.
 * The bridge holds no credentials and must never attempt a login or pretend
 * it got past one, so detection returns a human-readable reason (never a
 * boolean) and the caller refuses with that reason in the message.
 *
 * Signals (deliberately conservative to avoid flagging articles ABOUT logins
 * or ordinary forms that merely contain a password field):
 *  1. a VISIBLE password input PLUS a gate phrase or a login URL path — the
 *     page is asking for credentials in order to proceed;
 *  2. a gate phrase ("sign in to continue", ...) PLUS a login URL path or a
 *     visible sign-in button/link (covers OAuth-button walls with no password
 *     field on the page itself).
 * A password field alone, a gate phrase alone, or a login URL without gate
 * text is NOT enough.
 */
const LOGIN_PATH_RE =
  /\/(login|log-in|signin|sign-in|sign_in|auth|authenticate|accounts\/login|users\/sign_in)(\/|$|[?#])/i;

const LOGIN_GATE_PHRASES = [
  'sign in to continue',
  'log in to continue',
  'login to continue',
  'sign in to view',
  'log in to view',
  'sign in to access',
  'log in to access',
  'login required',
  'authentication required',
  'please log in',
  'please sign in',
];

const SIGN_IN_CONTROL_RE = /\b(sign|log)\s?in\b/i;

export function detectLoginWall(url: string, snap: PageSnapshot): string | null {
  let path = '';
  try {
    path = new URL(url).pathname;
  } catch {
    // Non-parseable URL: skip the path signal, DOM/text signals still apply.
  }
  const hasLoginPath = LOGIN_PATH_RE.test(path);

  let hasPasswordField = false;
  let hasSignInControl = false;
  const haystack: string[] = [snap.title ?? ''];
  for (const n of snap.nodes) {
    if (!n.visible) continue;
    if (n.tag === 'input' && (n.attributes['type'] ?? '').toLowerCase() === 'password') {
      hasPasswordField = true;
    }
    if (
      (n.tag === 'button' || n.tag === 'a' || n.role === 'button' || n.role === 'link') &&
      SIGN_IN_CONTROL_RE.test(n.name)
    ) {
      hasSignInControl = true;
    }
    if (n.name) haystack.push(n.name);
    if (n.text) haystack.push(n.text);
  }
  const text = haystack.join(' ').toLowerCase();
  const gatePhrase = LOGIN_GATE_PHRASES.find((p) => text.includes(p));

  if (hasPasswordField && (gatePhrase || hasLoginPath)) {
    return (
      `page contains a password field` +
      (gatePhrase ? ` with gate text "${gatePhrase}"` : '') +
      (hasLoginPath ? ` on login path "${path}"` : '')
    );
  }
  if (gatePhrase && (hasLoginPath || hasSignInControl)) {
    return `gate text "${gatePhrase}"${hasLoginPath ? ` on login path "${path}"` : ' with a sign-in control'}`;
  }
  return null;
}

export class PolicyEngine {
  private readonly confirmMedium: boolean;
  private readonly highRiskActions: Set<AgentAction['action']>;
  private readonly approvedUploads = new Set<string>();

  constructor(opts: PolicyEngineOptions = {}) {
    this.confirmMedium = opts.confirmMedium ?? false;
    this.highRiskActions = new Set(opts.highRiskActions ?? []);
  }

  /** Mark a local file path as user-approved for upload. */
  approveUpload(filePath: string): void {
    this.approvedUploads.add(filePath);
  }

  isUploadApproved(filePath: string): boolean {
    return this.approvedUploads.has(filePath);
  }

  classify(action: AgentAction, ctx: PolicyContext = {}): RiskLevel {
    if (this.highRiskActions.has(action.action)) return 'high';
    // Credential-adjacent: typing into password fields is always high risk.
    if (
      (action.action === 'type' || action.action === 'clear') &&
      ctx.inputType === 'password'
    ) {
      return 'high';
    }
    // Consequential clicks: heuristic keyword match on the target's label.
    // Icon-only buttons (empty targetText) are NOT caught — documented limit.
    if (
      (action.action === 'click' || action.action === 'double_click') &&
      consequentialClickKeyword(ctx.targetText) !== undefined
    ) {
      return 'high';
    }
    if (MEDIUM_ACTIONS.has(action.action)) return 'medium';
    return 'low';
  }

  decide(action: AgentAction, ctx: PolicyContext = {}): PolicyVerdict {
    const risk = this.classify(action, ctx);

    if (risk === 'high') {
      const keyword =
        (action.action === 'click' || action.action === 'double_click')
          ? consequentialClickKeyword(ctx.targetText)
          : undefined;
      const why =
        ctx.inputType === 'password'
          ? 'typing into a password field requires explicit user confirmation'
          : keyword !== undefined
            ? `click target "${ctx.targetText}" matches consequential keyword "${keyword}" — requires explicit user confirmation`
            : `high-risk action "${action.action}" requires explicit user confirmation`;
      return { verdict: 'confirm', risk, reason: why };
    }
    if (risk === 'medium' && this.confirmMedium) {
      return {
        verdict: 'confirm',
        risk,
        reason: `medium-risk action "${action.action}" requires confirmation (strict policy)`,
      };
    }
    return { verdict: 'allow', risk };
  }
}
