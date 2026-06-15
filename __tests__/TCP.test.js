const http = require('http');
const net = require('net');
const path = require('path');
const fs = require('fs').promises;
const ProxyServer = require('../src/ProxyServer');

// A raw TCP echo backend. Prefixes each chunk with `tag:` so HA tests can tell
// which backend actually answered.
function makeEchoBackend(tag) {
  return net.createServer((sock) => {
    sock.on('data', (d) => sock.write(`${tag}:${d.toString()}`));
    sock.on('error', () => {});
  });
}

function listenOn(server, port) {
  return new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
}

function closeServer(server) {
  return new Promise((resolve) => server.close(resolve));
}

// Connect to the proxy's TCP listen port, send `payload`, collect the reply.
// Resolves { data, got } where got=false means the proxy closed us without data
// (the TCP analogue of a 502 / forbidden).
function tcpSend(port, payload) {
  return new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1');
    let buf = '';
    let got = false;
    sock.on('connect', () => sock.write(payload));
    sock.on('data', (d) => { buf += d.toString(); got = true; sock.end(); });
    sock.on('close', () => resolve({ data: buf, got }));
    sock.on('error', () => { if (!got) resolve({ data: buf, got, error: true }); });
    sock.setTimeout(4000, () => { sock.destroy(); resolve({ data: buf, got, timedOut: true }); });
  });
}

function httpGet(port, host) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: '/', headers: { Host: host } }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('Raw TCP proxying', () => {
  let proxy;
  let logger;
  let testDataDir;
  const PROXY_PORT = 9300;

  // Spin up listeners for any newly-added TCP routes. startTcpListeners is
  // idempotent (skips already-bound ports), so it's safe to call per test.
  const refreshTcp = () => proxy.startTcpListeners(PROXY_PORT, 0, '127.0.0.1');

  beforeAll(async () => {
    testDataDir = path.join(__dirname, 'tcp-test-data');
    await fs.mkdir(testDataDir, { recursive: true }).catch(() => {});

    logger = { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() };

    proxy = new ProxyServer(logger);
    proxy.db.dbPath = path.join(testDataDir, 'test.db');
    proxy.certManager.certsDir = path.join(testDataDir, 'certs');

    process.env.HTTP_PORT = String(PROXY_PORT);
    process.env.ENABLE_HTTPS = 'false';

    await proxy.initialize();
    await proxy.start();
  }, 15000);

  afterAll(async () => {
    if (proxy) await proxy.stop();
    delete process.env.HTTP_PORT;
    delete process.env.ENABLE_HTTPS;
    try {
      const files = await fs.readdir(testDataDir);
      await Promise.all(files.map((f) => fs.unlink(path.join(testDataDir, f)).catch(() => {})));
      await fs.rmdir(testDataDir).catch(() => {});
    } catch (_) {}
  });

  test('schema: TCP route is stored with protocol=tcp and never matches getMapping', async () => {
    await proxy.db.addTcpRoute(9390, 'localhost', '9999');
    const routes = await proxy.db.getTcpRoutes();
    const r = routes.find((x) => x.listen_port === 9390);
    expect(r).toBeDefined();
    expect(r.protocol).toBe('tcp');
    expect(r.back_port).toBe('9999');
    // A TCP route must be invisible to the HTTP router even when the computed
    // domain is '' (e.g. a malformed "Host: :8080") — getMapping filters protocol.
    const m = await proxy.db.getMapping('', '/');
    expect(m).toBeNull();
  });

  test('forwards raw bytes to the backend and echoes the reply', async () => {
    const backend = makeEchoBackend('echo');
    await listenOn(backend, 9320);
    try {
      await proxy.db.addTcpRoute(9310, '127.0.0.1', '9320');
      await refreshTcp();
      const res = await tcpSend(9310, 'ping');
      expect(res.got).toBe(true);
      expect(res.data).toBe('echo:ping');
    } finally {
      await closeServer(backend);
    }
  }, 15000);

  test('HA: distributes connections across healthy backends', async () => {
    const b1 = makeEchoBackend('b1');
    const b2 = makeEchoBackend('b2');
    await listenOn(b1, 9330);
    await listenOn(b2, 9331);
    try {
      await proxy.db.addTcpRoute(9311, '127.0.0.1', '9330,9331');
      await refreshTcp();
      proxy.portScores.clear();
      proxy.rrCounters.clear();

      const seen = new Set();
      for (let i = 0; i < 4; i++) {
        const res = await tcpSend(9311, 'hi');
        expect(res.got).toBe(true);
        seen.add(res.data.split(':')[0]);
      }
      expect(seen.has('b1')).toBe(true);
      expect(seen.has('b2')).toBe(true);
    } finally {
      await closeServer(b1);
      await closeServer(b2);
    }
  }, 15000);

  test('HA: fails over to a live backend when one port is down', async () => {
    const alive = makeEchoBackend('alive');
    await listenOn(alive, 9341); // 9340 intentionally not listening
    try {
      await proxy.db.addTcpRoute(9312, '127.0.0.1', '9340,9341');
      await refreshTcp();
      proxy.portScores.clear();
      proxy.rrCounters.clear();

      const res = await tcpSend(9312, 'x');
      expect(res.got).toBe(true);
      expect(res.data).toBe('alive:x');

      const route = (await proxy.db.getTcpRoutes()).find((r) => r.listen_port === 9312);
      expect(proxy.getPortScore(route.id, 9340)).toBe(0); // dead port penalized
    } finally {
      await closeServer(alive);
    }
  }, 15000);

  test('all backends down: proxy closes the client connection with no data', async () => {
    await proxy.db.addTcpRoute(9313, '127.0.0.1', '9350,9351'); // neither listening
    await refreshTcp();
    proxy.portScores.clear();
    proxy.rrCounters.clear();

    const res = await tcpSend(9313, 'x');
    expect(res.got).toBe(false);
    expect(res.data).toBe('');
  }, 15000);

  test('IP allowlist: connection from a disallowed source is rejected', async () => {
    const backend = makeEchoBackend('secret');
    await listenOn(backend, 9360);
    try {
      await proxy.db.addTcpRoute(9314, '127.0.0.1', '9360', '8.8.8.8'); // not us
      await refreshTcp();
      const res = await tcpSend(9314, 'x');
      expect(res.got).toBe(false);
      expect(res.data).toBe('');
    } finally {
      await closeServer(backend);
    }
  }, 15000);

  test('HTTP mappings still work while TCP listeners are active', async () => {
    const httpBackend = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('http-ok');
    });
    await new Promise((r) => httpBackend.listen(9370, '127.0.0.1', r));
    try {
      await proxy.db.addMapping('coexist.tcp.test', '', '9370', '', 'http://127.0.0.1');
      const res = await httpGet(PROXY_PORT, 'coexist.tcp.test');
      expect(res.status).toBe(200);
      expect(res.body).toBe('http-ok');
    } finally {
      await closeServer(httpBackend);
    }
  }, 15000);
});
