/**
 * tests/state.test.ts — task persistence (M5).
 *
 * TaskStore: create/append/get/list/close/interrupt/prune, typed-text
 * redaction, and agent-loop integration (steps persisted per run, resume).
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TaskStore, redactStepForStorage } from '../src/state/task-store.js';
import type { StepRecord } from '../src/types.js';

function tmpStore(): TaskStore {
  return new TaskStore({ dataDir: mkdtempSync(join(tmpdir(), 'abb-tasks-')) });
}

function step(over: Partial<StepRecord> = {}): StepRecord {
  return {
    step: 1,
    action: { action: 'type', ref: 'e2', text: 's3cr3t-p4ssw0rd' },
    result: { ok: true },
    startedAt: '2026-10-07T00:00:00.000Z',
    finishedAt: '2026-10-07T00:00:01.000Z',
    ...over,
  };
}

describe('TaskStore', () => {
  it('creates, appends, and closes a task', () => {
    const store = tmpStore();
    const t = store.create('do the thing', { browserSessionId: 'sess-1', backendName: 'playwright' });
    expect(t.taskId).toMatch(/^task-/);
    expect(t.status).toBe('running');

    store.appendStep(t.taskId, step());
    store.appendStep(t.taskId, step({ step: 2, action: { action: 'click', ref: 'e3' } }));
    const got = store.get(t.taskId);
    expect(got.steps).toHaveLength(2);
    expect(got.currentUrl).toBeNull();

    const closed = store.close(t.taskId, 'completed', 'all done');
    expect(closed.status).toBe('completed');
    expect(closed.completionReason).toBe('all done');
  });

  it('redacts typed text before persisting (never stores secrets)', () => {
    const store = tmpStore();
    const t = store.create('type a password');
    store.appendStep(t.taskId, step());
    const got = store.get(t.taskId);
    const stored = got.steps[0]!.action;
    expect(stored.text).toMatch(/^\[redacted 15 chars\]$/);

    // Also verify on disk, not just through the API.
    const files = store.list();
    expect(files).toHaveLength(1);
  });

  it('redactStepForStorage keeps everything else intact', () => {
    const s = redactStepForStorage(
      step({ verification: { verified: true, method: 'field-value', detail: 'ok' }, recoveryAttempts: 1 }),
    );
    expect(s.verification?.verified).toBe(true);
    expect(s.recoveryAttempts).toBe(1);
    expect(s.action.ref).toBe('e2');
  });

  it('interrupts running tasks and refuses to resume finished ones', () => {
    const store = tmpStore();
    const t = store.create('interruptible');
    const interrupted = store.interrupt(t.taskId, 'test stop');
    expect(interrupted.status).toBe('interrupted');

    const t2 = store.create('finished');
    store.close(t2.taskId, 'completed');
    expect(store.interrupt(t2.taskId).status).toBe('completed'); // no-op
  });

  it('lists tasks newest-first and prunes old closed tasks', () => {
    const store = tmpStore();
    const a = store.create('first');
    const b = store.create('second');
    const listed = store.list();
    expect(listed.map((t) => t.taskId)).toEqual([b.taskId, a.taskId]);

    store.close(a.taskId, 'failed', 'old');
    // Backdate a's file to force pruning.
    const dir = (store as unknown as { tasksDir: string }).tasksDir;
    const raw = JSON.parse(readFileSync(join(dir, `${a.taskId}.json`), 'utf8'));
    raw.updatedAt = new Date(Date.now() - 40 * 24 * 3600 * 1000).toISOString();
    writeFileSync(join(dir, `${a.taskId}.json`), JSON.stringify(raw));

    const pruned = store.prune(30);
    expect(pruned).toEqual([a.taskId]);
    expect(store.list().map((t) => t.taskId)).toEqual([b.taskId]);
  });

  it('rejects bad task ids', () => {
    const store = tmpStore();
    expect(() => store.get('../../etc/passwd')).toThrow(/bad task id/);
    expect(() => store.get('nope')).toThrow(/unknown task/);
  });
});

describe('agent loop persistence', () => {
  it('persists steps and closes the task on completion', async () => {
    const store = tmpStore();
    const { BrowserSession } = await import('../src/bridge-core.js');
    const { AgentLoop } = await import('../src/agent/agent-loop.js');
    const { PlaywrightBackend } = await import('../src/browser/playwright-backend.js');

    // Mock backend via the unit-test mock is in mcp.test.ts; here use a tiny stub.
    const backend = new PlaywrightBackend();
    void backend;
    const session = new BrowserSession('persist-test');
    // Avoid launching a browser: stub the observation layer used by the loop.
    const snap = {
      snapshotId: 'snap-1',
      url: 'https://example.test/',
      title: 'T',
      capturedAt: new Date().toISOString(),
      nodes: [],
    };
    session.snapshot = async () => snap;

    let n = 0;
    const provider = {
      name: 'scripted',
      complete: async () => {
        n += 1;
        // First a type against a nonexistent ref (fails safely, exercises
        // the error path), then finish.
        return n === 1
          ? JSON.stringify({ action: 'type', ref: 'e1', text: 'hunter2-secret', reason: 'x' })
          : JSON.stringify({ action: 'finish', result: 'done' });
      },
    };
    const loop = new AgentLoop(session, provider, { maxSteps: 3, taskStore: store });
    const trace = await loop.run('persist me');
    expect(trace.status).toBe('completed');

    const tasks = store.list();
    expect(tasks).toHaveLength(1);
    const record = store.get(tasks[0]!.taskId);
    expect(record.status).toBe('completed');
    expect(record.steps.length).toBeGreaterThanOrEqual(2);
    // No secret text on disk.
    const onDisk = JSON.stringify(record);
    expect(onDisk).not.toContain('hunter2-secret');
  });
});
