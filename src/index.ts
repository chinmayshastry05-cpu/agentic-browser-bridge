/**
 * index.ts — CLI entry point.
 *
 *   node dist/index.js serve [--port 8931] [--host 127.0.0.1] [--headed]
 *   node dist/index.js demo
 *   node dist/index.js agent --goal "describe the goal" [--max-steps 12]
 *
 * The `serve` command starts the JSON-RPC/SSE bridge server; `demo` runs the
 * local end-to-end demo; `agent` runs one autonomous observe->plan->act loop
 * against a goal (needs OPENAI_API_KEY or another configured provider).
 */
import { AgentLoop } from './agent/agent-loop.js';
import { BrowserSession } from './bridge-core.js';
import { createProviderFromEnv } from './openai.js';
import { BridgeServer } from './server.js';
import { PolicyEngine } from './security/policy.js';
import { ConfirmationQueue } from './security/confirm.js';
import { TaskStore } from './state/task-store.js';
import { runDemo } from './demo-lib.js';

function argValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function cmdServe(args: string[]): Promise<void> {
  const port = Number(argValue(args, '--port') ?? process.env['ABB_PORT'] ?? 8931);
  const host = argValue(args, '--host') ?? process.env['ABB_HOST'] ?? '127.0.0.1';
  const headless = !args.includes('--headed');
  const server = new BridgeServer({ host, port, headless });
  const addr = await server.listen();
  console.log(`[agentic-browser-bridge] listening on http://${addr.host}:${addr.port}`);
  console.log(`[agentic-browser-bridge] health:  GET /health`);
  console.log(`[agentic-browser-bridge] rpc:     POST /rpc  (JSON-RPC 2.0)`);
  console.log(`[agentic-browser-bridge] events:  GET /events?sessionId=... (SSE)`);

  const shutdown = async (): Promise<void> => {
    console.log('\n[agentic-browser-bridge] shutting down...');
    await server.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

async function cmdAgent(args: string[]): Promise<void> {
  const goal = argValue(args, '--goal');
  const resumeTaskId = argValue(args, '--resume');
  if (!goal && !resumeTaskId) {
    console.error('usage: node dist/index.js agent --goal "your goal" [--max-steps 12] [--resume <taskId>] [--strict]');
    console.error('       node dist/index.js agent --resume <taskId>   # resume an interrupted task');
    process.exit(2);
  }
  const maxSteps = Number(argValue(args, '--max-steps') ?? '12');
  const session = new BrowserSession('agent-cli');
  await session.start({ headless: !args.includes('--headed') });
  try {
    const provider = createProviderFromEnv();
    const engine = new PolicyEngine({ confirmMedium: args.includes('--strict') });
    const confirmations = new ConfirmationQueue();
    const store = new TaskStore();
    const loop = new AgentLoop(session, provider, {
      maxSteps,
      taskStore: store,
      resumeTaskId: resumeTaskId ?? undefined,
      confirmations,
      policyCheck: async (action, ctx) => engine.decide(action, ctx),
      onStep: (s) => {
        const v = s.verification;
        console.log(
          `[step ${s.step}] ${s.action.action} ${s.action.ref ?? s.action.url ?? ''} -> ${s.result.ok ? 'ok' : 'ERROR: ' + s.result.error}` +
            (v && !v.verified ? ` [NOT VERIFIED: ${v.detail}]` : '') +
            (s.recoveryAttempts ? ` [recovered x${s.recoveryAttempts}]` : ''),
        );
      },
    });
    const trace = await loop.run(goal ?? '');
    console.log(JSON.stringify({ status: trace.status, finishReason: trace.finishReason }, null, 2));
    const pending = confirmations.listUnresolved();
    if (pending.length > 0) {
      console.log('[agentic-browser-bridge] pending confirmations:');
      for (const c of pending) {
        console.log(`  ${c.id}: ${c.reason} (task ${c.taskId})`);
      }
      console.log('[agentic-browser-bridge] approve with: node dist/index.js approve <id> --yes|--no, then resume with --resume <taskId>');
    }
  } finally {
    await session.close();
  }
}

async function cmdApprove(args: string[]): Promise<void> {
  const [id] = args;
  const yes = args.includes('--yes');
  const no = args.includes('--no');
  if (!id || yes === no) {
    console.error('usage: node dist/index.js approve <confirmation-id> --yes|--no');
    process.exit(2);
  }
  const queue = new ConfirmationQueue();
  try {
    const c = queue.resolve(id, yes);
    console.log(
      `[agentic-browser-bridge] confirmation ${c.id} ${yes ? 'APPROVED' : 'REJECTED'}: ${c.reason}`,
    );
    if (yes) {
      console.log(`[agentic-browser-bridge] resume the task with: node dist/index.js agent --resume ${c.taskId}`);
    } else {
      console.log('[agentic-browser-bridge] the task stays awaiting_confirmation; it will not proceed.');
    }
  } catch (err) {
    console.error(`[agentic-browser-bridge] approve failed: ${(err as Error).message}`);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case 'serve':
      await cmdServe(args);
      break;
    case 'demo':
      await runDemo();
      break;
    case 'agent':
      await cmdAgent(args);
      break;
    case 'approve':
      await cmdApprove(args);
      break;
    default:
      console.log('agentic-browser-bridge — original local MCP browser bridge');
      console.log('');
      console.log('  serve [--port N] [--host H] [--headed]   start the bridge server');
      console.log('  demo                                     run the local end-to-end demo');
      console.log('  agent --goal "..." [--max-steps N]       run the agent loop (needs OPENAI_API_KEY)');
      console.log('  agent --resume <taskId>                  resume an interrupted task');
      console.log('  approve <confirmation-id> --yes|--no     approve/reject a pending high-risk action');
      process.exit(cmd ? 2 : 0);
  }
}

main().catch((err) => {
  console.error('[agentic-browser-bridge] fatal:', (err as Error).message);
  process.exit(1);
});
