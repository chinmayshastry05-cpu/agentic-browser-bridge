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
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentAction } from '../types.js';
import type { RiskLevel } from './policy.js';

export interface PendingConfirmation {
  id: string;
  taskId: string;
  action: AgentAction;
  reason: string;
  risk: RiskLevel;
  createdAt: string;
  resolvedAt: string | null;
  approved: boolean | null;
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

  request(taskId: string, action: AgentAction, reason: string, risk: RiskLevel): PendingConfirmation {
    const confirmation: PendingConfirmation = {
      id: `confirm-${randomUUID().slice(0, 8)}`,
      taskId,
      action,
      reason,
      risk,
      createdAt: new Date().toISOString(),
      resolvedAt: null,
      approved: null,
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
    return readdirSync(this.dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(readFileSync(join(this.dir, f), 'utf8')) as PendingConfirmation)
      .filter((c) => !c.resolvedAt)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  /**
   * True when the operator previously approved this exact action for this
   * task. The loop consults this before the policy engine on resume, so an
   * approved action is not asked about twice.
   */
  isApproved(taskId: string | null, action: AgentAction): boolean {
    if (!taskId) return false;
    return readdirSync(this.dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => JSON.parse(readFileSync(join(this.dir, f), 'utf8')) as PendingConfirmation)
      .some(
        (c) =>
          c.taskId === taskId &&
          c.approved === true &&
          c.action.action === action.action &&
          c.action.ref === action.ref &&
          c.action.url === action.url,
      );
  }
}
