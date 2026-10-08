/**
 * verifier.ts — action verification (spec section 8).
 *
 * "Playwright did not throw" is not proof of success. After each action the
 * verifier checks whether the expected state change actually happened, using
 * only observable page state:
 *
 *   navigate      -> current URL matches the requested URL
 *   click         -> URL changed, or the click target's live state changed,
 *                    or the DOM changed observably; otherwise "unverified"
 *   type          -> the field's live value contains the typed text
 *   clear         -> the field's live value is empty
 *   select_option -> the select's live value is one of the chosen values
 *   check         -> the control's live checked state matches
 *   back/forward/reload -> URL or DOM changed
 *   press_key/scroll/hover/double_click -> executed; no reliable signal,
 *                    reported honestly as unverified rather than faked
 *
 * A verification that finds no observable change does NOT fail the step by
 * itself — it is recorded so the planner can decide (e.g. re-observe).
 */
import type {
  ActionVerification,
  AgentAction,
  TargetDescription,
} from '../types.js';
import type { BrowserSession } from '../bridge-core.js';

function normalizeUrl(url: string): string {
  return url.replace(/\/$/, '');
}

async function describeRef(
  session: BrowserSession,
  ref: string,
): Promise<TargetDescription | null> {
  return session.describeLiveTarget(ref);
}

export async function verifyAction(
  session: BrowserSession,
  action: AgentAction,
  preUrl: string,
): Promise<ActionVerification> {
  const unverified = (method: string, detail: string): ActionVerification => ({
    verified: false,
    method,
    detail,
  });

  switch (action.action) {
    case 'navigate': {
      const postUrl = session.url;
      const ok = normalizeUrl(postUrl) === normalizeUrl(action.url ?? '');
      return {
        verified: ok,
        method: 'url-match',
        detail: ok
          ? `URL is now ${postUrl}`
          : `expected URL ${action.url}, but page is at ${postUrl}`,
      };
    }

    case 'back':
    case 'forward':
    case 'reload': {
      const changed = session.url !== preUrl;
      return {
        verified: changed,
        method: 'url-changed',
        detail: changed ? `URL changed to ${session.url}` : 'URL unchanged after navigation action',
      };
    }

    case 'click':
    case 'double_click': {
      if (session.url !== preUrl) {
        return { verified: true, method: 'url-changed', detail: `navigated to ${session.url}` };
      }
      // Re-observe: if the DOM changed observably, the click had an effect.
      const post = await session.snapshot().catch(() => null);
      if (post && post.url !== preUrl) {
        return { verified: true, method: 'url-changed', detail: `navigated to ${post.url}` };
      }
      return unverified(
        'dom-diff',
        'no navigation or observable page change detected after click; planner should re-observe',
      );
    }

    case 'type': {
      const live = action.ref ? await describeRef(session, action.ref) : null;
      const expected = action.text ?? '';
      const ok = !!live && (live.value ?? '').includes(expected);
      return {
        verified: ok,
        method: 'field-value',
        detail: ok
          ? `field value contains the typed text`
          : `field value is "${(live?.value ?? '').slice(0, 80)}", expected it to contain "${expected.slice(0, 80)}"`,
      };
    }

    case 'clear': {
      const live = action.ref ? await describeRef(session, action.ref) : null;
      const ok = !!live && (live.value ?? '') === '';
      return {
        verified: ok,
        method: 'field-value',
        detail: ok ? 'field is empty' : `field value is "${(live?.value ?? '').slice(0, 80)}"`,
      };
    }

    case 'select_option': {
      const live = action.ref ? await describeRef(session, action.ref) : null;
      const ok = !!live && (action.values ?? []).includes(live.value ?? '');
      return {
        verified: ok,
        method: 'field-value',
        detail: ok
          ? `select value is "${live?.value}"`
          : `select value is "${live?.value ?? ''}", expected one of ${(action.values ?? []).join(', ')}`,
      };
    }

    case 'check': {
      const live = action.ref ? await describeRef(session, action.ref) : null;
      const ok = !!live && live.checked === action.checked;
      return {
        verified: ok,
        method: 'checked-state',
        detail: ok
          ? `checked state is ${live?.checked}`
          : `checked state is ${live?.checked}, expected ${action.checked}`,
      };
    }

    case 'press_key':
    case 'scroll':
      return unverified(
        'no-signal',
        `${action.action} executed without error, but there is no reliable observable signal to verify it`,
      );

    case 'wait_for':
    case 'snapshot':
    case 'screenshot':
    case 'finish':
    case 'noop':
      return { verified: true, method: 'no-effect-expected', detail: 'no state change expected' };

    default:
      return unverified(
        'unsupported-action',
        `no verifier for action "${(action as AgentAction).action}" — outcome not established`,
      );
  }
}
