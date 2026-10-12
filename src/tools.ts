/**
 * tools.ts — the MCP tool registry exposed by the bridge.
 *
 * Tools: browser_navigate, browser_snapshot, browser_click, browser_type,
 *        browser_screenshot.
 *
 * Each definition carries a JSON-schema input so MCP clients can call the
 * bridge over the JSON-RPC transport in server.ts. Handlers are bound to a
 * BrowserSession; validation errors are returned as tool errors, never thrown
 * across the transport boundary unhandled.
 */
import type { BrowserSession } from './bridge-core.js';
import { ActionBlockedError } from './bridge-core.js';
import { buildTree, dialogSubtreeNodes, regionNodes, renderTree } from './tree.js';
import { analyze } from './analyzer.js';
import { verifyAction } from './agent/verifier.js';
import type { AgentAction, McpToolDefinition, ToolResult } from './types.js';
import {
  RefusalError,
  parseDelivery,
  parseRoute,
  refusalFromError,
  refusedData,
  validateActionResult,
  type DeliveryMode,
  type EffectCode,
  type EvidenceKind,
  type InputRoute,
} from './effects.js';
import { runVerify, parsePredicates } from './verify-tool.js';

export interface ToolHandler {
  definition: McpToolDefinition;
  handle: (args: Record<string, unknown>) => Promise<ToolResult>;
}

function str(args: Record<string, unknown>, key: string, required = true): string {
  const v = args[key];
  if (typeof v !== 'string' || v === '') {
    if (required) throw new Error(`missing required string argument "${key}"`);
    return '';
  }
  return v;
}

export function createToolRegistry(session: BrowserSession): Map<string, ToolHandler> {
  const registry = new Map<string, ToolHandler>();

  const register = (
    name: string,
    description: string,
    inputSchema: Record<string, unknown>,
    handle: (args: Record<string, unknown>) => Promise<ToolResult>,
  ): void => {
    registry.set(name, {
      definition: { name, description, inputSchema },
      handle: async (args) => {
        try {
          return await handle(args);
        } catch (err) {
          if (err instanceof ActionBlockedError) {
            // Structured refusal: the agent must see WHAT blocks it (active
            // modal) instead of a bare error string. Legacy fields stay.
            return {
              ok: false,
              error: err.message,
              data: refusedData(
                {
                  code: 'blocked_by_modal',
                  message: err.message,
                  hint: err.detail.suggestedNextStep,
                },
                {
                  target: 'user',
                  reason: 'a modal/dialog or overlay owns the page; dismissing it is an explicit, separate step',
                },
                {
                  blocked: true,
                  reason: err.reason,
                  modal: err.detail.modal,
                  occluder: err.detail.occluder,
                  suggestedNextStep: err.detail.suggestedNextStep,
                },
              ),
            };
          }
          const refusal = refusalFromError(err);
          if (refusal) {
            return {
              ok: false,
              error: refusal.refusal.message,
              data: refusedData(refusal.refusal, refusal.escalation, {
                suggestedNextStep: refusal.refusal.hint,
              }),
            };
          }
          return { ok: false, error: (err as Error).message };
        }
      },
    });
  };

  /**
   * Run a browser action, then verify its outcome against observable page
   * state. Distinguishes ACCEPTED (the browser API did not throw) from
   * VERIFIED (the expected user-visible state change actually happened):
   * { ok: true } + verification.verified=false means "dispatched but no
   * observed effect" — never reported as success.
   */
  const withVerification = async (
    action: AgentAction,
    preUrl: string,
    run: () => Promise<Record<string, unknown>>,
    meta: { route?: InputRoute; delivery?: DeliveryMode; noopIsUnverifiable?: boolean } = {},
  ): Promise<ToolResult> => {
    const data = await run();
    let verification;
    try {
      verification = await verifyAction(session, action, preUrl);
    } catch (err) {
      verification = {
        verified: false,
        method: 'error',
        detail: `verification errored: ${(err as Error).message}`,
      };
    }
    let effect: EffectCode = verification.effect ?? (verification.verified ? 'unverifiable' : 'unverifiable');
    let evidence: EvidenceKind | undefined = verification.evidence;
    // A raw coordinate click carries no element to read back: no change is not proof of a no-op.
    if (meta.noopIsUnverifiable && effect === 'suspected_noop') effect = 'unverifiable';
    if (effect === 'confirmed' && !evidence) effect = 'unverifiable';
    if (effect !== 'confirmed') evidence = undefined;
    const env: Record<string, unknown> = { effect };
    if (evidence) env['evidence'] = evidence;
    if (meta.route) env['route'] = meta.route;
    if (meta.delivery) env['delivery'] = meta.delivery;
    const violations = validateActionResult(env as never);
    if (violations.length > 0) {
      env['effect'] = 'unverifiable';
      delete env['evidence'];
      verification = { ...verification, detail: `${verification.detail} [envelope invariant: ${violations.join('; ')}]` };
    }
    return { ok: true, data: { ...data, ...env, accepted: true, verification } };
  };

  /**
   * Parse delivery_mode / input_route for an input tool, refuse (never
   * silently downgrade) when the backend cannot honor them, and apply
   * foreground delivery. dom_event is only offered where the backend has it.
   */
  const prepareInput = async (
    args: Record<string, unknown>,
    opts: { allowDomEvent: boolean },
  ): Promise<{ route: InputRoute; delivery: DeliveryMode }> => {
    const requested = parseRoute(args['input_route']);
    const delivery = parseDelivery(args['delivery_mode']);
    const caps = session.inputRoutes();
    const route: InputRoute = requested === 'auto' ? caps.default : requested;
    const supported = caps.routes.includes(route) && (route !== 'dom_event' || caps.default === 'dom_event' || opts.allowDomEvent);
    if (!supported) {
      throw new RefusalError(
        {
          code: 'unsupported_route',
          message: `input_route "${route}" is not available for this action on backend "${session.backendName}"`,
          hint: `Available here: ${caps.routes.join(', ')}. Omit input_route to use "${caps.default}".`,
        },
        { target: 'different_route', reason: 'requested input route not deliverable' },
      );
    }
    if (delivery === 'foreground') await session.bringToFront();
    return { route, delivery };
  };

  const ROUTE_PROPS = {
    delivery_mode: {
      type: 'string',
      description:
        '"background" (default: act without bringing the tab to the front) or "foreground" (bring the tab to the front first). Refused if unsupported.',
    },
    input_route: {
      type: 'string',
      description:
        '"auto" (default), "trusted" (real input events) or "dom_event" (synthetic DOM click; click only). Refused if the backend cannot deliver it.',
    },
  };

  register(
    'browser_navigate',
    'Navigate the browser session to a URL (http/https/file/data only). ' +
      'Refuses with a clear error on login walls: the bridge holds no credentials and never attempts to log in.',
    {
      type: 'object',
      properties: { url: { type: 'string', description: 'URL to navigate to' } },
      required: ['url'],
    },
    async (args) => {
      const url = str(args, 'url');
      const preUrl = session.url;
      return withVerification({ action: 'navigate', url }, preUrl, async () => {
        const r = await session.navigate(url);
        return { navigated: r.url, title: r.title };
      });
    },
  );

  register(
    'browser_snapshot',
    'Capture the current page: URL, title, and the interactable element tree with stable refs. ' +
      'Rendering is priority-ordered (active dialog controls and visible interactables first) so ' +
      'critical controls survive truncation; omitted nodes are counted honestly. ' +
      'Use dialogOnly for a blocking modal, region for a viewport rectangle, maxNodes to bound output.',
    {
      type: 'object',
      properties: {
        dialogOnly: {
          type: 'boolean',
          description: 'Render only the active dialog subtree (visible dialogs + descendants)',
        },
        region: {
          type: 'object',
          description: 'Render only nodes intersecting this viewport rectangle (CSS px)',
          properties: {
            x: { type: 'number' },
            y: { type: 'number' },
            width: { type: 'number' },
            height: { type: 'number' },
          },
          required: ['x', 'y', 'width', 'height'],
        },
        maxNodes: {
          type: 'number',
          description: 'Maximum rendered nodes (default 120)',
        },
        include_screenshot: {
          type: 'boolean',
          description:
            'Also capture a PNG as verification EVIDENCE (with scale metadata and a one-use capture_id for browser_click_at). The element tree stays the primary way to see and act.',
        },
      },
    },
    async (args) => {
      const snap = await session.snapshot();
      const summary = analyze(snap);
      let nodes = snap.nodes;
      let scopeNote = '';
      if (args['dialogOnly'] === true) {
        nodes = dialogSubtreeNodes(nodes);
        scopeNote = 'dialog-scoped';
      }
      const region = args['region'];
      if (region && typeof region === 'object') {
        const r = region as Record<string, unknown>;
        if (
          typeof r['x'] === 'number' &&
          typeof r['y'] === 'number' &&
          typeof r['width'] === 'number' &&
          typeof r['height'] === 'number'
        ) {
          nodes = regionNodes(nodes, {
            x: r['x'] as number,
            y: r['y'] as number,
            width: r['width'] as number,
            height: r['height'] as number,
          });
          scopeNote = scopeNote ? `${scopeNote}+region` : 'region-scoped';
        }
      }
      const maxNodes =
        typeof args['maxNodes'] === 'number' && (args['maxNodes'] as number) > 0
          ? Math.min(Math.floor(args['maxNodes'] as number), 2000)
          : 120;
      const tree = renderTree(buildTree(nodes), 6, maxNodes, { prioritize: true });
      let screenshot: Record<string, unknown> | undefined;
      if (args['include_screenshot'] === true) {
        const cap = await session.captureVision();
        session.rememberCaptureMeta(cap.captureId, cap.scale, cap.viewport);
        screenshot = {
          capture_id: cap.captureId,
          mime_type: 'image/png',
          encoding: 'base64',
          width: cap.pngWidth,
          height: cap.pngHeight,
          viewport: cap.viewport,
          device_pixel_ratio: cap.devicePixelRatio,
          scale: cap.scale,
          coordinate_note:
            'x/y for browser_click_at are screenshot pixels; css = pixel / scale. Evidence aid only: prefer element refs.',
          data: cap.png.toString('base64'),
        };
      }
      return {
        ok: true,
        data: {
          url: snap.url,
          title: snap.title,
          capturedAt: snap.capturedAt,
          brief: summary.brief,
          countsByRole: summary.countsByRole,
          nodeCount: nodes.length,
          scope: scopeNote || 'full-page',
          tree,
          ...(screenshot ? { screenshot } : {}),
        },
      };
    },
  );

  register(
    'browser_click',
    'Click the element with the given ref from the latest snapshot. ' +
      'The result distinguishes accepted (dispatched without error) from verified ' +
      '(an observable page effect was seen) — accepted without verified is NOT success.',
    {
      type: 'object',
      properties: { ref: { type: 'string', description: 'Element ref, e.g. "e3"' }, ...ROUTE_PROPS },
      required: ['ref'],
    },
    async (args) => {
      const ref = str(args, 'ref');
      const meta = await prepareInput(args, { allowDomEvent: true });
      const preUrl = session.url;
      return withVerification(
        { action: 'click', ref },
        preUrl,
        async () => {
          await session.clickVia(ref, meta.route);
          return { clicked: ref };
        },
        meta,
      );
    },
  );

  register(
    'browser_type',
    'Type text into the element with the given ref (input/textarea/contenteditable). Optionally press Enter after. ' +
      'The result distinguishes accepted from verified — check verification.verified.',
    {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Element ref, e.g. "e5"' },
        text: { type: 'string', description: 'Text to type' },
        submit: { type: 'boolean', description: 'Press Enter after typing' },
        ...ROUTE_PROPS,
      },
      required: ['ref', 'text'],
    },
    async (args) => {
      const ref = str(args, 'ref');
      const text = str(args, 'text');
      const submit = args['submit'] === true;
      const meta = await prepareInput(args, { allowDomEvent: false });
      const preUrl = session.url;
      return withVerification(
        { action: 'type', ref, text, submit },
        preUrl,
        async () => {
          await session.type(ref, text, submit);
          return { typedInto: ref };
        },
        meta,
      );
    },
  );

  register(
    'browser_verify',
    'Check agent-declared postconditions against live page state. Predicates (1-8): ' +
      '{kind:"url", equals|contains|matches}, {kind:"title", equals|contains}, ' +
      '{kind:"element", ref, role?, name?, name_contains?, value?, value_contains?, checked?, visible?}. ' +
      'Polls every 100ms up to timeout_ms (default 5000, max 10000); "satisfied" needs 2 consecutive passing samples. ' +
      'Result: satisfied | unsatisfied | unknown (with per-predicate unknown_reason). ' +
      'Absence (exists:false) is rejected - it cannot be proven from a ref.',
    {
      type: 'object',
      properties: {
        predicates: {
          type: 'array',
          description: '1-8 predicate objects',
          items: {
            type: 'object',
            properties: {
              kind: { type: 'string', description: '"url", "title" or "element"' },
              ref: { type: 'string' },
              equals: { type: 'string' },
              contains: { type: 'string' },
              matches: { type: 'string', description: 'Regular expression (url only)' },
              role: { type: 'string' },
              name: { type: 'string' },
              name_contains: { type: 'string' },
              value: { type: 'string' },
              value_contains: { type: 'string' },
              checked: { type: 'boolean' },
              visible: { type: 'boolean' },
              exists: { type: 'boolean', description: 'Only true is accepted' },
            },
            required: ['kind'],
          },
        },
        timeout_ms: { type: 'number', description: 'Max polling time in ms (default 5000, max 10000)' },
      },
      required: ['predicates'],
    },
    async (args) => {
      const preds = parsePredicates(args['predicates']);
      const timeout =
        typeof args['timeout_ms'] === 'number' && (args['timeout_ms'] as number) > 0
          ? Math.min(args['timeout_ms'] as number, 10_000)
          : 5_000;
      const r = await runVerify(session, preds, timeout);
      return { ok: true, data: r as unknown as Record<string, unknown> };
    },
  );

  register(
    'browser_click_at',
    'Raw coordinate click bound to a screenshot capture (one-use capture_id from browser_snapshot include_screenshot). ' +
      'x/y are screenshot pixels. Refused when the capture is stale (page navigated), already used, or unknown. ' +
      'Last resort: prefer browser_click with an element ref.',
    {
      type: 'object',
      properties: {
        capture_id: { type: 'string', description: 'capture_id from browser_snapshot include_screenshot=true' },
        x: { type: 'number', description: 'X in screenshot pixels' },
        y: { type: 'number', description: 'Y in screenshot pixels' },
        delivery_mode: ROUTE_PROPS.delivery_mode,
      },
      required: ['capture_id', 'x', 'y'],
    },
    async (args) => {
      const captureId = str(args, 'capture_id');
      const x = args['x'];
      const y = args['y'];
      if (typeof x !== 'number' || typeof y !== 'number') throw new Error('"x" and "y" must be numbers');
      const delivery = parseDelivery(args['delivery_mode']);
      session.capturePointToCss(captureId, x, y); // refuse early, before foregrounding
      if (delivery === 'foreground') await session.bringToFront();
      const preUrl = session.url;
      return withVerification(
        { action: 'click' },
        preUrl,
        async () => {
          const p = await session.clickAtCapture(captureId, x, y);
          return { clickedAt: { x, y, cssX: p.cssX, cssY: p.cssY } };
        },
        { route: 'trusted_input', delivery, noopIsUnverifiable: true },
      );
    },
  );

  register(
    'browser_screenshot',
    'Take a PNG screenshot of the current viewport and save it to a local path.',
    {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Local file path for the PNG' },
      },
      required: ['path'],
    },
    async (args) => {
      const r = await session.screenshot(str(args, 'path'));
      return { ok: true, data: r };
    },
  );

  register(
    'browser_back',
    'Navigate back in the active tab history.',
    { type: 'object', properties: {} },
    async () => {
      const preUrl = session.url;
      return withVerification({ action: 'back' }, preUrl, async () => {
        const r = await session.goBack();
        return { url: r.url };
      });
    },
  );

  register(
    'browser_forward',
    'Navigate forward in the active tab history.',
    { type: 'object', properties: {} },
    async () => {
      const preUrl = session.url;
      return withVerification({ action: 'forward' }, preUrl, async () => {
        const r = await session.goForward();
        return { url: r.url };
      });
    },
  );

  register(
    'browser_reload',
    'Reload the active tab.',
    { type: 'object', properties: {} },
    async () => {
      const preUrl = session.url;
      return withVerification({ action: 'reload' }, preUrl, async () => {
        const r = await session.reload();
        return { url: r.url };
      });
    },
  );

  register(
    'browser_tabs',
    'List all tabs known to this session (id, url, title, active).',
    { type: 'object', properties: {} },
    async () => ({ ok: true, data: { tabs: await session.listTabs() } }),
  );

  register(
    'browser_open_tab',
    'Open a new tab (optionally navigating to a URL) and switch to it.',
    {
      type: 'object',
      properties: { url: { type: 'string', description: 'Optional URL to open' } },
    },
    async (args) => {
      const url = args['url'];
      return {
        ok: true,
        data: await session.openTab(typeof url === 'string' && url ? url : undefined),
      };
    },
  );

  register(
    'browser_switch_tab',
    'Switch the session to the tab with the given id (see browser_tabs).',
    {
      type: 'object',
      properties: { tabId: { type: 'string', description: 'Tab id, e.g. "tab-1"' } },
      required: ['tabId'],
    },
    async (args) => ({ ok: true, data: await session.switchTab(str(args, 'tabId')) }),
  );

  register(
    'browser_close_tab',
    'Close the tab with the given id. Refuses to close the last tab.',
    {
      type: 'object',
      properties: { tabId: { type: 'string', description: 'Tab id, e.g. "tab-2"' } },
      required: ['tabId'],
    },
    async (args) => {
      await session.closeTab(str(args, 'tabId'));
      return { ok: true, data: { closed: args['tabId'] } };
    },
  );

  register(
    'browser_status',
    'Show the session connection state: backend, user-browser vs isolated, current URL, last snapshot.',
    { type: 'object', properties: {} },
    async () => ({
      ok: true,
      data: {
        sessionId: session.id,
        backend: session.backendName,
        userBrowser: session.isUserBrowser,
        url: session.url,
        lastSnapshotId: session.lastSnapshotId,
        tabs: await session.listTabs(),
      },
    }),
  );

  register(
    'browser_double_click',
    'Double-click the element with the given ref.',
    {
      type: 'object',
      properties: { ref: { type: 'string', description: 'Element ref, e.g. "e3"' } },
      required: ['ref'],
    },
    async (args) => {
      const ref = str(args, 'ref');
      const preUrl = session.url;
      return withVerification({ action: 'double_click', ref }, preUrl, async () => {
        await session.dblclick(ref);
        return { doubleClicked: ref };
      });
    },
  );

  register(
    'browser_clear',
    'Clear the editable field with the given ref.',
    {
      type: 'object',
      properties: { ref: { type: 'string', description: 'Element ref, e.g. "e3"' } },
      required: ['ref'],
    },
    async (args) => {
      const ref = str(args, 'ref');
      const preUrl = session.url;
      return withVerification({ action: 'clear', ref }, preUrl, async () => {
        await session.clear(ref);
        return { cleared: ref };
      });
    },
  );

  register(
    'browser_press_key',
    'Press a keyboard key (e.g. "Enter", "Escape", "Tab", "ArrowDown") on the active page.',
    {
      type: 'object',
      properties: { key: { type: 'string', description: 'Key name, e.g. "Enter"' } },
      required: ['key'],
    },
    async (args) => {
      const key = str(args, 'key');
      const preUrl = session.url;
      return withVerification({ action: 'press_key', key }, preUrl, async () => {
        await session.pressKey(key);
        return { pressed: key };
      });
    },
  );

  register(
    'browser_hover',
    'Hover the pointer over the element with the given ref.',
    {
      type: 'object',
      properties: { ref: { type: 'string', description: 'Element ref, e.g. "e3"' } },
      required: ['ref'],
    },
    async (args) => {
      await session.hover(str(args, 'ref'));
      return { ok: true, data: { hovered: args['ref'] } };
    },
  );

  register(
    'browser_focus',
    'Move keyboard focus to the element with the given ref.',
    {
      type: 'object',
      properties: { ref: { type: 'string', description: 'Element ref, e.g. "e3"' } },
      required: ['ref'],
    },
    async (args) => {
      await session.focus(str(args, 'ref'));
      return { ok: true, data: { focused: args['ref'] } };
    },
  );

  register(
    'browser_scroll_into_view',
    'Scroll the element with the given ref into the viewport.',
    {
      type: 'object',
      properties: { ref: { type: 'string', description: 'Element ref, e.g. "e3"' } },
      required: ['ref'],
    },
    async (args) => {
      await session.scrollIntoView(str(args, 'ref'));
      return { ok: true, data: { scrolledTo: args['ref'] } };
    },
  );

  register(
    'browser_scroll',
    'Scroll the viewport by dx/dy pixels (negative scrolls up/left).',
    {
      type: 'object',
      properties: {
        dx: { type: 'number', description: 'Horizontal pixels' },
        dy: { type: 'number', description: 'Vertical pixels' },
      },
    },
    async (args) => {
      const dx = typeof args['dx'] === 'number' ? args['dx'] : 0;
      const dy = typeof args['dy'] === 'number' ? args['dy'] : 0;
      const preUrl = session.url;
      return withVerification({ action: 'scroll', dx, dy }, preUrl, async () => {
        await session.scrollBy(dx, dy);
        return { scrolledBy: { dx, dy } };
      });
    },
  );

  register(
    'browser_select_option',
    'Select option(s) in a <select> element by value.',
    {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Element ref of the select' },
        values: { type: 'array', items: { type: 'string' }, description: 'Option values to select' },
      },
      required: ['ref', 'values'],
    },
    async (args) => {
      const values = args['values'];
      if (!Array.isArray(values) || !values.every((v) => typeof v === 'string')) {
        throw new Error('"values" must be an array of strings');
      }
      const ref = str(args, 'ref');
      const vals = values as string[];
      const preUrl = session.url;
      return withVerification({ action: 'select_option', ref, values: vals }, preUrl, async () => {
        const selected = await session.selectOption(ref, vals);
        return { selected };
      });
    },
  );

  register(
    'browser_check',
    'Check or uncheck a checkbox / radio / switch element.',
    {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Element ref' },
        checked: { type: 'boolean', description: 'Desired checked state' },
      },
      required: ['ref', 'checked'],
    },
    async (args) => {
      if (typeof args['checked'] !== 'boolean') throw new Error('"checked" must be a boolean');
      const ref = str(args, 'ref');
      const checked = args['checked'] as boolean;
      const preUrl = session.url;
      return withVerification({ action: 'check', ref, checked }, preUrl, async () => {
        await session.setChecked(ref, checked);
        return { ref, checked };
      });
    },
  );

  register(
    'browser_wait_for',
    'Wait for a CSS selector to reach a state ("visible"|"hidden"|"attached"). ' +
      'A generic wait means "the selector currently exists" — it does NOT prove a navigation or ' +
      'task completed. Pass expectNewDocument=true after an action that should navigate: the wait ' +
      'then requires the document to change first, so a selector left over on the old page cannot ' +
      'falsely satisfy it.',
    {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector to wait for' },
        state: { type: 'string', description: 'visible (default), hidden, or attached' },
        timeoutMs: { type: 'number', description: 'Timeout in ms (default 10000)' },
        expectNewDocument: {
          type: 'boolean',
          description:
            'Require the document (URL or document load id) to change before the selector is evaluated',
        },
      },
      required: ['selector'],
    },
    async (args) => {
      const state = args['state'];
      const s = state === undefined ? 'visible' : str(args, 'state', false) || 'visible';
      if (!['visible', 'hidden', 'attached'].includes(s)) throw new Error(`bad state "${s}"`);
      const timeoutMs =
        typeof args['timeoutMs'] === 'number' ? (args['timeoutMs'] as number) : 10_000;
      const expectNewDocument = args['expectNewDocument'] === true;
      await session.waitForSelector(str(args, 'selector'), s as 'visible' | 'hidden' | 'attached', timeoutMs, {
        awaitNewDocument: expectNewDocument,
      });
      return { ok: true, data: { waitedFor: args['selector'], state: s, expectNewDocument } };
    },
  );

  register(
    'browser_get_text',
    'Extract visible text: whole page, or one element when ref is given.',
    {
      type: 'object',
      properties: { ref: { type: 'string', description: 'Optional element ref' } },
    },
    async (args) => {
      const ref = args['ref'];
      const text = await session.pageText(typeof ref === 'string' && ref ? ref : undefined);
      return { ok: true, data: { text } };
    },
  );

  register(
    'browser_page_info',
    'URL, title, and meta description of the active page.',
    { type: 'object', properties: {} },
    async () => ({ ok: true, data: await session.pageInfo() }),
  );

  register(
    'browser_frames',
    'List iframes in the active page (id, url, name).',
    { type: 'object', properties: {} },
    async () => ({ ok: true, data: { frames: await session.listFrames() } }),
  );

  register(
    'browser_frame_snapshot',
    'Snapshot the DOM inside one iframe; returned refs are frame-scoped and usable by the other tools.',
    {
      type: 'object',
      properties: { frameId: { type: 'string', description: 'Frame id, e.g. "frame-1"' } },
      required: ['frameId'],
    },
    async (args) => {
      const snap = await session.frameSnapshot(str(args, 'frameId'));
      const summary = analyze(snap);
      const tree = renderTree(buildTree(snap.nodes), 6, 120, { prioritize: true });
      return {
        ok: true,
        data: {
          url: snap.url,
          title: snap.title,
          capturedAt: snap.capturedAt,
          snapshotId: snap.snapshotId,
          brief: summary.brief,
          tree,
        },
      };
    },
  );

  register(
    'browser_upload',
    'Upload a local file through a file input. The path must be absolute and exist; the policy layer must approve uploads first.',
    {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Element ref of the file input' },
        filePath: { type: 'string', description: 'Absolute local path of the file to upload' },
      },
      required: ['ref', 'filePath'],
    },
    async (args) => {
      const r = await session.uploadFile(str(args, 'ref'), str(args, 'filePath'));
      return { ok: true, data: r };
    },
  );

  register(
    'browser_downloads',
    'List downloads tracked by this session (saved inside the bridge download dir).',
    {
      type: 'object',
      properties: {
        consume: { type: 'boolean', description: 'Clear the list after reading (default true)' },
      },
    },
    async (args) => {
      const consume = args['consume'] === undefined ? true : args['consume'] === true;
      return { ok: true, data: { downloads: await session.recentDownloads(consume) } };
    },
  );

  register(
    'browser_wait_for_download',
    'Wait for the next download to complete and report where it was saved.',
    {
      type: 'object',
      properties: {
        timeoutMs: { type: 'number', description: 'Timeout in ms (default 30000)' },
      },
    },
    async (args) => {
      const timeoutMs =
        typeof args['timeoutMs'] === 'number' ? (args['timeoutMs'] as number) : 30_000;
      return { ok: true, data: await session.waitForDownload(timeoutMs) };
    },
  );

  return registry;
}

export function listToolDefinitions(
  registry: Map<string, ToolHandler>,
): McpToolDefinition[] {
  return [...registry.values()].map((h) => h.definition);
}
