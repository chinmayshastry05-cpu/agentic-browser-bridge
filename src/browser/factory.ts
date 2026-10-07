/**
 * Backend factory — picks the BrowserBackend implementation by name.
 * Keeps CLI/server wiring in one place so `serve`/`agent`/`mcp` can select
 * the extension backend without importing each implementation.
 */
import type { BrowserBackend } from '../types.js';
import { PlaywrightBackend } from './playwright-backend.js';
import { ExtensionBackend } from './extension-backend.js';

export type BackendName = 'playwright' | 'extension';

export function parseBackendName(raw: string | undefined): BackendName {
  if (!raw || raw === 'playwright') return 'playwright';
  if (raw === 'extension') return 'extension';
  throw new Error(`unknown backend "${raw}" — expected "playwright" or "extension"`);
}

/** Fresh backend instance per call (backends hold connection state). */
export function createBackend(name: BackendName = 'playwright'): BrowserBackend {
  return name === 'extension' ? new ExtensionBackend() : new PlaywrightBackend();
}
