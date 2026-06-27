'use strict';

// Large / streaming uploads through CHAINED jsproxies of arbitrary depth:
//   client -> proxy_1 -> proxy_2 -> ... -> proxy_N -> echo backend
// Every hop shares the same domain (Host-routed) and every hop is HA (a live
// port + a dead port) so the HA streaming + failover path is exercised at each
// hop. Proves nothing is buffered (otherwise a chain of large bodies would OOM)
// and that no hop returns a 502/404 when a backend port is dead.

const http = require('http');
const path = require('path');
const fs   = require('fs').promises;
const ProxyServer = require('../src/ProxyServer');

const BIG = 8 * 1024 * 1024; // 8 MB — well over the 512 KB stream threshold

function listen(server, port) { return new Promise(r => server.listen(port, r)); }
function close(server)         { return new Promise(r => server.close(r)); }

// Counts incoming bytes without buffering; echoes the total.
function makeEchoBackend() {
  return http.createServer((req, res) => {
    let bytes = 0;
    req.on('data', c => { bytes += c.length; });
    req.on('end', () => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(String(bytes)); });
  });
}

// Upload with explicit Content-Length.
function upload(proxyPort, host, data) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: 'localhost', port: proxyPort, path: '/upload', method: 'POST',
      headers: { Host: host, 'content-type': 'application/octet-stream', 'content-length': data.length },
    }, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
    req.on('error', reject);
    req.end(data);
  });
}

// True streaming upload: NO content-length → Transfer-Encoding: chunked, written
// in chunks with backpressure so it genuinely streams rather than buffering.
function uploadChunked(proxyPort, host, data, chunkSize = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: 'localhost', port: proxyPort, path: '/upload', method: 'POST',
      headers: { Host: host, 'content-type': 'application/octet-stream' }, // no content-length
    }, res => { let b = ''; res.on('data', c => b += c); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
    req.on('error', reject);
    let off = 0;
    (function send() {
      while (off < data.length) {
        const end = Math.min(off + chunkSize, data.length);
        const ok = req.write(data.subarray(off, end));
        off = end;
        if (!ok) { req.once('drain', send); return; }
      }
      req.end();
    })();
  });
}

const logger = { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() };

// Reserve an OS-assigned port and immediately release it — gives a port number
// that is currently free, used here as a guaranteed-dead HA backend for failover.
function freePort() {
  return new Promise((resolve) => {
    const srv = http.createServer();
    srv.listen(0, () => { const p = srv.address().port; srv.close(() => resolve(p)); });
  });
}

// Start a proxy on an OS-assigned port. Mapping points at `mapBackPort` (the
// already-started downstream hop). Returns { proxy, port }.
async function makeProxy(dir, mapBackPort) {
  await fs.mkdir(dir, { recursive: true }).catch(() => {});
  process.env.HTTP_PORT = '0';
  process.env.ENABLE_HTTPS = 'false';
  const proxy = new ProxyServer(logger);
  proxy.db.dbPath = path.join(dir, 'test.db');
  proxy.certManager.certsDir = path.join(dir, 'certs');
  await proxy.initialize();
  await proxy.db.addMapping('chain.test', '', mapBackPort, '');
  await proxy.start();
  delete process.env.HTTP_PORT;
  return { proxy, port: proxy.httpServer.address().port };
}

// Build a depth-N HA chain with OS-assigned ports so nothing can collide with
// other tests or services. Each hop is HA: a live downstream port + a dead port.
async function buildChain(depth, dir) {
  const backend = makeEchoBackend();
  await listen(backend, 0);
  let prev = backend.address().port;

  const proxies = [];
  // Build from the backend outward; each proxy targets the already-started hop.
  for (let hop = depth; hop >= 1; hop--) {
    const dead = await freePort();
    const { proxy, port } = await makeProxy(path.join(dir, `p${hop}`), `${prev},${dead}`);
    proxies.push(proxy);
    prev = port;
  }

  return {
    entryPort: prev, // outermost proxy
    async teardown() {
      for (const p of proxies) { try { await p.stop(); } catch (_) {} }
      await close(backend).catch(() => {});
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    },
  };
}

describe.each([2, 3, 4])('HA chain depth %i — large uploads stream end-to-end', (depth) => {
  let chain;
  beforeAll(async () => {
    chain = await buildChain(depth, path.join(__dirname, `chain-data-d${depth}`));
  }, 30000);
  afterAll(async () => {
    if (chain) await chain.teardown();
    delete process.env.ENABLE_HTTPS;
  });

  // Run each request type several times: HA round-robin rotates the port order,
  // so a single pass could miss the dead-port-first case that produced the 502.
  test('large content-length upload survives every rotation', async () => {
    for (let i = 0; i < 6; i++) {
      const r = await upload(chain.entryPort, 'chain.test', Buffer.alloc(BIG));
      expect(r.status).toBe(200);
      expect(Number(r.body)).toBe(BIG);
    }
  }, 60000);

  test('chunked/streaming upload survives every rotation', async () => {
    for (let i = 0; i < 6; i++) {
      const r = await uploadChunked(chain.entryPort, 'chain.test', Buffer.alloc(BIG));
      expect(r.status).toBe(200);
      expect(Number(r.body)).toBe(BIG);
    }
  }, 60000);
});
