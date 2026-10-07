# Acceptance suite (spec section 21)

Every item below is exercised by an automated test or a recorded manual
procedure. "Evidence" is the command plus what it proved — no "should work".

Run everything: `npm test` (unit + integration + real-browser).
Full check: `npm run build && npm test && npm run demo`.

## A. Installation

| Check | Evidence |
|---|---|
| clean install | `npm install` on the published repo; `node_modules` present |
| build succeeds (tsc strict, zero errors) | `npm run build` — PASS |
| doctor/status work | `node dist/src/index.js doctor` — all PASS (provider is a non-failing WARN); `node dist/src/index.js status` — prints JSON |

## B. Isolated browser

`tests/browser.test.ts` (headless Chromium via PlaywrightBackend, local fixture server):

| Check | Test |
|---|---|
| launch isolated browser | all tests in the file |
| navigate | `makeSession()` navigates to `/v1.html` |
| snapshot | every test |
| click | fills form controls; double-click/hover/focus/press_key/scroll |
| type | fills form controls; verified by field value |
| screenshot | `tests/cdp.test.ts` writes and size-checks a PNG |

## C. Existing browser

`tests/cdp.test.ts` — launches a **standalone** Chromium with
`--remote-debugging-port` (not via Playwright), then:

- attach to the explicit loopback endpoint; non-loopback endpoints refused
- enumerate the browser's real tabs
- open/switch/close tabs
- navigate, snapshot, screenshot on the user's browser
- disconnect does **not** kill the user's browser (endpoint still responds)

`evidence-real-user.mjs` (one-off, 2026-10-07): full agent loop against the
attached browser — observe → type → click → verified visible change
("Status for Ada: shipped", before/after screenshots in /tmp/abb-evidence-*.png).

## D. Dynamic page

`tests/browser.test.ts` › "waits for delayed content instead of failing":
element appears after 1500ms; `browser_wait_for` waits instead of failing.

## E. Stale reference

- Unit: `tests/mcp.test.ts` › grounding — reorder, ambiguous duplicates (refused), no-candidate (refused), identity change (refused, no click issued).
- Real browser: `tests/browser.test.ts` › "re-grounds a stale ref after the element is replaced" — the Swap-me button replaces its own node; the loop re-grounds by semantic match (confidence ≥ 0.7) and clicks the replacement; ambiguous cases throw instead of guessing.

## F. Tabs

`tests/cdp.test.ts` (real browser) and `tests/mcp.test.ts` (unit): open, list,
switch, close; last-tab close refused.

## G. Frames

`tests/browser.test.ts` › "inspects and interacts with an iframe":
`browser_frames` lists the iframe, `browser_frame_snapshot` returns
frame-scoped refs, clicking the in-frame button works, frame ids survive
re-listing.

## H. Shadow DOM

`tests/browser.test.ts` › "pierces open shadow DOM": the walker pierces open
shadow roots (including non-interactable hosts); selectors are
shadow-root-relative so Playwright's piercing CSS engine resolves them;
clicking the shadow button has the verified effect. Closed shadow roots are
not accessible — documented limitation.

## I. Forms

`tests/browser.test.ts` › "fills form controls and verifies values": text
input, clear, textarea, select option, checkbox, radio; greeting verified in
page text.

## J. Upload

`tests/browser.test.ts` › "uploads a user-selected file and tracks downloads":
real `setInputFiles` with a temp file; page shows `chosen: avatar.png`;
missing file rejected with an error, not silently ignored.

## K. Download

Same test: clicks the fixture download link, `waitForDownload` resolves,
file exists at the recorded bridge-local path with safe filename and
expected bytes; `browser_downloads` lists it.

## L. Visual grounding

Screenshot support exists (`browser_screenshot`, attached to task state as
artifacts) and screenshots are taken in the CDP and evidence runs. A
pluggable visual-perception interface that maps screenshot regions to
grounded DOM candidates is **not yet implemented** — when DOM grounding is
insufficient the agent re-observes via snapshot, not via vision. Status:
PARTIAL (see README limitations).

## M. Prompt injection

- `tests/security.test.ts`: detector unit tests for all six shapes;
  adversarial `tests/fixtures/injection.html` flagged (override, extraction,
  exfiltration); benign login text stays clean.
- Loop-level: SECURITY NOTICE is appended to the planner message naming the
  patterns found (verified by capturing the provider's messages).
- Architecture: system prompt marks page content untrusted; policy engine
  gates consequential actions regardless of page text.

## N. Risky action

- `tests/security.test.ts`: password-field typing → `confirm` verdict;
  strict mode confirms medium-risk actions.
- Loop: `confirm` verdict → `awaiting_confirmation` + `PendingConfirmation`
  registered; the model cannot self-approve.
- CLI/API verified live: `approve <id> --yes` in a second process resolved
  a confirmation created in the first; double-approval rejected; UI
  `/api/confirmations` POST approve/reject exercised over HTTP.

## O. Persistence

`tests/state.test.ts`: create/append/get/list/close/interrupt/prune;
typed text redacted on disk (verified by reading the JSON back);
loop integration persists every step and closes the task `completed`;
interrupted tasks refuse resume once finished; bad ids rejected.

## P. Failure

`tests/mcp.test.ts` › "stops after one failed retry": fatal errors are not
retried; recoverable ones get exactly one retry; the loop always terminates
with a terminal status (`completed`/`failed`/`blocked`/
`awaiting_confirmation`). No unbounded loops anywhere (maxSteps caps runs,
waitForDownload has a timeout, retries are capped at one).
