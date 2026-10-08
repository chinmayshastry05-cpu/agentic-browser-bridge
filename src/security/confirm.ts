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
 *   3. page identity matches field-wise — url, snapshotId, navGeneration,
 *      pageNonce (see PageIdentity). ANY navigation — goto, reload,
 *      back/forward, tab open/switch/close, even to the identical URL —
 *      bumps navGeneration and mints a fresh pageNonce, voiding the
 *      approval. Refs are cleared on navigation, so an old ref can never
 *      replay against a rebuilt DOM.
 *   4. Not expired — approvals live 10 minutes from issuance (TTL).
 *   5. Not already consumed — each approval is single-use. The retry that
 *      the approval unblocks consumes it atomically; a second identical
 *      call needs a fresh ticket.
 *
 * CROSS-PROCESS ATOMICITY. The queue directory is shared between processes
 * (MCP server + `approve` CLI). The read→check→consume→write sequence in
 * isApproved() — and the mutating request()/resolve() — run under an
 * O_EXCL lockfile with stale-lock breaking, so two processes racing the
 * same ticket produce exactly one winner.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, openSync, closeSync, writeSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { AgentAction, PageIdentity } from '../types.js';
import type { RiskLevel } from './policy.js';

/** Default approval lifetime: 10 minutes. */
export const APPROVAL_TTL_MS = 10 * 60 * 1000;

/** How long to wait for the queue lock before giving up. */
const LOCK_ACQUIRE_TIMEOUT_MS = 5_000;
/** A lockfile older than this is assumed to belong to a crashed holder. */
const LOCK_STALE_MS = 10_000;
/** Spin-wait slice while contending for the lock (synchronous API). */
const LOCK_SPIN_MS = 20;

export interface PendingConfirmation {
  id: string;
  /** Approval scope: e.g. "mcp:<sessionId>", "mcp:stdio", "task:<taskId>". */
  taskId: string;
  action: AgentAction;
  reason: string;
  risk: RiskLevel;
  /** SHA-256 hex of the canonical full action args (see fingerprintAction). */
  argsFingerprint: string;
  /** Exact page state the approval is bound to (compared field-wise). */
  page: PageIdentity;
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
  page: PageIdentity;
}

/** Field-wise page identity comparison. Missing fields fail closed. */
export function pageIdentityEquals(a: unknown, b: unknown): boolean {
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  const pa = a as Partial<PageIdentity>;
  const pb = b as Partial<PageIdentity>;
  return (
    typeof pa.url === 'string' &&
    pa.url === pb.url &&
    (pa.snapshotId ?? null) === (pb.snapshotId ?? null) &&
    typeof pa.navGeneration === 'number' &&
    pa.navGeneration === pb.navGeneration &&
    typeof pa.pageNonce === 'string' &&
    pa.pageNonce.length > 0 &&
    pa.pageNonce === pb.pageNonce
  );
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
    page: PageIdentity,
    opts: { ttlMs?: number } = {},
  ): PendingConfirmation {
    return this.withLock(() => {
      const now = new Date();
      const confirmation: PendingConfirmation = {
        id: `confirm-${randomUUID().slice(0, 8)}`,
        taskId,
        action,
        reason,
        risk,
        argsFingerprint: fingerprintAction(action),
        page,
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + (opts.ttlMs ?? APPROVAL_TTL_MS)).toISOString(),
        resolvedAt: null,
        approved: null,
        consumedAt: null,
      };
      this.write(confirmation);
      return confirmation;
    });
  }

  resolve(id: string, approved: boolean): PendingConfirmation {
    return this.withLock(() => {
      const c = this.read(id);
      if (c.resolvedAt) throw new Error(`confirmation "${id}" was already resolved`);
      c.resolvedAt = new Date().toISOString();
      c.approved = approved;
      this.write(c);
      return c;
    });
  }

  get(id: string): PendingConfirmation | null {
    try {
      return this.read(id);
    } catch {
      return null;
    }
  }

  listUnresolved(): PendingConfirmation[] {
    return this.withLock(() =>
      this.all()
        .filter((c) => !c.resolvedAt)
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1)),
    );
  }

  /**
   * True only when an operator approval exists for THIS EXACT scope, page
   * identity, and full action args, and it is unexpired and unconsumed.
   * On success the approval is consumed atomically (single-use): the same
   * call a second time requires a fresh ticket. The whole read→check→
   * consume→write sequence holds the directory lock, so two processes
   * racing the same ticket produce exactly one winner.
   */
  isApproved(scope: ApprovalScope, action: AgentAction): boolean {
    return this.withLock(() => {
      const now = Date.now();
      const want = fingerprintAction(action);
      for (const c of this.all()) {
        if (c.taskId !== scope.scopeKey) continue;
        if (c.approved !== true) continue;
        if (c.consumedAt) continue;
        if (Number.isNaN(Date.parse(c.expiresAt)) || Date.parse(c.expiresAt) <= now) continue;
        if (c.argsFingerprint !== want) continue;
        if (!pageIdentityEquals(c.page, scope.page)) continue;
        // Exact match — consume atomically so the approval is single-use.
        c.consumedAt = new Date(now).toISOString();
        this.write(c);
        return true;
      }
      return false;
    });
  }

  /**
   * Directory lock for cross-process atomicity (MCP server + `approve`
   * CLI share the queue dir). O_EXCL creation is atomic; a lockfile left
   * by a crashed holder is broken after LOCK_STALE_MS. Not reentrant —
   * the private read/write helpers must stay unlocked.
   */
  private withLock<T>(fn: () => T): T {
    const lockPath = join(this.dir, '.lock');
    const deadline = Date.now() + LOCK_ACQUIRE_TIMEOUT_MS;
    for (;;) {
      try {
        const fd = openSync(lockPath, 'wx', 0o600);
        try {
          writeSync(fd, `${process.pid}:${Date.now()}`);
        } finally {
          closeSync(fd);
        }
        break; // acquired
      } catch (e: unknown) {
        if ((e as NodeJS.ErrnoException)?.code !== 'EEXIST') throw e;
        let stale = false;
        try {
          const content = readFileSync(lockPath, 'utf8');
          const ts = Number(content.split(':')[1]);
          stale = Number.isFinite(ts) && Date.now() - ts > LOCK_STALE_MS;
        } catch {
          // Lock vanished between checks — retry immediately.
        }
        if (stale) {
          try {
            unlinkSync(lockPath);
          } catch {
            // Lost the race to break it — retry.
          }
          continue;
        }
        if (Date.now() >= deadline) {
          throw new Error('confirmation queue lock acquisition timed out');
        }
        const spinUntil = Date.now() + LOCK_SPIN_MS;
        while (Date.now() < spinUntil) {
          // Synchronous API: brief spin-wait.
        }
      }
    }
    try {
      return fn();
    } finally {
      try {
        unlinkSync(lockPath);
      } catch {
        // Already gone — nothing to release.
      }
    }
  }
}
