# Chrome Extension Backend (MV3)

The bridge can drive a **normal user-launched Chrome** — no
`--remote-debugging-port` needed — through the unpacked extension in
`extension/`. The extension's service worker opens a WebSocket client to the
bridge's relay at `ws://127.0.0.1:<port>/extension` (loopback only) and
relays tab/page operations; the content script performs DOM
snapshot/click/type/scroll inside the page using the extension APIs
(`chrome.tabs`, `chrome.scripting`) — **not** CDP.

## Install the extension

1. Open `chrome://extensions` in Chrome.
2. Enable **Developer mode** (toggle, top right).
3. Click **Load unpacked** and select the `extension/` directory of this repo.
4. The extension's toolbar popup shows the relay connection status
   (disconnected / connecting / connected + the relay URL it is dialing).

## Connect the bridge

1. Start the bridge with the extension backend:
   ```bash
   node dist/src/index.js serve --backend extension
   ```
   (or select the extension backend in the UI/config you use).
2. The bridge listens for the extension on `ws://127.0.0.1:8932/extension`
   by default. The extension dials the relay URL shown in its popup
   (editable there; it only accepts `ws://127.0.0.1` / `ws://localhost`
   URLs — it will never connect to a remote host).
3. When the service worker connects, the popup shows **connected** and the
   bridge can list tabs, navigate, snapshot, click, type, and screenshot
   the active tab.

Port map: `8931` bridge HTTP · `8932` extension relay WS · `8933` MCP
Streamable HTTP.

## What the extension does

- Tab operations: list/activate/create/close tabs, navigate, go
  back/forward, reload.
- Page operations (via the content script in the **top frame only**):
  DOM snapshot (same node shape as the Playwright backend), click,
  double-click, type, clear, key presses, hover, focus, scroll into view,
  scroll by, select option, set checkbox, `waitForSelector`, page text,
  page info, viewport size, `elementFromPoint` hit testing, screenshot
  capture (`chrome.tabs.captureVisibleTab`).
- Reconnects with backoff if the bridge restarts.

## What it does NOT do (v1 limits, honest)

- **Top frame only.** Frame-scoped calls (`frameId` set) throw — the v1
  content script does not walk into iframes.
- **No file uploads.** The extension has no access to local files, so
  `browser_upload` is refused; use the Playwright backend for uploads.
- **No download tracking.** Downloads initiated in the user browser are
  handled by Chrome itself; the bridge does not observe them.
- **Synthetic input.** Clicks/types are dispatched as synthetic DOM events
  from the content script, not trusted OS-level input; some
  bot-detection-sensitive pages may behave differently.
- **Screenshots** capture the visible tab only.
- The relay accepts **exactly one** extension peer on loopback; a second
  connection replaces the first.

## Security notes

- The relay binds **127.0.0.1 only** and speaks plain WebSocket on
  loopback — never expose this port; it is browser control.
- The extension cannot be pointed at a remote relay URL (validated in the
  popup and the service worker).
- The same policy engine, confirmation gates, and secret redaction apply
  to extension-driven sessions as to Playwright/CDP sessions.
