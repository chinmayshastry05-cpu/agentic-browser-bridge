/**
 * demo/demo.ts — thin wrapper so `pnpm demo` runs the local end-to-end demo.
 * All demo logic lives in src/demo-lib.ts (shared with the CLI).
 */
import { runDemo } from '../src/demo-lib.js';

runDemo().catch((err) => {
  console.error('[demo] FAILED:', (err as Error).message);
  process.exit(1);
});
