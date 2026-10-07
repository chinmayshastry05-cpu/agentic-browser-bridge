# MCP Server — setup for ChatGPT and other MCP clients

The bridge exposes all of its tools over the [Model Context Protocol](https://modelcontextprotocol.io/)
via `src/mcp/server.ts`, using the official `@modelcontextprotocol/sdk`.
Every MCP tool call is routed through the **same `PolicyEngine`** as the
local agent loop (agent-loop pattern, including `describeLiveTarget` for
password-field context):

- A `confirm` verdict becomes an MCP error telling the client the action
  needs human approval via the bridge UI/CLI — MCP clients cannot approve
  interactively in v1.
- An unapproved `browser_upload` is refused over MCP.

## Start the server

```bash
# Local clients (Claude Desktop, MCP Inspector, ...): stdio
node dist/src/index.js mcp --transport stdio

# Remote clients: Streamable HTTP on 127.0.0.1:8933
node dist/src/index.js mcp --transport http --port 8933
```

Options: `--port N` (default `8933`), `--host H` (default `127.0.0.1`),
`--headed` (visible browser), `--backend playwright|extension`
(`ABB_BACKEND` env also works).

## Authentication

- **Loopback default is safe by binding:** `--host 127.0.0.1` without
  `--public` serves browser control on loopback only; no token is issued.
- **Bearer token is REQUIRED** when the server binds a non-loopback host
  or when `--public` is passed. The token comes from `ABB_MCP_TOKEN`; if
  unset, the server generates one with `crypto.randomBytes(32)`, prints it
  **once** to stderr, and never logs or stores it. Clients send
  `Authorization: Bearer <token>`.
- Never serve unauthenticated browser control to the internet. The bridge
  refuses to start non-loopback HTTP without a usable token.

Port map: `8931` bridge HTTP · `8932` extension relay WS · `8933` MCP
Streamable HTTP.

## Connecting ChatGPT (developer mode)

ChatGPT cannot reach a `localhost` MCP server directly — the server must be
reachable from the internet. Two paths (technical facts only):

### (a) OpenAI Secure MCP Tunnel (outbound-only)

Use the open-source `tunnel-client` (github.com/openai/tunnel-client):
it opens an **outbound-only** tunnel from your machine to OpenAI, so no
inbound firewall ports are needed. User-side steps:

1. Create a tunnel in the **OpenAI Platform → tunnel settings**.
2. Run `tunnel-client` locally pointing at the bridge's MCP HTTP port
   (e.g. `8933`), providing a **runtime API key** when prompted/needed.
3. Register the resulting tunnel URL as a custom MCP server in ChatGPT
   (developer mode), including the `Authorization: Bearer <ABB_MCP_TOKEN>`
   header.

### (b) Free fallback: cloudflared

```bash
cloudflared tunnel --url http://localhost:8933
```

Free, no account. It prints a random `*.trycloudflare.com` URL that
**rotates on every restart** — re-register it in ChatGPT after each
restart. **With this path the MCP HTTP endpoint MUST require the bearer
token** (bind non-loopback or pass `--public` so a token is enforced),
because the tunnel URL is public.

## What ChatGPT can actually do (verified, Oct 2026)

From OpenAI's official help article on MCP in ChatGPT — do not overclaim:

1. **Full MCP support, including write/modify actions, is beta for
   ChatGPT Business, Enterprise, and Edu plans only.**
2. **Pro users in developer mode get READ/FETCH permissions only** —
   tools like `browser_snapshot`, `browser_tabs`, `browser_screenshot`
   work; write tools (`browser_click`, `browser_type`, `browser_navigate`,
   …) will **not** be callable from ChatGPT on a Pro account.
3. **Agent mode will not use custom apps, period** — the bridge's MCP
   tools are not available inside ChatGPT's agent mode.
4. **The local agent loop (with any free LLM API) remains the path for
   full autonomous write actions** — ChatGPT in dev mode is a
   read/observe companion; the bridge's own loop does the clicking and
   typing.

## Tool list

`tools/list` returns the full bridge registry (30 tools: navigate,
snapshot, click, type, tabs, frames, waits, screenshot, upload, downloads,
…); input schemas are the registry's JSON Schemas converted to Zod and
back, preserving types/required/descriptions. Protocol tests in
`tests/mcp-server.test.ts` assert the real request/response shapes over
both transports with the official SDK client.
