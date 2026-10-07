
/**
 * Pairing-code hardening (round 3): 128-bit entropy, brute-force bound (5),
 * 10-minute expiry for generated codes, single-use rotation on success.
 * Each test starts its own server so lockout/expiry never pollute the main
 * OAuth flow in mcp-oauth.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { BrowserSession } from '../src/bridge-core.js';
import { MockBackend } from './fixtures/mock-backend.js';
import { buildMcpServer, startMcpServer } from '../src/mcp/server.js';
import { generatePairingCode } from '../src/mcp/oauth.js';
import { approveAttempt } from './mcp-oauth.test.js';

async function registerTestClient(base: string): Promise<string> {
  const res = await fetch(base + '/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ redirect_uris: ['http://localhost:9999/cb'] }),
  });
  expect(res.status).toBe(201);
  const body = (await res.json()) as { client_id: string };
  return body.client_id;
}

function withPairingEnv(code: string | undefined, fn: () => Promise<void>): Promise<void> {
  const prev = process.env['ABB_OAUTH_PAIRING_CODE'];
  if (code === undefined) delete process.env['ABB_OAUTH_PAIRING_CODE'];
  else process.env['ABB_OAUTH_PAIRING_CODE'] = code;
  return fn().finally(() => {
    if (prev === undefined) delete process.env['ABB_OAUTH_PAIRING_CODE'];
    else process.env['ABB_OAUTH_PAIRING_CODE'] = prev;
  });
}

describe('pairing-code hardening', () => {
  it('generated codes carry 128-bit entropy in operator-friendly grouping', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const code = generatePairingCode();
      // 32 hex chars (128 bits) in 8 dash-separated groups of 4.
      expect(code).toMatch(/^[0-9a-f]{4}(-[0-9a-f]{4}){7}$/);
      expect(code.replace(/-/g, '')).toHaveLength(32);
      seen.add(code);
    }
    expect(seen.size).toBe(50); // no collisions across 50 draws
  });

  it('5 wrong attempts lock the code out; the right code is then rejected too', async () => {
    await withPairingEnv('lockout-test-code', async () => {
      const session = new BrowserSession('mcp-pairing-lockout', new MockBackend());
      await session.start({ headless: true });
      const handle = await startMcpServer(() => buildMcpServer(session, {}), {
        transport: 'http',
        host: '127.0.0.1',
        port: 0,
      });
      try {
        const base = new URL(handle.url!).origin;
        const clientId = await registerTestClient(base);
        for (let i = 0; i < 4; i++) {
          const r = await approveAttempt(base, clientId, 'wrong-code');
          expect(r.status).toBe(403);
          expect(await r.text()).toContain('invalid pairing code');
        }
        const fifth = await approveAttempt(base, clientId, 'wrong-code');
        expect(fifth.status).toBe(403);
        expect(await fifth.text()).toMatch(/locked out/);
        // Even the correct code is rejected after lockout.
        const after = await approveAttempt(base, clientId, 'lockout-test-code');
        expect(after.status).toBe(403);
        expect(await after.text()).toMatch(/locked out/);
      } finally {
        await handle.close().catch(() => undefined);
        await session.close().catch(() => undefined);
      }
    });
  }, 60_000);

  it('generated codes expire (TTL override) with a clear message', async () => {
    await withPairingEnv(undefined, async () => {
      const session = new BrowserSession('mcp-pairing-expiry', new MockBackend());
      await session.start({ headless: true });
      const handle = await startMcpServer(() => buildMcpServer(session, {}), {
        transport: 'http',
        host: '127.0.0.1',
        port: 0,
        pairingCodeTtlMs: 60, // 60ms: lapses almost immediately
      });
      try {
        const base = new URL(handle.url!).origin;
        const clientId = await registerTestClient(base);
        await new Promise((r) => setTimeout(r, 150));
        const res = await approveAttempt(base, clientId, 'anything-at-all');
        expect(res.status).toBe(403);
        expect(await res.text()).toMatch(/expired/);
      } finally {
        await handle.close().catch(() => undefined);
        await session.close().catch(() => undefined);
      }
    });
  }, 60_000);

  it('successful approval retires a generated code (single-use): old rejected, fresh code works', async () => {
    await withPairingEnv(undefined, async () => {
      // Capture stderr to read the generated + rotated codes.
      const captured: string[] = [];
      const origWrite = process.stderr.write;
      process.stderr.write = ((chunk: unknown) => {
        captured.push(String(chunk));
        return true;
      }) as typeof process.stderr.write;
      const session = new BrowserSession('mcp-pairing-rotate', new MockBackend());
      await session.start({ headless: true });
      const handle = await startMcpServer(() => buildMcpServer(session, {}), {
        transport: 'http',
        host: '127.0.0.1',
        port: 0,
      });
      const codes = (): string[] =>
        captured
          .flatMap((line) => [...line.matchAll(/pairing code[^:]*: ([0-9a-f-]{39})/g)])
          .map((m) => m[1]!);
      try {
        const base = new URL(handle.url!).origin;
        const clientId = await registerTestClient(base);
        const first = codes().at(-1);
        expect(first).toBeTruthy();
        // Approve with the generated code -> 302 with an auth code.
        const ok = await approveAttempt(base, clientId, first!);
        expect(ok.status).toBe(302);
        // Single-use: a fresh code was issued and printed.
        const second = codes().at(-1);
        expect(second).toBeTruthy();
        expect(second).not.toBe(first);
        // The consumed code is now rejected...
        const stale = await approveAttempt(base, clientId, first!);
        expect(stale.status).toBe(403);
        // ...while the fresh code approves again.
        const ok2 = await approveAttempt(base, clientId, second!);
        expect(ok2.status).toBe(302);
      } finally {
        process.stderr.write = origWrite;
        await handle.close().catch(() => undefined);
        await session.close().catch(() => undefined);
      }
    });
  }, 60_000);
});
