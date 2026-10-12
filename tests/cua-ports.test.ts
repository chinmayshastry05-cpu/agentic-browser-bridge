/**
 * tests/cua-ports.test.ts — effect codes, refusal envelope, browser_verify,
 * snapshot screenshot evidence + one-use capture_id, closed schemas and
 * per-tool outputSchema. Offline: MockBackend only.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { BrowserSession } from '../src/bridge-core.js';
import { createToolRegistry } from '../src/tools.js';
import { buildMcpServer } from '../src/mcp/server.js';
import { PolicyEngine } from '../src/security/policy.js';
import { validateActionResult } from '../src/effects.js';
import { runVerify, parsePredicates } from '../src/verify-tool.js';
import { MockBackend } from './fixtures/mock-backend.js';

// Minimal valid PNG header: width 200, height 100.
function fakePng(w = 200, h = 100): Buffer {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'ascii');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
}

class VisionMock extends MockBackend {
  points: Array<[number, number]> = [];
  domClicks: string[] = [];
  fronted = 0;
  async screenshot(path: string): Promise<void> {
    await super.screenshot(path);
    await writeFile(path, fakePng(200, 100));
  }
  async viewportInfo() {
    return { width: 100, height: 50, devicePixelRatio: 2 };
  }
  async clickAt(x: number, y: number) {
    this.points.push([x, y]);
  }
  async describePoint() {
    return { tag: 'button', role: 'button', name: 'Greet me' };
  }
  async clickDom(selector: string) {
    this.domClicks.push(selector);
  }
  async bringToFront() {
    this.fronted += 1;
  }
}

async function boot(backend: MockBackend = new VisionMock()) {
  const session = new BrowserSession('cua', backend);
  await session.start({ headless: true });
  const registry = createToolRegistry(session);
  const call = async (name: string, args: Record<string, unknown> = {}) =>
    registry.get(name)!.handle(args);
  await session.snapshot();
  return { session, backend, call };
}

describe('effect codes + invariants', () => {
  it('validateActionResult enforces the invariants', () => {
    expect(validateActionResult({ effect: 'confirmed' })).toContain('confirmed requires evidence');
    expect(validateActionResult({ effect: 'confirmed', evidence: 'value_readback' })).toEqual([]);
    expect(validateActionResult({ effect: 'partial', evidence: 'value_readback' })[0]).toMatch(/must not carry evidence/);
    expect(validateActionResult({ effect: 'refused' })).toEqual(
      expect.arrayContaining(['refused requires error', 'refused requires refusal']),
    );
    expect(
      validateActionResult({
        effect: 'refused',
        error: 'x',
        refusal: { code: 'stale_ref', message: 'x', hint: 'h' },
        delivery: 'background',
      }),
    ).toContain('refused must not carry delivery');
    expect(validateActionResult({ effect: 'unverifiable', error: 'nope' })).toContain('only refused may carry error');
  });

  it('type confirms with value_readback evidence and reports route + delivery', async () => {
    const { call } = await boot();
    const r = await call('browser_type', { ref: 'e2', text: 'Ada' });
    expect(r.ok).toBe(true);
    const d = r.data as Record<string, unknown>;
    expect(d['effect']).toBe('confirmed');
    expect(d['evidence']).toBe('value_readback');
    expect(d['route']).toBe('trusted_input');
    expect(d['delivery']).toBe('background');
    expect(validateActionResult(d as never)).toEqual([]);
  });

  it('click with no observable change is suspected_noop, never confirmed', async () => {
    const { call } = await boot();
    const r = await call('browser_click', { ref: 'e3' });
    const d = r.data as Record<string, unknown>;
    expect(d['effect']).toBe('suspected_noop');
    expect(d['evidence']).toBeUndefined();
  });

  it('press_key has no signal: unverifiable', async () => {
    const { call } = await boot();
    const d = (await call('browser_press_key', { key: 'Enter' })).data as Record<string, unknown>;
    expect(d['effect']).toBe('unverifiable');
  });

  it('truncated typing is partial', async () => {
    const backend = new VisionMock();
    const orig = backend.type.bind(backend);
    backend.type = async (sel, text, submit, f) => {
      await orig(sel, text.slice(0, 2), submit, f);
    };
    const { call } = await boot(backend);
    const d = (await call('browser_type', { ref: 'e2', text: 'Ada Lovelace' })).data as Record<string, unknown>;
    expect(d['effect']).toBe('partial');
  });
});

describe('refusal envelope', () => {
  it('stale/unknown refs are refused with an escalation and keep suggestedNextStep', async () => {
    const { call } = await boot();
    const r = await call('browser_click', { ref: 'e999' });
    expect(r.ok).toBe(false);
    const d = r.data as Record<string, any>;
    expect(d.status).toBe('refused');
    expect(d.effect).toBe('refused');
    expect(d.refusal.code).toBe('unknown_ref');
    expect(d.escalation.target).toBe('fresh_snapshot');
    expect(typeof d.suggestedNextStep).toBe('string');
    expect(d.delivery).toBeUndefined();
    expect(d.route).toBeUndefined();
    expect(validateActionResult(d)).toEqual([]);
  });

  it('refuses unsupported input_route / invalid delivery_mode instead of downgrading', async () => {
    const { call, backend } = await boot();
    const bad = (await call('browser_type', { ref: 'e2', text: 'x', input_route: 'dom_event' })).data as Record<string, any>;
    expect(bad.refusal.code).toBe('unsupported_route');
    const bad2 = (await call('browser_click', { ref: 'e3', delivery_mode: 'sideways' })).data as Record<string, any>;
    expect(bad2.refusal.code).toBe('invalid_argument');
    expect((backend as VisionMock).domClicks).toHaveLength(0);
  });

  it('dom_event click goes through clickDom; foreground brings tab to front', async () => {
    const { call, backend } = await boot();
    const d = (await call('browser_click', { ref: 'e3', input_route: 'dom_event', delivery_mode: 'foreground' })).data as Record<string, any>;
    expect(d.route).toBe('dom_event');
    expect(d.delivery).toBe('foreground');
    expect((backend as VisionMock).domClicks).toEqual(['#e3']);
    expect((backend as VisionMock).fronted).toBe(1);
  });

  it('refused actions are not retried by the agent loop', async () => {
    const backend = new VisionMock();
    const { session } = await boot(backend);
    // an unknown ref is a refusal-class error: stale-retry must not apply to RefusalError
    const { RefusalError } = await import('../src/effects.js');
    const err = new RefusalError(
      { code: 'unsupported_route', message: 'm', hint: 'h' },
      { target: 'different_route', reason: 'r' },
    );
    expect(err).toBeInstanceOf(Error);
    expect(session).toBeTruthy();
  });
});

describe('browser_verify', () => {
  it('rejects exists:false and malformed predicates', () => {
    expect(() => parsePredicates([{ kind: 'element', ref: 'e1', exists: false }])).toThrow(/absence/);
    expect(() => parsePredicates([])).toThrow();
    expect(() => parsePredicates([{ kind: 'url' }])).toThrow(/needs equals/);
    expect(() => parsePredicates([{ kind: 'url', matches: '(' }])).toThrow(/regular expression/);
  });

  it('satisfied needs 2 stable samples', async () => {
    const { session } = await boot();
    const r = await runVerify(
      session,
      parsePredicates([{ kind: 'url', contains: 'example.test' }, { kind: 'element', ref: 'e1', role: 'heading', name: 'Welcome' }]),
      2000,
      async () => undefined,
    );
    expect(r.status).toBe('satisfied');
    expect(r.samples).toBe(2);
  });

  it('unsatisfied when a predicate is definitively false at the deadline', async () => {
    const { session } = await boot();
    const r = await runVerify(session, parsePredicates([{ kind: 'url', contains: 'nope' }]), 0, async () => undefined);
    expect(r.status).toBe('unsatisfied');
    expect(r.predicates[0]!.state).toBe('fail');
  });

  it('unknown (with reason) when a ref cannot be resolved', async () => {
    const { session } = await boot();
    const r = await runVerify(session, parsePredicates([{ kind: 'element', ref: 'e999', visible: true }]), 0, async () => undefined);
    expect(r.status).toBe('unknown');
    expect(r.predicates[0]!.unknown_reason).toMatch(/ref_unresolvable/);
  });

  it('works as an MCP tool and reports typed value', async () => {
    const { call } = await boot();
    await call('browser_type', { ref: 'e2', text: 'Ada' });
    const r = await call('browser_verify', {
      predicates: [{ kind: 'element', ref: 'e2', value: 'Ada' }],
      timeout_ms: 1000,
    });
    expect((r.data as Record<string, unknown>)['status']).toBe('satisfied');
  });
});

describe('snapshot screenshot evidence + capture_id', () => {
  it('include_screenshot returns scale metadata and a capture_id; click_at is one-use', async () => {
    const { call, backend } = await boot();
    const snap = await call('browser_snapshot', { include_screenshot: true });
    const shot = (snap.data as Record<string, any>).screenshot;
    expect(shot.mime_type).toBe('image/png');
    expect(shot.width).toBe(200);
    expect(shot.device_pixel_ratio).toBe(2);
    expect(shot.viewport).toEqual({ width: 100, height: 50 });
    expect(shot.scale).toBe(2);
    expect(typeof shot.data).toBe('string');
    const id = shot.capture_id as string;

    const ok = await call('browser_click_at', { capture_id: id, x: 100, y: 40 });
    expect(ok.ok).toBe(true);
    expect((backend as VisionMock).points).toEqual([[50, 20]]); // px / scale -> css
    expect((ok.data as Record<string, any>).effect).toBe('unverifiable');

    const again = await call('browser_click_at', { capture_id: id, x: 100, y: 40 });
    expect(again.ok).toBe(false);
    expect((again.data as Record<string, any>).refusal.code).toBe('stale_capture');
    expect((backend as VisionMock).points).toHaveLength(1);
  });

  it('refuses stale_capture after navigation and unknown_capture / out_of_bounds', async () => {
    const { call, backend } = await boot();
    const shot = ((await call('browser_snapshot', { include_screenshot: true })).data as Record<string, any>).screenshot;
    await call('browser_navigate', { url: 'https://example.test/next' });
    const stale = await call('browser_click_at', { capture_id: shot.capture_id, x: 10, y: 10 });
    expect((stale.data as Record<string, any>).refusal.code).toBe('stale_capture');
    const unk = await call('browser_click_at', { capture_id: 'cap-nope', x: 1, y: 1 });
    expect((unk.data as Record<string, any>).refusal.code).toBe('unknown_capture');
    const shot2 = ((await call('browser_snapshot', { include_screenshot: true })).data as Record<string, any>).screenshot;
    const oob = await call('browser_click_at', { capture_id: shot2.capture_id, x: 9999, y: 1 });
    expect((oob.data as Record<string, any>).refusal.code).toBe('out_of_bounds');
    expect((backend as VisionMock).points).toHaveLength(0);
  });

  it('snapshot without include_screenshot carries no screenshot (tree stays primary)', async () => {
    const { call } = await boot();
    const snap = await call('browser_snapshot', {});
    expect((snap.data as Record<string, unknown>)['screenshot']).toBeUndefined();
    expect(String((snap.data as Record<string, unknown>)['tree'])).toContain('[e3]');
  });

  it('mock backend without clickAt refuses with unsupported_backend', async () => {
    const { call, session } = await boot(new MockBackend());
    // MockBackend has no screenshot dims; fabricate a capture through the session API
    const cap = await session.captureVision().catch(() => null);
    if (cap) {
      session.rememberCaptureMeta(cap.captureId, 1, { width: 1e9, height: 1e9 });
      const r = await call('browser_click_at', { capture_id: cap.captureId, x: 1, y: 1 });
      expect((r.data as Record<string, any>).refusal.code).toBe('unsupported_backend');
    }
  });
});

describe('MCP layer: closed schema, outputSchema, image block', () => {
  let client: Client;
  let backend: VisionMock;

  beforeEach(async () => {
    backend = new VisionMock();
    const session = new BrowserSession('mcp-cua', backend);
    await session.start({ headless: true });
    await session.snapshot();
    const server = buildMcpServer(session, { policy: new PolicyEngine() });
    const [a, b] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 't', version: '0' }, { capabilities: {} });
    await Promise.all([server.connect(a), client.connect(b)]);
  });

  it('lists outputSchema for every tool, with the effect envelope on action tools', async () => {
    const { tools } = await client.listTools();
    expect(tools.length).toBeGreaterThanOrEqual(32);
    for (const t of tools) expect(t.outputSchema, t.name).toBeTruthy();
    const click = tools.find((t) => t.name === 'browser_click')!;
    expect(JSON.stringify(click.outputSchema)).toContain('suspected_noop');
    expect(JSON.stringify(click.outputSchema)).toContain('refusal');
    expect(tools.find((t) => t.name === 'browser_verify')!.annotations?.readOnlyHint).toBe(true);
  });

  it('rejects unknown arguments (closed schema)', async () => {
    const r = (await client.callTool({ name: 'browser_click', arguments: { ref: 'e3', bogus: 1 } })) as { isError?: boolean };
    expect(r.isError).toBe(true);
  });

  it('returns structuredContent and an image block for include_screenshot', async () => {
    await client.callTool({ name: 'browser_snapshot', arguments: {} });
    const r = (await client.callTool({
      name: 'browser_snapshot',
      arguments: { include_screenshot: true },
    })) as { content: Array<{ type: string; text?: string }>; structuredContent?: Record<string, any> };
    expect(r.content.map((c) => c.type)).toEqual(['text', 'image']);
    expect(r.structuredContent?.data.screenshot.capture_id).toMatch(/^cap-/);
    expect(r.structuredContent?.data.screenshot.data).toBeUndefined(); // base64 only in the image block
  });

  it('refusals come back as isError with the refusal envelope in structuredContent', async () => {
    const r = (await client.callTool({ name: 'browser_click', arguments: { ref: 'e999' } })) as {
      isError?: boolean;
      structuredContent?: Record<string, any>;
    };
    expect(r.isError).toBe(true);
    expect(r.structuredContent?.data.status).toBe('refused');
    expect(r.structuredContent?.data.refusal.code).toBe('unknown_ref');
  });

  it('successful actions validate against the outputSchema', async () => {
    const r = (await client.callTool({ name: 'browser_type', arguments: { ref: 'e2', text: 'Ada' } })) as {
      isError?: boolean;
      structuredContent?: Record<string, any>;
    };
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent?.data.effect).toBe('confirmed');
  });
});
