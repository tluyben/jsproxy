const net = require('net');
const path = require('path');
const fs = require('fs').promises;
const ProxyServer = require('../src/ProxyServer');

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

// A raw TCP route whose listen_port IS the HTTP/HTTPS port takes that port
// over: the HTTP(S) server is not started and the port is pure passthrough.
describe('Raw TCP takeover of the HTTP/HTTPS ports', () => {
  let proxy;
  let logger;
  let testDataDir;
  let b1;
  let b2;
  const HTTP_PORT = 9860;
  const HTTPS_PORT = 9861;

  beforeAll(async () => {
    testDataDir = path.join(__dirname, 'tcp-takeover-data');
    await fs.mkdir(testDataDir, { recursive: true }).catch(() => {});

    logger = { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() };

    b1 = makeEchoBackend('b1');
    b2 = makeEchoBackend('b2');
    await listenOn(b1, 9865);
    await listenOn(b2, 9866);

    proxy = new ProxyServer(logger);
    proxy.db.dbPath = path.join(testDataDir, 'test.db');
    proxy.certManager.certsDir = path.join(testDataDir, 'certs');

    process.env.HTTP_PORT = String(HTTP_PORT);
    process.env.HTTPS_PORT = String(HTTPS_PORT);
    process.env.ENABLE_HTTPS = 'false';

    await proxy.initialize();
    // Routes exist BEFORE start(), so start() must yield both ports to them.
    await proxy.db.addTcpRoute(HTTP_PORT, '127.0.0.1', '9865');
    await proxy.db.addTcpRoute(HTTPS_PORT, 'tcp://127.0.0.1:9865,tcp://127.0.0.1:9866', '');
    await proxy.start();
  }, 15000);

  afterAll(async () => {
    if (proxy) await proxy.stop();
    await closeServer(b1);
    await closeServer(b2);
    delete process.env.HTTP_PORT;
    delete process.env.HTTPS_PORT;
    delete process.env.ENABLE_HTTPS;
    try {
      const files = await fs.readdir(testDataDir);
      await Promise.all(files.map((f) => fs.unlink(path.join(testDataDir, f)).catch(() => {})));
      await fs.rmdir(testDataDir).catch(() => {});
    } catch (_) {}
  });

  test('the HTTP server is not started and the takeover is logged', () => {
    expect(proxy.httpServer).toBeNull();
    const warned = logger.warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(warned).toMatch(/claimed by a raw TCP route/);
  });

  test('the HTTP port forwards raw bytes instead of speaking HTTP', async () => {
    const res = await tcpSend(HTTP_PORT, 'GET / HTTP/1.1\r\nHost: x\r\n\r\n');
    expect(res.got).toBe(true);
    // An echo prefixed with the backend tag — not an HTTP response from jsproxy.
    expect(res.data.startsWith('b1:GET /')).toBe(true);
  });

  test('the HTTPS port runs HA passthrough across both tcp:// backends', async () => {
    proxy.portScores.clear();
    proxy.rrCounters.clear();
    const seen = new Set();
    for (let i = 0; i < 4; i++) {
      const res = await tcpSend(HTTPS_PORT, 'hello');
      expect(res.got).toBe(true);
      seen.add(res.data.split(':')[0]);
    }
    expect(seen.has('b1')).toBe(true);
    expect(seen.has('b2')).toBe(true);
  });
});
