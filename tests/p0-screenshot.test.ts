/**
 * tests/p0-screenshot.test.ts — P0-7 screenshot capture coordinator.
 *
 * Real-site evidence (v0.1.3, independent): rapid consecutive screenshots
 * failed with MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND. The session now
 * serializes captures and enforces the backend's minimum interval, and
 * maps raw quota errors to an actionable message.
 *
 * Deterministic unit tests with a fake backend (no real browser needed):
 * burst behavior, spacing, and error mapping are timing-asserted.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserSession } from '../src/bridge-core.js';
import { MockBackend } from './fixtures/mock-backend.js';

class PacingMockBackend extends MockBackend {
  readonly screenshotMinIntervalMs = 60;
  captureTimes: number[] = [];
  concurrent = 0;
  maxConcurrent = 0;

  override async screenshot(path: string): Promise<void> {
    this.concurrent += 1;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.concurrent);
    this.captureTimes.push(Date.now());
    await new Promise((r) => setTimeout(r, 5));
    this.concurrent -= 1;
    this.screenshots.push(path);
  }
}

class QuotaMockBackend extends MockBackend {
  override async screenshot(_path: string): Promise<void> {
    throw new Error('MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND');
  }
}

describe('P0-7 screenshot coordinator', () => {
  it('burst of concurrent screenshots: all succeed, serialized, spaced', async () => {
    const backend = new PacingMockBackend();
    const session = new BrowserSession('p0shot', backend);
    const dir = mkdtempSync(join(tmpdir(), 'p0shot-'));
    const t0 = Date.now();
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => session.screenshot(join(dir, `s${i}.png`))),
    );
    const elapsed = Date.now() - t0;
    expect(results).toHaveLength(8);
    expect(results.every((r) => r.path.endsWith('.png'))).toBe(true);
    // Serialized: never two captures in flight.
    expect(backend.maxConcurrent).toBe(1);
    // Spaced: 8 captures at >=60ms intervals => >= 420ms total.
    expect(elapsed).toBeGreaterThanOrEqual(400);
    // Bounded: not absurdly slow either (8 * 60ms + overhead < 3s).
    expect(elapsed).toBeLessThan(3000);
    for (let i = 1; i < backend.captureTimes.length; i++) {
      expect(backend.captureTimes[i]! - backend.captureTimes[i - 1]!).toBeGreaterThanOrEqual(50);
    }
  });

  it('backends without a quota get serialization but no added delay', async () => {
    const backend = new MockBackend(); // no screenshotMinIntervalMs
    const asBackend = backend as import('../src/types.js').BrowserBackend;
    expect(asBackend.screenshotMinIntervalMs).toBeUndefined();
    const session = new BrowserSession('p0shot2', backend);
    const dir = mkdtempSync(join(tmpdir(), 'p0shot-'));
    const t0 = Date.now();
    await Promise.all(
      Array.from({ length: 4 }, (_, i) => session.screenshot(join(dir, `s${i}.png`))),
    );
    // No artificial pacing: 4 quick mock captures well under a second.
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('raw browser quota errors are mapped to an actionable message', async () => {
    const session = new BrowserSession('p0shot3', new QuotaMockBackend());
    const err = await session
      .screenshot(join(mkdtempSync(join(tmpdir(), 'p0shot-')), 's.png'))
      .catch((e) => e);
    const msg = String(err.message);
    expect(msg).toContain('rate-limited by the browser');
    expect(msg).toContain('wait briefly and retry');
    // The raw browser constant is kept as debuggability detail, but the
    // actionable guidance comes first.
    expect(msg.indexOf('rate-limited by the browser')).toBeLessThan(
      msg.indexOf('MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND'),
    );
  });

  it('a failed capture does not break the coordinator for later captures', async () => {
    let failOnce = true;
    class Flaky extends PacingMockBackend {
      override async screenshot(path: string): Promise<void> {
        if (failOnce) {
          failOnce = false;
          throw new Error('boom');
        }
        return super.screenshot(path);
      }
    }
    const backend = new Flaky();
    const session = new BrowserSession('p0shot4', backend);
    const dir = mkdtempSync(join(tmpdir(), 'p0shot-'));
    await expect(session.screenshot(join(dir, 'a.png'))).rejects.toThrow('boom');
    const r = await session.screenshot(join(dir, 'b.png'));
    expect(r.path).toContain('b.png');
    expect(backend.screenshots).toContain(join(dir, 'b.png'));
  });
});
