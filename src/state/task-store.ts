/**
 * task-store.ts — durable local task state (spec section 10).
 *
 * Each task is one JSON file under <dataDir>/tasks/<taskId>.json. No
 * database, no network. On every agent step the loop appends the step
 * record; on completion the task is closed with a terminal status and a
 * reason. A crashed or stopped bridge can resume a task later from the
 * stored state.
 *
 * Secret hygiene: typed text is NEVER persisted verbatim. Step actions of
 * type "type" have their text replaced with "[redacted N chars]" before
 * writing. Page text/screenshot bytes are not stored — only metadata
 * (paths, URLs, titles). Nothing here leaves the machine.
 *
 * Retention: prune(olderThanDays) deletes closed tasks older than the
 * cutoff. Open tasks are never pruned.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
  ActionVerification,
  AgentAction,
  AgentStatus,
  StepRecord,
  ToolResult,
} from '../types.js';

export interface TaskArtifact {
  kind: 'screenshot' | 'download' | 'file';
  path: string;
  at: string;
  note?: string;
}

export interface StoredStep {
  step: number;
  action: AgentAction;
  result: ToolResult;
  verification?: ActionVerification;
  recoveryAttempts?: number;
  startedAt: string;
  finishedAt: string;
}

export type TaskStatus = AgentStatus | 'running' | 'interrupted';

export interface TaskRecord {
  taskId: string;
  goal: string;
  createdAt: string;
  updatedAt: string;
  status: TaskStatus;
  browserSessionId: string | null;
  backendName: string | null;
  currentUrl: string | null;
  pageTitle: string | null;
  steps: StoredStep[];
  pendingConfirmation: string | null;
  artifacts: TaskArtifact[];
  failureReason: string | null;
  completionReason: string | null;
}

/** Redact typed text before persisting a step. */
export function redactStepForStorage(step: StepRecord): StoredStep {
  const action: AgentAction = { ...step.action };
  if (action.action === 'type' && typeof action.text === 'string') {
    action.text = `[redacted ${action.text.length} chars]`;
  }
  return {
    step: step.step,
    action,
    result: step.result,
    verification: step.verification,
    recoveryAttempts: step.recoveryAttempts,
    startedAt: step.startedAt,
    finishedAt: step.finishedAt,
  };
}

export interface TaskStoreOptions {
  dataDir?: string;
}

export class TaskStore {
  private readonly tasksDir: string;

  constructor(opts: TaskStoreOptions = {}) {
    const base =
      opts.dataDir ??
      process.env['ABB_DATA_DIR'] ??
      join(process.env['HOME'] ?? process.cwd(), '.agentic-browser-bridge');
    this.tasksDir = join(base, 'tasks');
    mkdirSync(this.tasksDir, { recursive: true });
  }

  private pathFor(taskId: string): string {
    if (!/^[a-zA-Z0-9_-]+$/.test(taskId)) throw new Error(`bad task id "${taskId}"`);
    return join(this.tasksDir, `${taskId}.json`);
  }

  create(goal: string, opts: { browserSessionId?: string; backendName?: string } = {}): TaskRecord {
    const now = new Date().toISOString();
    const record: TaskRecord = {
      taskId: `task-${randomUUID().slice(0, 8)}`,
      goal,
      createdAt: now,
      updatedAt: now,
      status: 'running',
      browserSessionId: opts.browserSessionId ?? null,
      backendName: opts.backendName ?? null,
      currentUrl: null,
      pageTitle: null,
      steps: [],
      pendingConfirmation: null,
      artifacts: [],
      failureReason: null,
      completionReason: null,
    };
    this.write(record);
    return record;
  }

  get(taskId: string): TaskRecord {
    const p = this.pathFor(taskId);
    if (!existsSync(p)) throw new Error(`unknown task "${taskId}"`);
    return JSON.parse(readFileSync(p, 'utf8')) as TaskRecord;
  }

  list(): Array<Pick<TaskRecord, 'taskId' | 'goal' | 'status' | 'updatedAt' | 'currentUrl'>> {
    return readdirSync(this.tasksDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        const r = JSON.parse(readFileSync(join(this.tasksDir, f), 'utf8')) as TaskRecord;
        return {
          taskId: r.taskId,
          goal: r.goal,
          status: r.status,
          updatedAt: r.updatedAt,
          currentUrl: r.currentUrl,
        };
      })
      .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }

  update(taskId: string, patch: Partial<TaskRecord>): TaskRecord {
    const record = this.get(taskId);
    const next: TaskRecord = {
      ...record,
      ...patch,
      taskId: record.taskId,
      createdAt: record.createdAt,
      updatedAt: new Date().toISOString(),
    };
    this.write(next);
    return next;
  }

  appendStep(taskId: string, step: StepRecord): TaskRecord {
    const record = this.get(taskId);
    record.steps.push(redactStepForStorage(step));
    record.updatedAt = new Date().toISOString();
    this.write(record);
    return record;
  }

  addArtifact(taskId: string, artifact: TaskArtifact): TaskRecord {
    const record = this.get(taskId);
    record.artifacts.push(artifact);
    record.updatedAt = new Date().toISOString();
    this.write(record);
    return record;
  }

  /**
   * Close a task with a terminal status. 'interrupted' is used when the
   * bridge stops mid-run; such tasks can be resumed.
   */
  close(taskId: string, status: TaskStatus, reason?: string): TaskRecord {
    const patch: Partial<TaskRecord> = { status };
    if (status === 'completed') patch.completionReason = reason ?? null;
    else if (status === 'failed' || status === 'blocked') patch.failureReason = reason ?? null;
    return this.update(taskId, patch);
  }

  /** Mark a running task as interrupted (e.g. on bridge shutdown). */
  interrupt(taskId: string, reason = 'bridge stopped'): TaskRecord {
    const record = this.get(taskId);
    if (record.status === 'running') return this.close(taskId, 'interrupted', reason);
    return record;
  }

  /** Delete closed tasks older than the cutoff. Never deletes open tasks. */
  prune(olderThanDays = 30): string[] {
    const cutoff = Date.now() - olderThanDays * 24 * 3600 * 1000;
    const removed: string[] = [];
    for (const f of readdirSync(this.tasksDir)) {
      if (!f.endsWith('.json')) continue;
      const p = join(this.tasksDir, f);
      const r = JSON.parse(readFileSync(p, 'utf8')) as TaskRecord;
      if (r.status !== 'running' && Date.parse(r.updatedAt) < cutoff) {
        unlinkSync(p);
        removed.push(r.taskId);
      }
    }
    return removed;
  }

  private write(record: TaskRecord): void {
    // Atomic-ish: write temp then rename.
    const p = this.pathFor(record.taskId);
    const tmp = `${p}.tmp`;
    writeFileSync(tmp, JSON.stringify(record, null, 2));
    renameSync(tmp, p);
  }
}
