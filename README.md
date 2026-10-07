# Agentic Browser bridge

A local-first **browser agent bridge**: an AI agent observes a real browser
session, plans one safe action at a time, verifies the effect, and asks for
approval before the policy engine flags an action high-risk — over JSON-RPC
+ SSE, with a minimal local UI.

> **Originality note:** original implementation written from scratch for this
> project. No third-party "agentic browser" code is reused.

## What it is

An agent can't click what it can't see. This bridge gives it eyes and hands:

- **Eyes** — `browser_snapshot` captures the page as an element tree: every
  interactable element gets a short ref (`[e3]`) plus role, accessible name,
  selector, and frame context. Open shadow roots are pierced; iframes are
  inspectable via `browser_frame_snapshot`.
- **Brain** — `src/agent/agent-loop.ts` runs observe → plan → **check**
  (policy gate) → act → **verify**. Refs are grounded: before acting, the
  live element is re-described and compared to its snapshot signature; stale
  refs are re-grounded semantically or refused — never guessed.
- **Hands** — 30 `browser_*` tools (navigate, click, type, select, check,
  press key, scroll, wait, tabs, frames, upload, download tracking,
  screenshots, …) served by a tiny local HTTP server as JSON-RPC 2.0
  (`POST /rpc`) with SSE (`GET /events`) and a status UI (`GET /ui`).
- **Memory** — every run is a persisted task (JSON, `~/.agentic-browser-bridge/tasks/`);
  interrupted tasks resume with `agent --resume <taskId>`. Typed text is
  redacted before anything is written to disk.
- **Conscience** — a policy engine classifies actions low/medium/high risk.
  Exactly what counts as high risk: typing into password fields, uploads of
  not-yet-approved files, anything in the operator's `highRiskActions` list,
  and clicks whose target label matches a tight consequential keyword set
  (buy, purchase, pay, checkout, place order, subscribe, delete, remove,
  transfer, withdraw, send money). The keyword check is heuristic TEXT
  matching on the control's accessible name — icon-only buttons with no
  accessible name are NOT caught. High-risk actions stop the loop with
  `awaiting_confirmation` until the operator approves via CLI or UI.

## Architecture

```
                    ┌─────────────────────────────────────────┐
                    │  BridgeServer (server.ts)               │
  MCP client ──rpc─▶│   sessions · tools · /ui · /api         │──▶ TaskStore (JSON)
                    └──────────────┬──────────────────────────┘    ConfirmationQueue
                                   │ refs + grounding                     (file-backed)
                    ┌──────────────▼──────────────┐
                    │  BrowserSession             │
                    │  resolveTarget(): verify →  │
                    │  re-ground → or refuse      │
                    └──────────────┬──────────────┘
                    ┌──────────────▼──────────────┐
                    │  BrowserBackend             │
                    │  ├── PlaywrightBackend      │  launched isolated Chromium
                    │  ├── CdpBackend             │  user's Chrome/Edge over CDP
                    │  └── ExtensionBackend       │  user's Chrome via MV3 extension (docs/EXTENSION.md)
                    └─────────────────────────────┘
  AgentLoop: OBSERVE → PLAN → CHECK(policy) → ACT → VERIFY → recover (≤1 retry)

  MCP server: `node dist/src/index.js mcp --transport stdio|http` exposes the
  30 bridge tools over MCP (stdio for local clients, Streamable HTTP on
  127.0.0.1:8933 for remote). HTTP /mcp ALWAYS requires a credential
  (OAuth access token or operator bearer token), even on loopback.
  See docs/MCP_CHATGPT.md (ChatGPT setup and authentication options).
```

Key modules: `src/browser/` (backends, snapshot walker), `src/perception/`
(grounding), `src/agent/` (loop, verifier), `src/security/` (policy,
confirmations, redaction, injection), `src/state/` (task store).

## Install

Prerequisites: Node.js ≥ 18. (`npm` is used below; the repo also ships a
`pnpm` workspace file.)

```bash
git clone https://github.com/chinmayshastry05-cpu/agentic-browser-bridge
cd agentic-browser-bridge
npm install
npx playwright install chromium   # one-time browser download
npm run build                     # tsc strict, zero errors
npm test                          # 86 tests (unit + real headless Chromium + real CDP)
node dist/src/index.js doctor     # setup checks
```

## First run

```bash
# 1. Local demo (no keys, no network): observe → plan → act on a bundled page
npm run demo

# 2. Bridge server + UI
node dist/src/index.js serve --port 8931
# open http://127.0.0.1:8931/ui   (sessions, tasks, pending confirmations)

# 3. Status / tasks
node dist/src/index.js status
node dist/src/index.js tasks
```

## Connect your real browser (Chrome/Edge)

The bridge never scans for or silently attaches to browsers. You start the
connection explicitly:

```bash
# 1. Start Chrome with remote debugging (your normal profile):
chrome --remote-debugging-port=9222 --user-data-dir=/path/to/your/profile

# 2. Attach a bridge session to it (only loopback endpoints are accepted):
curl -s -X POST localhost:8931/rpc -d '{
  "jsonrpc":"2.0","id":1,"method":"session/create","params":{"headless":true}}'
# -> {"result":{"sessionId":"sess-1"}}
curl -s -X POST localhost:8931/rpc -d '{
  "jsonrpc":"2.0","id":2,"method":"session/attach",
  "params":{"sessionId":"sess-1","cdpEndpoint":"http://127.0.0.1:9222"}}'

# 3. See your real tabs and act on one:
curl -s -X POST localhost:8931/rpc -d '{
  "jsonrpc":"2.0","id":3,"method":"tools/call",
  "params":{"sessionId":"sess-1","name":"browser_tabs","arguments":{}}}'
```

Disconnecting (`session/close`) never closes your browser — the bridge just
drops the CDP connection. Connection state is always visible via
`browser_status` and the `/ui` page.

## Example task (needs `OPENAI_API_KEY`)

```bash
export OPENAI_API_KEY="..."   # env only — never committed, never logged
node dist/src/index.js agent --goal "Open https://example.com and summarize the page" --max-steps 12
# strict mode: confirm even medium-risk actions
node dist/src/index.js agent --goal "..." --strict
# approve a pending high-risk action, then resume:
node dist/src/index.js approve confirm-xxxxxxxx --yes
node dist/src/index.js agent --resume task-xxxxxxxx
```

## Security model

- **Local-first.** The server binds `127.0.0.1` by default; no telemetry, no
  cloud calls except the LLM provider you configure. What listens, what can
  connect, and what leaves the machine is documented here — nothing else.
- **Explicit browser authorization.** CDP attach requires a user-supplied
  loopback endpoint; the bridge never launches, scans for, or closes your
  browser.
- **Untrusted page content.** The planner is instructed that page text is
  data, never instructions; a detector flags injection shapes
  (instruction override, fake system prompts, exfiltration, credential
  harvesting) and injects a SECURITY NOTICE into the planner message.
- **Secrets.** Typed text is redacted in persisted task steps; planner-bound
  summaries are scrubbed for API keys/tokens/card numbers; provider keys
  come only from the environment.
- **Risky actions.** Low/medium/high classification; high-risk actions
  (password fields, etc.) require operator approval via CLI or UI. The model
  cannot approve its own actions. Uploads need an existing absolute path;
  downloads land in a bridge-controlled directory with safe filenames.

## Limitations (honest)

- **Closed shadow DOM is not accessible** — a hard browser boundary, not a bug.
- **Visual grounding is coordinate-based, not a vision model.**
  `src/perception/visual.ts` maps viewport (x, y) to DOM refs via
  `elementFromPoint` (extension content script or Playwright) and
  `regionToCandidates` via bounding-box intersection. It resolves points to
  refs reliably, but there is no image understanding — do not expect it to
  find things by appearance.
- **Extension backend is top-frame-only in v1**, has no file uploads and no
  download tracking, and dispatches synthetic DOM events (not trusted
  OS-level input). See `docs/EXTENSION.md`. CDP attach (`CdpBackend`) is
  still available for existing browsers started with
  `--remote-debugging-port`.
- **Verification is best-effort.** Actions without a reliable observable
  signal (hover, scroll) are reported as *unverified*, never faked. The loop
  records this honestly for the planner.
- **No CAPTCHA solving, no bot-detection evasion, no auth bypass** — out of
  scope, documented as future work.
- **Single-user, single-machine.** No multi-user auth on the bridge itself;
  anyone who can reach localhost can drive it — keep it on loopback. The
  MCP HTTP transport additionally requires a credential on every /mcp
  request (OAuth access token or bearer token), even on loopback
  (see `docs/MCP_CHATGPT.md`).
- **The LLM provider is required for autonomous runs** and is the only
  network call the agent makes; everything else is local and deterministic.

## Project layout

```
src/
  browser/       backends (playwright/cdp/extension), relay, factory, snapshot walker, tab/frame logic
  perception/    grounding.ts — stale detection + semantic re-grounding; visual.ts — coordinate grounding
  mcp/           server.ts — MCP server (stdio + Streamable HTTP, always-auth + OAuth)
  agent/         agent-loop.ts, verifier.ts
  security/      policy.ts, confirm.ts, redact.ts, injection.ts
  state/         task-store.ts — JSON task persistence + resume
  server.ts      JSON-RPC/SSE server + /ui + /api
  tools.ts       30 browser_* tool definitions
  index.ts       CLI: serve|mcp|demo|agent|approve|status|doctor|tasks
extension/       Chrome MV3 extension (service worker + content script + popup)
docs/            EXTENSION.md, MCP_CHATGPT.md, ACCEPTANCE.md
tests/           unit (mock) + real headless Chromium + real CDP attach + MCP protocol + visual
tests/fixtures/  deterministic fixture pages (forms, frames, shadow DOM,
                 delayed/stale elements, upload, download, injection)
docs/ACCEPTANCE.md  acceptance suite A–P mapped to tests and evidence
demo/            bundled offline demo page
```

## Test evidence (this checkout)

Note: the browser-backed tests (`browser.test.ts`, `cdp.test.ts`) require the
one-time `npx playwright install chromium` download first (see the Install
section above); run it before `npm test`.

```
npm run build   PASS (tsc strict, zero errors)
npm test        PASS — 86/86 across 6 files:
                  mcp.test.ts (47): analyzer, tree, tools, agent loop,
                    provider, server RPC, tabs/attach, grounding, verifier,
                    recovery + terminal states
                  browser.test.ts (10): real headless Chromium — forms,
                    keyboard/scroll, delayed content, iframe, shadow DOM,
                    upload, download tracking, page info, stale re-grounding,
                    scripted end-to-end loop run
                  cdp.test.ts (3): real standalone Chromium over CDP —
                    attach, tab enumeration/control, snapshot, screenshot,
                    non-loopback refusal, browser survives disconnect
                  security.test.ts (15): policy, confirmations, redaction,
                    injection shapes + adversarial fixture, loop wiring
                  state.test.ts (7): task store, redaction on disk, resume
                  server-ui.test.ts (4): /ui page, task/confirmation APIs
npm run demo    PASS — observe/plan/act on the bundled page, greeting verified
```

Real-user browser validation (§20) was demonstrated 2026-10-07: standalone
Chromium launched with `--remote-debugging-port` (not via Playwright) →
bridge attached over CDP → enumerated real tabs → scripted agent loop
observed, typed, clicked → visible change verified ("Status for Ada:
shipped", before/after screenshots) → browser survived disconnect.
