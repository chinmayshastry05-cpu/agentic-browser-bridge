# Agentic Browser bridge

A local-first **MCP bridge** that lets an AI agent observe, plan, and act inside a real browser session: **observe → plan → act**, over JSON-RPC + SSE.

> **Originality note:** this is a new, original implementation written from scratch for this project. It is **not** a copy of any third-party "Agentic Browser" project or repository. A friend shared only a verbal architecture explanation; every line of code here was written fresh, and no external source archive was used.

## What it is

An agent can't click what it can't see. This bridge gives it eyes and hands:

- **Eyes** — `browser_snapshot` captures the page as a compact element tree: every interactable element gets a short stable ref (`[e3]`) plus role, accessible name, and a unique selector.
- **Brain** — `agent-loop.ts` runs observe → plan → act: snapshot → analyze → ask the LLM for the next JSON action → execute it. The LLM side is a pluggable provider interface; the shipped `OpenAIAdapter` speaks the OpenAI Chat Completions API (and any OpenAI-compatible endpoint).
- **Hands** — MCP tools `browser_navigate`, `browser_snapshot`, `browser_click`, `browser_type`, `browser_screenshot`, served over a tiny local HTTP server (`server.ts`) as JSON-RPC 2.0 (`POST /rpc`) with a Server-Sent Events stream (`GET /events`) for live step updates.

## How it works

```
┌─────────────┐   POST /rpc (JSON-RPC)    ┌──────────────────────┐
│  MCP client │ ───────────────────────▶ │  BridgeServer        │
│  or agent   │ ◀─────────────────────── │  server.ts           │
└─────────────┘   GET /events (SSE)      │   ├─ SessionManager  │
                                         │   ├─ tool registry │
                                         │   │   tools.ts     │
                                         └───────┬──────────────┘
                                                 │ refs, selectors
                                         ┌───────▼──────────────┐
                                         │  BrowserSession      │
                                         │  bridge-core.ts      │
                                         │   ├─ analyzer.ts ────┼─▶ summary for planner
                                         │   └─ tree.ts ────────┼─▶ navigable element tree
                                         └───────┬──────────────┘
                                                 │ Playwright
                                         ┌───────▼──────────────┐
                                         │  Chromium (local)    │
                                         └──────────────────────┘
```

Per step, `AgentLoop`:
1. **Observe** — `session.snapshot()` walks the DOM in-page (`page.evaluate`), assigns `data-abb-ref` attributes, and returns nodes with unique CSS selectors. `analyzer.ts` condenses this to a one-paragraph brief; `tree.ts` renders the indented tree the planner sees.
2. **Plan** — the provider (`openai.ts`) is asked for exactly one JSON action (`navigate`/`click`/`type`/`screenshot`/`snapshot`/`finish`/`noop`).
3. **Act** — the action executes against the session; refs resolve to selectors recorded at snapshot time (stale refs are rejected with a clear error).

### Why plain `playwright` instead of `@playwright/mcp`?

Three reasons, documented here and in `src/bridge-core.ts`:

1. The bridge runs the browser **in-process** and exposes its **own** MCP-style tool layer — the external `@playwright/mcp` server would be a redundant hop.
2. We need **per-snapshot stable element refs** (`e1`, `e2`, …) that survive across our observe → plan → act loop; an in-page DOM walk gives us exactly the refs, roles, and selectors our analyzer/tree modules consume.
3. Fewer moving parts for a local-only bridge: one process, one browser dependency.

## Project layout

```
src/
  bridge-core.ts   Session + transport abstraction over the browser backend
                   (BrowserBackend interface; PlaywrightBackend; BrowserSession;
                   SessionManager). Backend-agnostic: implement BrowserBackend
                   to drive a different automation stack.
  analyzer.ts      Snapshot → planner-friendly summary (role counts, outline,
                   ranked interactables) + findByName/findByRole helpers.
  tree.ts          Flat snapshot nodes → navigable element tree; text renderer.
  openai.ts        Pluggable LLM provider. Key comes ONLY from the environment
                   (OPENAI_API_KEY); never hardcoded, never logged.
  agent-loop.ts    The observe → plan → act loop (provider-agnostic).
  tools.ts         MCP tool registry: the five browser_* tools + JSON schemas.
  server.ts        Local HTTP bridge server: JSON-RPC 2.0 + SSE.
  index.ts         CLI: serve | demo | agent.
  demo-lib.ts      Shared end-to-end demo logic.
  types.ts         Shared types.
demo/
  page.html        Bundled offline demo page (no network needed).
  demo.ts          `pnpm demo` entry — drives page.html headless end to end.
tests/
  mcp.test.ts      22 offline unit tests (mock backend, stubbed fetch).
config/
  bridge.config.example.json   Example config — placeholders only, no secrets.
```

## Quickstart

Prerequisites: Node.js ≥ 18 and `pnpm` (or `npm`). Playwright downloads its bundled Chromium on first use (`pnpm exec playwright install chromium`) — or reuse an existing `~/.cache/ms-playwright`.

```bash
pnpm install
pnpm build        # type-check + compile to dist/
pnpm test         # 22 offline unit tests
pnpm demo         # headless end-to-end demo (see below)
```

### The local demo

`pnpm demo` launches headless Chromium, opens the bundled `demo/page.html` via `file://`, snapshots the page, types `Ada` into the name field, clicks **Greet me**, re-snapshots to verify the greeting text appeared, and saves `demo/output/demo-screenshot.png`. Fully offline — no API keys, no network.

### The bridge server

```bash
pnpm serve -- --port 8931            # JSON-RPC at POST /rpc, SSE at GET /events
curl localhost:8931/health
```

JSON-RPC methods: `session/create`, `session/close`, `tools/list`, `tools/call`.

```bash
# create a session
curl -s -X POST localhost:8931/rpc \
  -d '{"jsonrpc":"2.0","id":1,"method":"session/create","params":{"headless":true}}'
# list tools
curl -s -X POST localhost:8931/rpc \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{"sessionId":"sess-1"}}'
# navigate + snapshot
curl -s -X POST localhost:8931/rpc \
  -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"sessionId":"sess-1","name":"browser_navigate","arguments":{"url":"https://example.com"}}}'
```

### The autonomous agent loop (needs an LLM key)

```bash
export OPENAI_API_KEY="YOUR_API_KEY"   # never commit this; env only
pnpm agent -- --goal "Open the demo page and trigger the greeting" --max-steps 12
```

`openai.ts` also accepts `baseUrl` for any OpenAI-compatible endpoint and a custom `apiKeyEnv` if you prefer a different variable name.

### Configuration

Copy `config/bridge.config.example.json` to `config/bridge.config.json` and adjust. The example uses placeholders like `YOUR_MODEL_NAME` — put **no real keys** in it (the `.gitignore` excludes real `.env` files anyway).

## Security notes

- **No secrets in this repo.** API keys are read from environment variables at runtime only. Config examples contain placeholders. Nothing is logged that could contain a key (the adapter sends it solely in the `Authorization` header).
- The server binds to `127.0.0.1` by default — local only. Do not expose it to the internet without adding authentication.
- `browser_navigate` refuses non-web schemes (`javascript:`, etc.).
- This tool drives a real browser: only point it at pages you trust, and never use it to exfiltrate credentials or personal data.

## License

MIT — see [LICENSE](LICENSE).
