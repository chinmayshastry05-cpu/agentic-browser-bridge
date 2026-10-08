/**
 * tests/mcp.test.ts — offline unit tests for the bridge.
 *
 * No real browser and no network: a MockBackend stands in for Playwright and
 * a stubbed fetch stands in for the LLM HTTP call. The one integration-style
 * test (tools/call through the JSON-RPC layer) also uses the mock backend.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserSession, SessionManager } from '../src/bridge-core.js';
import { analyze, findByName, findByRole, rankInteractables } from '../src/analyzer.js';
import { buildTree, findNode, flatten, renderTree } from '../src/tree.js';
import { OpenAIAdapter } from '../src/openai.js';
import { AgentLoop } from '../src/agent/agent-loop.js';
import { createToolRegistry, listToolDefinitions } from '../src/tools.js';
import { BridgeServer } from '../src/server.js';
import type {
  BrowserBackend,
  DomNode,
  ElementDescriptor,
  LLMProvider,
  PageSnapshot,
} from '../src/types.js';
import { nameSimilarity, reground, signatureMatches, similarityScore } from '../src/perception/grounding.js';
import { MockBackend, node, sampleSnapshot } from './fixtures/mock-backend.js';

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

function makeSession(): { session: BrowserSession; backend: MockBackend } {
  const backend = new MockBackend();
  const session = new BrowserSession('test', backend);
  return { session, backend };
}

/* ------------------------------------------------------------------ */
/* analyzer.ts                                                         */
/* ------------------------------------------------------------------ */

describe('analyzer', () => {
  const snap = sampleSnapshot();

  it('counts roles and summarizes the page', () => {
    const a = analyze(snap);
    expect(a.totalNodes).toBe(5);
    expect(a.visibleNodes).toBe(4);
    expect(a.countsByRole['button']).toBe(1);
    expect(a.countsByRole['textbox']).toBe(1);
    expect(a.outline).toContain('H: Welcome');
    expect(a.brief).toContain('Demo');
  });

  it('finds nodes by name and role', () => {
    expect(findByName(snap, 'greet')).toHaveLength(2); // textbox placeholder + button
    expect(findByRole(snap, 'link')).toHaveLength(1);
    expect(findByName(snap, 'nonexistent')).toHaveLength(0);
  });

  it('ranks visible interactables first', () => {
    const ranked = rankInteractables(snap);
    expect(ranked.every((n) => ['button', 'link', 'textbox'].includes(n.role))).toBe(true);
    expect(ranked[ranked.length - 1].visible).toBe(false); // hidden link sinks
  });
});

/* ------------------------------------------------------------------ */
/* tree.ts                                                             */
/* ------------------------------------------------------------------ */

describe('tree', () => {
  const snap = sampleSnapshot();

  it('builds nested trees from parent refs', () => {
    const roots = buildTree(snap.nodes);
    const form = findNode(roots, (n) => n.ref === 'e4');
    expect(form).not.toBeNull();
    expect(form!.children.map((c) => c.node.ref)).toEqual(['e3']);
    expect(form!.children[0].depth).toBe(form!.depth + 1);
    expect(flatten(roots)).toHaveLength(5);
  });

  it('renders an indented text tree', () => {
    const text = renderTree(buildTree(snap.nodes));
    expect(text).toContain('[e1] heading "Welcome"');
    expect(text).toContain('[e3] button "Greet me"');
    expect(text).toMatch(/\n  \[e3\]/); // indented under the form
  });

  it('returns null when nothing matches', () => {
    expect(findNode(buildTree(snap.nodes), (n) => n.ref === 'e999')).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* tools.ts — MCP tool registry                                        */
/* ------------------------------------------------------------------ */

describe('mcp tools', () => {
  let session: BrowserSession;
  let backend: MockBackend;

  beforeEach(() => {
    ({ session, backend } = makeSession());
  });

  it('exposes the browser tools with JSON schemas', () => {
    const defs = listToolDefinitions(createToolRegistry(session));
    expect(defs.map((d) => d.name).sort()).toEqual([
      'browser_back',
      'browser_check',
      'browser_clear',
      'browser_click',
      'browser_close_tab',
      'browser_double_click',
      'browser_downloads',
      'browser_focus',
      'browser_forward',
      'browser_frame_snapshot',
      'browser_frames',
      'browser_get_text',
      'browser_hover',
      'browser_navigate',
      'browser_open_tab',
      'browser_page_info',
      'browser_press_key',
      'browser_reload',
      'browser_screenshot',
      'browser_scroll',
      'browser_scroll_into_view',
      'browser_select_option',
      'browser_snapshot',
      'browser_status',
      'browser_switch_tab',
      'browser_tabs',
      'browser_type',
      'browser_upload',
      'browser_wait_for',
      'browser_wait_for_download',
    ]);
    for (const d of defs) {
      expect(d.description.length).toBeGreaterThan(10);
      expect(d.inputSchema).toHaveProperty('type', 'object');
    }
  });

  it('browser_navigate drives the backend and rejects non-web URLs', async () => {
    const registry = createToolRegistry(session);
    const okRes = await registry.get('browser_navigate')!.handle({ url: 'https://example.com' });
    expect(okRes.ok).toBe(true);
    expect(backend.navigated).toEqual(['https://example.com']);

    const bad = await registry.get('browser_navigate')!.handle({ url: 'javascript:alert(1)' });
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/refusing/i);
  });

  it('browser_snapshot returns a brief plus the rendered tree', async () => {
    const registry = createToolRegistry(session);
    const res = await registry.get('browser_snapshot')!.handle({});
    expect(res.ok).toBe(true);
    const data = res.data as { brief: string; tree: string };
    expect(data.brief).toContain('Demo');
    expect(data.tree).toContain('[e2] textbox "Your name"');
  });

  it('browser_click / browser_type resolve refs from the latest snapshot', async () => {
    const registry = createToolRegistry(session);
    await registry.get('browser_snapshot')!.handle({}); // populate ref map

    const click = await registry.get('browser_click')!.handle({ ref: 'e3' });
    expect(click.ok).toBe(true);
    expect(backend.clicked).toEqual(['#e3']);

    const type = await registry.get('browser_type')!.handle({ ref: 'e2', text: 'Ada', submit: true });
    expect(type.ok).toBe(true);
    expect(backend.typed).toEqual([{ selector: '#e2', text: 'Ada', submit: true }]);
  });

  it('returns a tool error (not a throw) for unknown refs and missing args', async () => {
    const registry = createToolRegistry(session);
    const unknown = await registry.get('browser_click')!.handle({ ref: 'e999' });
    expect(unknown.ok).toBe(false);
    expect(unknown.error).toMatch(/unknown element ref/);

    const missing = await registry.get('browser_type')!.handle({ ref: 'e2' });
    expect(missing.ok).toBe(false);
    expect(missing.error).toMatch(/missing required/);
  });

  it('browser_screenshot records the requested path', async () => {
    const registry = createToolRegistry(session);
    const res = await registry.get('browser_screenshot')!.handle({ path: '/tmp/shot.png' });
    expect(res.ok).toBe(true);
    expect(backend.screenshots).toEqual(['/tmp/shot.png']);
  });
});

/* ------------------------------------------------------------------ */
/* agent-loop.ts                                                       */
/* ------------------------------------------------------------------ */

function scriptedProvider(responses: string[]): LLMProvider {
  let i = 0;
  return {
    name: 'scripted-test-provider',
    complete: async () => {
      const r = responses[Math.min(i, responses.length - 1)];
      i += 1;
      return r;
    },
  };
}

describe('agent-loop', () => {
  it('runs observe->plan->act and stops on finish', async () => {
    const { session, backend } = makeSession();
    await session.snapshot(); // seed refs
    const provider = scriptedProvider([
      JSON.stringify({ action: 'click', ref: 'e3', reason: 'press the greet button' }),
      JSON.stringify({ action: 'finish', result: 'greeting triggered' }),
    ]);
    const seen: string[] = [];
    const loop = new AgentLoop(session, provider, {
      maxSteps: 5,
      onStep: (s) => seen.push(s.action.action),
    });
    const trace = await loop.run('trigger the greeting');
    expect(trace.finished).toBe(true);
    expect(trace.steps).toHaveLength(2);
    expect(seen).toEqual(['click', 'finish']);
    expect(backend.clicked).toEqual(['#e3']);
    expect(trace.finishReason).toContain('greeting triggered');
  });

  it('surfaces planner errors as failed noop steps instead of crashing', async () => {
    const { session } = makeSession();
    const provider: LLMProvider = {
      name: 'broken',
      complete: async () => 'this is not json at all',
    };
    const loop = new AgentLoop(session, provider, { maxSteps: 3 });
    const trace = await loop.run('do something');
    expect(trace.finished).toBe(false);
    expect(trace.finishReason).toMatch(/planner error/);
    expect(trace.steps[0].result.ok).toBe(false);
  });

  it('stops at maxSteps when the planner never finishes', async () => {
    const { session } = makeSession();
    const provider = scriptedProvider([JSON.stringify({ action: 'noop', reason: 'waiting' })]);
    const loop = new AgentLoop(session, provider, { maxSteps: 3 });
    const trace = await loop.run('never finishes');
    expect(trace.finished).toBe(false);
    expect(trace.steps).toHaveLength(3);
    expect(trace.finishReason).toMatch(/maxSteps/);
  });
});

/* ------------------------------------------------------------------ */
/* openai.ts                                                           */
/* ------------------------------------------------------------------ */

describe('openai adapter', () => {
  const ENV = 'OPENAI_API_KEY';

  it('refuses to construct without an env key (never hardcoded)', () => {
    const saved = process.env[ENV];
    delete process.env[ENV];
    try {
      expect(() => new OpenAIAdapter()).toThrow(/OPENAI_API_KEY/);
    } finally {
      if (saved !== undefined) process.env[ENV] = saved;
    }
  });

  it('builds a correct chat-completions request without leaking the key into the body', () => {
    process.env[ENV] = 'dummy-test-key';
    const adapter = new OpenAIAdapter({ model: 'test-model' });
    const { url, body } = adapter.buildRequest([{ role: 'user', content: 'hi' }]);
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    const b = body as Record<string, unknown>;
    expect(b['model']).toBe('test-model');
    expect(JSON.stringify(body)).not.toContain('dummy-test-key');
  });

  it('sends the key only in the Authorization header and parses the reply', async () => {
    process.env[ENV] = 'dummy-test-key';
    let seenAuth = '';
    const fetchImpl = (async (_url: unknown, init: unknown) => {
      seenAuth = (init as { headers: Record<string, string> }).headers['authorization'];
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: '{"action":"finish"}' } }] }),
      };
    }) as unknown as typeof fetch;
    const adapter = new OpenAIAdapter({ fetchImpl });
    const out = await adapter.complete([{ role: 'user', content: 'hi' }]);
    expect(out).toBe('{"action":"finish"}');
    expect(seenAuth).toBe('Bearer dummy-test-key');
  });

  it('raises a clear error on HTTP failure', async () => {
    process.env[ENV] = 'dummy-test-key';
    const fetchImpl = (async () => ({
      ok: false,
      status: 401,
      text: async () => 'unauthorized',
    })) as unknown as typeof fetch;
    const adapter = new OpenAIAdapter({ fetchImpl });
    await expect(adapter.complete([{ role: 'user', content: 'hi' }])).rejects.toThrow(/HTTP 401/);
  });
});

/* ------------------------------------------------------------------ */
/* server.ts — JSON-RPC layer (mock backend, no sockets)                */
/* ------------------------------------------------------------------ */

describe('bridge server rpc', () => {
  it('lists tools and calls them through JSON-RPC', async () => {
    const server = new BridgeServer({ maxSessions: 2 });
    const manager: SessionManager = server.sessionManager;
    const backend = new MockBackend();
    const session = manager.create(backend);
    await session.start({ headless: true });

    const list = await server.rpcForTest({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: { sessionId: session.id },
    });
    expect(list.error).toBeUndefined();
    const tools = (list.result as { tools: Array<{ name: string }> }).tools;
    expect(tools.map((t) => t.name)).toContain('browser_snapshot');

    const call = await server.rpcForTest({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { sessionId: session.id, name: 'browser_navigate', arguments: { url: 'https://example.com' } },
    });
    expect(call.error).toBeUndefined();
    expect((call.result as { ok: boolean }).ok).toBe(true);
    expect(backend.navigated).toEqual(['https://example.com']);

    const unknownTool = await server.rpcForTest({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { sessionId: session.id, name: 'browser_fly', arguments: {} },
    });
    expect(unknownTool.error?.code).toBe(-32601);

    await server.stop();
    expect(manager.ids()).toHaveLength(0);
  });

  it('rejects unknown methods and enforces the session cap', async () => {
    const server = new BridgeServer({ maxSessions: 1 });
    const bad = await server.rpcForTest({ jsonrpc: '2.0', id: 1, method: 'nope/do' });
    expect(bad.error?.code).toBe(-32601);

    const manager: SessionManager = server.sessionManager;
    manager.create(new MockBackend());
    expect(() => manager.create(new MockBackend())).toThrow(/session limit/);
    await server.stop();
  });
});

/* ------------------------------------------------------------------ */
/* browser session: tabs + attach + snapshot ids (M1)                   */
/* ------------------------------------------------------------------ */

describe('session tabs and attach', () => {
  it('delegates tab operations to the backend', async () => {
    const { session, backend } = makeSession();
    const tabs = await session.listTabs();
    expect(tabs).toHaveLength(1);

    const opened = await session.openTab('https://example.com/2');
    expect(opened.id).toBe('tab-2');
    expect((await session.listTabs())).toHaveLength(2);

    const switched = await session.switchTab('tab-1');
    expect(switched.active).toBe(true);

    await session.closeTab('tab-2');
    expect((await session.listTabs())).toHaveLength(1);
    await expect(session.closeTab('tab-1')).rejects.toThrow(/last tab/);
    expect(backend.tabs).toHaveLength(1);
  });

  it('attaches to an explicit CDP endpoint through the session', async () => {
    const { session, backend } = makeSession();
    await session.attach({ cdpEndpoint: 'http://127.0.0.1:9222' });
    expect(backend.attached).toEqual(['http://127.0.0.1:9222']);
  });

  it('assigns a unique snapshotId per snapshot', async () => {
    const { session } = makeSession();
    const a = await session.snapshot();
    const b = await session.snapshot();
    expect(a.snapshotId).toMatch(/^snap-/);
    expect(b.snapshotId).toMatch(/^snap-/);
    expect(a.snapshotId).not.toBe(b.snapshotId);
    expect(session.lastSnapshotId).toBe(b.snapshotId);
  });

  it('browser_status reports backend and connection state', async () => {
    const { session } = makeSession();
    const registry = createToolRegistry(session);
    const res = await registry.get('browser_status')!.handle({});
    expect(res.ok).toBe(true);
    const data = res.data as Record<string, unknown>;
    expect(data['backend']).toBe('mock');
    expect(data['userBrowser']).toBe(false);
    expect(data['sessionId']).toBe('test');
  });

  it('session/attach RPC validates its parameters', async () => {
    const server = new BridgeServer({ maxSessions: 2 });
    const manager = server.sessionManager;
    const session = manager.create(new MockBackend());
    const bad = await server.rpcForTest({
      jsonrpc: '2.0',
      id: 1,
      method: 'session/attach',
      params: { sessionId: session.id },
    });
    expect(bad.error?.code).toBe(-32602);
    await server.stop();
  });
});

/* ------------------------------------------------------------------ */
/* perception/grounding.ts — stale refs and semantic re-grounding (M3)  */
/* ------------------------------------------------------------------ */

function descriptor(over: Partial<ElementDescriptor> = {}): ElementDescriptor {
  return {
    ref: 'e3',
    snapshotId: 'snap-1',
    role: 'button',
    name: 'Greet me',
    tag: 'button',
    selector: '#greet',
    docGeneration: 0,
    docLoadId: null,
    ...over,
  };
}

describe('grounding', () => {
  it('matches identical signatures', () => {
    expect(signatureMatches(descriptor(), { role: 'button', name: 'Greet me', tag: 'button' })).toBe(true);
    expect(signatureMatches(descriptor(), { role: 'link', name: 'Greet me', tag: 'a' })).toBe(false);
    expect(signatureMatches(descriptor(), { role: 'button', name: 'Farewell', tag: 'button' })).toBe(false);
  });

  it('scores name similarity by token overlap', () => {
    expect(nameSimilarity('Greet me', 'Greet me')).toBe(1);
    expect(nameSimilarity('Greet me now', 'Greet me')).toBeGreaterThan(0.5);
    expect(nameSimilarity('Greet me', 'Delete everything')).toBeLessThan(0.3);
    expect(nameSimilarity('', 'Greet me')).toBe(0);
  });

  it('re-grounds by ref when the signature still matches', () => {
    const fresh = sampleSnapshot();
    const r = reground(descriptor(), fresh);
    expect(r.ok).toBe(true);
    expect(r.method).toBe('ref-signature');
    expect(r.confidence).toBe(1);
  });

  it('re-grounds semantically when the DOM was reordered (selector changed)', () => {
    const fresh = sampleSnapshot();
    // Simulate a re-render: same button, new selector and new ref position.
    fresh.nodes = fresh.nodes.map((n) =>
      n.ref === 'e3'
        ? { ...n, ref: 'e9', selector: '#app > button.primary' }
        : n,
    );
    const r = reground(descriptor(), fresh);
    expect(r.ok).toBe(true);
    expect(r.method).toBe('semantic');
    expect(r.newRef).toBe('e9');
    expect(r.confidence!).toBeGreaterThanOrEqual(0.7);
  });

  it('refuses when duplicate labels make the match ambiguous', () => {
    const dup = sampleSnapshot();
    dup.nodes = [
      ...dup.nodes,
      node({ ref: 'e9', role: 'button', name: 'Greet me', tag: 'button', selector: '#greet2' }),
    ];
    const r = reground({ ...descriptor(), ref: 'e999', selector: '#gone' }, dup);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/ambiguous/);
    expect(r.candidates!.length).toBeGreaterThanOrEqual(2);
  });

  it('refuses when nothing resembles the descriptor', () => {
    const empty: PageSnapshot = {
      snapshotId: 'snap-2',
      url: 'https://example.test/',
      title: 'Demo',
      capturedAt: '2026-10-07T00:00:00.000Z',
      nodes: [node({ ref: 'e1', role: 'heading', name: 'Unrelated', tag: 'h1', selector: '#h' })],
    };
    const r = reground(descriptor(), empty);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/below threshold/);
  });

  it('similarityScore weights role over name', () => {
    const d = descriptor();
    const sameRole = node({ ref: 'e1', role: 'button', name: 'Something else', tag: 'button', selector: '#x' });
    const diffRole = node({ ref: 'e2', role: 'link', name: 'Greet me', tag: 'a', selector: '#y' });
    expect(similarityScore(d, sameRole)).toBeGreaterThan(similarityScore(d, diffRole));
  });
});

describe('session resolveTarget (stale detection)', () => {
  it('acts directly when the live target still matches', async () => {
    const { session, backend } = makeSession();
    await session.snapshot();
    await session.click('e3');
    expect(backend.clicked).toEqual(['#e3']);
  });

  it('re-grounds and acts when the DOM moved the element', async () => {
    const { session, backend } = makeSession();
    await session.snapshot();
    // DOM drift: the selector no longer resolves, but a fresh snapshot has
    // the same button under a new selector.
    backend.describeOverride = { '#e3': null };
    backend.snapshotData = {
      ...sampleSnapshot(),
      nodes: sampleSnapshot().nodes.map((n) =>
        n.ref === 'e3' ? { ...n, selector: '#app > button.primary' } : n,
      ),
    };
    await session.click('e3');
    expect(backend.clicked).toEqual(['#app > button.primary']);
  });

  it('throws instead of guessing when re-grounding is ambiguous', async () => {
    const { session, backend } = makeSession();
    await session.snapshot();
    backend.describeOverride = { '#e3': null };
    const dup = sampleSnapshot();
    backend.snapshotData = {
      ...dup,
      nodes: [
        ...dup.nodes.filter((n) => n.ref !== 'e3'),
        node({ ref: 'e8', role: 'button', name: 'Greet me', tag: 'button', selector: '#g1' }),
        node({ ref: 'e9', role: 'button', name: 'Greet me', tag: 'button', selector: '#g2' }),
      ],
    };
    await expect(session.click('e3')).rejects.toThrow(/stale element ref/);
    expect(backend.clicked).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* agent/verifier.ts + loop recovery and terminal states (M4)          */
/* ------------------------------------------------------------------ */

import { verifyAction } from '../src/agent/verifier.js';

describe('verifier', () => {
  it('verifies navigate by URL match', async () => {
    const { session } = makeSession();
    const v = await verifyAction(session, { action: 'navigate', url: 'https://example.test/' }, '');
    expect(v.verified).toBe(true);
    expect(v.method).toBe('url-match');

    const bad = await verifyAction(session, { action: 'navigate', url: 'https://other.test/' }, '');
    expect(bad.verified).toBe(false);
  });

  it('verifies type by field value', async () => {
    const { session } = makeSession();
    await session.snapshot();
    await session.type('e2', 'Ada');
    const v = await verifyAction(session, { action: 'type', ref: 'e2', text: 'Ada' }, session.url);
    expect(v.verified).toBe(true);
    expect(v.method).toBe('field-value');

    const bad = await verifyAction(session, { action: 'type', ref: 'e2', text: 'Zed' }, session.url);
    expect(bad.verified).toBe(false);
  });

  it('verifies check by checked state', async () => {
    const { session, backend } = makeSession();
    backend.fieldChecked['#e3'] = true;
    await session.snapshot();
    const v = await verifyAction(session, { action: 'check', ref: 'e3', checked: true }, session.url);
    expect(v.verified).toBe(true);
  });

  it('reports click honestly when nothing observable changed', async () => {
    const { session } = makeSession();
    await session.snapshot();
    const v = await verifyAction(session, { action: 'click', ref: 'e3' }, session.url);
    expect(v.verified).toBe(false);
    expect(v.detail).toMatch(/no navigation/i);
  });
});

describe('agent loop recovery and terminal states', () => {
  it('retries once after a stale failure, then verifies', async () => {
    const { session, backend } = makeSession();
    backend.nextClickError = 'stale element ref "e3" (simulated)';
    const provider = scriptedProvider([
      JSON.stringify({ action: 'click', ref: 'e3', reason: 'press it' }),
      JSON.stringify({ action: 'finish', result: 'done' }),
    ]);
    const loop = new AgentLoop(session, provider, { maxSteps: 5 });
    const trace = await loop.run('press the button');
    expect(trace.status).toBe('completed');
    expect(trace.steps[0]!.recoveryAttempts).toBe(1);
    expect(trace.steps[0]!.result.ok).toBe(true);
    expect(backend.clicked).toEqual(['#e3']);
  });

  it('stops after one failed retry (bounded, no infinite loop)', async () => {
    const { session, backend } = makeSession();
    // MockBackend.click only fails once via nextClickError; simulate a
    // persistent failure by failing describeTarget instead: every action
    // attempt throws a fatal error through a poisoned backend method.
    backend.click = async () => {
      throw new Error('fatal: element is not clickable at point');
    };
    const provider = scriptedProvider([JSON.stringify({ action: 'click', ref: 'e3' })]);
    const loop = new AgentLoop(session, provider, { maxSteps: 2 });
    const trace = await loop.run('press the button');
    expect(trace.steps).toHaveLength(2);
    expect(trace.steps[0]!.recoveryAttempts).toBe(0); // fatal: no retry
    expect(trace.steps[0]!.result.ok).toBe(false);
    expect(trace.status).toBe('failed');
    expect(trace.finishReason).toMatch(/maxSteps/);
  });

  it('enters awaiting_confirmation when the policy gate requires it', async () => {
    const { session } = makeSession();
    const provider = scriptedProvider([JSON.stringify({ action: 'click', ref: 'e3' })]);
    const loop = new AgentLoop(session, provider, {
      maxSteps: 5,
      policyCheck: async () => ({ verdict: 'confirm', risk: 'medium', reason: 'clicking might submit a form — approve?' }),
    });
    const trace = await loop.run('do the thing');
    expect(trace.status).toBe('awaiting_confirmation');
    expect(trace.finishReason).toMatch(/requires confirmation/);
  });

  it('enters blocked when the policy gate denies', async () => {
    const { session } = makeSession();
    const provider = scriptedProvider([JSON.stringify({ action: 'click', ref: 'e3' })]);
    const loop = new AgentLoop(session, provider, {
      maxSteps: 5,
      policyCheck: async () => ({ verdict: 'deny', risk: 'medium', reason: 'clicking is disabled in this context' }),
    });
    const trace = await loop.run('do the thing');
    expect(trace.status).toBe('blocked');
    expect(trace.finishReason).toMatch(/denied by policy/);
  });

  it('records verification on successful steps', async () => {
    const { session } = makeSession();
    const provider = scriptedProvider([
      JSON.stringify({ action: 'type', ref: 'e2', text: 'Ada', reason: 'fill name' }),
      JSON.stringify({ action: 'finish', result: 'filled' }),
    ]);
    const loop = new AgentLoop(session, provider, { maxSteps: 5 });
    const trace = await loop.run('fill the name');
    expect(trace.status).toBe('completed');
    expect(trace.steps[0]!.verification?.verified).toBe(true);
    expect(trace.steps[0]!.verification?.method).toBe('field-value');
  });
});

/* ------------------------------------------------------------------ */
/* bridge-core session ref handling                                     */
/* ------------------------------------------------------------------ */

describe('browser session', () => {
  it('resolves refs only from the latest snapshot', async () => {
    const { session, backend } = makeSession();
    await expect(session.click('e1')).rejects.toThrow(/fresh browser_snapshot/);
    await session.snapshot();
    await session.click('e1');
    expect(backend.clicked).toEqual(['#e1']);

    // A new snapshot with a different selector for the same element:
    // the ref still works because the semantic signature matches.
    backend.snapshotData = {
      ...sampleSnapshot(),
      nodes: [node({ ref: 'e1', role: 'heading', name: 'Welcome', tag: 'h1', selector: '#other' })],
    };
    await session.snapshot();
    await session.click('e1');
    expect(backend.clicked[1]).toBe('#other');
  });

  it('refuses to act when the element behind a ref changed identity', async () => {
    const { session, backend } = makeSession();
    await session.snapshot();
    // DOM changes after the snapshot: e1's heading is replaced by different content.
    backend.snapshotData = {
      ...sampleSnapshot(),
      nodes: sampleSnapshot().nodes.map((n) =>
        n.ref === 'e1' ? { ...n, name: 'Something else entirely' } : n,
      ),
    };
    await expect(session.click('e1')).rejects.toThrow(/stale element ref/);
    expect(backend.clicked).toEqual([]);
  });
});
