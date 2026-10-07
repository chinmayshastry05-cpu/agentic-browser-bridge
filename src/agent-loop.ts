/**
 * agent-loop.ts — the observe -> plan -> act decision loop.
 *
 * Each step:
 *   1. OBSERVE: take a snapshot, analyze it, render the element tree.
 *   2. PLAN:    ask the LLM provider for the next action as JSON.
 *   3. ACT:     execute the action against the BrowserSession via the tool layer.
 *
 * The loop is provider-agnostic (any LLMProvider) and transport-agnostic
 * (any BrowserSession). It never touches the network except through the
 * injected provider and session.
 */
import { analyze } from './analyzer.js';
import { buildTree, renderTree } from './tree.js';
import type {
  AgentAction,
  AgentTrace,
  BrowserBackend,
  ChatMessage,
  LLMProvider,
  StepRecord,
  ToolResult,
} from './types.js';
import { BrowserSession } from './bridge-core.js';

export interface AgentLoopOptions {
  maxSteps?: number;
  /** Extra system-prompt guidance, e.g. site-specific rules. */
  systemPromptExtra?: string;
  /** Called after every step (for SSE streaming / logging). */
  onStep?: (step: StepRecord) => void;
}

const SYSTEM_PROMPT = `You are a browser automation agent. You see a page as an element tree where each interactable element has a short ref like [e3].

Reply with ONLY a JSON object describing the next action, no markdown, no prose. Schema:
{
  "action": "navigate" | "click" | "type" | "screenshot" | "snapshot" | "finish" | "noop",
  "ref": "e3",            // required for click/type: the element ref from the tree
  "url": "https://...",   // required for navigate
  "text": "...",          // required for type
  "submit": true,         // optional for type: press Enter afterwards
  "reason": "why this action moves toward the goal",
  "result": "..."         // required for finish: summarize what was achieved
}

Rules:
- Use only refs shown in the current tree. Refs expire after every snapshot; if you need fresh refs, use {"action":"snapshot"}.
- Prefer the smallest action sequence that achieves the goal.
- If the goal is already satisfied by the current page state, use "finish".
- Never invent URLs, credentials, or personal data.`;

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
  const valid = ['navigate', 'click', 'type', 'screenshot', 'snapshot', 'finish', 'noop'];
  if (!valid.includes(a.action)) throw new Error(`unknown action "${a.action}"`);
  if (a.action === 'click' && !a.ref) throw new Error('click requires "ref"');
  if (a.action === 'type' && (!a.ref || a.text === undefined))
    throw new Error('type requires "ref" and "text"');
  if (a.action === 'navigate' && !a.url) throw new Error('navigate requires "url"');
  return a as AgentAction;
}

export class AgentLoop {
  private readonly session: BrowserSession;
  private readonly provider: LLMProvider;
  private readonly maxSteps: number;
  private readonly systemPromptExtra: string;
  private readonly onStep?: (step: StepRecord) => void;
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
  }

  /** Exposed for tests: run one observe->plan->act cycle. */
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
                .map((h) => `step ${h.step}: ${JSON.stringify(h.action)} -> ${h.result.ok ? 'ok' : 'ERROR: ' + h.result.error}`)
                .join('\n')}\n\n`
            : '') +
          `What is the next action? Reply with ONLY the JSON object.`,
      },
    ];

    let action: AgentAction;
    let result: ToolResult;
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

    // 3. ACT
    try {
      result = await this.execute(action);
    } catch (err) {
      result = { ok: false, error: (err as Error).message };
    }

    const rec: StepRecord = {
      step: stepNumber,
      action,
      result,
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
      case 'click':
        await this.session.click(action.ref!);
        return { ok: true, data: { clicked: action.ref } };
      case 'type':
        await this.session.type(action.ref!, action.text!, action.submit ?? false);
        return { ok: true, data: { typed: action.ref } };
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
    const steps: StepRecord[] = [];
    let finished = false;
    let finishReason: string | undefined;

    for (let i = 1; i <= this.maxSteps; i++) {
      const rec = await this.stepOnce(goal, i, steps);
      steps.push(rec);
      if (rec.action.action === 'finish') {
        finished = true;
        finishReason = rec.action.result ?? 'planner declared the goal achieved';
        break;
      }
      if (!rec.result.ok && rec.action.action === 'noop') {
        // Planner is broken; stop rather than burn steps.
        finishReason = `planner error at step ${i}: ${rec.result.error}`;
        break;
      }
    }
    if (!finished && !finishReason) finishReason = `reached maxSteps (${this.maxSteps})`;

    return {
      goal,
      steps,
      finished,
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
