# ChatGPT Developer Mode — exact connect steps

Connect the bridge's MCP server to ChatGPT (developer mode / custom MCP
server) so GPT can drive your browser through the 30 `browser_*` tools.
No API key, no paid upgrade, no LLM key anywhere. Free tunnel, free
everything.

Full auth internals live in `docs/MCP_CHATGPT.md`; this file is only the
exact click-path.

## Status: UNPROVEN

The local MCP server, OAuth issuer, and pairing flow are tested
(`tests/mcp-server.test.ts`, `tests/mcp-oauth.test.ts`). The **real
ChatGPT-side connection is UNPROVEN**: on 2026-10-08 the tunnel OAuth
callback did not persist the connected account in ChatGPT (Connect showed
disabled/spinner/internal errors) and the reconnect was never resolved.
Test the steps below on the real ChatGPT account and report what happens;
do not claim it works until the tool list loads inside ChatGPT.

## Prerequisites (one time)

- Node 22+, this repo installed (`pnpm install --frozen-lockfile`) and
  built (`pnpm run build`).
- `cloudflared` installed (free, no account): https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
- The Chrome extension installed from the latest release ZIP
  (`Load unpacked`), paired to the local relay (see `docs/EXTENSION.md`).
- ChatGPT account with developer mode / custom MCP servers available
  (verified present on `chinmayshastry05@gmail.com`, Go plan).

## Connect steps

**1. Start the tunnel FIRST** (it retries against the closed port; that is
fine):

```bash
cloudflared tunnel --url http://localhost:8933
```

Copy the `https://<random>.trycloudflare.com` URL it prints. It rotates on
every restart — you will re-do these steps each time.

**2. Start the MCP server with that URL as the issuer:**

```bash
node dist/src/index.js mcp --transport http --port 8933 --issuer https://<random>.trycloudflare.com
```

The server prints a **one-time OAuth pairing code** to the terminal.
Keep the terminal visible. (`--issuer` is required: without it, discovery
hands ChatGPT loopback auth URLs it can never reach. `ABB_PUBLIC_URL` env
works too; the flag wins.)

**3. In ChatGPT:** Settings/Plugins → Add → **"Add custom MCP server"** →
paste `https://<random>.trycloudflare.com/mcp` → authentication: **OAuth**.
(There is no Bearer/API-key field; do not pick "No authentication" — the
server answers 401 to that.)

**4. Approve:** ChatGPT opens the bridge's `/authorize` page. Enter the
pairing code from step 2, click Approve.

**5. Done:** ChatGPT exchanges the code (PKCE) for an access token and
lists the tools. Ask it to `browser_navigate` somewhere harmless
(e.g. `https://example.com`) and `browser_snapshot` to confirm it drives
the browser.

## After a restart

The tunnel URL changes on every `cloudflared` restart, and the pairing
code is per server start. Order: tunnel → copy URL → restart bridge with
`--issuer <new-url>` → re-register in ChatGPT → new pairing code.

## What GPT can and cannot do through the tools

- Read-only observation (`browser_snapshot`, `browser_get_text`,
  `browser_screenshot`, `browser_page_info`, …) just works.
- Clicks whose label matches a consequential keyword (buy/pay/checkout/
  delete/…) and typing into password fields **require your approval**: the
  tool returns a confirmation ticket id; approve in the bridge UI
  ("Pending confirmations") or `node dist/index.js approve <id> --yes`,
  then GPT retries. Icon-only buttons with no accessible name are NOT
  caught by this heuristic.
- **Login walls are refused, not faked:** navigating to a login-walled
  page fails with a clear error. The bridge holds no credentials and will
  never attempt to log in. Log in manually in your own browser if a page
  needs it.
- Slow pages: `browser_navigate` waits up to 30s for the page shell; use
  `browser_wait_for` for late-hydrating content.

## Troubleshooting

- `401` on `/mcp`: ChatGPT was configured with "No authentication", or
  the OAuth token expired — re-do the OAuth flow (step 3–4).
- "content script not ready" / ops fail: the extension is not paired or
  the tab is a `chrome://` page (content scripts cannot run there).
- Tunnel URL changed: see "After a restart" above.
- Pairing code rejected 5 times: the code locks; restart the bridge for a
  fresh one.
