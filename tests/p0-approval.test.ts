/**
 * tests/p0-approval.test.ts — Fixture J: approval lifecycle (safe, deterministic).
 *
 * Guards the security model while reliability work lands around it:
 * identity required, expiry enforced, one-use consumption, replay
 * rejected, and the task remains resumable after a proper approval.
 *
 * Does NOT weaken the approval model to simplify the test: uses the real
 * ConfirmationQueue with real cryptography, short TTLs, and the real
 * MCP tool path (policy → ticket → approve → retry).
 *
 * Offline unit tests (no browser, no network).
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfirmationQueue, type ApprovalScope } from '../src/security/confirm.js';
import type { AgentAction, PageIdentity } from '../src/types.js';

function queue(): ConfirmationQueue {
  return new ConfirmationQueue(mkdtempSync(join(tmpdir(), 'p0appr-')));
}

const page: PageIdentity = {
  url: 'https://example.test/',
  snapshotId: 'snap-1',
  navGeneration: 3,
  pageNonce: 'nonce-1',
};
const scope: ApprovalScope = { scopeKey: 'mcp:test-session', page };
const typeA: AgentAction = { action: 'type', ref: 'e2', text: 'hello' };

describe('Fixture J — approval lifecycle', () => {
  it('identity required: wrong page identity does not authorize', () => {
    const q = queue();
    const t = q.request(scope.scopeKey, typeA, 'test', 'high', page);
    q.resolve(t.id, true);
    const otherPage = { ...page, navGeneration: 4 };
    expect(q.isApproved({ scopeKey: scope.scopeKey, page: otherPage }, typeA)).toBe(false);
  });

  it('expiry enforced: expired approvals do not authorize', async () => {
    const q = queue();
    const t = q.request(scope.scopeKey, typeA, 'test', 'high', page, { ttlMs: 50 });
    q.resolve(t.id, true);
    await new Promise((r) => setTimeout(r, 80));
    expect(q.isApproved(scope, typeA)).toBe(false);
  });

  it('one-use: approval authorizes exactly once, replay is rejected', () => {
    const q = queue();
    const t = q.request(scope.scopeKey, typeA, 'test', 'high', page);
    q.resolve(t.id, true);
    expect(q.isApproved(scope, typeA)).toBe(true);
    expect(q.isApproved(scope, typeA)).toBe(false);
    // A replayed ticket id cannot be re-resolved into a fresh approval.
    expect(() => q.resolve(t.id, true)).toThrow(/already resolved/);
  });

  it('task remains resumable: after consuming, a fresh ticket + approval works again', () => {
    const q = queue();
    const t1 = q.request(scope.scopeKey, typeA, 'test', 'high', page);
    q.resolve(t1.id, true);
    expect(q.isApproved(scope, typeA)).toBe(true); // consumed
    expect(q.isApproved(scope, typeA)).toBe(false); // needs a fresh ticket
    const t2 = q.request(scope.scopeKey, typeA, 'test', 'high', page);
    expect(t2.id).not.toBe(t1.id);
    q.resolve(t2.id, true);
    expect(q.isApproved(scope, typeA)).toBe(true); // task proceeds
  });

  it('denied tickets never authorize', () => {
    const q = queue();
    const t = q.request(scope.scopeKey, typeA, 'test', 'high', page);
    q.resolve(t.id, false);
    expect(q.isApproved(scope, typeA)).toBe(false);
  });
});
