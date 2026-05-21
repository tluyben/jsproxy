#!/usr/bin/env node
'use strict';

/**
 * Reproduces an HA false-positive 502 when one port is down and the other is
 * healthy-but-slow (>10s).
 *
 * Setup:
 *   - mapping ha-slow.test → "8888,8889" (HA, two backends)
 *   - port 8888 has NOTHING listening (simulates the down side of a blue/green)
 *   - port 8889 has a tiny HTTP server that responds with "Hello World" after 15s
 *
 * Expected: GET / → 200 "Hello World" after ~15s
 * Actual:   GET / → 502 "Bad Gateway: all backends unavailable" after ~10s,
 *           because _tryPort() in src/ProxyServer.js hard-codes timeout=10000
 *           and the HA logic treats the read-timeout as "port is down".
 */

const { spawn } = require('child_process');
const http      = require('http');
const net       = require('net');
const path      = require('path');
const fs        = require('fs');
const os        = require('os');
const crypto    = require('crypto');
const sqlite3   = require('sqlite3').verbose();

const ARGS       = process.argv.slice(2);
const MODE       = ARGS.includes('--sse') ? 'sse' : 'buffered';
const SLOW_MS    = parseInt(ARGS.find(a => /^\d+$/.test(a)) || process.env.SLOW_MS || '15000', 10);
const ROOT       = path.join(__dirname, '..');
const PROXY_PORT = 9080;
const DEAD_PORT  = 8888;
const SLOW_PORT  = 8889;
const DOMAIN     = 'ha-slow.test';
const DB_PATH    = path.join(os.tmpdir(), `jsproxy-repro-ha-slow-${process.pid}.db`);
// Give the proxy headroom so the backend's slow response can complete before the
// response-phase timeout fires. (Default in the proxy is 30s.)
const RESP_TIMEOUT_MS = Math.max(SLOW_MS + 10000, 30000);

const C = {
  reset:'\x1b[0m', bold:'\x1b[1m', dim:'\x1b[2m',
  red:'\x1b[31m', green:'\x1b[32m', yellow:'\x1b[33m',
  blue:'\x1b[34m', cyan:'\x1b[36m', magenta:'\x1b[35m',
};
const log = (color, ...args) => console.log(`${color}${args.join(' ')}${C.reset}`);

// ── port preflight ───────────────────────────────────────────────────────────
function isPortFree(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(port, '127.0.0.1');
  });
}

// ── slow backend on SLOW_PORT ────────────────────────────────────────────────
// Serves either a plain HTTP 200 (buffered HA path) or an SSE stream (streamed
// HA path) depending on the client's Accept header. Always delays the first
// byte by SLOW_MS so the proxy's slow-response handling gets exercised.
function startSlowBackend() {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      // Fast path for warm-up probes. Returns immediately so the proxy can
      // seed every worker's in-memory port scores (8888 → 0, 8889 → 100)
      // before the actual slow-backend probe runs.
      if (req.url === '/_warmup') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        res.end('warm\n');
        return;
      }
      const isSSE = req.headers.accept?.includes('text/event-stream');
      log(C.cyan, `[slow-backend] ${req.method} ${req.url} (sse=${isSSE}) — sleeping ${SLOW_MS}ms before responding`);
      const t = setTimeout(() => {
        if (res.writableEnded || res.destroyed) {
          log(C.yellow, '[slow-backend] client disconnected before response could be sent');
          return;
        }
        if (isSSE) {
          res.writeHead(200, {
            'Content-Type':  'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection':    'keep-alive',
          });
          res.write('event: hello\n');
          res.write('data: hello world\n\n');
          res.end();
          log(C.cyan, '[slow-backend] SSE event sent');
        } else {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end('Hello World\n');
          log(C.cyan, '[slow-backend] 200 OK sent');
        }
      }, SLOW_MS);
      req.on('close', () => clearTimeout(t));
    });
    server.on('error', reject);
    server.listen(SLOW_PORT, '127.0.0.1', () => {
      log(C.cyan, `[slow-backend] listening on 127.0.0.1:${SLOW_PORT} (will respond after ${SLOW_MS}ms)`);
      resolve(server);
    });
  });
}

// ── seed a throw-away DB with the HA mapping ─────────────────────────────────
function seedMapping() {
  return new Promise((resolve, reject) => {
    for (const ext of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(DB_PATH + ext); } catch {}
    }
    const db = new sqlite3.Database(DB_PATH, (err) => {
      if (err) return reject(err);
      db.serialize(() => {
        db.run(`CREATE TABLE mappings (
          id TEXT PRIMARY KEY,
          domain TEXT NOT NULL,
          front_uri TEXT NOT NULL,
          back_port TEXT NOT NULL,
          back_uri TEXT NOT NULL,
          backend TEXT DEFAULT NULL,
          allowed_ips TEXT DEFAULT NULL,
          auth_type TEXT DEFAULT NULL,
          auth_credentials TEXT DEFAULT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);
        db.run(
          `INSERT INTO mappings (id, domain, front_uri, back_port, back_uri)
           VALUES (?, ?, '', ?, '')`,
          [crypto.randomUUID(), DOMAIN, `${DEAD_PORT},${SLOW_PORT}`],
          (e2) => db.close(() => e2 ? reject(e2) : resolve())
        );
      });
    });
  });
}

// ── start jsproxy as a child process ─────────────────────────────────────────
function startProxy() {
  return new Promise((resolve, reject) => {
    const proc = spawn('node', ['index.js'], {
      cwd: ROOT,
      env: {
        ...process.env,
        HTTP_PORT:               String(PROXY_PORT),
        ENABLE_HTTPS:            'false',
        DB_PATH,
        NODE_ENV:                'development',
        LOG_LEVEL:               process.env.LOG_LEVEL || 'info',
        // Let the proxy wait long enough for the slow backend to respond.
        HA_RESPONSE_TIMEOUT_MS:  String(RESP_TIMEOUT_MS),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let ready = false;
    const settle = (chunk) => {
      const text = chunk.toString();
      process.stdout.write(`${C.dim}[jsproxy] ${text}${C.reset}`);
      if (!ready && text.includes('worker ready')) {
        ready = true;
        resolve(proc);
      }
    };
    proc.stdout.on('data', settle);
    proc.stderr.on('data', settle);
    proc.on('exit', (code, sig) => {
      if (!ready) reject(new Error(`jsproxy exited before ready (code=${code} sig=${sig})`));
    });
    setTimeout(() => {
      if (!ready) reject(new Error('jsproxy did not become ready within 15s'));
    }, 15000);
  });
}

// ── warm-up: seed every worker's in-memory port scores ──────────────────────
// jsproxy spawns up to 4 workers, each with independent port-score state. The
// streamed HA path doesn't failover (body may already be in flight), so the
// SSE probe needs the chosen worker to already prefer the healthy port. We
// issue a burst of parallel buffered probes to `/_warmup` (fast path on the
// slow backend) so every worker's buffered-HA loop penalizes 8888 and boosts
// 8889. After this, rankedPorts deterministically returns [8889, 8888].
function warmup(n = 16) {
  const once = () => new Promise((resolve) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port:     PROXY_PORT,
      path:     '/_warmup',
      method:   'GET',
      headers:  { Host: DOMAIN, Connection: 'close' },
    }, (res) => { res.on('data', () => {}); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', () => resolve(0));
    req.end();
  });
  return Promise.all(Array.from({ length: n }, once));
}

// ── one probe request through the proxy ──────────────────────────────────────
function probe() {
  return new Promise((resolve) => {
    const start = Date.now();
    const headers = { Host: DOMAIN };
    if (MODE === 'sse') headers.Accept = 'text/event-stream';
    const req = http.request({
      hostname: '127.0.0.1',
      port:     PROXY_PORT,
      path:     '/',
      method:   'GET',
      headers,
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end',  () => resolve({
        status:       res.statusCode,
        contentType:  res.headers['content-type'],
        body:         Buffer.concat(chunks).toString(),
        ms:           Date.now() - start,
      }));
    });
    req.on('error', (err) => resolve({ error: err.message, ms: Date.now() - start }));
    req.end();
  });
}

// ── main ─────────────────────────────────────────────────────────────────────
(async () => {
  let slowServer, proxyProc;
  try {
    log(C.bold + C.yellow, '\n=== jsproxy HA false-positive 502 reproduction ===\n');
    log(C.dim,
      `mode=${MODE}  ` +
      `proxy=:${PROXY_PORT}  ` +
      `dead-port=:${DEAD_PORT}  ` +
      `slow-port=:${SLOW_PORT} (responds after ${SLOW_MS}ms)  ` +
      `HA_RESPONSE_TIMEOUT_MS=${RESP_TIMEOUT_MS}\n`);

    if (!(await isPortFree(DEAD_PORT))) {
      throw new Error(`port ${DEAD_PORT} is already in use — pick a free port (the repro needs it DOWN)`);
    }
    if (!(await isPortFree(PROXY_PORT))) {
      throw new Error(`port ${PROXY_PORT} (proxy) is already in use`);
    }

    slowServer = await startSlowBackend();
    await seedMapping();
    log(C.green, `[setup] mapping ${DOMAIN} → "${DEAD_PORT},${SLOW_PORT}" written to ${DB_PATH}`);

    proxyProc = await startProxy();
    await new Promise(r => setTimeout(r, 500));

    if (MODE === 'sse') {
      log(C.dim, '[warmup] seeding port scores across workers via /_warmup ...');
      const codes = await warmup(16);
      const ok = codes.filter(c => c === 200).length;
      log(C.dim, `[warmup] done (${ok}/${codes.length} warmup requests returned 200)`);
    }

    log(C.bold, `\n[probe] GET http://${DOMAIN}/ via 127.0.0.1:${PROXY_PORT}`);
    log(C.dim,  `[probe] healthy outcome = 200 "Hello World" in ~${SLOW_MS}ms (post-fix)`);
    log(C.dim,  `[probe] buggy   outcome = 502 "all backends unavailable" in ~10s (pre-fix)\n`);

    const r = await probe();
    const elapsed = `${(r.ms / 1000).toFixed(2)}s`;

    if (r.error) {
      log(C.red, `[result] connection error after ${elapsed}: ${r.error}`);
    } else {
      const color = r.status === 200 ? C.green : C.red;
      log(color, `[result] HTTP ${r.status} after ${elapsed}`);
      log(C.dim, `[result] body: ${JSON.stringify(r.body)}`);
    }

    const bug = r.status === 502;
    const sseOk = MODE === 'sse'
      && r.status === 200
      && /text\/event-stream/i.test(r.contentType || '')
      && /data: hello world/.test(r.body || '');
    const bufferedOk = MODE === 'buffered'
      && r.status === 200
      && (r.body || '').includes('Hello World');

    if (bug) {
      log(C.red + C.bold,
        '\nBUG REPRODUCED — proxy returned 502 while the slow backend was still working.');
      log(C.dim,
        `cause (buffered): src/ProxyServer.js _tryPort hard-coded 10s timeout, indistinguishable\n` +
        `                  connect vs read failures → false "all backends unavailable".\n` +
        `cause (sse):      src/ProxyServer.js proxy.on('error') penalizes the streamed-HA port on any\n` +
        `                  failure, including post-connect timeouts → healthy slow backend marked down.\n`);
      process.exitCode = 1;
    } else if (sseOk || bufferedOk) {
      log(C.green + C.bold,
        `\nNo bug observed (${MODE}) — proxy correctly waited for the slow backend.\n`);
      process.exitCode = 0;
    } else {
      log(C.yellow + C.bold, '\nUnexpected outcome — inspect output above.\n');
      process.exitCode = 3;
    }
  } catch (err) {
    log(C.red, `[fatal] ${err.message}`);
    process.exitCode = 2;
  } finally {
    if (proxyProc) {
      proxyProc.kill('SIGTERM');
      await new Promise(r => proxyProc.once('exit', r));
    }
    if (slowServer) {
      slowServer.closeAllConnections?.();
      await new Promise(r => slowServer.close(r));
    }
    for (const ext of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(DB_PATH + ext); } catch {}
    }
  }
})();
