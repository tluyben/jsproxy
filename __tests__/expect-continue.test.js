'use strict';

// Regression guard for the large-upload fixes (v1.0.21). Production runs many
// chained jsproxies, so every forward path is exercised here:
//
//   Expect: 100-continue MUST be stripped before forwarding, in ALL paths:
//     (a) single-backend proxy.web          — setupProxyErrorHandling
//     (b) buffered HA / plugin-buffered      — _tryPort
//     (c) streaming HA (large/chunked/SSE)   — _streamHA
//     (d) plugin streaming (needsBody:false) — _streamWithPlugins
//   The test backend returns 404 if it still sees Expect (exactly how the real
//   app behaved), so a 200 proves the header was stripped on that path.
//
//   The streaming HA response timeout MUST NOT fire while the body is still
//   uploading (slow/large uploads), but MUST still fire if the backend goes
//   silent AFTER receiving the whole body.
//
//   Streaming HA must fail over on connect-phase failures and 502 when every
//   backend is unreachable.

const http = require('http');
const path = require('path');
const fs   = require('fs').promises;
const ProxyServer = require('../src/ProxyServer');
const { PluginManager } = require('../src/PluginManager');

const logger = { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() };

const listen = (s, p = 0) => new Promise(r => s.listen(p, () => r(s.address().port)));
const close  = (s) => new Promise(r => s.close(r));

// OS-assigned free port released immediately → a guaranteed-dead backend.
function deadPort() {
  return new Promise(r => { const s = http.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
}

// Backend that 404s on a stale Expect (like the real app); otherwise echoes the
// received byte count. Records the last Expect header seen for direct assertions.
function strictBackend() {
  const state = { lastExpect: 'unset', hits: 0 };
  const srv = http.createServer((req, res) => {
    state.hits++;
    state.lastExpect = req.headers.expect || 'none';
    if ((req.headers.expect || '').toLowerCase().includes('100-continue')) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('Not Found');
    }
    let bytes = 0;
    req.on('data', c => { bytes += c.length; });
    req.on('end', () => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(String(bytes)); });
  });
  srv._state = state;
  return srv;
}

// Reads the body SLOWLY: pauses after each chunk so the upload is throttled and
// backpressure propagates up the chain (the proxy ends up pausing the client
// request). This is the scenario that broke 1.0.24 — an active-but-paused upload.
function throttledBackend(tickMs = 60) {
  const srv = http.createServer((req, res) => {
    let bytes = 0;
    req.on('data', c => {
      bytes += c.length;
      req.pause();
      setTimeout(() => req.resume(), tickMs);
    });
    req.on('end', () => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(String(bytes)); });
  });
  return srv;
}

async function makeProxy(dir, backPort, pluginMgr) {
  // Start from a clean dir every time: the SQLite mapping DB persists on disk, so
  // a leftover file from a previous run would resurrect stale mappings (pointing
  // at long-dead ports) and getMapping would return those instead of this run's.
  await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  await fs.mkdir(dir, { recursive: true }).catch(() => {});
  process.env.HTTP_PORT = '0';
  process.env.ENABLE_HTTPS = 'false';
  const proxy = pluginMgr ? new ProxyServer(logger, pluginMgr) : new ProxyServer(logger);
  proxy.db.dbPath = path.join(dir, 'test.db');
  proxy.certManager.certsDir = path.join(dir, 'certs');
  await proxy.initialize();
  await proxy.start();
  delete process.env.HTTP_PORT;
  delete process.env.ENABLE_HTTPS;
  return { proxy, port: proxy.httpServer.address().port };
}

// POST with Expect: 100-continue. Sends the body only after a 100 (or a short
// fallback so a buggy hop can't hang the test). `trickleMs` spaces the chunks to
// simulate a slow upload.
function uploadExpect(port, host, data, { trickleMs = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: 'localhost', port, path: '/upload', method: 'POST',
      headers: { Host: host, 'content-type': 'application/octet-stream', 'content-length': data.length, Expect: '100-continue' },
    }, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
    const sendBody = () => {
      if (data.length === 0) return req.end();
      const chunkSize = trickleMs ? Math.max(1, Math.ceil(data.length / 20)) : data.length;
      let off = 0;
      (function pump() {
        if (off >= data.length) return req.end();
        const end = Math.min(off + chunkSize, data.length);
        req.write(data.subarray(off, end));
        off = end;
        if (trickleMs) setTimeout(pump, trickleMs); else req.end();
      })();
    };
    let sent = false;
    req.on('continue', () => { if (!sent) { sent = true; sendBody(); } });
    const t = setTimeout(() => { if (!sent) { sent = true; sendBody(); } }, 1500);
    if (t.unref) t.unref();
    req.on('error', reject);
  });
}

const SMALL = Buffer.alloc(4 * 1024);             // < 512 KB → buffered on HA
const LARGE = Buffer.alloc(2 * 1024 * 1024);      // > 512 KB → streamed on HA

// ── Expect: 100-continue stripped on every forward path ──────────────────────
describe('Expect: 100-continue is stripped before forwarding', () => {
  let backend, dir;
  let single, singleUri, ha, pluginStream, pluginBuffered;
  let pluginSrv;

  beforeAll(async () => {
    dir = path.join(__dirname, 'expect-data');
    backend = strictBackend();
    const bport = await listen(backend);
    const dead = await deadPort();

    // (a) single backend, no URI mapping → proxy.web
    single = await makeProxy(path.join(dir, 'single'), null);
    await single.proxy.db.addMapping('single.test', '', String(bport), '');

    // (a) single backend WITH URI rewrite (back_uri set) → proxy.web complex
    // branch (buildTargetUrl). front_uri empty so every path maps; the backend
    // receives /api/<path> and echoes byte count regardless.
    singleUri = await makeProxy(path.join(dir, 'singleuri'), null);
    await singleUri.proxy.db.addMapping('uri.test', '', String(bport), 'api');

    // (b)+(c) HA: live + dead port → buffered for small, streamed for large
    ha = await makeProxy(path.join(dir, 'ha'), null);
    await ha.proxy.db.addMapping('ha.test', '', `${bport},${dead}`, '');

    // (d) plugin streaming (needsBody:false) and (b) plugin buffered (needsBody:true)
    pluginSrv = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        if (req.url === '/valid') {
          // streaming for stream.test, buffered for buffered.test
          const meta = JSON.parse(req.headers['x-plugin-meta'] || '{}');
          const needsBody = meta.domain === 'buffered.test';
          return res.end(JSON.stringify({ valid: true, needsBody }));
        }
        res.writeHead(200, { 'x-plugin-result': 'CONTINUE' });
        res.end();
      });
    });
    const pport = await listen(pluginSrv);
    const pluginMgr = new PluginManager(logger, `localhost:${pport}`);
    pluginStream = await makeProxy(path.join(dir, 'plugin'), pluginMgr);
    await pluginStream.proxy.db.addMapping('stream.test', '', String(bport), '');
    await pluginStream.proxy.db.addMapping('buffered.test', '', String(bport), '');
    pluginBuffered = pluginStream; // same proxy, different domains
  }, 30000);

  afterAll(async () => {
    for (const x of [single, singleUri, ha, pluginStream]) if (x) await x.proxy.stop();
    if (pluginSrv) await close(pluginSrv);
    if (backend) await close(backend);
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  beforeEach(() => { backend._state.lastExpect = 'unset'; });

  test('(a) single backend, small body', async () => {
    const r = await uploadExpect(single.port, 'single.test', SMALL);
    expect(r.status).toBe(200);
    expect(Number(r.body)).toBe(SMALL.length);
    expect(backend._state.lastExpect).toBe('none'); // backend never saw Expect
  }, 15000);

  test('(a) single backend, large body (streamed via _streamHA)', async () => {
    const r = await uploadExpect(single.port, 'single.test', LARGE);
    expect(r.status).toBe(200);
    expect(Number(r.body)).toBe(LARGE.length);
    expect(backend._state.lastExpect).toBe('none');
  }, 20000);

  test('(a) single backend WITH URI mapping', async () => {
    const r = await uploadExpect(singleUri.port, 'uri.test', SMALL);
    expect(r.status).toBe(200);
    expect(backend._state.lastExpect).toBe('none');
  }, 15000);

  test('(b) buffered HA path (small body)', async () => {
    for (let i = 0; i < 4; i++) { // cover round-robin rotations incl. dead-first
      const r = await uploadExpect(ha.port, 'ha.test', SMALL);
      expect(r.status).toBe(200);
      expect(Number(r.body)).toBe(SMALL.length);
    }
    expect(backend._state.lastExpect).toBe('none');
  }, 20000);

  test('(c) streaming HA path (large body)', async () => {
    for (let i = 0; i < 4; i++) {
      const r = await uploadExpect(ha.port, 'ha.test', LARGE);
      expect(r.status).toBe(200);
      expect(Number(r.body)).toBe(LARGE.length);
    }
    expect(backend._state.lastExpect).toBe('none');
  }, 30000);

  test('(d) plugin streaming path (needsBody:false)', async () => {
    const r = await uploadExpect(pluginStream.port, 'stream.test', LARGE);
    expect(r.status).toBe(200);
    expect(Number(r.body)).toBe(LARGE.length);
    expect(backend._state.lastExpect).toBe('none');
  }, 20000);

  test('(b via plugin) plugin buffered path (needsBody:true)', async () => {
    const r = await uploadExpect(pluginBuffered.port, 'buffered.test', SMALL);
    expect(r.status).toBe(200);
    expect(Number(r.body)).toBe(SMALL.length);
    expect(backend._state.lastExpect).toBe('none');
  }, 15000);
});

// ── streaming HA response-timeout semantics ──────────────────────────────────
describe('streaming HA response timeout', () => {
  let dir, savedTimeout;

  beforeAll(() => { savedTimeout = process.env.STREAM_IDLE_TIMEOUT_MS; dir = path.join(__dirname, 'timeout-data'); });
  afterAll(() => {
    if (savedTimeout === undefined) delete process.env.STREAM_IDLE_TIMEOUT_MS;
    else process.env.STREAM_IDLE_TIMEOUT_MS = savedTimeout;
  });

  test('an active upload slower than the idle timeout still succeeds (idle resets on data)', async () => {
    // Idle timeout 500 ms, but chunks keep arriving every 100 ms for ~2 s — the
    // stream is never idle, so it must NOT be torn down despite running 4× the
    // idle window. This is the core "don't time out an active stream" guarantee.
    process.env.STREAM_IDLE_TIMEOUT_MS = '500';
    const backend = strictBackend();
    const bport = await listen(backend);
    const ha = await makeProxy(path.join(dir, 'slow'), null);
    await ha.proxy.db.addMapping('slow.test', '', `${bport},${await deadPort()}`, '');
    try {
      const r = await uploadExpect(ha.port, 'slow.test', LARGE, { trickleMs: 100 });
      expect(r.status).toBe(200);
      expect(Number(r.body)).toBe(LARGE.length);
    } finally {
      await ha.proxy.stop(); await close(backend);
    }
  }, 30000);

  test('SINGLE-backend slow upload (the https-entry path) also survives the idle timeout', async () => {
    // A single-backend large upload now streams through _streamHA (not http-proxy's
    // fixed-timeout proxy.web). With a 500 ms idle timeout and chunks every 100 ms,
    // a ~2 s upload must complete — this is exactly the jsproxy-https entry hop.
    process.env.STREAM_IDLE_TIMEOUT_MS = '500';
    const backend = strictBackend();
    const bport = await listen(backend);
    const ha = await makeProxy(path.join(dir, 'single-slow'), null);
    await ha.proxy.db.addMapping('singleslow.test', '', String(bport), ''); // single backend, no comma
    try {
      const r = await uploadExpect(ha.port, 'singleslow.test', LARGE, { trickleMs: 100 });
      expect(r.status).toBe(200);
      expect(Number(r.body)).toBe(LARGE.length);
    } finally {
      await ha.proxy.stop(); await close(backend);
    }
  }, 30000);

  test('backpressure: a slow backend that pauses the upload does NOT trip the idle timeout', async () => {
    // THE production regression (the 504-mid-upload bug). A throttled backend
    // forces pipe() to PAUSE the client request for long stretches, so req 'data'
    // events go silent even though bytes are pouring out to the backend. The idle
    // monitor watches the backend socket's byte counters (which keep advancing)
    // instead, so the actively-transferring stream — here ~3 s, well past the 2 s
    // idle window — must NOT be torn down. (With the old 'data'-event reset this
    // returned 504 while the upload was still flowing.)
    // Margins (all comfortably separated so the test isn't timing-flaky):
    //   transfer (~7-9 s, throttle-paced) ≫ idle window (3 s) ≫ post-delivery
    //   tail (~1.5 s, the kernel buffer the backend drains after our last write).
    process.env.STREAM_IDLE_TIMEOUT_MS = '3000';
    const backend = throttledBackend(10);
    const bport = await listen(backend);
    const ha = await makeProxy(path.join(dir, 'backpressure'), null);
    await ha.proxy.db.addMapping('bp.test', '', String(bport), '');
    try {
      const body = Buffer.alloc(40 * 1024 * 1024); // throttled reads make this take well over the idle window
      const started = Date.now();
      const r = await new Promise((resolve) => {
        const req = http.request({ hostname: 'localhost', port: ha.port, path: '/upload', method: 'POST',
          headers: { Host: 'bp.test', 'content-type': 'application/octet-stream', 'content-length': body.length } },
          res => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
        req.on('error', e => resolve({ status: 'ERR', body: e.message }));
        req.end(body);
      });
      const elapsed = Date.now() - started;
      expect(r.status).toBe(200);
      expect(Number(r.body)).toBe(body.length);
      expect(elapsed).toBeGreaterThan(3000); // outlived the idle window while actively transferring
    } finally {
      await ha.proxy.stop(); await close(backend);
    }
  }, 40000);

  test('a genuinely idle connection (no data either way) is torn down', async () => {
    // Reads the whole body, then goes silent forever. With nothing moving in
    // either direction the idle timeout must bite — that is what a timeout is for.
    process.env.STREAM_IDLE_TIMEOUT_MS = '500';
    const hung = http.createServer((req, res) => { req.resume(); /* no res.end */ });
    const bport = await listen(hung);
    const ha = await makeProxy(path.join(dir, 'hung'), null);
    await ha.proxy.db.addMapping('hung.test', '', String(bport), ''); // single live port, no failover
    try {
      const started = Date.now();
      const r = await new Promise((resolve, reject) => {
        const req = http.request({ hostname: 'localhost', port: ha.port, path: '/upload', method: 'POST',
          headers: { Host: 'hung.test', 'content-type': 'application/octet-stream', 'content-length': LARGE.length } },
          res => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
        req.on('error', e => resolve({ status: 'ERR', body: e.message }));
        req.end(LARGE);
      });
      const elapsed = Date.now() - started;
      // 504 (idle), 502, or a torn connection — within a few seconds, not forever.
      expect([502, 504, 'ERR']).toContain(r.status);
      expect(elapsed).toBeLessThan(5000);
    } finally {
      await ha.proxy.stop(); await close(hung);
    }
  }, 15000);
});

// ── streaming HA failover edges ──────────────────────────────────────────────
describe('streaming HA failover', () => {
  let dir;
  beforeAll(() => { dir = path.join(__dirname, 'failover-data'); });

  test('dead port first → connect-phase failover → 200', async () => {
    const backend = strictBackend();
    const bport = await listen(backend);
    const dead = await deadPort();
    const ha = await makeProxy(path.join(dir, 'fo'), null);
    await ha.proxy.db.addMapping('fo.test', '', `${bport},${dead}`, '');
    try {
      const mappingId = (await ha.proxy.db.getMapping('fo.test', '/')).id;
      // Force the dead port to be ranked first.
      ha.proxy.portScores.clear(); ha.proxy.rrCounters.clear();
      ha.proxy.penalizePort(mappingId, bport);   // live port scored 0 → dead tried first
      ha.proxy.boostPort(mappingId, dead);       // dead scored 100 → first
      const r = await new Promise((resolve, reject) => {
        const req = http.request({ hostname: 'localhost', port: ha.port, path: '/upload', method: 'POST',
          headers: { Host: 'fo.test', 'content-type': 'application/octet-stream', 'content-length': LARGE.length } },
          res => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
        req.on('error', reject); req.end(LARGE);
      });
      expect(r.status).toBe(200); // failed over from dead to live mid-connect
      expect(Number(r.body)).toBe(LARGE.length);
    } finally {
      await ha.proxy.stop(); await close(backend);
    }
  }, 20000);

  test('all backends dead → 502', async () => {
    const d1 = await deadPort(), d2 = await deadPort();
    const ha = await makeProxy(path.join(dir, 'alldead'), null);
    await ha.proxy.db.addMapping('alldead.test', '', `${d1},${d2}`, '');
    try {
      const r = await new Promise((resolve, reject) => {
        const req = http.request({ hostname: 'localhost', port: ha.port, path: '/upload', method: 'POST',
          headers: { Host: 'alldead.test', 'content-type': 'application/octet-stream', 'content-length': LARGE.length } },
          res => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
        req.on('error', e => resolve({ status: 'ERR', body: e.message })); req.end(LARGE);
      });
      expect([502, 'ERR']).toContain(r.status);
    } finally {
      await ha.proxy.stop();
    }
  }, 15000);
});
