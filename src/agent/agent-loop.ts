/**
 * agent-loop.ts — the observe -> plan -> check -> act -> verify loop.
 *
 * Each step:
 *   1. OBSERVE: take a snapshot, analyze it, render the element tree.
 *   2. PLAN:    ask the LLM provider for the next action as JSON.
 *   3. CHECK:   policy gate (M6 plugs a real policy engine here; default allows).
 *   4. ACT:     execute the action against the BrowserSession via grounding.
 *   5. VERIFY:  confirm the expected state change actually happened.
 *
 * Failures are classified and retried with strict bounds (max 1 retry per
 * step, maxSteps overall). Terminal states: completed | failed | blocked |
 * awaiting_confirmation | awaiting_user_input.
 *
 * The loop is provider-agnostic (any LLMProvider) and transport-agnostic
 * (any BrowserSession). It never touches the network except through the
 * injected provider and session.
 */
import { analyze } from '../analyzer.js';
import { buildTree, renderTree } from '../tree.js';
import { verifyAction } from './verifier.js';
import { TaskStore } from '../state/task-store.js';
import type {
  ActionVerification,
  AgentAction,
  AgentStatus,
  AgentTrace,
  BrowserBackend,
  ChatMessage,
  LLMProvider,
  StepRecord,
  ToolResult,
} from '../types.js';
import { BrowserSession } from '../bridge-core.js';

export interface AgentLoopOptions {
  maxSteps?: number;
  /** Extra system-prompt guidance, e.g. site-specific rules. */
  systemPromptExtra?: string;
  /** Called after every step (for SSE streaming / logging). */
  onStep?: (step: StepRecord) => void;
  /**
   * Policy gate consulted before acting. Returns 'allow', or 'confirm' /
   * 'deny' with a reason. Defaults to allow-all; the real policy engine
   * (src/security/policy.ts) is plugged in by the caller.
   */
  policyCheck?: (action: AgentAction) => Promise<'allow' | { confirm: string } | { deny: string }>;
  /**
   * Optional durable task store. When set, the loop creates (or resumes)
   * a task record and persists every step, so an interrupted run can be
   * resumed later.
   */
  taskStore?: TaskStore;
  /** Resume this existing task instead of creating a new one. */
  resumeTaskId?: string;
}

const SYSTEM_PROMPT = `You are a browser automation agent. You see a page as an element tree where each interactable element has a short ref like [e3].

Reply with ONLY a JSON object describing the next action, no markdown, no prose. Schema:
{
  "action": "navigate" | "back" | "forward" | "reload" | "click" | "double_click" | "type" | "clear" | "press_key" | "select_option" | "check" | "scroll" | "wait_for" | "screenshot" | "snapshot" | "finish" | "noop",
  "ref": "e3",            // required for click/double_click/type/clear/hover/select_option/check: the element ref from the tree
  "url": "https://...",   // required for navigate
  "text": "...",          // required for type
  "submit": true,         // optional for type: press Enter afterwards
  "key": "Enter",         // required for press_key
  "values": ["red"],      // required for select_option: option values
  "checked": true,        // required for check
  "dx": 0, "dy": 500,     // optional for scroll: viewport delta in pixels
  "selector": "#delayed", // required for wait_for: CSS selector
  "reason": "why this action moves toward the goal",
  "result": "..."         // required for finish: summarize what was achieved
}

Rules:
- Use only refs shown in the current tree. Refs expire after every snapshot; if you need fresh refs, use {"action":"snapshot"}.
- Prefer the smallest action sequence that achieves the goal.
- If the goal is already satisfied by the current page state, use "finish".
- After each action you will be told whether its effect was verified; if not verified, re-observe before retrying.
- Never invent URLs, credentials, or personal data.`;

const VALID_ACTIONS: AgentAction['action'][] = [
  'navigate', 'back', 'forward', 'reload', 'click', 'double_click', 'type',
  'clear', 'press_key', 'select_option', 'check', 'scroll', 'wait_for',
  'screenshot', 'snapshot', 'finish', 'noop',
];

function parseAction(raw: string): AgentAction {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Try to salvage JSON from a chatty reply.
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) throw new Error(`planner did not return JSON: ${raw.slice(0, 200)}`);
    parsed = JSON.parse(m[0]);
  }
  const a = parsed as Partial<AgentAction>;
  if (!a.action) throw new Error('planner JSON missing "action"');
  if (!VALID_ACTIONS.includes(a.action)) throw new Error(`unknown action "${a.action}"`);
  const needsRef = ['click', 'double_click', 'type', 'clear', 'select_option', 'check'];
  if (needsRef.includes(a.action) && !a.ref) throw new Error(`${a.action} requires "ref"`);
  if (a.action === 'type' && a.text === undefined) throw new Error('type requires "text"');
  if (a.action === 'navigate' && !a.url) throw new Error('navigate requires "url"');
  if (a.action === 'press_key' && !a.key) throw new Error('press_key requires "key"');
  if (a.action === 'select_option' && !Array.isArray(a.values))
    throw new Error('select_option requires "values" array');
  if (a.action === 'check' && typeof a.checked !== 'boolean')
    throw new Error('check requires boolean "checked"');
  if (a.action === 'wait_for' && !a.selector) throw new Error('wait_for requires "selector"');
  return a as AgentAction;
}

/** Classify an action failure to decide whether a retry is sensible. */
function classifyFailure(message: string): 'stale' | 'not-found' | 'timeout' | 'fatal' {
  const m = message.toLowerCase();
  if (m.includes('stale element ref') || m.includes('unknown element ref')) return 'stale';
  if (m.includes('timeout') || m.includes('timed out') || m.includes('waiting for')) return 'timeout';
  if (m.includes('not found') || m.includes('could not resolve') || m.includes('no element'))
    return 'not-found';
  return 'fatal';
}

export class AgentLoop {
  private readonly session: BrowserSession;
  private readonly provider: LLMProvider;
  private readonly maxSteps: number;
  private readonly systemPromptExtra: string;
  private readonly onStep?: (step: StepRecord) => void;
  private readonly policyCheck: NonNullable<AgentLoopOptions['policyCheck']>;
  private readonly taskStore?: TaskStore;
  private readonly resumeTaskId?: string;
  private screenshotCounter = 0;

  constructor(
    session: BrowserSession,
    provider: LLMProvider,
    opts: AgentLoopOptions = {},
  ) {
    this.session = session;
    this.provider = provider;
    this.maxSteps = opts.maxSteps ?? 12;
    this.systemPromptExtra = opts.systemPromptExtra ?? '';
    this.onStep = opts.onStep;
    this.policyCheck = opts.policyCheck ?? (async () => 'allow');
    this.taskStore = opts.taskStore;
    this.resumeTaskId = opts.resumeTaskId;
  }

  /** Exposed for tests: run one observe->plan->act->verify cycle. */
  async stepOnce(goal: string, stepNumber: number, history: StepRecord[]): Promise<StepRecord> {
    const startedAt = new Date().toISOString();

    // 1. OBSERVE
    const snapshot = await this.session.snapshot();
    const summary = analyze(snapshot);
    const tree = renderTree(buildTree(snapshot.nodes));

    // 2. PLAN
    const messages: ChatMessage[] = [
      {
        role: 'system',
        content: SYSTEM_PROMPT + (this.systemPromptExtra ? `\n\n${this.systemPromptExtra}` : ''),
      },
      {
        role: 'user',
        content:
          `GOAL: ${goal}\n\n` +
          `PAGE BRIEF: ${summary.brief}\n\n` +
          `ELEMENT TREE:\n${tree}\n\n` +
          (history.length > 0
            ? `PREVIOUS STEPS:\n${history
                .slice(-5)
                .map(
                  (h) =>
                    `step ${h.step}: ${JSON.stringify(h.action)} -> ${h.result.ok ? 'ok' : 'ERROR: ' + h.result.error}` +
                    (h.verification && !h.verification.verified
                      ? ` (NOT VERIFIED: ${h.verification.detail})`
                      : ''),
                )
                .join('\n')}\n\n`
            : '') +
          `What is the next action? Reply with ONLY the JSON object.`,
      },
    ];

    let action: AgentAction;
    let result: ToolResult;
    let verification: ActionVerification | undefined;
    let recoveryAttempts = 0;
    try {
      const raw = await this.provider.complete(messages);
      action = parseAction(raw);
    } catch (err) {
      action = { action: 'noop', reason: 'planner error' };
      result = { ok: false, error: `planner failed: ${(err as Error).message}` };
      const rec: StepRecord = { step: stepNumber, action, result, startedAt, finishedAt: new Date().toISOString() };
      this.onStep?.(rec);
      return rec;
    }

    // 3. CHECK (policy gate)
    try {
      const decision = await this.policyCheck(action);
      if (decision !== 'allow') {
        const reason =
          typeof decision === 'object' && 'deny' in decision
            ? `denied by policy: ${decision.deny}`
            : `requires confirmation: ${(decision as { confirm: string }).confirm}`;
        result = { ok: false, error: reason };
        const rec: StepRecord = { step: stepNumber, action, result, startedAt, finishedAt: new Date().toISOString() };
        this.onStep?.(rec);
        return rec;
      }
    } catch (err) {
      result = { ok: false, error: `policy check failed: ${(err as Error).message}` };
      const rec: StepRecord = { step: stepNumber, action, result, startedAt, finishedAt: new Date().toISOString() };
      this.onStep?.(rec);
      return rec;
    }

    // 4. ACT with bounded recovery, then 5. VERIFY
    const preUrl = this.session.url;
    let lastError = '';
    for (let attempt = 0; attempt <= 1; attempt++) {
      try {
        result = await this.execute(action);
        lastError = '';
        break;
      } catch (err) {
        lastError = (err as Error).message;
        const kind = classifyFailure(lastError);
        if (attempt === 1 || kind === 'fatal') {
          // No more retries: one retry already used, or not retryable.
          recoveryAttempts = attempt;
          result = { ok: false, error: lastError };
          break;
        }
        // Recoverable: re-observe once (fresh refs) before the single retry.
        recoveryAttempts = attempt + 1;
        await this.session.snapshot().catch(() => undefined);
      }
    }

    if (result!.ok) {
      try {
        verification = await verifyAction(this.session, action, preUrl);
      } catch (err) {
        verification = {
          verified: false,
          method: 'error',
          detail: `verification errored: ${(err as Error).message}`,
        };
      }
    }

    const rec: StepRecord = {
      step: stepNumber,
      action,
      result: result!,
      verification,
      recoveryAttempts,
      startedAt,
      finishedAt: new Date().toISOString(),
    };
    this.onStep?.(rec);
    return rec;
  }

  private async execute(action: AgentAction): Promise<ToolResult> {
    switch (action.action) {
      case 'navigate': {
        const r = await this.session.navigate(action.url!);
        return { ok: true, data: r };
      }
      case 'back':
        return { ok: true, data: await this.session.goBack() };
      case 'forward':
        return { ok: true, data: await this.session.goForward() };
      case 'reload':
        return { ok: true, data: await this.session.reload() };
      case 'click':
        await this.session.click(action.ref!);
        return { ok: true, data: { clicked: action.ref } };
      case 'double_click':
        await this.session.dblclick(action.ref!);
        return { ok: true, data: { doubleClicked: action.ref } };
      case 'type':
        await this.session.type(action.ref!, action.text!, action.submit ?? false);
        return { ok: true, data: { typed: action.ref } };
      case 'clear':
        await this.session.clear(action.ref!);
        return { ok: true, data: { cleared: action.ref } };
      case 'press_key':
        await this.session.pressKey(action.key!);
        return { ok: true, data: { pressed: action.key } };
      case 'select_option': {
        const selected = await this.session.selectOption(action.ref!, action.values!);
        return { ok: true, data: { selected } };
      }
      case 'check':
        await this.session.setChecked(action.ref!, action.checked!);
        return { ok: true, data: { ref: action.ref, checked: action.checked } };
      case 'scroll':
        await this.session.scrollBy(action.dx ?? 0, action.dy ?? 0);
        return { ok: true, data: { scrolledBy: { dx: action.dx ?? 0, dy: action.dy ?? 0 } } };
      case 'wait_for':
        await this.session.waitForSelector(action.selector!, 'visible', 15_000);
        return { ok: true, data: { waitedFor: action.selector } };
      case 'snapshot': {
        const snap = await this.session.snapshot();
        return { ok: true, data: { url: snap.url, nodes: snap.nodes.length } };
      }
      case 'screenshot': {
        this.screenshotCounter += 1;
        const path = `agent-step-${this.screenshotCounter}.png`;
        await this.session.screenshot(path);
        return { ok: true, data: { path } };
      }
      case 'finish':
        return { ok: true, data: { finished: true, result: action.result } };
      case 'noop':
        return { ok: true, data: { noop: true } };
    }
  }

  async run(goal: string): Promise<AgentTrace> {
    const startedAt = new Date().toISOString();
    const store = this.taskStore;
    let taskId = this.resumeTaskId ?? null;
    let steps: StepRecord[] = [];
    let startStep = 1;

    if (store) {
      if (taskId) {
        const record = store.get(taskId);
        if (record.status !== 'interrupted' && record.status !== 'running') {
          throw new Error(`task ${taskId} is ${record.status} and cannot be resumed`);
        }
        goal = record.goal;
        steps = record.steps.map((s) => ({ ...s }) as StepRecord);
        startStep = steps.length + 1;
        store.update(taskId, { status: 'running', browserSessionId: this.session.id });
      } else {
        taskId = store.create(goal, {
          browserSessionId: this.session.id,
          backendName: this.session.backendName,
        }).taskId;
      }
    }

    let status: AgentStatus = 'failed';
    let finishReason: string | undefined;

    try {
      for (let i = startStep; i < startStep + this.maxSteps; i++) {
        const rec = await this.stepOnce(goal, i, steps);
        steps.push(rec);
        if (store && taskId) {
          store.appendStep(taskId, rec);
          store.update(taskId, { currentUrl: this.session.url });
        }
        if (rec.action.action === 'finish') {
          status = 'completed';
          finishReason = rec.action.result ?? 'planner declared the goal achieved';
          break;
        }
        if (!rec.result.ok && rec.action.action === 'noop') {
          // Planner is broken; stop rather than burn steps.
          status = 'failed';
          finishReason = `planner error at step ${i}: ${rec.result.error}`;
          break;
        }
        if (!rec.result.ok && rec.result.error?.startsWith('requires confirmation:')) {
          status = 'awaiting_confirmation';
          finishReason = rec.result.error;
          if (store && taskId) store.update(taskId, { pendingConfirmation: rec.result.error });
          break;
        }
        if (!rec.result.ok && rec.result.error?.startsWith('denied by policy:')) {
          status = 'blocked';
          finishReason = rec.result.error;
          break;
        }
      }
    } catch (err) {
      finishReason = `loop crashed: ${(err as Error).message}`;
      if (store && taskId) store.interrupt(taskId, finishReason);
      throw err;
    }
    if (status === 'failed' && !finishReason) {
      finishReason = `reached maxSteps (${this.maxSteps}) without completing`;
    }
    if (store && taskId) {
      store.close(taskId, status, finishReason);
    }

    return {
      goal,
      steps,
      finished: status === 'completed',
      status,
      finishReason,
      startedAt,
      finishedAt: new Date().toISOString(),
    };
  }
}

/** Convenience: build a session on the default Playwright backend. */
export function createLocalSession(id: string, backend?: BrowserBackend): BrowserSession {
  return new BrowserSession(id, backend);
}
