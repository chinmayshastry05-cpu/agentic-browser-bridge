/**
 * tests/server-ui.test.ts — bridge server UI + JSON API (M7).
 *
 * Starts a real BridgeServer on a loopback port and exercises:
 *   GET  /ui                       -> status page HTML
 *   GET  /api/tasks                -> task list JSON
 *   GET  /api/confirmations        -> pending confirmations JSON
 *   POST /api/confirmations/:id    -> approve/reject from the UI
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BridgeServer } from '../src/server.js';
import { ConfirmationQueue } from '../src/security/confirm.js';

let base = '';
let server: BridgeServer | null = null;

beforeAll(async () => {
  process.env['ABB_DATA_DIR'] = mkdtempSync(join(tmpdir(), 'abb-ui-test-'));
  server = new BridgeServer({ port: 0 });
  await server.listen();
  const inner = (server as unknown as { server: { address(): { port: number } } }).server;
  base = `http://127.0.0.1:${inner.address().port}`;
});

afterAll(async () => {
  await server?.stop();
  server = null;
});

describe('bridge server UI and API', () => {
  it('serves the status page', async () => {
    const res = await fetch(`${base}/ui`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('Agentic Browser bridge');
    expect(html).toContain('/api/confirmations');
  });

  it('lists tasks (empty at first)', async () => {
    const res = await fetch(`${base}/api/tasks`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it('approves a confirmation through the API', async () => {
    const queue = new ConfirmationQueue(); // same ABB_DATA_DIR
    const c = queue.request(
      'task-ui-test',
      { action: 'type', ref: 'e5', text: 'x' },
      'typing into a password field requires explicit user confirmation',
      'high',
      { url: 'https://example.test/', snapshotId: null, navGeneration: 0, pageNonce: 'n' },
    );

    const listed = (await (await fetch(`${base}/api/confirmations`)).json()) as Array<{ id: string }>;
    expect(listed.map((x) => x.id)).toContain(c.id);

    const approved = await fetch(`${base}/api/confirmations/${c.id}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approved: true }),
    });
    expect(approved.status).toBe(200);
    expect(((await approved.json()) as { approved: boolean }).approved).toBe(true);

    const after = (await (await fetch(`${base}/api/confirmations`)).json()) as unknown[];
    expect(after).toEqual([]);
  });

  it('rejects bad approval requests', async () => {
    const badBody = await fetch(`${base}/api/confirmations/confirm-nope`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approved: 'maybe' }),
    });
    expect(badBody.status).toBe(400);

    const unknown = await fetch(`${base}/api/confirmations/confirm-doesnotexist`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approved: true }),
    });
    expect(unknown.status).toBe(400);
  });
});
