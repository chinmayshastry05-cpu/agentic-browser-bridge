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
- **What an approval covers (exact, fail-closed):** one approval authorizes
  ONE specific call and nothing else. It binds the canonical FULL tool
  arguments (every argument — e.g. the exact `text` being typed, not just
  the ref), the exact page identity at ticket time (page URL, snapshot id,
  a monotonic navigation generation, and a per-navigation page nonce), and
  the requesting MCP session. It expires 10 minutes after issuance and is
  **single-use**: the retry it unblocks consumes it, so the same call a
  second time needs a fresh ticket. **Every bridge-driven navigation voids
  the approval — even to the identical URL:** `browser_navigate`,
  `browser_reload`, `browser_back`/`browser_forward`, and tab open/switch/close
  issued through the bridge each bump the navigation generation, mint a fresh
  page nonce, and clear all element refs. An old ref after navigation fails
  with the "stale ref — take a fresh snapshot" error and can never resolve
  against the rebuilt DOM. Approving `browser_type e4 "hello"` never authorizes
  `browser_type e4 "goodbye"`, and one session's approval never authorizes
  another session. Concurrent approval checks across processes (MCP server
  + `approve` CLI share the file-backed queue) are serialized with a
  lockfile, so racing the same ticket produces exactly one winner.
- **Page-initiated navigation (pre-action live check):** the cached page
  identity only reflects bridge-driven navigation, so after an approval is
  granted — and before the action executes — the bridge re-reads the
  page's LIVE identity (the actual URL plus the document's load id, which
  changes on every committed navigation including same-URL reloads) and
  compares it with the identity the approval was bound to. If the page
  navigated or reloaded itself (link click, JS redirect, form submit,
  external reload), the approval is voided exactly like a bridge navigation
  (refs cleared, generation bumped) and nothing acts — a fresh snapshot and
  a new ticket are required. This check runs on the Playwright and extension
  backends, which report a live document load id; backends without one
  degrade to URL comparison only (same-URL reloads are not detectable
  there). **Residual limits, stated plainly:** a navigation landing in the
  microseconds between the live check and the DOM write is not covered, and
  pure DOM mutation with no navigation/reload is not detectable by any
  backend and remains uncovered. `pageIdentity()` returns the cached
  url/nonce from the last bridge-driven navigation; the live document id is
  re-read in `onNavigationCommitted` and in this pre-action check only.
  Do not claim fully safe autonomy — the bridge is not generally safe on
  arbitrary websites.
- **What is NOT protected:** a bare "Send"/"Submit" click whose label
  matches no consequential keyword is low-risk and proceeds without
  confirmation; icon-only buttons with no accessible name are NOT caught by
  the keyword heuristic. Do not treat the bridge as generally safe on
  arbitrary websites — these gates are fixture-tested heuristics, not a
  safety proof.
- `browser_upload` is refused unless the absolute path is pre-approved via
  the `ABB_UPLOAD_ALLOWLIST` environment variable (comma-separated); the
  block message says exactly this.

## Start the server

```bash
# Local clients (Claude Desktop, MCP Inspector, ...): stdio
node dist/src/index.js mcp --transport stdio

# Remote clients incl. ChatGPT: Streamable HTTP on 127.0.0.1:8933, OAuth on
node dist/src/index.js mcp --transport http --port 8933 --issuer https://<your-tunnel>.trycloudflare.com
```

On HTTP startup the server prints a **one-time OAuth pairing code** to
stderr (shown once, never stored). Keep the terminal visible — you need
this code to approve ChatGPT's OAuth flow. To set your own code instead:
`ABB_OAUTH_PAIRING_CODE=<code>` in the environment.

**Pairing-code policy:** generated codes carry 128-bit entropy, expire 10
minutes after the server starts, and are single-use (a successful approval
retires the code and a fresh one is printed). 5 consecutive wrong codes
lock the code out — restart the server for a fresh one. Operator-supplied
codes (`ABB_OAUTH_PAIRING_CODE`) are long-lived but the 5-attempt bound
still applies.

Options: `--port N` (default `8933`), `--host H` (default `127.0.0.1`),
`--issuer URL` (also `ABB_PUBLIC_URL` env; **required** for ChatGPT —
see below), `--headed` (visible browser), `--backend playwright|extension`
(`ABB_BACKEND` env also works).

## Authentication

- **`/mcp` ALWAYS requires a credential — no exceptions, including
  loopback.** Every request must carry a valid OAuth 2.0 access token or
  the static operator bearer token. The old "loopback without `--public`
  needs no auth" behavior is gone: the documented loopback + tunnel setup
  would otherwise expose unauthenticated browser control to the internet.
- **OAuth 2.0 (for ChatGPT):** Authorization Code + PKCE (S256), per the
  MCP authorization spec. Discovery at
  `/.well-known/oauth-authorization-server`, protected-resource metadata
  (RFC 9728) at `/.well-known/oauth-protected-resource`, dynamic client
  registration at `/register`, approval at `/authorize`, tokens at
  `/token`. 401 responses carry a `WWW-Authenticate: Bearer
  resource_metadata="..."` challenge. The approval page requires the
  pairing code, so a stranger who guesses the tunnel URL cannot
  self-approve.
- **Public issuer (`--issuer` / `ABB_PUBLIC_URL`): REQUIRED for ChatGPT.**
  ChatGPT fetches the discovery document over the internet, so the
  authorization/token/registration URLs in it must be publicly reachable.
  Pass your tunnel's `https://` URL. Validated fail-fast at startup:
  must be `https` (http allowed only for loopback/`.localhost`, for local
  testing), and private-network literals are rejected. The issuer is never
  derived from `Host` / `X-Forwarded-*` headers.
- **Static bearer token (operator/local use):** `ABB_MCP_TOKEN` env or
  explicit `--token`. Accepted on `/mcp` alongside OAuth tokens.
- **Fail closed:** if ChatGPT is configured with "No authentication", its
  requests get **401** with a message pointing at the OAuth setup.
  Unauthenticated browser control is never allowed.
- **Consequential clicks need approval:** `browser_click` /
  `browser_double_click` resolve the target's accessible name and require
  a human confirmation ticket when the label matches a tight keyword set
  (buy, purchase, pay, checkout, place order, subscribe, delete, remove,
  transfer, withdraw, send money). This is heuristic TEXT matching, not
  semantic understanding — icon-only buttons with no accessible name are
  NOT caught.

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

1. Start the tunnel FIRST (it retries against the closed port — that is
   fine): `cloudflared tunnel --url http://localhost:8933`
   Copy the `https://<random>.trycloudflare.com` URL it prints.
2. Start the bridge with that URL as the issuer (note the pairing code
   printed to the terminal):
   `node dist/src/index.js mcp --transport http --port 8933 --issuer https://<random>.trycloudflare.com`
   (`--issuer` is required: without it, discovery hands ChatGPT loopback
   auth URLs it can never reach. `ABB_PUBLIC_URL` env works too; the flag
   wins.)
3. In ChatGPT: Plugins → Add → "Add custom MCP server" → paste
   `https://<random>.trycloudflare.com/mcp` → authentication: **OAuth**.
4. ChatGPT opens the bridge's `/authorize` page: enter the pairing code
   from step 1, click Approve.
5. ChatGPT exchanges the code (PKCE) for an access token and lists the
   tools. Done — no API key, no paid upgrade, no LLM key anywhere.

Restarting: the tunnel URL changes on every `cloudflared` restart, so
start the tunnel first, copy the new URL, then restart the bridge with
`--issuer <new-url>` and re-register in ChatGPT. The pairing code is per
server start; restarting the bridge prints a new one.

## What ChatGPT can actually do (reviewer-verified, Oct 2026)

Proven end-to-end by independent review (not a claim — observed): real
ChatGPT Go account (`chinmayshastry05@gmail.com`) custom MCP via OAuth,
GPT drove `snapshot` / `type` / `click` / `gettext` on a fresh real MV3
Chromium fixture, plus a real confirmation-ticket approval flow
(`confirm-3baaca76`). No API key, no paid upgrade. Scope of the proof:
the local fixture only — behavior on arbitrary public websites is NOT
covered by this verification.

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
