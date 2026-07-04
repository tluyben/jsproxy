#!/usr/bin/env node
'use strict';

/**
 * Build a self-contained single-file executable with caxa.
 *
 * Unlike the `pkg` builds (build:linux-x86 etc.), caxa bundles the REAL Node.js
 * runtime plus the REAL node_modules — including the native `sqlite3` addon — and
 * self-extracts on first run. That means it runs the existing source unchanged,
 * with none of the native-module limitations that block `bun build --compile`.
 *
 *   npm run build:caxa            # -> dist/jsproxy-caxa (current OS/arch)
 *
 * The produced binary embeds whatever Node version is running this script.
 * Build on the same OS/arch you intend to deploy to.
 */

const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const root = path.join(__dirname, '..');
const outDir = path.join(root, 'dist');
const output = path.join(outDir, process.platform === 'win32' ? 'jsproxy-caxa.exe' : 'jsproxy-caxa');

fs.mkdirSync(outDir, { recursive: true });

// Heavy, non-runtime paths that must never end up inside the binary. Notably
// `dist` (holds other multi-hundred-MB binaries) and the alt-language ports.
const exclude = [
  '.git', 'dist', 'coverage', 'rust', 'deno', 'docs', 'sync',
  '__tests__', '__mocks__', '.env', 'PLUGIN_PLAN.md', 'TCP_PLAN.md',
];

const caxaBin = path.join(root, 'node_modules', '.bin', 'caxa');

const args = [
  '--input', '.',
  '--output', output,
  '--no-dedupe',                     // keep the already-built native sqlite3; no network
  '--exclude', ...exclude,
  '--uncompression-message', 'Unpacking jsproxy (first run only)...',
  '--',
  '{{caxa}}/node_modules/.bin/node', // caxa drops the embedded Node here
  '{{caxa}}/index.js',
];

console.log(`Building single-file executable -> ${output}`);
execFileSync(caxaBin, args, { cwd: root, stdio: 'inherit' });

const { size } = fs.statSync(output);
console.log(`\nDone: ${output} (${(size / 1024 / 1024).toFixed(0)} MB)`);
console.log('Run it anywhere — no Node.js or node_modules required on the host.');
