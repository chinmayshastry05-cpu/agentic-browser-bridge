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
import type { AgentAction } from '../types.js';

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
