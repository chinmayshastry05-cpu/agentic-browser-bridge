# MCP Server — setup for ChatGPT and other MCP clients

The bridge exposes all of its tools over the [Model Context Protocol](https://modelcontextprotocol.io/)
via `src/mcp/server.ts`, using the official `@modelcontextprotocol/sdk`.
Every MCP tool call is routed through the **same `PolicyEngine`** as the
local agent loop (including `describeLiveTarget` for password-field context):

- A `confirm` verdict registers a **real confirmation ticket**
  (`ConfirmationQueue`, the same file-backed store the CLI and bridge UI
  use). The MCP error names the ticket id; the operator approves with
  `node dist/index.js approve <id> --yes` or the bridge UI "Pending
  confirmations", and the retried tool call proceeds. Gated actions stay
  gated — nothing proceeds silently.
- `browser_upload` is refused unless the absolute path is pre-approved via
  the `ABB_UPLOAD_ALLOWLIST` environment variable (comma-separated); the
  block message says exactly this.

## Start the server

```bash
# Local clients (Claude Desktop, MCP Inspector, ...): stdio
node dist/src/index.js mcp --transport stdio

# Remote clients incl. ChatGPT: Streamable HTTP on 127.0.0.1:8933, OAuth on
node dist/src/index.js mcp --transport http --port 8933
```

On HTTP startup the server prints a **one-time OAuth pairing code** to
stderr (shown once, never stored). Keep the terminal visible — you need
this code to approve ChatGPT's OAuth flow. To set your own code instead:
`ABB_OAUTH_PAIRING_CODE=<code>` in the environment.

Options: `--port N` (default `8933`), `--host H` (default `127.0.0.1`),
`--headed` (visible browser), `--backend playwright|extension`
(`ABB_BACKEND` env also works).

## Authentication

- **Loopback default is safe by binding:** `--host 127.0.0.1` without
  `--public` serves browser control on loopback only. OAuth is still
  active (ChatGPT needs it), and the static operator bearer token is not
  required on loopback.
- **OAuth 2.0 (for ChatGPT):** Authorization Code + PKCE (S256), per the
  MCP authorization spec. Discovery at
  `/.well-known/oauth-authorization-server`, dynamic client registration
  at `/register`, approval at `/authorize`, tokens at `/token`. The
  approval page requires the one-time pairing code, so a stranger who
  guesses the tunnel URL cannot self-approve.
- **Static bearer token (operator/local use):** `ABB_MCP_TOKEN` env,
  explicit `--token`, or a generated token printed once to stderr.
  Accepted on `/mcp` alongside OAuth tokens.
- **Fail closed:** `/mcp` requires a valid OAuth access token OR the
  operator bearer token — always. If ChatGPT is configured with "No
  authentication", its requests get **401** with a message pointing at
  the OAuth setup. Unauthenticated browser control is never allowed.

Port map: `8931` bridge HTTP · `8932` extension relay WS · `8933` MCP
Streamable HTTP.

## Reachability: free tunnel (no account)

ChatGPT cannot reach `localhost` — the MCP server must be reachable from
the internet:

```bash
cloudflared tunnel --url http://localhost:8933
```

Free, no account. It prints a random `*.trycloudflare.com` URL that
**rotates on every restart** — re-register the new URL in ChatGPT after
each restart. The URL is public, but the MCP server behind it always
requires OAuth or the operator bearer token, so browser control stays
authenticated.

## Connecting ChatGPT — exact steps

Verified account state: `chinmayshastry05@gmail.com`, status Go;
ChatGPT → Plugins → Add offers **"Add custom MCP server"**. Its
authentication selector offers ONLY: **OAuth**, **No authentication**,
**"OAuth or no authentication"** — there is no Bearer/API-key field.

1. Start the bridge: `node dist/src/index.js mcp --transport http --port 8933`
   (note the pairing code printed to the terminal).
2. Start the tunnel: `cloudflared tunnel --url http://localhost:8933`
   (note the `https://<random>.trycloudflare.com` URL).
3. In ChatGPT: Plugins → Add → "Add custom MCP server" → paste
   `https://<random>.trycloudflare.com/mcp` → authentication: **OAuth**.
4. ChatGPT opens the bridge's `/authorize` page: enter the pairing code
   from step 1, click Approve.
5. ChatGPT exchanges the code (PKCE) for an access token and lists the
   tools. Done — no API key, no paid upgrade, no LLM key anywhere.

Restarting: the tunnel URL changes on every `cloudflared` restart, so
repeat steps 2–3 with the new URL. The pairing code is per server start;
restarting the bridge prints a new one.

## What ChatGPT can actually do (verified, Oct 2026)

- Read/write capability through ChatGPT is **empirically untested** and
  will be verified with real ChatGPT tool calls; no claim is made either
  way.
- The bridge's own local agent loop performs browser write actions on
  this machine regardless; whether ChatGPT can do the same through the
  MCP server is part of what the real tool-call verification will check.

## Tool list

`tools/list` returns the full bridge registry (30 tools: navigate,
snapshot, click, type, tabs, frames, waits, screenshot, upload, downloads,
…); input schemas are the registry's JSON Schemas converted to Zod,
preserving types/required/descriptions. Every tool carries honest MCP
`annotations`: read-only tools (`browser_snapshot`, `browser_screenshot`,
`browser_get_text`, `browser_page_info`, `browser_tabs`,
`browser_frames`, `browser_frame_snapshot`, `browser_status`,
`browser_downloads`, `browser_wait_for_download`) are
`readOnlyHint: true`; `browser_close_tab` is `destructiveHint: true`;
everything else is a non-destructive state change
(`readOnlyHint: false`). Protocol tests in `tests/mcp-server.test.ts` and
`tests/mcp-oauth.test.ts` assert the real request/response shapes over
both transports with the official SDK client.
