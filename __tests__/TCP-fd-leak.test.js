const net = require('net');
const path = require('path');
const fs = require('fs').promises;
const ProxyServer = require('../src/ProxyServer');

// A backend that accepts connections and then holds them open forever. The
// `allowHalfOpen` flag is the point: without it Node auto-closes the backend
// socket the moment it receives the client's FIN, which papers over an upstream
// socket the proxy forgot to destroy. Real backends (databases, chained
// proxies) routinely hold a connection open after a half-close, so this is the
// shape that actually leaked in production.
function makeHoldingBackend() {
  const server = net.createServer({ allowHalfOpen: true }, (sock) => {
    server.__sockets.push(sock);
    sock.on('error', () => {});
    // deliberately never end() / destroy()
  });
  server.__sockets = [];
  return server;
}

function listenOn(server, port) {
  return new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
}

// server.close() only stops accepting — it waits for live connections to end.
// The holding backend never ends any, so drop them explicitly first or this
// never settles. (closeAllConnections() is an http.Server method; net.Server
// has no equivalent, hence the manual socket list.)
function closeServer(server) {
  return new Promise((resolve) => {
    (server.__sockets || []).forEach((s) => s.destroy());
    server.close(resolve);
  });
}

function waitFor(predicate, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      if (predicate() || Date.now() - started > timeoutMs) return resolve();
      setTimeout(tick, 25);
    };
    tick();
  });
}

describe('Raw TCP proxying — upstream socket lifecycle (fd leak)', () => {
  let proxy;
  let logger;
  let testDataDir;
  const PROXY_PORT = 9500;

  const refreshTcp = () => proxy.startTcpListeners(PROXY_PORT, 0, '127.0.0.1');

  beforeAll(async () => {
    testDataDir = path.join(__dirname, 'tcp-fdleak-test-data');
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

  // Capture the sockets the proxy opens toward a specific backend port, so we
  // can assert on their disposal. Filtering by port keeps the test's own client
  // sockets out of the sample.
  function captureUpstreams(backendPort) {
    const captured = [];
    const original = net.Socket.prototype.connect;
    net.Socket.prototype.connect = function patched(...args) {
      const first = args[0];
      const port = first && typeof first === 'object' ? first.port : first;
      if (Number(port) === backendPort) captured.push(this);
      return original.apply(this, args);
    };
    return { captured, restore: () => { net.Socket.prototype.connect = original; } };
  }

  test('destroys the upstream socket when the client closes', async () => {
    const BACKEND_PORT = 9520;
    const LISTEN_PORT = 9510;
    const backend = makeHoldingBackend();
    await listenOn(backend, BACKEND_PORT);
    const spy = captureUpstreams(BACKEND_PORT);
    const clients = [];
    try {
      await proxy.db.addTcpRoute(LISTEN_PORT, '127.0.0.1', String(BACKEND_PORT));
      await refreshTcp();

      // Open a few connections and half-close each from the client side. We do
      // not wait for the client's 'close' here: the whole point of the bug is
      // that the proxy may never come back, so waiting would just time out and
      // obscure the actual assertion below.
      for (let i = 0; i < 3; i++) {
        await new Promise((resolve, reject) => {
          const sock = net.connect(LISTEN_PORT, '127.0.0.1', () => {
            clients.push(sock);
            sock.end();               // graceful FIN
            resolve();
          });
          sock.on('error', reject);
        });
      }

      await waitFor(() => spy.captured.length >= 3 && spy.captured.every((s) => s.destroyed));

      expect(spy.captured.length).toBeGreaterThanOrEqual(3);
      // Count, not the socket objects — a failed toHaveLength on sockets dumps
      // several screens of internal state and buries the actual number.
      const leaked = spy.captured.filter((s) => !s.destroyed).length;
      expect(leaked).toBe(0);
    } finally {
      spy.restore();
      clients.forEach((s) => s.destroy());
      await closeServer(backend);
    }
  }, 20000);

  // Guards the obvious way to over-fix the leak: tearing the peer down with
  // destroy() on 'close' discards whatever is still sitting in its write
  // buffer, silently truncating large responses. The payload here is well past
  // the 16 KB highWaterMark so it cannot flush in a single tick.
  test('does not truncate a large response when the backend closes first', async () => {
    const BACKEND_PORT = 9522;
    const LISTEN_PORT = 9512;
    const PAYLOAD = 'x'.repeat(4 * 1024 * 1024);
    const backend = net.createServer((sock) => {
      sock.on('error', () => {});
      sock.end(PAYLOAD);            // write everything, then FIN immediately
    });
    backend.__sockets = [];
    await listenOn(backend, BACKEND_PORT);
    try {
      await proxy.db.addTcpRoute(LISTEN_PORT, '127.0.0.1', String(BACKEND_PORT));
      await refreshTcp();

      const received = await new Promise((resolve, reject) => {
        const sock = net.connect(LISTEN_PORT, '127.0.0.1');
        let n = 0;
        // Stall before reading. The backend has already sent everything and
        // hung up, so the bytes pile up in the proxy's write buffer — which is
        // precisely what a destroy()-on-close would throw away.
        sock.pause();
        setTimeout(() => sock.resume(), 500);
        sock.on('data', (d) => { n += d.length; });
        sock.on('close', () => resolve(n));
        sock.on('error', reject);
        sock.setTimeout(8000, () => { sock.destroy(); resolve(n); });
      });

      expect(received).toBe(PAYLOAD.length);
    } finally {
      await closeServer(backend);
    }
  }, 20000);

  test('destroys the client socket when the backend closes', async () => {
    const BACKEND_PORT = 9521;
    const LISTEN_PORT = 9511;
    // This backend hangs up on the proxy as soon as it accepts.
    const backend = net.createServer((sock) => { sock.on('error', () => {}); sock.destroy(); });
    await listenOn(backend, BACKEND_PORT);
    const spy = captureUpstreams(BACKEND_PORT);
    try {
      await proxy.db.addTcpRoute(LISTEN_PORT, '127.0.0.1', String(BACKEND_PORT));
      await refreshTcp();

      const clientClosed = await new Promise((resolve) => {
        const sock = net.connect(LISTEN_PORT, '127.0.0.1');
        sock.on('error', () => resolve(true));
        sock.on('close', () => resolve(true));
        sock.setTimeout(5000, () => { sock.destroy(); resolve(false); });
      });

      expect(clientClosed).toBe(true);
      await waitFor(() => spy.captured.every((s) => s.destroyed));
      expect(spy.captured.filter((s) => !s.destroyed).length).toBe(0);
    } finally {
      spy.restore();
      await closeServer(backend);
    }
  }, 20000);
});
