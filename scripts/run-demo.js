#!/usr/bin/env node
'use strict';

/**
 * jsproxy plugin demo runner
 *
 * Starts the demo backend, the plugin, and jsproxy; adds the required mapping;
 * then runs a series of curl commands with pretty-printed output.
 *
 * Usage:
 *   node scripts/run-demo.js hello
 *   node scripts/run-demo.js rewrite
 *   node scripts/run-demo.js retry
 */

const { spawn, execSync, spawnSync } = require('child_process');
const http  = require('http');
const net   = require('net');
const path  = require('path');
const fs    = require('fs');

const ROOT = path.join(__dirname, '..');

// ── colours ──────────────────────────────────────────────────────────────────
const C = {
  reset:   '\x1b[0m',
  bold:    '\x1b[1m',
  dim:     '\x1b[2m',
  red:     '\x1b[31m',
  green:   '\x1b[32m',
  yellow:  '\x1b[33m',
  blue:    '\x1b[34m',
  magenta: '\x1b[35m',
  cyan:    '\x1b[36m',
};

// ── demo definitions ─────────────────────────────────────────────────────────
const DEMOS = {
  hello: {
    title:   'hello-world plugin',
    desc:    'Intercepts /hello and returns "Hello World!" — regardless of what the backend returns.',
    backend: { script: 'plugins/demo-backend.js', port: 3000 },
    plugin:  { script: 'plugins/hello-world.js',  port: 3001, env: {} },
    proxy:   { port: 8080, plugin: 'localhost:3001' },
    curls: [
      {
        label: '/hello  →  plugin rewrites response to "Hello World!"',
        cmd:   'curl -s http://localhost:8080/hello',
      },
      {
        label: '/hello?q=x  →  query strings also intercepted',
        cmd:   'curl -s "http://localhost:8080/hello?q=x"',
      },
      {
        label: '/  →  not claimed by plugin (/valid returned false), hits backend directly',
        cmd:   'curl -s http://localhost:8080/',
      },
    ],
  },

  rewrite: {
    title:   'rewrite plugin',
    desc:    'Transparently rewrites /api/v1/* → /api/v2/* before forwarding. Client never knows.',
    backend: { script: 'plugins/demo-backend.js', port: 3000 },
    plugin:  { script: 'plugins/rewrite.js',      port: 3002, env: {} },
    proxy:   { port: 8080, plugin: 'localhost:3002' },
    curls: [
      {
        label: '/api/v1/users  →  rewritten to /api/v2/users at the backend',
        cmd:   'curl -s http://localhost:8080/api/v1/users',
      },
      {
        label: '/api/v1/items?page=2  →  query string preserved in rewrite',
        cmd:   'curl -s "http://localhost:8080/api/v1/items?page=2"',
      },
      {
        label: '/api/v2/users directly  →  plugin skipped (/valid: false), goes straight through',
        cmd:   'curl -s http://localhost:8080/api/v2/users',
      },
      {
        label: '/  →  completely unaffected',
        cmd:   'curl -s http://localhost:8080/',
      },
    ],
  },

  retry: {
    title:   'retry plugin',
    desc:    'Retries 5xx responses with exponential backoff. /flaky alternates 200↔500 at the backend.',
    backend: { script: 'plugins/demo-backend.js', port: 3000 },
    plugin: {
      script: 'plugins/retry.js',
      port:   3003,
      env: { BACKEND_URL: 'http://localhost:3000', MAX_RETRIES: '3', BASE_DELAY_MS: '200' },
    },
    proxy: { port: 8080, plugin: 'localhost:3003' },
    curls: [
      {
        label: '/flaky (backend returns 500)  →  plugin retries, client sees 200',
        cmd:   'curl -s http://localhost:8080/flaky',
      },
      {
        label: '/flaky (backend returns 200)  →  no retry needed',
        cmd:   'curl -s http://localhost:8080/flaky',
      },
      {
        label: '/flaky (backend returns 500 again)  →  plugin retries, client sees 200',
        cmd:   'curl -s http://localhost:8080/flaky',
      },
      {
        label: '/  →  200 from backend, plugin passes straight through',
        cmd:   'curl -s http://localhost:8080/',
      },
    ],
  },

  telemetry: {
    title:   'telemetry plugin',
    desc:    'Captures per-request spans (method, route, status, latency). Plug into Sentry, OpenTelemetry, or any webhook — no app code changes.',
    backend: { script: 'plugins/demo-backend.js', port: 3000 },
    plugin: {
      script: 'plugins/telemetry.js',
      port:   3004,
      env:    { TELEMETRY_TARGET: 'console', TELEMETRY_SERVICE_NAME: 'demo-api' },
    },
    proxy: { port: 8080, plugin: 'localhost:3004' },
    curls: [
      {
        label: 'GET /api/users  →  200 span printed by plugin (watch plugin log)',
        cmd:   'curl -s http://localhost:8080/api/users',
      },
      {
        label: 'GET /api/slow  →  500ms latency captured in span',
        cmd:   'curl -s http://localhost:8080/api/slow',
      },
      {
        label: 'GET /api/crash  →  500 error span with error=true flag',
        cmd:   'curl -s http://localhost:8080/api/crash',
      },
      {
        label: 'GET /health  →  ignored by plugin (/valid returns false for /health)',
        cmd:   'curl -s http://localhost:8080/health',
      },
      {
        label: 'POST /api/orders  →  POST spans include method in the span name',
        cmd:   'curl -s -X POST http://localhost:8080/api/orders -H "Content-Type: application/json" -d \'{"item":"widget","qty":3}\'',
      },
    ],
  },

  pii: {
    title:   'pii plugin',
    desc:    'Detects PII fields in JSON bodies (email, name, phone, SSN, address, card, …) and replaces them with realistic mock data before forwarding.',
    backend: { script: 'plugins/demo-backend.js', port: 3000 },
    plugin: {
      script: 'plugins/pii.js',
      port:   3005,
      env:    { PII_MODE: 'mock', PII_DIRECTION: 'both' },
    },
    proxy: { port: 8080, plugin: 'localhost:3005' },
    curls: [
      {
        label: 'GET /api/user/profile  →  response PII (name, email, phone, SSN, address, card) replaced with mock data',
        cmd:   'curl -s http://localhost:8080/api/user/profile',
      },
      {
        label: 'GET /api/users  →  PII in array items scrubbed (plugin walks arrays recursively)',
        cmd:   'curl -s http://localhost:8080/api/users',
      },
      {
        label: 'POST /api/register  →  request body PII scrubbed before it reaches the backend',
        cmd:   'curl -s -X POST http://localhost:8080/api/register -H "Content-Type: application/json" -d \'{"name":"Jane Doe","email":"jane@real.com","phone":"555-1234","password":"hunter2","address":"123 Real St","zip":"97201"}\'',
      },
      {
        label: 'POST /api/orders  →  nested PII (customer + shipping object) all scrubbed',
        cmd:   'curl -s -X POST http://localhost:8080/api/orders -H "Content-Type: application/json" -d \'{"order_id":"ORD-001","customer":{"name":"John Smith","email":"john@real.com","phone":"555-9999"},"shipping":{"address":"456 Oak Ave","city":"Portland","zip":"97201","country":"US"},"total":99.99}\'',
      },
    ],
  },
};

// ── helpers ───────────────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function waitForPort(port, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    (function attempt() {
      const sock = net.createConnection(port, 'localhost');
      sock.once('connect', () => { sock.destroy(); resolve(); });
      sock.once('error',   () => {
        sock.destroy();
        if (Date.now() - start > timeout) return reject(new Error(`port ${port} not ready after ${timeout}ms`));
        setTimeout(attempt, 150);
      });
    })();
  });
}

function waitForHttp(url, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    (function attempt() {
      http.get(url, res => { res.resume(); resolve(); })
          .on('error', () => {
            if (Date.now() - start > timeout) return reject(new Error(`${url} not ready after ${timeout}ms`));
            setTimeout(attempt, 150);
          });
    })();
  });
}

const procs = [];

function startProc(label, color, script, extraEnv = {}) {
  const prefix = color + `[${label}]` + C.reset + C.dim + ' ';
  const proc = spawn('node', [script], {
    cwd: ROOT,
    env: Object.assign({}, process.env, extraEnv),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const print = chunk => {
    chunk.toString().split('\n').filter(Boolean).forEach(line => {
      process.stdout.write(prefix + line + C.reset + '\n');
    });
  };
  proc.stdout.on('data', print);
  proc.stderr.on('data', print);
  procs.push(proc);
  return proc;
}

function cleanup() {
  for (const p of procs) { try { p.kill(); } catch {} }
}

function printCurlResult(raw) {
  const trimmed = raw.trim();
  try {
    const parsed = JSON.parse(trimmed);
    const pretty = JSON.stringify(parsed, null, 2);
    console.log(C.green + pretty.split('\n').map(l => '    ' + l).join('\n') + C.reset);
  } catch {
    console.log(C.green + trimmed.split('\n').map(l => '    ' + l).join('\n') + C.reset);
  }
}

function runCurl({ label, cmd }) {
  // Print the command so it's easy to copy-paste
  console.log('\n' + C.cyan + C.bold + '  $ ' + cmd + C.reset);
  console.log(C.dim + '  # ' + label + C.reset);

  const result = spawnSync(cmd, {
    shell: true,
    encoding: 'utf8',
    timeout: 30000,
  });

  if (result.error) {
    console.log(C.red + '  error: ' + result.error.message + C.reset);
  } else {
    printCurlResult(result.stdout || result.stderr || '(empty response)');
  }
}

// ── main ──────────────────────────────────────────────────────────────────────
async function main() {
  const demoName = process.argv[2];

  if (!demoName || !DEMOS[demoName]) {
    console.log(C.bold + '\nUsage: node scripts/run-demo.js <demo>\n' + C.reset);
    console.log('Available demos:\n');
    for (const [name, d] of Object.entries(DEMOS)) {
      console.log(`  ${C.cyan}${C.bold}${name.padEnd(10)}${C.reset}  ${d.desc}`);
    }
    console.log('');
    process.exit(demoName ? 1 : 0);
  }

  const demo = DEMOS[demoName];

  process.on('SIGINT',  () => { cleanup(); process.exit(0); });
  process.on('SIGTERM', () => { cleanup(); process.exit(0); });
  process.on('exit',    cleanup);

  // Header
  const bar = C.blue + C.bold + '══════════════════════════════════════════════════' + C.reset;
  console.log('\n' + bar);
  console.log(C.blue + C.bold + `  jsproxy demo: ${demo.title}` + C.reset);
  console.log(C.dim + `  ${demo.desc}` + C.reset);
  console.log(bar + '\n');

  // Ensure data dir (jsproxy needs it for the SQLite DB)
  fs.mkdirSync(path.join(ROOT, 'data'), { recursive: true });

  // ── 1. start demo backend ────────────────────────────────────────────────
  console.log(C.yellow + `▶ starting demo-backend on :${demo.backend.port}` + C.reset);
  startProc('backend', C.yellow, demo.backend.script, { PORT: String(demo.backend.port) });
  await waitForHttp(`http://localhost:${demo.backend.port}/health`);
  console.log(C.green + `  ✓ backend ready` + C.reset);

  // ── 2. start plugin ──────────────────────────────────────────────────────
  console.log(C.magenta + `▶ starting plugin (${demo.plugin.script}) on :${demo.plugin.port}` + C.reset);
  startProc('plugin', C.magenta, demo.plugin.script,
    Object.assign({ PORT: String(demo.plugin.port) }, demo.plugin.env));
  await waitForPort(demo.plugin.port);
  console.log(C.green + `  ✓ plugin ready` + C.reset);

  // ── 3. start jsproxy ─────────────────────────────────────────────────────
  console.log(C.cyan + `▶ starting jsproxy on :${demo.proxy.port}  PLUGIN=${demo.proxy.plugin}` + C.reset);
  startProc('jsproxy', C.cyan, 'index.js', {
    HTTP_PORT:    String(demo.proxy.port),
    ENABLE_HTTPS: 'false',
    PLUGIN:       demo.proxy.plugin,
    NODE_ENV:     'development',
    LOG_LEVEL:    'warn',   // quieter proxy logs during demo
  });
  await waitForHttp(`http://localhost:${demo.proxy.port}/health`);
  console.log(C.green + `  ✓ jsproxy ready` + C.reset);

  // ── 4. add mapping ───────────────────────────────────────────────────────
  console.log(C.yellow + `▶ adding mapping: localhost → :${demo.backend.port}` + C.reset);
  execSync(`node scripts/add-mapping.js localhost ${demo.backend.port}`, {
    cwd: ROOT,
    stdio: 'ignore',
  });
  console.log(C.green + `  ✓ mapping ready` + C.reset);

  // small pause so any startup logs flush before we print curl output
  await sleep(300);

  // ── 5. curl examples ─────────────────────────────────────────────────────
  console.log('\n' + C.blue + C.bold + '── curl examples ─────────────────────────────────' + C.reset);
  for (const curl of demo.curls) {
    await sleep(400);
    runCurl(curl);
  }

  // ── 6. done ──────────────────────────────────────────────────────────────
  console.log('\n' + C.blue + C.bold + '─────────────────────────────────────────────────' + C.reset);
  console.log(C.dim + '\nAll services still running. Press Ctrl+C to stop.\n' + C.reset);
  console.log('Copy-paste any ' + C.cyan + '$ curl ...' + C.reset + ' command above to keep experimenting.\n');

  // keep alive until Ctrl+C
  await new Promise(() => {});
}

main().catch(err => {
  console.error(C.red + 'Demo failed: ' + err.message + C.reset);
  cleanup();
  process.exit(1);
});
