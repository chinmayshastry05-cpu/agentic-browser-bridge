# Action contract (effects, refusals, verify, capture evidence)

Bridge stays DOM / accessibility-tree first. Agents read and act on the code
layer by `ref`. Screenshots are an optional evidence aid, never the driver.

## Effect codes
Every action tool result carries `effect`:
`confirmed` (needs `evidence`), `partial`, `unverifiable`, `suspected_noop`, `refused` (carries `error` + `refusal`, no `delivery`).
Invariants are checked by `validateActionResult` (src/effects.ts) before a result is returned.
Result also reports `route` (`trusted_input` | `dom_event`) and `delivery` (`background` | `foreground`).

## Refusal envelope
`{ status: "refused", refusal: { code, message, hint }, escalation: { target, reason } }`
plus the legacy `blocked/reason/modal/occluder/suggestedNextStep` fields for modal blocks.
Codes: blocked_by_modal, stale_ref, unknown_ref, unsupported_route, unsupported_delivery,
unsupported_backend, invalid_argument, stale_capture, unknown_capture, out_of_bounds.
Refused actions are never auto-retried by the agent loop; the caller decides.
`click`/`type` accept `delivery_mode` and `input_route`. `dom_event` needs the CDP/Playwright backend;
the extension backend refuses it instead of silently downgrading.

## browser_verify
Agent-declared predicates over `url` / `title` / `element` (ref + role/name/value/visible/checked).
Polls up to 10 s, needs 2 stable samples. Returns `satisfied | unsatisfied | unknown` with
`unknown_reason` per predicate. Absence (`exists:false`) is rejected: it cannot be told from a stale ref.

## Screenshot evidence
`browser_snapshot { include_screenshot: true }` adds a PNG (MCP image block) with `device_pixel_ratio`,
viewport and `scale`, and a one-use `capture_id`. `browser_click_at { capture_id, x, y }` maps image
pixels to CSS pixels, runs the same policy gate, and refuses `stale_capture` after navigation, reuse, or
a new snapshot of the page.

## MCP
Every tool has annotations, an `outputSchema` (including the refusal shape) and `structuredContent`.
Input schemas are closed: unknown arguments are rejected.
