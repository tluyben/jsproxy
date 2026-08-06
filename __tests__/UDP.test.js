const dgram = require('dgram');
const net = require('net');
const path = require('path');
const fs = require('fs').promises;
const ProxyServer = require('../src/ProxyServer');
const { buildDnsQuery } = require('../src/ProtocolProbes');

// UDP echo backend: prefixes each datagram with `tag:` so HA tests can tell
// which backend answered.
function makeUdpEcho(tag, port) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    sock.on('message', (msg, rinfo) => {
      sock.send(Buffer.concat([Buffer.from(`${tag}:`), msg]), rinfo.port, rinfo.address);
    });
    sock.bind(port, '127.0.0.1', () => resolve(sock));
  });
}

// Fake DNS backend: answers ANY datagram with the query + QR bit set, plus a
// trailing `|tag` so tests can identify which backend served the reply. The
// QR/id echo is what the dns:// health probe validates.
function makeFakeDns(tag, port) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    sock.on('message', (msg, rinfo) => {
      const reply = Buffer.from(msg);
      if (reply.length >= 3) reply[2] |= 0x80;
      sock.send(Buffer.concat([reply, Buffer.from(`|${tag}`)]), rinfo.port, rinfo.address);
    });
    sock.bind(port, '127.0.0.1', () => resolve(sock));
  });
}

// Send one datagram to the proxy's UDP listen port and wait for a reply.
function udpSend(port, payload, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    const timer = setTimeout(() => { sock.close(); resolve(null); }, timeoutMs);
    sock.on('message', (msg) => {
      clearTimeout(timer);
      sock.close();
      resolve(msg);
    });
    sock.send(Buffer.isBuffer(payload) ? payload : Buffer.from(payload), port, '127.0.0.1');
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('Raw UDP proxying', () => {
  let proxy;
  let logger;
  let testDataDir;
  const PROXY_PORT = 9500;

  const refreshUdp = () => proxy.startUdpListeners('127.0.0.1');
  const refreshTcp = () => proxy.startTcpListeners(PROXY_PORT, 0, '127.0.0.1');

  beforeAll(async () => {
    testDataDir = path.join(__dirname, 'udp-test-data');
    await fs.mkdir(testDataDir, { recursive: true }).catch(() => {});

    logger = { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() };

    proxy = new ProxyServer(logger);
    proxy.db.dbPath = path.join(testDataDir, 'test.db');
    proxy.certManager.certsDir = path.join(testDataDir, 'certs');

    process.env.HTTP_PORT = String(PROXY_PORT);
    process.env.ENABLE_HTTPS = 'false';
    // Fast probe cadence so failover tests converge quickly.
    process.env.PROTOCOL_PROBE_INTERVAL_MS = '250';
    process.env.PROTOCOL_PROBE_TIMEOUT_MS = '400';

    await proxy.initialize();
    await proxy.start();
  }, 15000);

  afterAll(async () => {
    if (proxy) await proxy.stop();
    delete process.env.HTTP_PORT;
    delete process.env.ENABLE_HTTPS;
    delete process.env.PROTOCOL_PROBE_INTERVAL_MS;
    delete process.env.PROTOCOL_PROBE_TIMEOUT_MS;
    try {
      const files = await fs.readdir(testDataDir);
      await Promise.all(files.map((f) => fs.unlink(path.join(testDataDir, f)).catch(() => {})));
      await fs.rmdir(testDataDir).catch(() => {});
    } catch (_) {}
  });

  test('schema: UDP route is stored with protocol=udp and never matches getMapping', async () => {
    await proxy.db.addUdpRoute(9590, 'localhost', '9999', null, 'probe.example');
    const routes = await proxy.db.getUdpRoutes();
    const r = routes.find((x) => x.listen_port === 9590);
    expect(r).toBeDefined();
    expect(r.protocol).toBe('udp');
    expect(r.domain).toBe('probe.example');
    // Even with a domain set (the probe query name), a UDP row must be
    // invisible to the HTTP router — getMapping filters on protocol.
    const m = await proxy.db.getMapping('probe.example', '/');
    expect(m).toBeNull();
    const tcp = await proxy.db.getTcpRoutes();
    expect(tcp.find((x) => x.listen_port === 9590)).toBeUndefined();
  });

  test('_rawTargets: legacy host+port-list shape keeps bare-port keys (TCP compat)', () => {
    const t = proxy._rawTargets({ id: 'x', backend: '127.0.0.1', back_port: '5432,5433' });
    expect(t).toEqual([
      { hostname: '127.0.0.1', port: 5432, key: '5432', probe: null },
      { hostname: '127.0.0.1', port: 5433, key: '5433', probe: null },
    ]);
    const h = proxy._rawTargets({ id: 'x', backend: 'http://db.internal', back_port: '5432' });
    expect(h).toEqual([{ hostname: 'db.internal', port: 5432, key: '5432', probe: null }]);
  });

  test('_rawTargets: dns:// entries get host:port keys, the dns probe, and default port 53', () => {
    const t = proxy._rawTargets({ id: 'x', backend: 'dns://10.0.0.2:5353,dns://10.0.0.3', back_port: '' });
    expect(t).toEqual([
      { hostname: '10.0.0.2', port: 5353, key: '10.0.0.2:5353', probe: 'dns' },
      { hostname: '10.0.0.3', port: 53, key: '10.0.0.3:53', probe: 'dns' },
    ]);
    // udp:// scheme: no probe; port falls back to a numeric back_port
    const u = proxy._rawTargets({ id: 'x', backend: 'udp://a.internal,udp://b.internal', back_port: '514' });
    expect(u).toEqual([
      { hostname: 'a.internal', port: 514, key: 'a.internal:514', probe: null },
      { hostname: 'b.internal', port: 514, key: 'b.internal:514', probe: null },
    ]);
  });

  test('forwards datagrams to the backend and routes the reply back', async () => {
    const backend = await makeUdpEcho('echo', 9520);
    try {
      await proxy.db.addUdpRoute(9510, '127.0.0.1', '9520');
      await refreshUdp();
      const res = await udpSend(9510, 'ping');
      expect(res).not.toBeNull();
      expect(res.toString()).toBe('echo:ping');
    } finally {
      backend.close();
    }
  }, 15000);

  test('flow stickiness: consecutive datagrams from one client reuse one backend flow', async () => {
    const backend = await makeUdpEcho('sticky', 9521);
    try {
      await proxy.db.addUdpRoute(9511, '127.0.0.1', '9521');
      await refreshUdp();
      const sock = dgram.createSocket('udp4');
      const replies = [];
      sock.on('message', (m) => replies.push(m.toString()));
      sock.send('one', 9511, '127.0.0.1');
      await sleep(200);
      sock.send('two', 9511, '127.0.0.1');
      await sleep(400);
      sock.close();
      expect(replies).toEqual(['sticky:one', 'sticky:two']);
      const state = proxy.udpServers.get(9511);
      expect(state.flows.size).toBe(1); // one client → one flow
    } finally {
      backend.close();
    }
  }, 15000);

  test('HA with dns:// backends: probe penalizes the dead one, traffic goes to the live one', async () => {
    const live = await makeFakeDns('live', 9531); // 9530 intentionally dead
    try {
      await proxy.db.addUdpRoute(9512, 'dns://127.0.0.1:9530,dns://127.0.0.1:9531');
      await refreshUdp();
      // Let the initial probe round complete: dead backend → score 0.
      await sleep(700);

      const route = (await proxy.db.getUdpRoutes()).find((r) => r.listen_port === 9512);
      expect(proxy.getPortScore(route.id, '127.0.0.1:9530')).toBe(0);
      expect(proxy.getPortScore(route.id, '127.0.0.1:9531')).toBe(100);

      // Every query lands on the live backend — the dead one is ranked out.
      for (let i = 0; i < 3; i++) {
        const res = await udpSend(9512, buildDnsQuery('example.com', 0x2222));
        expect(res).not.toBeNull();
        expect(res.toString('latin1')).toContain('|live');
      }
    } finally {
      live.close();
    }
  }, 15000);

  test('HA without probes: ICMP refusal on loopback retries the datagram on the next backend', async () => {
    const live = await makeUdpEcho('alive', 9541); // 9540 intentionally dead
    try {
      await proxy.db.addUdpRoute(9513, '127.0.0.1', '9540,9541');
      await refreshUdp();
      proxy.portScores.clear();
      proxy.rrCounters.clear();

      // Whichever backend is picked first, the reply must come from the live
      // one: a dead pick surfaces ECONNREFUSED and the datagram is replayed.
      for (let i = 0; i < 4; i++) {
        const res = await udpSend(9513, `try${i}`);
        expect(res).not.toBeNull();
        expect(res.toString()).toBe(`alive:try${i}`);
      }
    } finally {
      live.close();
    }
  }, 20000);

  test('IP allowlist: datagram from a disallowed source is silently dropped', async () => {
    const backend = await makeUdpEcho('secret', 9550);
    try {
      await proxy.db.addUdpRoute(9514, '127.0.0.1', '9550', '8.8.8.8'); // not us
      await refreshUdp();
      const res = await udpSend(9514, 'x', 1200);
      expect(res).toBeNull();
    } finally {
      backend.close();
    }
  }, 15000);

  test('a TCP route and a UDP route can share the same listen_port', async () => {
    const udpBackend = await makeUdpEcho('udp53', 9560);
    const tcpBackend = net.createServer((s) => { s.on('data', (d) => s.write(`tcp53:${d}`)); s.on('error', () => {}); });
    await new Promise((r) => tcpBackend.listen(9561, '127.0.0.1', r));
    try {
      await proxy.db.addUdpRoute(9515, '127.0.0.1', '9560');
      await proxy.db.addTcpRoute(9515, '127.0.0.1', '9561');
      await refreshUdp();
      await refreshTcp();

      const udpRes = await udpSend(9515, 'hello');
      expect(udpRes).not.toBeNull();
      expect(udpRes.toString()).toBe('udp53:hello');

      const tcpRes = await new Promise((resolve) => {
        const sock = net.connect(9515, '127.0.0.1');
        sock.on('connect', () => sock.write('hello'));
        sock.on('data', (d) => { resolve(d.toString()); sock.destroy(); });
        sock.setTimeout(3000, () => { sock.destroy(); resolve(null); });
        sock.on('error', () => resolve(null));
      });
      expect(tcpRes).toBe('tcp53:hello');
    } finally {
      udpBackend.close();
      await new Promise((r) => tcpBackend.close(r));
    }
  }, 15000);

  test('HTTP mappings still work while UDP listeners are active', async () => {
    const http = require('http');
    const httpBackend = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('http-ok');
    });
    await new Promise((r) => httpBackend.listen(9570, '127.0.0.1', r));
    try {
      await proxy.db.addMapping('coexist.udp.test', '', '9570', '', 'http://127.0.0.1');
      const res = await new Promise((resolve, reject) => {
        const req = http.request({ hostname: '127.0.0.1', port: PROXY_PORT, path: '/', headers: { Host: 'coexist.udp.test' } }, (r) => {
          let body = '';
          r.on('data', (c) => { body += c; });
          r.on('end', () => resolve({ status: r.statusCode, body }));
        });
        req.on('error', reject);
        req.end();
      });
      expect(res.status).toBe(200);
      expect(res.body).toBe('http-ok');
    } finally {
      await new Promise((r) => httpBackend.close(r));
    }
  }, 15000);
});
