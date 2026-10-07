/**
 * redact.ts — secret redaction (spec section 12).
 *
 * Secrets must never be treated as ordinary model context: not logged, not
 * persisted, not sent to the LLM merely because they appear in a page.
 *
 * redactSecrets() scrubs the common shapes: API keys, bearer tokens, AWS
 * keys, private-key blocks, credit-card numbers, and password= assignments.
 * It is applied to planner-bound page summaries (the element tree/brief can
 * contain visible secrets); page text the agent explicitly requested via
 * browser_get_text is left intact so read tasks keep working, and typed
 * input is redacted at the task-store layer instead.
 *
 * This is a best-effort safety net, not a guarantee — documented as such.
 */
const PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  { name: 'aws-key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { name: 'openai-key', re: /\bsk-[A-Za-z0-9_-]{8,}\b/g },
  { name: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{8,}\b/g },
  { name: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{8,}\b/g },
  { name: 'bearer', re: /\b[bB]earer\s+[A-Za-z0-9._~+/-]{8,}={0,2}\b/g },
  { name: 'password-assign', re: /\b(password|passwd|pwd)\s*[:=]\s*\S+/gi },
  { name: 'apikey-assign', re: /\b(api[_-]?key|secret[_-]?key|access[_-]?token)\s*[:=]\s*["']?\S+["']?/gi },
  // 13-19 digit card-like runs with separators.
  { name: 'card', re: /\b(?:\d[ -]*?){13,19}\b/g },
];

/**
 * Replace likely secret values with [REDACTED:<kind>]. Returns the scrubbed
 * text and the kinds that were found.
 */
export function redactSecrets(text: string): { text: string; redacted: string[] } {
  const found = new Set<string>();
  let out = text;
  for (const { name, re } of PATTERNS) {
    re.lastIndex = 0;
    if (re.test(out)) {
      found.add(name);
      re.lastIndex = 0;
      out = out.replace(re, `[REDACTED:${name}]`);
    }
  }
  return { text: out, redacted: [...found] };
}

/** True when the text contains anything redactSecrets would scrub. */
export function containsSecret(text: string): boolean {
  return redactSecrets(text).redacted.length > 0;
}
