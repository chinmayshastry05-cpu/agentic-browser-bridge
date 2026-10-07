/**
 * mcp/server.ts — a real Model Context Protocol server for the bridge.
 *
 * Exposes every tool from the bridge tool registry (src/tools.ts) as an MCP
 * tool, over two transports:
 *   - stdio            (local MCP clients: Claude Code, editors, ...)
 *   - Streamable HTTP  (remote clients incl. ChatGPT developer mode)
 *
 * Security properties (non-negotiable):
 *  - Every tool call is routed through the SAME PolicyEngine as the local
 *    agent loop (allow / confirm / deny). A "confirm" verdict becomes an
 *    MCP error — MCP clients cannot approve interactively in v1, so gated
 *    actions stay gated instead of silently proceeding.
 *  - Unapproved file uploads are refused (the operator approves paths via
 *    the bridge CLI/UI first).
 *  - The HTTP transport binds 127.0.0.1 by default. A bearer token is
 *    REQUIRED when bound to a non-loopback address or when --public is
 *    passed. Token source: ABB_MCP_TOKEN env, else a generated token that
 *    is printed ONCE to stderr and never logged or committed.
 *  - Nothing here phones home; no secrets are written to the repo.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { BrowserSession } from '../bridge-core.js';
import { createToolRegistry } from '../tools.js';
import { PolicyEngine, type PolicyContext } from '../security/policy.js';
import type { AgentAction } from '../types.js';

/** Default port for the MCP Streamable-HTTP transport (bridge HTTP: 8931, extension relay: 8932). */
export const DEFAULT_MCP_HTTP_PORT = 8933;

function errText(text: string): {
  content: Array<{ type: 'text'; text: string }>;
  isError: true;
} {
  return { content: [{ type: 'text' as const, text }], isError: true as const };
}

function strArg(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === 'string' && v ? v : undefined;
}

/**
 * Map an MCP tool call to the closest AgentAction so the shared
 * PolicyEngine classifies it exactly as it would for the local agent loop.
 * Read-only / reversible tools map to low-risk actions; the verdict is what
 * matters, and low-risk tools are always allowed.
 */
function toolToAction(name: string, args: Record<string, unknown>): AgentAction {
  const ref = strArg(args, 'ref');
  switch (name) {
    case 'browser_navigate':
      return { action: 'navigate', url: strArg(args, 'url') };
    case 'browser_back':
      return { action: 'back' };
    case 'browser_forward':
      return { action: 'forward' };
    case 'browser_reload':
      return { action: 'reload' };
    case 'browser_click':
      return { action: 'click', ref };
    case 'browser_double_click':
      return { action: 'double_click', ref };
    case 'browser_type': {
      const a: AgentAction = { action: 'type', ref };
      const t = strArg(args, 'text');
      if (t !== undefined) a.text = t;
      if (args['submit'] === true) a.submit = true;
      return a;
    }
    case 'browser_clear':
      return { action: 'clear', ref };
    case 'browser_press_key':
      return { action: 'press_key', key: strArg(args, 'key') };
    case 'browser_select_option':
      return { action: 'select_option', ref, values: Array.isArray(args['values']) ? (args['values'] as string[]) : [] };
    case 'browser_check':
      return { action: 'check', ref, checked: args['checked'] === true };
    case 'browser_wait_for':
      return { action: 'wait_for', selector: strArg(args, 'selector') };
    case 'browser_scroll':
      return {
        action: 'scroll',
        dx: typeof args['dx'] === 'number' ? args['dx'] : 0,
        dy: typeof args['dy'] === 'number' ? args['dy'] : 0,
      };
    case 'browser_upload':
      // Uploads are gated separately via PolicyEngine.isUploadApproved.
      return { action: 'type', ref };
    default:
      // snapshot, screenshot, get_text, page_info, tabs, frames, status,
      // downloads, hover, focus, scroll_into_view: low-risk reads.
      return { action: 'snapshot' };
  }
}

/**
 * Convert one of the bridge's plain JSON Schemas to a Zod object. The MCP
 * SDK only accepts Zod schemas (it throws on plain JSON Schema), so this
 * adapter preserves the registry's validation semantics (types, required,
 * descriptions) in Zod form. Unknown/unsupported shapes become z.unknown().
 */
export function jsonSchemaToZod(schema: Record<string, unknown>): z.ZodTypeAny {
  const desc = typeof schema['description'] === 'string' ? schema['description'] : undefined;
  const t = schema['type'];
  let base: z.ZodTypeAny;
  if (t === 'string') {
    base = z.string();
  } else if (t === 'number' || t === 'integer') {
    base = z.number();
  } else if (t === 'boolean') {
    base = z.boolean();
  } else if (t === 'array') {
    const items = schema['items'];
    base = z.array(
      items && typeof items === 'object'
        ? jsonSchemaToZod(items as Record<string, unknown>)
        : z.unknown(),
    );
  } else if (t === 'object' || schema['properties']) {
    const props = (schema['properties'] ?? {}) as Record<string, Record<string, unknown>>;
    const required = new Set(
      Array.isArray(schema['required']) ? (schema['required'] as unknown[]).filter((r): r is string => typeof r === 'string') : [],
    );
    const shape: Record<string, z.ZodTypeAny> = {};
    for (const [k, v] of Object.entries(props)) {
      const field = jsonSchemaToZod(v);
      shape[k] = required.has(k) ? field : field.optional();
    }
    base = z.object(shape);
  } else {
    base = z.unknown();
  }
  return desc ? base.describe(desc) : base;
}

export interface McpServerBuildOptions {
  policy?: PolicyEngine;
  serverName?: string;
  serverVersion?: string;
}

/** Build an MCP server whose tools are the bridge registry, policy-gated. */
export function buildMcpServer(
  session: BrowserSession,
  opts: McpServerBuildOptions = {},
): McpServer {
  const server = new McpServer({
    name: opts.serverName ?? 'agentic-browser-bridge',
    version: opts.serverVersion ?? '0.1.0',
  });
  const policy = opts.policy ?? new PolicyEngine();
  const registry = createToolRegistry(session);

  for (const [name, handler] of registry) {
    server.registerTool(
      name,
      {
        description: handler.definition.description,
        inputSchema: jsonSchemaToZod(handler.definition.inputSchema),
      },
      async (args: unknown) => {
        // The SDK validates args against the Zod schema before we run; narrow
        // for the registry, which takes Record<string, unknown>.
        const a: Record<string, unknown> =
          args && typeof args === 'object' ? (args as Record<string, unknown>) : {};
        const action = toolToAction(name, a);
        const ctx: PolicyContext = { url: session.url };
        if (action.ref) {
          const live = await session.describeLiveTarget(action.ref).catch(() => null);
          if (live) {
            ctx.inputType = live.inputType;
            ctx.targetRole = live.role;
          }
        }
        if (name === 'browser_upload') {
          const fp = strArg(a, 'filePath');
          if (!fp || !policy.isUploadApproved(fp)) {
            return errText(
              `upload of "${fp ?? '(missing path)'}" requires operator approval first ` +
                `(PolicyEngine gate kept intact over MCP). Approve via the bridge UI or CLI; ` +
                `MCP clients cannot approve interactively.`,
            );
          }
        }
        const decision = policy.decide(action, ctx);
        if (decision.verdict === 'deny') {
          return errText(`denied by policy: ${decision.reason}`);
        }
        if (decision.verdict === 'confirm') {
          return errText(
            `requires human confirmation (${decision.reason}). MCP clients cannot ` +
              `approve interactively in v1 — approve via the bridge UI or ` +
              `"node dist/index.js approve", then retry.`,
          );
        }
        const result = await handler.handle(a);
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(result) }],
          isError: !result.ok,
        };
      },
    );
  }
  return server;
}

export interface McpServeOptions {
  transport: 'stdio' | 'http';
  /** HTTP only. Defaults to 127.0.0.1 — never expose browser control otherwise. */
  host?: string;
  /** HTTP only. Default 8933. */
  port?: number;
  /** HTTP only: require bearer auth even on loopback. */
  public?: boolean;
  /** Explicit bearer token; else ABB_MCP_TOKEN; else generated once. */
  token?: string;
}

export interface McpServeHandle {
  close(): Promise<void>;
  /** The bearer token when auth is required, else null. */
  token: string | null;
  /** HTTP endpoint URL when transport is http. */
  url?: string;
}

function isLoopback(host: string): boolean {
  const h = host.toLowerCase();
  return h === '127.0.0.1' || h === 'localhost' || h === '::1';
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c as Buffer));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * Start the MCP server on the requested transport. For HTTP, bearer auth is
 * REQUIRED unless bound to loopback without --public. A generated token is
 * printed exactly once to stderr and never logged again.
 */
export async function startMcpServer(
  server: McpServer,
  opts: McpServeOptions,
): Promise<McpServeHandle> {
  if (opts.transport === 'stdio') {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    return {
      token: null,
      close: async () => {
        await transport.close().catch(() => undefined);
        await server.close().catch(() => undefined);
      },
    };
  }

  const host = opts.host ?? '127.0.0.1';
  const port = opts.port ?? DEFAULT_MCP_HTTP_PORT;
  const needAuth = !isLoopback(host) || opts.public === true;
  let token: string | null = opts.token ?? process.env['ABB_MCP_TOKEN'] ?? null;
  if (needAuth && !token) {
    token = randomBytes(32).toString('hex');
    // Printed exactly once; never logged again, never committed.
    process.stderr.write(
      `[agentic-browser-bridge] generated MCP bearer token (shown once, not stored): ${token}\n`,
    );
  }

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
  });
  await server.connect(transport);

  const httpServer = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname !== '/mcp') {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('not found');
        return;
      }
      if (needAuth) {
        const auth = req.headers.authorization ?? '';
        if (auth !== `Bearer ${token}`) {
          res.writeHead(401, { 'content-type': 'text/plain' });
          res.end('unauthorized: valid bearer token required');
          return;
        }
      }
      let body: unknown;
      if (req.method === 'POST') {
        try {
          body = JSON.parse(await readBody(req));
        } catch {
          res.writeHead(400, { 'content-type': 'text/plain' });
          res.end('invalid JSON');
          return;
        }
      }
      await transport.handleRequest(req as never, res as never, body);
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'text/plain' });
        res.end('internal error');
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, host, () => resolve());
  });
  const addr = httpServer.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : port;

  return {
    token: needAuth ? token : null,
    url: `http://${host}:${actualPort}/mcp`,
    close: async () => {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      await transport.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    },
  };
}
