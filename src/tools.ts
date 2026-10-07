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
import { buildTree, renderTree } from './tree.js';
import { analyze } from './analyzer.js';
import type { McpToolDefinition, ToolResult } from './types.js';

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
          return { ok: false, error: (err as Error).message };
        }
      },
    });
  };

  register(
    'browser_navigate',
    'Navigate the browser session to a URL (http/https/file/data only).',
    {
      type: 'object',
      properties: { url: { type: 'string', description: 'URL to navigate to' } },
      required: ['url'],
    },
    async (args) => {
      const r = await session.navigate(str(args, 'url'));
      return { ok: true, data: r };
    },
  );

  register(
    'browser_snapshot',
    'Capture the current page: URL, title, and the interactable element tree with stable refs.',
    { type: 'object', properties: {} },
    async () => {
      const snap = await session.snapshot();
      const summary = analyze(snap);
      const tree = renderTree(buildTree(snap.nodes));
      return {
        ok: true,
        data: {
          url: snap.url,
          title: snap.title,
          capturedAt: snap.capturedAt,
          brief: summary.brief,
          countsByRole: summary.countsByRole,
          tree,
        },
      };
    },
  );

  register(
    'browser_click',
    'Click the element with the given ref from the latest snapshot.',
    {
      type: 'object',
      properties: { ref: { type: 'string', description: 'Element ref, e.g. "e3"' } },
      required: ['ref'],
    },
    async (args) => {
      await session.click(str(args, 'ref'));
      return { ok: true, data: { clicked: args['ref'] } };
    },
  );

  register(
    'browser_type',
    'Type text into the element with the given ref (input/textarea/contenteditable). Optionally press Enter after.',
    {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Element ref, e.g. "e5"' },
        text: { type: 'string', description: 'Text to type' },
        submit: { type: 'boolean', description: 'Press Enter after typing' },
      },
      required: ['ref', 'text'],
    },
    async (args) => {
      await session.type(str(args, 'ref'), str(args, 'text'), args['submit'] === true);
      return { ok: true, data: { typedInto: args['ref'] } };
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
    async () => ({ ok: true, data: await session.goBack() }),
  );

  register(
    'browser_forward',
    'Navigate forward in the active tab history.',
    { type: 'object', properties: {} },
    async () => ({ ok: true, data: await session.goForward() }),
  );

  register(
    'browser_reload',
    'Reload the active tab.',
    { type: 'object', properties: {} },
    async () => ({ ok: true, data: await session.reload() }),
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
      await session.dblclick(str(args, 'ref'));
      return { ok: true, data: { doubleClicked: args['ref'] } };
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
      await session.clear(str(args, 'ref'));
      return { ok: true, data: { cleared: args['ref'] } };
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
      await session.pressKey(str(args, 'key'));
      return { ok: true, data: { pressed: args['key'] } };
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
      await session.scrollBy(dx, dy);
      return { ok: true, data: { scrolledBy: { dx, dy } } };
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
      const selected = await session.selectOption(str(args, 'ref'), values as string[]);
      return { ok: true, data: { selected } };
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
      await session.setChecked(str(args, 'ref'), args['checked'] as boolean);
      return { ok: true, data: { ref: args['ref'], checked: args['checked'] } };
    },
  );

  register(
    'browser_wait_for',
    'Wait for a CSS selector to reach a state ("visible"|"hidden"|"attached").',
    {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector to wait for' },
        state: { type: 'string', description: 'visible (default), hidden, or attached' },
        timeoutMs: { type: 'number', description: 'Timeout in ms (default 10000)' },
      },
      required: ['selector'],
    },
    async (args) => {
      const state = args['state'];
      const s = state === undefined ? 'visible' : str(args, 'state', false) || 'visible';
      if (!['visible', 'hidden', 'attached'].includes(s)) throw new Error(`bad state "${s}"`);
      const timeoutMs =
        typeof args['timeoutMs'] === 'number' ? (args['timeoutMs'] as number) : 10_000;
      await session.waitForSelector(
        str(args, 'selector'),
        s as 'visible' | 'hidden' | 'attached',
        timeoutMs,
      );
      return { ok: true, data: { waitedFor: args['selector'], state: s } };
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
      const tree = renderTree(buildTree(snap.nodes));
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
