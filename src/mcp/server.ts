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
 *    agent loop (allow / confirm / deny). A "confirm" verdict registers a
 *    real confirmation ticket (ConfirmationQueue, shared file-backed store
 *    with the CLI/UI): the error names the ticket id, the operator approves
 *    with `node dist/index.js approve <id> --yes` or the bridge UI "Pending
 *    confirmations", and the retried MCP call proceeds. Gated actions stay
 *    gated instead of silently proceeding.
 *  - Unapproved file uploads are refused. The ONLY upload-approval path over
 *    MCP is the operator allowlist: ABB_UPLOAD_ALLOWLIST env (comma-separated
 *    absolute paths), read at server startup. The block message says exactly
 *    this — there is no UI/CLI upload approval to promise.
 *  - The HTTP transport binds 127.0.0.1 by default. Auth is REQUIRED on
 *    /mcp when bound to a non-loopback address or when --public is passed,
 *    via EITHER the static operator bearer token (ABB_MCP_TOKEN env,
 *    explicit --token, or a generated token printed ONCE to stderr) OR a
 *    token issued by the built-in OAuth 2.0 authorization server
 *    (src/mcp/oauth.ts: authorization code + PKCE S256, operator-gated by
 *    a pairing code). This exists because ChatGPT's custom-MCP setup offers
 *    only OAuth — no bearer/API-key field — so OAuth is the only path for
 *    ChatGPT. Unauthenticated browser control is never allowed: clients
 *    that select "no authentication" still get 401.
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
import { ConfirmationQueue, type PendingConfirmation } from '../security/confirm.js';
import type { AgentAction } from '../types.js';
import { OAuthProvider, OAuthError } from './oauth.js';

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
  /**
   * Confirmation ticket queue. The MCP path registers a PendingConfirmation
   * on "confirm" verdicts and honors operator approvals on retry, so the
   * approval instructions in error messages are real, not aspirational.
   * File-backed and shared with the CLI/UI by default.
   */
  confirmations?: ConfirmationQueue;
  /**
   * Absolute local file paths pre-approved for browser_upload. Defaults to
   * the ABB_UPLOAD_ALLOWLIST env var (comma-separated). This is the ONLY
   * upload-approval path over MCP — the error message says exactly this.
   */
  uploadAllowlist?: string[];
}

/**
 * Resolve the upload allowlist: explicit option, else ABB_UPLOAD_ALLOWLIST
 * (comma-separated absolute paths). Relative entries are ignored.
 */
function resolveUploadAllowlist(explicit?: string[]): string[] {
  const raw = explicit ?? (process.env['ABB_UPLOAD_ALLOWLIST'] ?? '').split(',');
  return raw.map((p) => p.trim()).filter((p) => p.startsWith('/'));
}

/** True when two actions are the same approvable unit (mirrors ConfirmationQueue.isApproved). */
function sameAction(a: AgentAction, b: AgentAction): boolean {
  return a.action === b.action && a.ref === b.ref && a.url === b.url;
}

/**
 * Honest MCP tool annotations per tool. Read-only tools (snapshot,
 * screenshot, get_text, ...) are read-only + idempotent; hover/focus/
 * scroll_into_view mutate page state mildly but reversibly; navigation and
 * input actions are neither read-only nor idempotent; close_tab destroys a
 * tab, so it is flagged destructive.
 */
const TOOL_ANNOTATIONS: Record<
  string,
  { readOnlyHint: boolean; destructiveHint: boolean; idempotentHint: boolean }
> = {
  // Read-only reads.
  browser_snapshot: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  browser_screenshot: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  browser_get_text: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  browser_page_info: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  browser_tabs: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  browser_frames: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  browser_frame_snapshot: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  browser_status: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  browser_downloads: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  browser_wait_for_download: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
  // Reversible, idempotent state changes (no data loss, safe to repeat).
  browser_hover: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  browser_focus: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  browser_scroll_into_view: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  // State-changing and NOT idempotent (navigation, input, tab management).
  browser_navigate: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  browser_back: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  browser_forward: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  browser_reload: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  browser_click: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  browser_double_click: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  browser_type: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  browser_clear: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  browser_press_key: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  browser_select_option: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  browser_check: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  browser_open_tab: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  browser_switch_tab: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  browser_scroll: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  browser_wait_for: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  browser_upload: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  // Destroys a tab.
  browser_close_tab: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
};

/** Conservative fallback for any tool missing from the map above. */
const DEFAULT_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
};

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
  const confirmations = opts.confirmations ?? new ConfirmationQueue();
  for (const p of resolveUploadAllowlist(opts.uploadAllowlist)) policy.approveUpload(p);
  const registry = createToolRegistry(session);

  for (const [name, handler] of registry) {
    server.registerTool(
      name,
      {
        description: handler.definition.description,
        inputSchema: jsonSchemaToZod(handler.definition.inputSchema),
        annotations: TOOL_ANNOTATIONS[name] ?? DEFAULT_ANNOTATIONS,
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
            // Honest: the ONLY upload-approval path over MCP is the operator
            // allowlist. There is no UI/CLI approval for uploads.
            return errText(
              `upload of "${fp ?? '(missing path)'}" was blocked: file uploads over MCP ` +
                `require the operator to pre-approve the absolute path via the ` +
                `ABB_UPLOAD_ALLOWLIST environment variable (comma-separated), then restart ` +
                `the MCP server.`,
            );
          }
        }
        const decision = policy.decide(action, ctx);
        if (decision.verdict === 'deny') {
          return errText(`denied by policy: ${decision.reason}`);
        }
        if (decision.verdict === 'confirm') {
          // Real ticket continuation: an operator approval of this exact
          // action (via the bridge UI "Pending confirmations" or
          // `node dist/index.js approve <id> --yes`) is honored on retry.
          if (!confirmations.isApproved('mcp', action)) {
            const existing: PendingConfirmation | undefined = confirmations
              .listUnresolved()
              .find((c) => c.taskId === 'mcp' && sameAction(c.action, action));
            const ticket = existing ?? confirmations.request('mcp', action, decision.reason, decision.risk);
            return errText(
              `requires human confirmation (${decision.reason}). Confirmation ticket ` +
                `${ticket.id} registered — approve with: node dist/index.js approve ${ticket.id} ` +
                `--yes (or the bridge UI "Pending confirmations"), then retry this tool.`,
            );
          }
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

function text(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'content-type': 'text/plain' });
  res.end(body);
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** Message for 401s: fail closed — "no authentication" in ChatGPT still fails. */
const MCP_UNAUTHORIZED_MESSAGE =
  'unauthorized: this MCP server requires OAuth authorization (see docs/MCP_CHATGPT.md) ' +
  'or the operator bearer token. Unauthenticated browser control is never allowed.';

/** Parse /token params from either urlencoded or JSON bodies. */
async function readTokenParams(req: IncomingMessage): Promise<Record<string, string>> {
  const raw = await readBody(req);
  const contentType = (req.headers['content-type'] ?? '').toLowerCase();
  if (contentType.includes('application/json')) {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new OAuthError('invalid_request', 'token body must be a JSON object');
    }
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === 'string') out[k] = v;
    }
    return out;
  }
  return Object.fromEntries(new URLSearchParams(raw));
}

/**
 * Start the MCP server on the requested transport. For HTTP, auth is
 * REQUIRED on /mcp when bound to a non-loopback address or when --public
 * is passed: either the static bearer token (ABB_MCP_TOKEN / explicit
 * --token, else a generated token printed exactly once to stderr) or an
 * OAuth 2.0 access token issued by the built-in authorization server
 * (pairing code printed exactly once at startup). Unauthenticated browser
 * control is never allowed.
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

  // Assigned after listen(), once the real port is known. The request
  // handler below references it, but no request can arrive before listen()
  // resolves, so this is safe.
  let oauth: OAuthProvider;

  const httpServer = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const pathname = url.pathname;
      const method = req.method ?? 'GET';

      // --- OAuth 2.0 authorization-server endpoints (before /mcp) ---
      if (method === 'GET' && pathname === '/.well-known/oauth-authorization-server') {
        json(res, 200, oauth.discoveryDocument());
        return;
      }
      if (method === 'POST' && pathname === '/register') {
        let parsed: unknown;
        try {
          parsed = JSON.parse(await readBody(req));
        } catch {
          text(res, 400, 'invalid JSON');
          return;
        }
        try {
          const client = oauth.registerClient(
            parsed as { redirect_uris: string[]; client_name?: string },
          );
          json(res, 201, client);
        } catch (err) {
          json(res, 400, { error: err instanceof OAuthError ? err.code : 'invalid_client_metadata' });
        }
        return;
      }
      if (pathname === '/authorize') {
        if (method === 'GET') {
          const page = oauth.buildApprovalPage({
            client_id: url.searchParams.get('client_id') ?? '',
            redirect_uri: url.searchParams.get('redirect_uri') ?? '',
            state: url.searchParams.get('state') ?? undefined,
            code_challenge: url.searchParams.get('code_challenge') ?? '',
            code_challenge_method: url.searchParams.get('code_challenge_method') ?? '',
          });
          if (!page.ok) {
            text(res, 400, page.error);
            return;
          }
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
          res.end(page.html);
          return;
        }
        if (method === 'POST') {
          const form = Object.fromEntries(new URLSearchParams(await readBody(req)));
          const result = oauth.handleAuthorizePost(form);
          if (result.location) {
            res.writeHead(result.status, { location: result.location });
            res.end();
            return;
          }
          text(res, result.status, result.body ?? 'error');
          return;
        }
        text(res, 405, 'method not allowed');
        return;
      }
      if (method === 'POST' && pathname === '/token') {
        let params: Record<string, string>;
        try {
          params = await readTokenParams(req);
        } catch (err) {
          json(res, 400, { error: err instanceof OAuthError ? err.code : 'invalid_request' });
          return;
        }
        try {
          if (params['grant_type'] === 'authorization_code') {
            json(
              res,
              200,
              oauth.exchangeCode({
                code: params['code'] ?? '',
                client_id: params['client_id'] ?? '',
                redirect_uri: params['redirect_uri'] ?? '',
                code_verifier: params['code_verifier'] ?? '',
              }),
            );
          } else if (params['grant_type'] === 'refresh_token') {
            json(
              res,
              200,
              oauth.refreshToken({
                refresh_token: params['refresh_token'] ?? '',
                client_id: params['client_id'] ?? '',
              }),
            );
          } else {
            json(res, 400, { error: 'unsupported_grant_type' });
          }
        } catch (err) {
          json(res, 400, { error: err instanceof OAuthError ? err.code : 'invalid_grant' });
        }
        return;
      }

      if (pathname !== '/mcp') {
        text(res, 404, 'not found');
        return;
      }
      if (needAuth) {
        const auth = req.headers.authorization ?? '';
        const staticOk = token !== null && auth === `Bearer ${token}`;
        const bearer = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
        const oauthOk = bearer !== '' && oauth.validateToken(bearer) !== null;
        if (!staticOk && !oauthOk) {
          text(res, 401, MCP_UNAUTHORIZED_MESSAGE);
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

  // Construct the OAuth provider with the REAL port (ChatGPT fetches the
  // discovery document from this issuer, so it must be exact).
  oauth = new OAuthProvider({ issuer: `http://${host}:${actualPort}` });

  return {
    token: needAuth ? token : null,
    url: `http://${host}:${actualPort}/mcp`,
    close: async () => {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      oauth.revokeAll(); // wipe every OAuth store on stop
      await transport.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    },
  };
}
