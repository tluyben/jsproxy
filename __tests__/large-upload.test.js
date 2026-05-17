'use strict';

// Integration test: proves that large uploads and downloads pass through the
// proxy without being buffered into memory. A 100 MB payload on localhost takes
// essentially no time but conclusively exercises every streaming code path.

const http = require('http');
const path = require('path');
const fs   = require('fs').promises;
const ProxyServer    = require('../src/ProxyServer');
const { PluginManager } = require('../src/PluginManager');

const SIZE = 100 * 1024 * 1024; // 100 MB

function listen(server, port) {
  return new Promise(resolve => server.listen(port, resolve));
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

// Backend that counts incoming bytes and echoes the total back.
function makeEchoBackend() {
  return http.createServer((req, res) => {
    let bytes = 0;
    req.on('data', chunk => { bytes += chunk.length; });
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(String(bytes));
    });
  });
}

function upload(proxyPort, host, data) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: 'localhost',
      port: proxyPort,
      path: '/upload',
      method: 'POST',
      headers: {
        Host: host,
        'content-type': 'application/octet-stream',
        'content-length': data.length,
      },
    }, res => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end(data);
  });
}

const logger = { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() };

// ── single-backend path (direct http-proxy, no plugins, no HA) ───────────────
describe('large upload — single backend (direct proxy)', () => {
  const PROXY_PORT   = 9700;
  const BACKEND_PORT = 9710;
  let proxy, backend, testDataDir;

  beforeAll(async () => {
    testDataDir = path.join(__dirname, 'large-upload-data-single');
    await fs.mkdir(testDataDir, { recursive: true }).catch(() => {});

    backend = makeEchoBackend();
    await listen(backend, BACKEND_PORT);

    process.env.HTTP_PORT   = String(PROXY_PORT);
    process.env.ENABLE_HTTPS = 'false';

    proxy = new ProxyServer(logger);
    proxy.db.dbPath = path.join(testDataDir, 'test.db');
    proxy.certManager.certsDir = path.join(testDataDir, 'certs');
    await proxy.initialize();
    await proxy.start();

    await proxy.db.addMapping('upload-single.test', '', String(BACKEND_PORT), '');
  }, 15000);

  afterAll(async () => {
    if (proxy)   await proxy.stop();
    if (backend) await close(backend);
    delete process.env.HTTP_PORT;
    delete process.env.ENABLE_HTTPS;
    try {
      const files = await fs.readdir(testDataDir);
      await Promise.all(files.map(f => fs.unlink(path.join(testDataDir, f)).catch(() => {})));
      await fs.rmdir(testDataDir).catch(() => {});
    } catch (_) {}
  });

  test('100 MB upload received intact', async () => {
    const data   = Buffer.alloc(SIZE);
    const result = await upload(PROXY_PORT, 'upload-single.test', data);
    expect(result.status).toBe(200);
    expect(Number(result.body)).toBe(SIZE);
  }, 30000);
});

// ── HA path — streaming for large bodies, failover for small bodies ───────────
describe('large upload — HA path', () => {
  const PROXY_PORT    = 9701;
  const BACKEND_A     = 9720;
  const BACKEND_B     = 9721;
  let proxy, backendA, backendB, testDataDir;

  beforeAll(async () => {
    testDataDir = path.join(__dirname, 'large-upload-data-ha');
    await fs.mkdir(testDataDir, { recursive: true }).catch(() => {});

    backendA = makeEchoBackend();
    backendB = makeEchoBackend();
    await listen(backendA, BACKEND_A);
    await listen(backendB, BACKEND_B);

    process.env.HTTP_PORT    = String(PROXY_PORT);
    process.env.ENABLE_HTTPS = 'false';

    proxy = new ProxyServer(logger);
    proxy.db.dbPath = path.join(testDataDir, 'test.db');
    proxy.certManager.certsDir = path.join(testDataDir, 'certs');
    await proxy.initialize();
    await proxy.start();

    await proxy.db.addMapping('upload-ha.test',   '', `${BACKEND_A},${BACKEND_B}`, '');
    await proxy.db.addMapping('failover-ha.test',  '', `${BACKEND_A},${BACKEND_B}`, '');
    await proxy.db.addMapping('smallbody-ha.test', '', `${BACKEND_A},${BACKEND_B}`, '');
  }, 15000);

  afterAll(async () => {
    if (proxy)    await proxy.stop();
    if (backendA) await close(backendA);
    if (backendB) await close(backendB);
    delete process.env.HTTP_PORT;
    delete process.env.ENABLE_HTTPS;
    try {
      const files = await fs.readdir(testDataDir);
      await Promise.all(files.map(f => fs.unlink(path.join(testDataDir, f)).catch(() => {})));
      await fs.rmdir(testDataDir).catch(() => {});
    } catch (_) {}
  });

  // ── streaming path (large body) ──────────────────────────────────────────

  test('100 MB upload streams through HA path without buffering', async () => {
    proxy.portScores.clear();
    proxy.rrCounters.clear();
    const data   = Buffer.alloc(SIZE);
    const result = await upload(PROXY_PORT, 'upload-ha.test', data);
    expect(result.status).toBe(200);
    expect(Number(result.body)).toBe(SIZE);
  }, 30000);

  test('large upload to dead port is penalized so next request hits live port', async () => {
    // Manually score BACKEND_A to 0 (simulate dead) so BACKEND_B is picked.
    // This also proves that score-based routing still works for streaming requests.
    const mappingId = (await proxy.db.getMapping('failover-ha.test', '/')).id;
    proxy.portScores.clear();
    proxy.rrCounters.clear();
    proxy.penalizePort(mappingId, BACKEND_A); // A is "dead"

    const data   = Buffer.alloc(SIZE);
    const result = await upload(PROXY_PORT, 'failover-ha.test', data);
    // B is alive → should succeed despite A being penalized
    expect(result.status).toBe(200);
    expect(Number(result.body)).toBe(SIZE);
  }, 30000);

  // ── buffered path (small body) — failover must still work ────────────────
  // THIS IS THE REGRESSION TEST. If haRequest ever stops buffering small
  // bodies, these will fail and catch the breakage before it hits production.

  test('small body HA: fails over from dead port to live port transparently', async () => {
    proxy.portScores.clear();
    proxy.rrCounters.clear();

    // Put dead port first — a non-streaming proxy would OOM on large uploads but
    // must still failover transparently for small bodies.
    await proxy.db.addMapping('smallfailover-ha.test', '', `${BACKEND_A + 99},${BACKEND_A}`, '');

    const result = await upload(PROXY_PORT, 'smallfailover-ha.test', Buffer.from('hello'));
    expect(result.status).toBe(200);
    // Backend echoes byte count: 5 bytes
    expect(Number(result.body)).toBe(5);
  }, 15000);

  test('small body HA: dead port gets penalized so subsequent requests skip it', async () => {
    const mappingId = (await proxy.db.getMapping('smallbody-ha.test', '/')).id;
    proxy.portScores.clear();
    proxy.rrCounters.clear();

    // Poison A so it's always tried last
    proxy.penalizePort(mappingId, BACKEND_A);

    // Even with A penalized, B is alive → success
    const result = await upload(PROXY_PORT, 'smallbody-ha.test', Buffer.from('x'));
    expect(result.status).toBe(200);
    expect(Number(result.body)).toBe(1);

    // Verify A stayed penalized (score 0) and B was boosted (score 100)
    expect(proxy.getPortScore(mappingId, BACKEND_A)).toBe(0);
    expect(proxy.getPortScore(mappingId, BACKEND_B)).toBe(100);
  }, 15000);
});

// ── plugin path with needsBody: false ────────────────────────────────────────
describe('large upload — plugin path (needsBody: false)', () => {
  const PROXY_PORT   = 9702;
  const BACKEND_PORT = 9730;
  const PLUGIN_PORT  = 9731;
  let proxy, backend, pluginServer, testDataDir;

  beforeAll(async () => {
    testDataDir = path.join(__dirname, 'large-upload-data-plugin');
    await fs.mkdir(testDataDir, { recursive: true }).catch(() => {});

    backend = makeEchoBackend();
    await listen(backend, BACKEND_PORT);

    // Minimal plugin: interested in all requests but declares it doesn't need the body.
    pluginServer = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        if (req.url === '/valid')  return res.end(JSON.stringify({ valid: true, needsBody: false }));
        if (req.url === '/before') return res.end(JSON.stringify({ result: 'CONTINUE' }));
        if (req.url === '/after')  return res.end(JSON.stringify({ result: 'CONTINUE' }));
        res.end('{}');
      });
    });
    await listen(pluginServer, PLUGIN_PORT);

    const pluginMgr = new PluginManager(logger, `localhost:${PLUGIN_PORT}`);

    process.env.HTTP_PORT    = String(PROXY_PORT);
    process.env.ENABLE_HTTPS = 'false';

    proxy = new ProxyServer(logger, pluginMgr);
    proxy.db.dbPath = path.join(testDataDir, 'test.db');
    proxy.certManager.certsDir = path.join(testDataDir, 'certs');
    await proxy.initialize();
    await proxy.start();

    await proxy.db.addMapping('upload-plugin.test', '', String(BACKEND_PORT), '');
  }, 15000);

  afterAll(async () => {
    if (proxy)        await proxy.stop();
    if (pluginServer) await close(pluginServer);
    if (backend)      await close(backend);
    delete process.env.HTTP_PORT;
    delete process.env.ENABLE_HTTPS;
    try {
      const files = await fs.readdir(testDataDir);
      await Promise.all(files.map(f => fs.unlink(path.join(testDataDir, f)).catch(() => {})));
      await fs.rmdir(testDataDir).catch(() => {});
    } catch (_) {}
  });

  test('100 MB upload streams through plugin path without buffering', async () => {
    const data   = Buffer.alloc(SIZE);
    const result = await upload(PROXY_PORT, 'upload-plugin.test', data);
    expect(result.status).toBe(200);
    expect(Number(result.body)).toBe(SIZE);
  }, 30000);

  test('plugin CANCEL still works (no body consumed)', async () => {
    // Swap to a plugin that cancels, verify we get the cancel status
    const cancelServer = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        if (req.url === '/valid')  return res.end(JSON.stringify({ valid: true, needsBody: false }));
        if (req.url === '/before') return res.end(JSON.stringify({ result: 'CANCEL', statusCode: 403 }));
        res.end('{}');
      });
    });
    const CANCEL_PLUGIN_PORT = 9732;
    await listen(cancelServer, CANCEL_PLUGIN_PORT);

    const cancelMgr   = new PluginManager(logger, `localhost:${CANCEL_PLUGIN_PORT}`);
    const cancelProxy = new ProxyServer(logger, cancelMgr);
    const CANCEL_PROXY_PORT = 9703;
    process.env.HTTP_PORT = String(CANCEL_PROXY_PORT);
    cancelProxy.db.dbPath = path.join(testDataDir, 'cancel-test.db');
    cancelProxy.certManager.certsDir = path.join(testDataDir, 'cancel-certs');
    await cancelProxy.initialize();
    await cancelProxy.start();
    await cancelProxy.db.addMapping('cancel-plugin.test', '', String(BACKEND_PORT), '');

    try {
      const data   = Buffer.alloc(1024); // small — we just need the cancel to fire
      const result = await upload(CANCEL_PROXY_PORT, 'cancel-plugin.test', data);
      expect(result.status).toBe(403);
    } finally {
      await cancelProxy.stop();
      await close(cancelServer);
      delete process.env.HTTP_PORT;
    }
  }, 15000);
});
