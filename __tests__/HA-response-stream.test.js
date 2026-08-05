const http = require('http');
const path = require('path');
const fs = require('fs').promises;
const ProxyServer = require('../src/ProxyServer');

// Regression tests for the buffered-request/streamed-response HA path
// (_streamResponseHA). The original bug: a plain GET download took the fully
// buffered path (_requestHA), so (a) the entire response was held in memory and
// (b) HA_RESPONSE_TIMEOUT_MS applied to the whole body — a large download whose
// first byte (or any mid-body gap) exceeded 30s was treated as a backend
// failure, penalized, retried on every target and finally surfaced as
// "Bad Gateway: all backends unavailable" even though every backend was healthy.

const PROXY_PORT = 9640;
const CHUNK = Buffer.alloc(64 * 1024, 'x');

function listenOn(server, port) {
  return new Promise(resolve => server.listen(port, resolve));
}

function closeServer(server) {
  return new Promise(resolve => server.close(resolve));
}

// GET that records when the FIRST body byte arrived relative to request start,
// so tests can prove the response streamed instead of being buffered.
function timedGet(host, reqPath = '/', method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    let firstByteMs = null;
    const req = http.request(
      { hostname: 'localhost', port: PROXY_PORT, path: reqPath, method,
        headers: { Host: host, ...(body ? { 'Content-Length': body.length } : {}) } },
      res => {
        let bytes = 0;
        let text = '';
        res.on('data', c => {
          if (firstByteMs === null) firstByteMs = Date.now() - start;
          bytes += c.length;
          if (bytes <= 4096) text += c.toString();
        });
        res.on('end', () => resolve({
          status: res.statusCode, bytes, text, firstByteMs, totalMs: Date.now() - start,
        }));
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

describe('HA streamed-response path', () => {
  let proxy;
  let logger;
  let testDataDir;
  const servers = [];

  async function backend(port, handler) {
    const s = http.createServer(handler);
    await listenOn(s, port);
    servers.push(s);
    return s;
  }

  beforeAll(async () => {
    testDataDir = path.join(__dirname, 'ha-response-stream-test-data');
    await fs.mkdir(testDataDir, { recursive: true }).catch(() => {});

    logger = { info: jest.fn(), error: jest.fn(), warn: jest.fn() };

    // Scaled down from the 30s production default so the old buffered behaviour
    // (which failed any silent gap > this value mid-body) would fail fast here.
    process.env.HA_RESPONSE_TIMEOUT_MS = '800';
    process.env.HTTP_PORT = String(PROXY_PORT);
    process.env.ENABLE_HTTPS = 'false';

    proxy = new ProxyServer(logger);
    proxy.db.dbPath = path.join(testDataDir, 'test.db');
    proxy.certManager.certsDir = path.join(testDataDir, 'certs');

    await proxy.initialize();
    await proxy.start();
  }, 15000);

  afterAll(async () => {
    if (proxy) await proxy.stop();
    await Promise.all(servers.map(closeServer));
    delete process.env.HA_RESPONSE_TIMEOUT_MS;
    delete process.env.HTTP_PORT;
    delete process.env.ENABLE_HTTPS;
    try {
      const files = await fs.readdir(testDataDir);
      await Promise.all(files.map(f => fs.unlink(path.join(testDataDir, f)).catch(() => {})));
      await fs.rmdir(testDataDir).catch(() => {});
    } catch (_) {}
  });

  test('large response streams to the client instead of being buffered', async () => {
    // 15 chunks, one every 100ms → ~1.5s total. If the proxy buffered the
    // response, the client's first byte would arrive only at the very end.
    await backend(9641, (req, res) => {
      res.writeHead(200, { 'Content-Length': String(CHUNK.length * 15) });
      let sent = 0;
      const t = setInterval(() => {
        res.write(CHUNK);
        if (++sent >= 15) { clearInterval(t); res.end(); }
      }, 100);
      res.on('close', () => clearInterval(t));
    });
    await proxy.db.addMapping('stream.rs.test', '', '9641,9642', '');

    const r = await timedGet('stream.rs.test');
    expect(r.status).toBe(200);
    expect(r.bytes).toBe(CHUNK.length * 15);
    expect(r.totalMs).toBeGreaterThan(1000);
    expect(r.firstByteMs).toBeLessThan(1000); // streamed, not held until complete
  }, 15000);

  test('mid-body stall longer than HA_RESPONSE_TIMEOUT_MS still completes (the original bug)', async () => {
    await backend(9643, (req, res) => {
      res.writeHead(200, { 'Content-Length': String(CHUNK.length * 2) });
      res.write(CHUNK);
      setTimeout(() => res.end(CHUNK), 2000); // 2s silence ≫ 800ms timeout
    });
    await proxy.db.addMapping('stall.rs.test', '', '9643,9644', '');

    const r = await timedGet('stall.rs.test');
    expect(r.status).toBe(200);
    expect(r.bytes).toBe(CHUNK.length * 2);
  }, 15000);

  test('steady download taking far longer than HA_RESPONSE_TIMEOUT_MS survives', async () => {
    await backend(9645, (req, res) => {
      res.writeHead(200, { 'Content-Length': String(CHUNK.length * 30) });
      let sent = 0;
      const t = setInterval(() => {
        res.write(CHUNK);
        if (++sent >= 30) { clearInterval(t); res.end(); }
      }, 100); // ~3s total against an 800ms response timeout
      res.on('close', () => clearInterval(t));
    });
    // Second (dead) port keeps the mapping on the HA path.
    await proxy.db.addMapping('steady.rs.test', '', '9645,9646', '');

    const r = await timedGet('steady.rs.test');
    expect(r.status).toBe(200);
    expect(r.bytes).toBe(CHUNK.length * 30);
    expect(r.totalMs).toBeGreaterThan(2000);
  }, 15000);

  test('accepted-but-silent backend fails over to a healthy one before headers', async () => {
    await backend(9647, (req, res) => { /* accept, never respond */ });
    await backend(9648, (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('served-by-healthy');
    });
    await proxy.db.addMapping('failover.rs.test', '', '9647,9648', '');
    // Deterministic order: make the silent backend the top-ranked target.
    proxy.boostPort(
      (await proxy.db.getMapping('failover.rs.test', '/')).id, '9647');

    const r = await timedGet('failover.rs.test');
    expect(r.status).toBe(200);
    expect(r.text).toBe('served-by-healthy');
  }, 15000);

  test('non-idempotent request to a silent backend gets 504, no failover', async () => {
    let healthyHits = 0;
    await backend(9649, (req, res) => { /* accept, never respond */ });
    await backend(9650, (req, res) => {
      healthyHits++;
      res.writeHead(200); res.end('ok');
    });
    await proxy.db.addMapping('post.rs.test', '', '9649,9650', '');
    proxy.boostPort((await proxy.db.getMapping('post.rs.test', '/')).id, '9649');

    const r = await timedGet('post.rs.test', '/', 'POST', Buffer.from('payload'));
    expect(r.status).toBe(504);
    expect(r.text).toContain('Gateway Timeout');
    expect(healthyHits).toBe(0);
  }, 15000);

  test('all backends down still returns the 502 all-backends page', async () => {
    await proxy.db.addMapping('alldown.rs.test', '', '9651,9652', '');
    const r = await timedGet('alldown.rs.test');
    expect(r.status).toBe(502);
    expect(r.text).toBe('Bad Gateway: all backends unavailable');
  }, 15000);

  test('forwards back_host (or original Host) upstream, never the backend address', async () => {
    let seenHost = null;
    await backend(9653, (req, res) => {
      seenHost = req.headers.host;
      res.writeHead(200); res.end('ok');
    });
    await proxy.db.addMapping('host.rs.test', '', '9653,9654', '');
    const m = await proxy.db.getMapping('host.rs.test', '/');
    proxy.boostPort(m.id, '9653');

    let r = await timedGet('host.rs.test');
    expect(r.status).toBe(200);
    expect(seenHost).toBe('host.rs.test');

    await new Promise((resolve, reject) => {
      proxy.db.db.run('UPDATE mappings SET back_host = ? WHERE id = ?',
        ['internal.example', m.id], err => (err ? reject(err) : resolve()));
    });
    r = await timedGet('host.rs.test');
    expect(r.status).toBe(200);
    expect(seenHost).toBe('internal.example');
  }, 15000);
});
