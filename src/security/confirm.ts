/**
 * confirm.ts — pending-confirmation queue for high-risk actions.
 *
 * When the policy engine returns "confirm", the agent loop stops with status
 * awaiting_confirmation and registers a PendingConfirmation here. Only the
 * operator — via the CLI (`agent approve <id> --yes`) — can resolve it. The
 * model can never approve its own action.
 *
 * The queue is file-backed (<dataDir>/confirmations/) so approvals work
 * across processes: approve in one terminal, resume the task in another.
 *
 * APPROVAL SCOPE (exact, fail-closed). An approval authorizes ONE specific
 * action and nothing else. All of the following must hold for
 * isApproved() to return true:
 *   1. scopeKey matches — e.g. "mcp:<mcp-session-id>" or "task:<taskId>".
 *      An approval granted in one MCP session never authorizes another
 *      session, and an old unscoped ticket never matches a scoped check.
 *   2. argsFingerprint matches — SHA-256 over the CANONICAL FULL action
 *      args (every argument: text, values, checked, url, ...). Approving
 *      `type e4 "hello"` does NOT approve `type e4 "rm -rf /"`.
 *   3. pageFingerprint matches — "<url>::<snapshotId>" captured at ticket
 *      time. Navigation, or a snapshot rotation (which reassigns refs),
 *      voids the approval: refs must not be reused across pages/snapshots.
 *   4. Not expired — approvals live 10 minutes from issuance (TTL).
 *   5. Not already consumed — each approval is single-use. The retry that
 *      the approval unblocks consumes it atomically; a second identical
 *      call needs a fresh ticket.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { AgentAction } from '../types.js';
import type { RiskLevel } from './policy.js';

/** Default approval lifetime: 10 minutes. */
export const APPROVAL_TTL_MS = 10 * 60 * 1000;

export interface PendingConfirmation {
  id: string;
  /** Approval scope: e.g. "mcp:<sessionId>", "mcp:stdio", "task:<taskId>". */
  taskId: string;
  action: AgentAction;
  reason: string;
  risk: RiskLevel;
  /** SHA-256 hex of the canonical full action args (see fingerprintAction). */
  argsFingerprint: string;
  /** "<pageUrl>::<snapshotId>" captured when the ticket was requested. */
  pageFingerprint: string;
  createdAt: string;
  /** Approvals expire; an expired approval never authorizes anything. */
  expiresAt: string;
  resolvedAt: string | null;
  approved: boolean | null;
  /** Set when an approval is consumed (single-use). */
  consumedAt: string | null;
}

/** What isApproved() checks an action against. */
export interface ApprovalScope {
  scopeKey: string;
  pageFingerprint: string;
}

/** Deterministic JSON: object keys sorted recursively, undefined dropped. */
function canonicalize(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * Canonical fingerprint of the FULL action args. Two actions are the same
 * approvable unit iff their fingerprints are equal — every argument
 * (text, values, checked, url, key, ...) participates, not just
 * action/ref/url.
 */
export function fingerprintAction(action: AgentAction): string {
  return createHash('sha256').update(canonicalize(action)).digest('hex');
}

/** True when two actions are the same approvable unit (full-args comparison). */
export function sameAction(a: AgentAction, b: AgentAction): boolean {
  return fingerprintAction(a) === fingerprintAction(b);
}

export class ConfirmationQueue {
  private readonly dir: string;

  constructor(dataDir?: string) {
    const base =
      dataDir ??
      process.env['ABB_DATA_DIR'] ??
      join(process.env['HOME'] ?? process.cwd(), '.agentic-browser-bridge');
    this.dir = join(base, 'confirmations');
    mkdirSync(this.dir, { recursive: true });
  }

  private pathFor(id: string): string {
    if (!/^confirm-[a-zA-Z0-9_-]+$/.test(id)) throw new Error(`bad confirmation id "${id}"`);
    return join(this.dir, `${id}.json`);
  }

  private write(c: PendingConfirmation): void {
    writeFileSync(this.pathFor(c.id), JSON.stringify(c, null, 2));
  }

  private read(id: string): PendingConfirmation {
    const p = this.pathFor(id);
    if (!existsSync(p)) throw new Error(`unknown confirmation "${id}"`);
    return JSON.parse(readFileSync(p, 'utf8')) as PendingConfirmation;
  }

  private all(): PendingConfirmation[] {
    return readdirSync(this.dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(readFileSync(join(this.dir, f), 'utf8')) as PendingConfirmation);
  }

  request(
    taskId: string,
    action: AgentAction,
    reason: string,
    risk: RiskLevel,
    pageFingerprint: string,
    opts: { ttlMs?: number } = {},
  ): PendingConfirmation {
    const now = new Date();
    const confirmation: PendingConfirmation = {
      id: `confirm-${randomUUID().slice(0, 8)}`,
      taskId,
      action,
      reason,
      risk,
      argsFingerprint: fingerprintAction(action),
      pageFingerprint,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + (opts.ttlMs ?? APPROVAL_TTL_MS)).toISOString(),
      resolvedAt: null,
      approved: null,
      consumedAt: null,
    };
    this.write(confirmation);
    return confirmation;
  }

  resolve(id: string, approved: boolean): PendingConfirmation {
    const c = this.read(id);
    if (c.resolvedAt) throw new Error(`confirmation "${id}" was already resolved`);
    c.resolvedAt = new Date().toISOString();
    c.approved = approved;
    this.write(c);
    return c;
  }

  get(id: string): PendingConfirmation | null {
    try {
      return this.read(id);
    } catch {
      return null;
    }
  }

  listUnresolved(): PendingConfirmation[] {
    return this.all()
      .filter((c) => !c.resolvedAt)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  /**
   * True only when an operator approval exists for THIS EXACT scope, page,
   * and full action args, and it is unexpired and unconsumed. On success the
   * approval is consumed atomically (single-use): the same call a second
   * time requires a fresh ticket.
   */
  isApproved(scope: ApprovalScope, action: AgentAction): boolean {
    const now = Date.now();
    const want = fingerprintAction(action);
    for (const c of this.all()) {
      if (c.taskId !== scope.scopeKey) continue;
      if (c.approved !== true) continue;
      if (c.consumedAt) continue;
      if (Number.isNaN(Date.parse(c.expiresAt)) || Date.parse(c.expiresAt) <= now) continue;
      if (c.argsFingerprint !== want) continue;
      if (c.pageFingerprint !== scope.pageFingerprint) continue;
      // Exact match — consume atomically so the approval is single-use.
      c.consumedAt = new Date(now).toISOString();
      this.write(c);
      return true;
    }
    return false;
  }
}
