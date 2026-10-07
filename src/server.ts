/**
 * server.ts — the bridge server entry point.
 *
 * A small local HTTP server exposing the MCP tools over JSON-RPC 2.0:
 *
 *   GET  /health          -> { status: "ok", sessions: [...] }
 *   POST /rpc             -> JSON-RPC 2.0
 *        methods:
 *          session/create            { headless? }                       -> { sessionId }
 *          session/close             { sessionId }                       -> { closed }
 *          tools/list                { sessionId }                       -> { tools: [...] }
 *          tools/call                { sessionId, name, arguments }       -> tool result
 *   GET  /events?sessionId=... -> Server-Sent Events stream of session events
 *
 * Transport choice: plain HTTP + SSE, kept deliberately simple and local-only
 * (binds to 127.0.0.1 by default). Any MCP client that can POST JSON-RPC can
 * drive the bridge; no MCP SDK dependency required.
 */
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import { URL } from 'node:url';
import { BrowserSession, SessionManager } from './bridge-core.js';
import { createToolRegistry } from './tools.js';
import { TaskStore } from './state/task-store.js';
import { ConfirmationQueue } from './security/confirm.js';
import type { JsonRpcRequest, JsonRpcResponse, ToolResult } from './types.js';

export interface ServerOptions {
  host?: string;
  port?: number;
  maxSessions?: number;
  headless?: boolean;
}

type EventListener = (event: string, data: unknown) => void;

export class BridgeServer {
  private readonly sessions = new SessionManager();
  private readonly listeners = new Map<string, Set<EventListener>>();
  private server: http.Server | null = null;
  private readonly opts: Required<ServerOptions>;
  private readonly taskStore = new TaskStore();
  private readonly confirmations = new ConfirmationQueue();

  constructor(opts: ServerOptions = {}) {
    this.opts = {
      host: opts.host ?? '127.0.0.1',
      port: opts.port ?? 8931,
      maxSessions: opts.maxSessions ?? 4,
      headless: opts.headless ?? true,
    };
    this.sessions = new SessionManager(this.opts.maxSessions);
  }

  private emit(sessionId: string, event: string, data: unknown): void {
    for (const fn of this.listeners.get(sessionId) ?? []) {
      try {
        fn(event, data);
      } catch {
        /* listener errors must not break the bridge */
      }
    }
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    const text = JSON.stringify(body);
    res.writeHead(status, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(text),
    });
    res.end(text);
  }

  private async handleRpc(req: JsonRpcRequest): Promise<JsonRpcResponse> {
    const fail = (id: JsonRpcRequest['id'], code: number, message: string): JsonRpcResponse => ({
      jsonrpc: '2.0',
      id,
      error: { code, message },
    });
    const ok = (id: JsonRpcRequest['id'], result: unknown): JsonRpcResponse => ({
      jsonrpc: '2.0',
      id,
      result,
    });

    try {
      const params = req.params ?? {};
      switch (req.method) {
        case 'session/create': {
          const session = this.sessions.create();
          await session.start({ headless: (params['headless'] as boolean) ?? this.opts.headless });
          this.emit(session.id, 'session.created', { sessionId: session.id });
          return ok(req.id, { sessionId: session.id });
        }
        case 'session/close': {
          const id = params['sessionId'] as string;
          await this.sessions.close(id);
          this.emit(id, 'session.closed', { sessionId: id });
          return ok(req.id, { closed: id });
        }
        case 'session/attach': {
          // Attach a session to the user's existing browser over CDP.
          // The endpoint must be an explicitly provided loopback debugging port.
          const session = this.sessions.get(params['sessionId'] as string);
          const cdpEndpoint = params['cdpEndpoint'] as string;
          if (typeof cdpEndpoint !== 'string' || !cdpEndpoint) {
            return fail(req.id, -32602, 'session/attach requires "cdpEndpoint"');
          }
          await session.attach({ cdpEndpoint });
          this.emit(session.id, 'session.attached', {
            sessionId: session.id,
            backend: session.backendName,
          });
          return ok(req.id, {
            sessionId: session.id,
            backend: session.backendName,
            userBrowser: session.isUserBrowser,
          });
        }
        case 'tools/list': {
          const session = this.sessions.get(params['sessionId'] as string);
          const registry = createToolRegistry(session);
          return ok(req.id, {
            tools: [...registry.values()].map((h) => h.definition),
          });
        }
        case 'tools/call': {
          const session = this.sessions.get(params['sessionId'] as string);
          const registry = createToolRegistry(session);
          const name = params['name'] as string;
          const handler = registry.get(name);
          if (!handler) return fail(req.id, -32601, `unknown tool "${name}"`);
          const args = (params['arguments'] as Record<string, unknown>) ?? {};
          const result: ToolResult = await handler.handle(args);
          this.emit(session.id, 'tool.called', { name, ok: result.ok });
          return ok(req.id, result);
        }
        default:
          return fail(req.id, -32601, `unknown method "${req.method}"`);
      }
    } catch (err) {
      return fail(req.id, -32603, (err as Error).message);
    }
  }

  private readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c as Buffer));
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  private html(res: ServerResponse, body: string): void {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(body);
  }

  /** Minimal local status UI: connection, sessions, tasks, confirmations. */
  private uiPage(): string {
    return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><title>Agentic Browser bridge</title>
<style>
body{font-family:system-ui,sans-serif;max-width:900px;margin:2rem auto;padding:0 1rem;color:#222}
h1{font-size:1.4rem}h2{font-size:1.1rem;margin-top:2rem}
table{border-collapse:collapse;width:100%;font-size:.85rem}
th,td{border:1px solid #ccc;padding:.4rem .6rem;text-align:left;vertical-align:top}
th{background:#f4f4f4}.pill{display:inline-block;padding:.1rem .5rem;border-radius:1rem;font-size:.75rem}
.running{background:#d4edda}.completed{background:#cce5ff}.failed,.blocked{background:#f8d7da}
.awaiting_confirmation,.interrupted{background:#fff3cd}
button{margin:.1rem;padding:.3rem .7rem;cursor:pointer}
pre{background:#f6f6f6;padding:.5rem;overflow:auto;font-size:.75rem}
.note{color:#666;font-size:.8rem}
</style></head><body>
<h1>Agentic Browser bridge <span class="note">local-only · <a href="/health">health</a></span></h1>
<p class="note">Auto-refreshes every 5s. Typed text is redacted in stored steps; secrets never appear here.</p>
<h2>Sessions</h2><div id="sessions"><p class="note">loading…</p></div>
<h2>Tasks</h2><div id="tasks"><p class="note">loading…</p></div>
<h2>Pending confirmations</h2><div id="confirmations"><p class="note">loading…</p></div>
<script>
async function j(u, opts){const r=await fetch(u,opts);if(!r.ok)throw new Error(r.status);return r.json();}
function esc(s){return String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}
async function refresh(){
  try{
    const h=await j('/health');
    document.getElementById('sessions').innerHTML=h.sessions.length
      ? '<table><tr><th>session</th></tr>'+h.sessions.map(s=>'<tr><td>'+esc(s)+'</td></tr>').join('')+'</table>'
      : '<p class="note">no live sessions</p>';
    const tasks=await j('/api/tasks');
    document.getElementById('tasks').innerHTML=tasks.length
      ? '<table><tr><th>task</th><th>status</th><th>goal</th><th>url</th><th>updated</th></tr>'+tasks.map(t=>
        '<tr><td>'+esc(t.taskId)+'</td><td><span class="pill '+esc(t.status)+'">'+esc(t.status)+
        '</span></td><td>'+esc(t.goal)+'</td><td>'+esc(t.currentUrl||'')+'</td><td>'+esc(t.updatedAt)+'</td></tr>').join('')+'</table>'
      : '<p class="note">no tasks yet</p>';
    const cs=await j('/api/confirmations');
    document.getElementById('confirmations').innerHTML=cs.length
      ? '<table><tr><th>id</th><th>task</th><th>action</th><th>reason</th><th></th></tr>'+cs.map(c=>
        '<tr><td>'+esc(c.id)+'</td><td>'+esc(c.taskId)+'</td><td><pre>'+esc(JSON.stringify(c.action))+
        '</pre></td><td>'+esc(c.reason)+'</td><td><button onclick="decide(\\''+c.id+'\\',true)">Approve</button>'+
        '<button onclick="decide(\\''+c.id+'\\',false)">Reject</button></td></tr>').join('')+'</table>'
      : '<p class="note">none pending</p>';
  }catch(e){/* keep old content on transient errors */}
}
async function decide(id, approved){
  await j('/api/confirmations/'+id,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({approved})});
  refresh();
}
refresh();setInterval(refresh,5000);
</script></body></html>`;
  }

  private async handleApi(
    req: IncomingMessage,
    res: ServerResponse,
    url: URL,
  ): Promise<boolean> {
    const path = url.pathname;
    if (req.method === 'GET' && path === '/ui') {
      this.html(res, this.uiPage());
      return true;
    }
    if (req.method === 'GET' && path === '/api/tasks') {
      this.json(res, 200, this.taskStore.list());
      return true;
    }
    if (req.method === 'GET' && path.startsWith('/api/tasks/')) {
      const id = decodeURIComponent(path.slice('/api/tasks/'.length));
      try {
        this.json(res, 200, this.taskStore.get(id));
      } catch (err) {
        this.json(res, 404, { error: (err as Error).message });
      }
      return true;
    }
    if (req.method === 'GET' && path === '/api/confirmations') {
      this.json(res, 200, this.confirmations.listUnresolved());
      return true;
    }
    if (req.method === 'POST' && path.startsWith('/api/confirmations/')) {
      const id = decodeURIComponent(path.slice('/api/confirmations/'.length));
      try {
        const body = JSON.parse(await this.readBody(req)) as { approved?: unknown };
        if (typeof body.approved !== 'boolean') {
          this.json(res, 400, { error: '"approved" must be a boolean' });
          return true;
        }
        const c = this.confirmations.resolve(id, body.approved);
        this.json(res, 200, { id: c.id, approved: c.approved, taskId: c.taskId });
      } catch (err) {
        this.json(res, 400, { error: (err as Error).message });
      }
      return true;
    }
    return false;
  }

  async listen(): Promise<{ host: string; port: number }> {
    await this.stop();
    this.server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
        if (req.method === 'GET' && url.pathname === '/health') {
          this.json(res, 200, { status: 'ok', sessions: this.sessions.ids() });
          return;
        }
        if (await this.handleApi(req, res, url)) return;
        if (req.method === 'GET' && url.pathname === '/events') {
          const sessionId = url.searchParams.get('sessionId') ?? '';
          res.writeHead(200, {
            'content-type': 'text/event-stream',
            'cache-control': 'no-cache',
            connection: 'keep-alive',
          });
          res.write(': connected\n\n');
          const listener: EventListener = (event, data) => {
            res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
          };
          let set = this.listeners.get(sessionId);
          if (!set) {
            set = new Set();
            this.listeners.set(sessionId, set);
          }
          set.add(listener);
          req.on('close', () => set!.delete(listener));
          return;
        }
        if (req.method === 'POST' && url.pathname === '/rpc') {
          const text = await this.readBody(req);
          let rpc: JsonRpcRequest;
          try {
            rpc = JSON.parse(text) as JsonRpcRequest;
          } catch {
            this.json(res, 400, {
              jsonrpc: '2.0',
              id: null,
              error: { code: -32700, message: 'invalid JSON' },
            });
            return;
          }
          if (rpc.jsonrpc !== '2.0' || typeof rpc.method !== 'string') {
            this.json(res, 400, {
              jsonrpc: '2.0',
              id: rpc.id ?? null,
              error: { code: -32600, message: 'invalid JSON-RPC request' },
            });
            return;
          }
          this.json(res, 200, await this.handleRpc(rpc));
          return;
        }
        this.json(res, 404, { error: 'not found' });
      } catch (err) {
        this.json(res, 500, { error: (err as Error).message });
      }
    });

    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.opts.port, this.opts.host, () => resolve());
    });
    return { host: this.opts.host, port: this.opts.port };
  }

  async stop(): Promise<void> {
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = null;
    }
    await this.sessions.closeAll();
    this.listeners.clear();
  }

  /** Test seam: exercise the RPC layer without opening a socket. */
  async rpcForTest(req: JsonRpcRequest): Promise<JsonRpcResponse> {
    return this.handleRpc(req);
  }

  get sessionManager(): SessionManager {
    return this.sessions;
  }
}

/** Create a session bound to a custom backend (used by tests/demos). */
export function createSessionWithBackend(
  manager: SessionManager,
  backend: import('./types.js').BrowserBackend,
): BrowserSession {
  return manager.create(backend);
}
