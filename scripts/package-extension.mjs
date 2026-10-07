#!/usr/bin/env node
/**
 * Package the tested extension/ directory into a distributable MV3 zip.
 *
 * Usage: npm run package-extension
 * Output: dist/abb-extension-<version>.zip  (<version> from extension/manifest.json)
 *
 * No new npm dependencies: shells out to the `zip` CLI first, falls back to
 * python3 (zipfile). Fails loudly if the zip is missing manifest.json or if
 * manifest_version is not 3.
 */

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const extDir = join(repoRoot, 'extension');
const distDir = join(repoRoot, 'dist');

function fail(msg) {
  console.error(`package-extension: ERROR: ${msg}`);
  process.exit(1);
}

// ---- read + validate manifest ----
const manifestPath = join(extDir, 'manifest.json');
if (!existsSync(manifestPath)) fail('extension/manifest.json not found');
let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
} catch (e) {
  fail(`extension/manifest.json is not valid JSON: ${e.message}`);
}
if (manifest.manifest_version !== 3) {
  fail(`manifest_version is ${JSON.stringify(manifest.manifest_version)}, expected 3`);
}
const version = String(manifest.version || '').trim();
if (!version) fail('extension/manifest.json has no version');

// ---- collect file list ----
const REQUIRED = ['manifest.json', 'background.js', 'content.js', 'popup.html', 'popup.js'];
const EXCLUDE_PATTERNS = [/node_modules/i, /^\.git(\/|$)/, /\.DS_Store$/i, /\.(pem|key)$/i, /(^|\/)(secret|secrets)(\/|$)/i];

function listFiles(dir, base) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    const abs = join(dir, name);
    const rel = base ? `${base}/${name}` : name;
    if (EXCLUDE_PATTERNS.some((re) => re.test(rel) || re.test(name))) continue;
    if (statSync(abs).isDirectory()) out.push(...listFiles(abs, rel));
    else out.push(rel);
  }
  return out;
}

const files = [];
for (const f of REQUIRED) {
  if (!existsSync(join(extDir, f))) fail(`required file missing: extension/${f}`);
  files.push(f);
}
const iconsDir = join(extDir, 'icons');
if (existsSync(iconsDir) && statSync(iconsDir).isDirectory()) {
  files.push(...listFiles(iconsDir, 'icons'));
}
for (const f of files) {
  if (EXCLUDE_PATTERNS.some((re) => re.test(f))) fail(`excluded pattern matched file to include: ${f}`);
}

const outName = `abb-extension-${version}.zip`;
const outPath = join(distDir, outName);

console.log('Files included:');
for (const f of files) console.log(`  ${f}`);

mkdirSync(distDir, { recursive: true });
if (existsSync(outPath)) rmSync(outPath);

// ---- zip it: try `zip` CLI first, fall back to python3 ----
let usedTool = '';
try {
  execFileSync('zip', ['-v'], { stdio: 'ignore' });
  execFileSync(
    'zip',
    ['-X', '-9', '-q', outPath, ...files,
      '-x', 'node_modules/*', '-x', '.git/*', '-x', '*.pem', '-x', '*.key', '-x', '.DS_Store'],
    { cwd: extDir, stdio: 'pipe' },
  );
  usedTool = 'zip CLI';
} catch {
  console.log('`zip` CLI unavailable, falling back to python3 -m zipfile');
  // stage the explicit file list in a temp dir, then zip it (exclusions already applied)
  const stage = join(tmpdir(), `abb-ext-stage-${Date.now()}`);
  try {
    for (const f of files) {
      const dst = join(stage, f);
      mkdirSync(dirname(dst), { recursive: true });
      copyFileSync(join(extDir, f), dst);
    }
    const py = `
import sys, json, zipfile, pathlib
out = sys.argv[1]
files = json.loads(sys.argv[2])
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as z:
    for f in files:
        z.write(pathlib.Path(sys.argv[3]) / f, f)
print("ok")
`;
    execFileSync('python3', ['-c', py, outPath, JSON.stringify(files), stage], { stdio: 'pipe' });
    usedTool = 'python3 zipfile';
  } catch (e) {
    fail(`both zip backends failed: ${e.message}`);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

if (!existsSync(outPath) || statSync(outPath).size === 0) {
  fail(`zip was not created or is empty: ${outPath}`);
}

// ---- verify: manifest.json inside, and its manifest_version is 3 ----
try {
  const py = `
import sys, json, zipfile
z = zipfile.ZipFile(sys.argv[1])
names = z.namelist()
assert "manifest.json" in names, "manifest.json not in zip"
m = json.loads(z.read("manifest.json"))
assert m.get("manifest_version") == 3, f"manifest_version={m.get('manifest_version')} != 3"
print("manifest.json present, manifest_version=3")
`;
  const out = execFileSync('python3', ['-c', py, outPath], { encoding: 'utf8' });
  console.log(out.trim());
} catch (e) {
  fail(`zip verification failed: ${e.message}`);
}

// ---- checksum ----
const zipBytes = readFileSync(outPath);
const sha256 = createHash('sha256').update(zipBytes).digest('hex');

console.log('');
console.log(`tool:     ${usedTool}`);
console.log(`output:   ${outPath}`);
console.log(`sha256:   ${sha256}`);
console.log(`bytes:    ${zipBytes.length}`);
console.log('package-extension: OK');
