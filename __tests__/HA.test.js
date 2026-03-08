const http = require('http');
const path = require('path');
const fs = require('fs').promises;
const ProxyServer = require('../src/ProxyServer');

// Helpers
function makeBackend(statusCode, body) {
  return http.createServer((req, res) => {
    res.writeHead(statusCode, { 'Content-Type': 'text/plain' });
    res.end(body);
  });
}

function listenOn(server, port) {
  return new Promise(resolve => server.listen(port, resolve));
}

function closeServer(server) {
  return new Promise(resolve => server.close(resolve));
}

function httpGet(port, host) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: 'localhost', port, path: '/', headers: { Host: host } }, res => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('HA / Round-Robin multi-port', () => {
  let proxy;
  let logger;
  let testDataDir;
  const PROXY_PORT = 9200;

  beforeAll(async () => {
    testDataDir = path.join(__dirname, 'ha-test-data');
    await fs.mkdir(testDataDir, { recursive: true }).catch(() => {});

    logger = { info: jest.fn(), error: jest.fn(), warn: jest.fn() };

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
      await Promise.all(files.map(f => fs.unlink(path.join(testDataDir, f)).catch(() => {})));
      await fs.rmdir(testDataDir).catch(() => {});
    } catch (_) {}
  });

  test('back_port stored and retrieved as string for single port', async () => {
    await proxy.db.addMapping('single.ha.test', '', '4100', '');
    const m = await proxy.db.getMapping('single.ha.test', '/');
    expect(m.back_port).toBe('4100');
    expect(typeof m.back_port).toBe('string');
  });

  test('back_port stored and retrieved as string for multi-port', async () => {
    await proxy.db.addMapping('multi.ha.test', '', '4101,4102,4103', '');
    const m = await proxy.db.getMapping('multi.ha.test', '/');
    expect(m.back_port).toBe('4101,4102,4103');
    expect(typeof m.back_port).toBe('string');
  });

  test('round-robin distributes requests across healthy backends', async () => {
    const b1 = makeBackend(200, 'backend-4110');
    const b2 = makeBackend(200, 'backend-4111');
    await listenOn(b1, 4110);
    await listenOn(b2, 4111);
    try {
      await proxy.db.addMapping('rr.ha.test', '', '4110,4111', '');

      const results = [];
      for (let i = 0; i < 4; i++) {
        const r = await httpGet(PROXY_PORT, 'rr.ha.test');
        expect(r.status).toBe(200);
        results.push(r.body);
      }

      // Both backends should have been hit
      expect(results).toContain('backend-4110');
      expect(results).toContain('backend-4111');
    } finally {
      await closeServer(b1).catch(() => {});
      await closeServer(b2).catch(() => {});
    }
  }, 15000);

  test('fails over to alive backend when one is down', async () => {
    const alive = makeBackend(200, 'alive-4120');
    await listenOn(alive, 4120);
    // Port 4121 intentionally not listening

    try {
      await proxy.db.addMapping('failover.ha.test', '', '4121,4120', '');
      proxy.deadPorts.clear();
      proxy.rrCounters.clear();

      const r = await httpGet(PROXY_PORT, 'failover.ha.test');
      expect(r.status).toBe(200);
      expect(r.body).toBe('alive-4120');
    } finally {
      await closeServer(alive).catch(() => {});
    }
  }, 15000);

  test('returns 502 when all backends are down', async () => {
    // Ports 4130,4131 intentionally not listening
    await proxy.db.addMapping('alldown.ha.test', '', '4130,4131', '');
    proxy.deadPorts.clear();
    proxy.rrCounters.clear();

    const r = await httpGet(PROXY_PORT, 'alldown.ha.test');
    expect(r.status).toBe(502);
  }, 15000);

  test('dead port is skipped after ECONNREFUSED and eventually recovers', async () => {
    const b = makeBackend(200, 'recovered-4140');

    await proxy.db.addMapping('recover.ha.test', '', '4139,4140', '');
    proxy.deadPorts.clear();
    proxy.rrCounters.clear();

    try {
      // First request — 4139 is down, 4140 not started yet → both fail → 502
      const r1 = await httpGet(PROXY_PORT, 'recover.ha.test');
      expect(r1.status).toBe(502);

      // 4139 should now be marked dead; start 4140
      await listenOn(b, 4140);

      // Second request — 4139 dead (skipped), 4140 alive → 200
      const r2 = await httpGet(PROXY_PORT, 'recover.ha.test');
      expect(r2.status).toBe(200);
      expect(r2.body).toBe('recovered-4140');

      // Expire all dead-port TTLs so both ports get retried; 4140 is alive → 200
      proxy.deadPorts.forEach((ts, key) => proxy.deadPorts.set(key, Date.now() - proxy.DEAD_PORT_TTL - 1));
      const r3 = await httpGet(PROXY_PORT, 'recover.ha.test');
      expect(r3.status).toBe(200);
    } finally {
      await closeServer(b).catch(() => {});
    }
  }, 15000);

  test('best non-2xx response is returned when no backend succeeds with 2xx', async () => {
    const b1 = makeBackend(503, 'unavailable');
    const b2 = makeBackend(404, 'not-found');
    await listenOn(b1, 4150);
    await listenOn(b2, 4151);
    try {
      await proxy.db.addMapping('besteffort.ha.test', '', '4150,4151', '');
      proxy.deadPorts.clear();
      proxy.rrCounters.clear();

      const r = await httpGet(PROXY_PORT, 'besteffort.ha.test');
      // Sorted by status class: 404 (4xx) < 503 (5xx) → picks 404
      expect(r.status).toBe(404);
    } finally {
      await closeServer(b1).catch(() => {});
      await closeServer(b2).catch(() => {});
    }
  }, 15000);
});
