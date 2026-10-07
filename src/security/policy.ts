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
 *          forward, reload, wait_for
 *   medium ordinary state changes: type, clear, select_option, check,
 *          double_click, press_key, upload, tab open/close/switch
 *   high   consequential or credential-adjacent: typing into password fields,
 *          uploads of not-yet-approved files, anything in highRiskActions
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
    if (MEDIUM_ACTIONS.has(action.action)) return 'medium';
    return 'low';
  }

  decide(action: AgentAction, ctx: PolicyContext = {}): PolicyVerdict {
    const risk = this.classify(action, ctx);

    if (risk === 'high') {
      const why =
        ctx.inputType === 'password'
          ? 'typing into a password field requires explicit user confirmation'
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
