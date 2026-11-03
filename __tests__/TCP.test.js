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

  test('backup targets take traffic only while every primary is down', async () => {
    const primary = makeEchoBackend('primary');
    const standby = makeEchoBackend('standby');
    await listenOn(primary, 9371);
    await listenOn(standby, 9372);
    try {
      await proxy.db.addTcpRoute(9314, 'tcp://127.0.0.1:9371,tcp://127.0.0.1:9372?backup=1', '');
      await refreshTcp();
      proxy.portScores.clear();
      proxy.rrCounters.clear();

      // Healthy primary: every connection goes there, never round-robined to the standby.
      for (let i = 0; i < 4; i++) {
        const res = await tcpSend(9314, 'a');
        expect(res.data).toBe('primary:a');
      }

      // Primary dies: the standby answers.
      await closeServer(primary);
      const res = await tcpSend(9314, 'b');
      expect(res.data).toBe('standby:b');
      const route = (await proxy.db.getTcpRoutes()).find((r) => r.listen_port === 9314);
      expect(proxy.getPortScore(route.id, '127.0.0.1:9371')).toBe(0);

      // Primary back (its background re-check marks it alive): traffic returns to it.
      await listenOn(primary, 9371);
      proxy.portScores.set(proxy._portKey(route.id, '127.0.0.1:9371'), 50);
      const back = await tcpSend(9314, 'c');
      expect(back.data).toBe('primary:c');
    } finally {
      await closeServer(primary).catch(() => {});
      await closeServer(standby);
    }
  }, 20000);

  test('rankedTargets: tiers are healthy primaries, healthy backups, then the dead', () => {
    const t = (key, backup) => ({ hostname: 'h', port: 1, key, ...(backup ? { backup: true } : {}) });
    proxy.portScores.clear();
    proxy.rrCounters.clear();
    proxy.portScores.set(proxy._portKey('m', 'p2'), 0);
    const order = proxy.rankedTargets('m', [t('b1', true), t('p1'), t('p2'), t('b2', true)]).map((x) => x.key);
    expect(order[0]).toBe('p1');
    expect(order.slice(1, 3).sort()).toEqual(['b1', 'b2']);
    expect(order[3]).toBe('p2');
  });

  test('_rawTargets: ?backup=1 marks a standby and keeps the host:port score key', () => {
    const targets = proxy._rawTargets({ id: 'r', backend: 'tcp://10.0.0.1:25,tcp://10.0.0.2:25?backup=1', back_port: '' });
    expect(targets.map((x) => [x.key, !!x.backup])).toEqual([['10.0.0.1:25', false], ['10.0.0.2:25', true]]);
  });

  test('all backends down: proxy closes the client connection with no data', async () => {
    await proxy.db.addTcpRoute(9313, '127.0.0.1', '9350,9351'); // neither listening
    await refreshTcp();
    proxy.portScores.clear();
    proxy.rrCounters.clear();

    process.env.TCP_RETRY_BUDGET_MS = '0';   // one pass, no retry rounds
    try {
      const res = await tcpSend(9313, 'x');
      expect(res.got).toBe(false);
      expect(res.data).toBe('');
    } finally { delete process.env.TCP_RETRY_BUDGET_MS; }
  }, 15000);

  test('edge stall: every backend unreachable for a moment, client still gets through (retry rounds)', async () => {
    await proxy.db.addTcpRoute(9326, '127.0.0.1', '9366,9367'); // nothing listening yet
    await refreshTcp();
    proxy.portScores.clear();
    proxy.rrCounters.clear();

    const backend = makeEchoBackend('late');
    // The "path" comes back 1.5 s after the client connected.
    const t = setTimeout(() => backend.listen(9367, '127.0.0.1'), 1500);
    try {
      const t0 = Date.now();
      const res = await new Promise((resolve) => {
        const sock = net.connect(9326, '127.0.0.1');
        let buf = '';
        sock.on('connect', () => sock.write('hi'));
        sock.on('data', (d) => { buf += d.toString(); sock.end(); });
        sock.on('close', () => resolve({ data: buf, ms: Date.now() - t0 }));
        sock.on('error', () => resolve({ data: buf, ms: Date.now() - t0, error: true }));
        sock.setTimeout(10000, () => sock.destroy());
      });
      expect(res.data).toBe('late:hi');
      expect(res.ms).toBeGreaterThanOrEqual(1400);
      expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/reached (127\.0\.0\.1:)?9367 after \d+ retry round/));
    } finally {
      clearTimeout(t);
      await closeServer(backend).catch(() => {});
    }
  }, 15000);

  test('retry budget: still unreachable after TCP_RETRY_BUDGET_MS -> client closed with no data', async () => {
    await proxy.db.addTcpRoute(9327, '127.0.0.1', '9368,9369');
    await refreshTcp();
    proxy.portScores.clear();
    process.env.TCP_RETRY_BUDGET_MS = '2000';
    try {
      const t0 = Date.now();
      const res = await tcpSend(9327, 'x');
      expect(res.got).toBe(false);
      expect(res.timedOut).not.toBe(true);
      const ms = Date.now() - t0;
      expect(ms).toBeGreaterThanOrEqual(1500);   // it did retry
      expect(ms).toBeLessThan(3900);
    } finally { delete process.env.TCP_RETRY_BUDGET_MS; }
  }, 15000);

  test('client that gives up during retry rounds stops the dialing at once', async () => {
    await proxy.db.addTcpRoute(9328, '127.0.0.1', '9373,9374');  // never listening
    await refreshTcp();
    proxy.portScores.clear();
    // Count only the relay's own dial() calls (by stack): health probes and
    // background re-checks of the same ports run on their own schedule.
    const relayDials = [];
    const origConnect = net.Socket.prototype.connect;
    const dialSpy = jest.spyOn(net.Socket.prototype, 'connect').mockImplementation(function (...args) {
      const o = args[0];
      if (o && typeof o === 'object' && [9373, 9374].includes(o.port) && /\bat dial\b/.test(new Error().stack)) relayDials.push(o.port);
      return origConnect.apply(this, args);
    });
    try {
      await new Promise((resolve) => {
        const sock = net.connect(9328, '127.0.0.1');
        sock.on('connect', () => setTimeout(() => sock.end(), 600));  // FIN, not RST
        sock.on('close', resolve);
        sock.on('error', resolve);
      });
      await new Promise((r) => setTimeout(r, 300));
      const handlerDials = () => relayDials.length;
      const before = handlerDials();
      expect(before).toBeGreaterThan(0);               // it did dial before the client left
      await new Promise((r) => setTimeout(r, 2500));   // a live loop would dial again by now
      expect(handlerDials()).toBe(before);
    } finally { dialSpy.mockRestore(); }
  }, 15000);

  test('probe hysteresis: one failed protocol probe does not score a target 0', async () => {
    process.env.PROTOCOL_PROBE_INTERVAL_MS = '400';
    process.env.PROTOCOL_PROBE_TIMEOUT_MS = '200';
    const route = { id: 'hyst-route', domain: 'x.test' };
    const target = { hostname: '127.0.0.1', port: 9375, key: '127.0.0.1:9375', probe: 'https+check' };  // closed
    try {
      proxy._startProtocolProbes(route, [target], 'tcp');
      await new Promise((r) => setTimeout(r, 250));     // first probe has failed
      expect(proxy.getPortScore(route.id, target.key)).toBe(100);
      await new Promise((r) => setTimeout(r, 500));     // second consecutive failure
      expect(proxy.getPortScore(route.id, target.key)).toBe(0);
    } finally {
      delete process.env.PROTOCOL_PROBE_INTERVAL_MS;
      delete process.env.PROTOCOL_PROBE_TIMEOUT_MS;
    }
  }, 10000);

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

  test('listen_host: binds only that IP, coexisting with another service on the same port (Linux 127/8)', async () => {
    // Something else owns 127.0.0.1:9380; the route binds 127.0.0.2:9380.
    const other = makeEchoBackend('other');
    await listenOn(other, 9380); // listenOn binds 127.0.0.1
    const backend = makeEchoBackend('mine');
    await listenOn(backend, 9381);
    try {
      await proxy.db.addTcpRoute(9380, '127.0.0.1', '9381', null, '127.0.0.2');
      await refreshTcp();
      expect(proxy.tcpServers.has('127.0.0.2:9380')).toBe(true);

      const sendTo = (host) => new Promise((resolve) => {
        const sock = net.connect(9380, host);
        sock.on('connect', () => sock.write('ping'));
        sock.on('data', (d) => { resolve(d.toString()); sock.destroy(); });
        sock.setTimeout(3000, () => { sock.destroy(); resolve(null); });
        sock.on('error', () => resolve(null));
      });
      expect(await sendTo('127.0.0.2')).toBe('mine:ping');
      expect(await sendTo('127.0.0.1')).toBe('other:ping');
    } finally {
      await closeServer(other);
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
