/**
 * demo-lib.ts — the local end-to-end demo, importable by both the CLI
 * (`node dist/index.js demo`) and the demo script (`node dist/demo/demo.js`).
 *
 * Fully offline: drives the bundled demo/page.html via a file:// URL, types
 * into the name field, clicks the greet button, asserts the greeting appears,
 * and saves a screenshot to demo/output/.
 */
import { mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserSession } from './bridge-core.js';
import { findByRole } from './analyzer.js';
import { buildTree, renderTree } from './tree.js';

/** Project root = nearest ancestor directory containing package.json. */
export function projectRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    dir = dirname(dir);
  }
  throw new Error('could not locate project root (no package.json found walking up)');
}

export interface DemoResult {
  greeting: string;
  screenshotPath: string;
  nodeCount: number;
}

export async function runDemo(): Promise<DemoResult> {
  const root = projectRoot();
  const pagePath = join(root, 'demo', 'page.html');
  if (!existsSync(pagePath)) {
    throw new Error(`demo page missing: ${pagePath} (run from the project root)`);
  }
  const outDir = join(root, 'demo', 'output');
  mkdirSync(outDir, { recursive: true });
  const screenshotPath = join(outDir, 'demo-screenshot.png');

  const session = new BrowserSession('demo');
  await session.start({ headless: true });
  try {
    const pageUrl = `file://${pagePath}`;
    console.log(`[demo] navigating to ${pageUrl}`);
    await session.navigate(pageUrl);

    // OBSERVE
    const snap = await session.snapshot();
    console.log(`[demo] snapshot: "${snap.title}" — ${snap.nodes.length} nodes`);
    console.log('[demo] element tree (excerpt):');
    console.log(renderTree(buildTree(snap.nodes), 4, 25));

    // PLAN (scripted for the demo): find the name field and the greet button.
    // NOTE: select by role first — a naive name search would also match the
    // <main> landmark whose accessible name contains the page prose.
    const [nameField] = findByRole(snap, 'textbox');
    if (!nameField) throw new Error('demo: name textbox not found in snapshot');
    const greetBtn = findByRole(snap, 'button').find((b) =>
      b.name.toLowerCase().includes('greet'),
    );
    if (!greetBtn) throw new Error('demo: greet button not found in snapshot');
    console.log(`[demo] typing into ${nameField.ref} ("${nameField.name}")`);
    console.log(`[demo] clicking ${greetBtn.ref} ("${greetBtn.name}")`);

    // ACT
    await session.type(nameField.ref, 'Ada');
    await session.click(greetBtn.ref);

    // VERIFY: re-snapshot and check the greeting text appeared.
    const after = await session.snapshot();
    const greetingNode = after.nodes.find((n) => n.text?.includes('Hello, Ada!'));
    const greeting = greetingNode?.text ?? '';
    if (!greetingNode) {
      throw new Error('demo FAILED: greeting text did not appear after clicking');
    }
    console.log(`[demo] verified page text: "${greeting}"`);

    await session.screenshot(screenshotPath);
    console.log(`[demo] screenshot saved: ${screenshotPath}`);
    console.log('[demo] SUCCESS — observe/plan/act loop works end to end.');
    return { greeting, screenshotPath, nodeCount: after.nodes.length };
  } finally {
    await session.close();
  }
}
