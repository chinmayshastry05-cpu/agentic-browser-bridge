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
import { AgentLoop } from './agent-loop.js';
import { BrowserSession } from './bridge-core.js';
import { createProviderFromEnv } from './openai.js';
import { BridgeServer } from './server.js';
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
  if (!goal) {
    console.error('usage: node dist/index.js agent --goal "your goal" [--max-steps 12]');
    process.exit(2);
  }
  const maxSteps = Number(argValue(args, '--max-steps') ?? '12');
  const session = new BrowserSession('agent-cli');
  await session.start({ headless: !args.includes('--headed') });
  try {
    const provider = createProviderFromEnv();
    const loop = new AgentLoop(session, provider, {
      maxSteps,
      onStep: (s) =>
        console.log(
          `[step ${s.step}] ${s.action.action} ${s.action.ref ?? s.action.url ?? ''} -> ${s.result.ok ? 'ok' : 'ERROR: ' + s.result.error}`,
        ),
    });
    const trace = await loop.run(goal);
    console.log(JSON.stringify(trace, null, 2));
  } finally {
    await session.close();
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
    default:
      console.log('agentic-browser-bridge — original local MCP browser bridge');
      console.log('');
      console.log('  serve [--port N] [--host H] [--headed]   start the bridge server');
      console.log('  demo                                     run the local end-to-end demo');
      console.log('  agent --goal "..." [--max-steps N]       run the agent loop (needs OPENAI_API_KEY)');
      process.exit(cmd ? 2 : 0);
  }
}

main().catch((err) => {
  console.error('[agentic-browser-bridge] fatal:', (err as Error).message);
  process.exit(1);
});
