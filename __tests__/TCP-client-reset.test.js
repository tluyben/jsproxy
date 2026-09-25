const net = require('net');
const path = require('path');
const fs = require('fs').promises;
const ProxyServer = require('../src/ProxyServer');

// A client that RESETS its connection while jsproxy is still connecting to the
// backend. The client socket had no 'error' listener until the upstream
// connected, so the ECONNRESET was an unhandled 'error' event — an uncaught
// exception that took the whole worker (and every relayed connection on it)
// down. Seen in production: the hetzner-1 host jsproxy crash-restarted with
// "Error: read ECONNRESET at TCP.onStreamRead" several times a day, cutting
// every in-flight upload through the box.
describe('Raw TCP proxying — client reset before the upstream connects', () => {
  let proxy;
  let testDataDir;
  const PROXY_PORT = 9540;
  const LISTEN_PORT = 9541;
  const uncaught = [];
  const onUncaught = (e) => uncaught.push(e);

  beforeAll(async () => {
    testDataDir = path.join(__dirname, 'tcp-client-reset-test-data');
    await fs.mkdir(testDataDir, { recursive: true }).catch(() => {});
    const logger = { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() };
    proxy = new ProxyServer(logger);
    proxy.db.dbPath = path.join(testDataDir, 'test.db');
    proxy.certManager.certsDir = path.join(testDataDir, 'certs');
    process.env.HTTP_PORT = String(PROXY_PORT);
    process.env.ENABLE_HTTPS = 'false';
    process.env.TCP_CONNECT_TIMEOUT_MS = '2000';
    await proxy.initialize();
    await proxy.start();
    process.on('uncaughtException', onUncaught);
  }, 15000);

  afterAll(async () => {
    process.removeListener('uncaughtException', onUncaught);
    if (proxy) await proxy.stop();
    delete process.env.HTTP_PORT;
    delete process.env.ENABLE_HTTPS;
    delete process.env.TCP_CONNECT_TIMEOUT_MS;
    await fs.rm(testDataDir, { recursive: true, force: true }).catch(() => {});
  });

  test('does not crash when the client resets during the upstream connect', async () => {
    // 10.255.255.1 is non-routable: the connect hangs until the timeout, which
    // holds the relay in its pre-connect window.
    await proxy.db.addTcpRoute(LISTEN_PORT, '10.255.255.1', '9');
    await proxy.startTcpListeners(PROXY_PORT, 0, '127.0.0.1');

    for (let i = 0; i < 3; i++) {
      await new Promise((resolve) => {
        const c = net.connect(LISTEN_PORT, '127.0.0.1', () => {
          c.write('hello');
          setTimeout(() => { c.resetAndDestroy(); resolve(); }, 100);
        });
        c.on('error', () => {});
      });
    }
    await new Promise((r) => setTimeout(r, 500));

    expect(uncaught.map((e) => e.message)).toEqual([]);
  }, 20000);
});
