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

  return registry;
}

export function listToolDefinitions(
  registry: Map<string, ToolHandler>,
): McpToolDefinition[] {
  return [...registry.values()].map((h) => h.definition);
}
