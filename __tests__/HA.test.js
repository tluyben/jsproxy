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

// A backend that accepts the TCP connection but never sends a response — it
// resets the socket instead. Mimics a container that has started listening
// during a blue/green deploy but isn't ready to serve yet.
function makeNotReadyBackend() {
  return http.createServer((req, res) => {
    req.socket.destroy(); // accept connection, then drop it with no response
  });
}

function listenOn(server, port) {
  return new Promise(resolve => server.listen(port, resolve));
}

function httpRequest(port, host, method) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: 'localhost', port, path: '/', method, headers: { Host: host } }, res => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
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

// GET with arbitrary extra headers (used to force the streaming path via Accept).
function httpGetH(port, host, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: 'localhost', port, path: '/', headers: { Host: host, ...extraHeaders } },
      res => {
        let body = '';
        res.on('data', c => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode, body }));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

// A backend that echoes back the label it was created with AND the Host header it
// received — so a test can assert BOTH which backend served the request and what
// Host was forwarded upstream (front URL vs. back_host rewrite).
function makeEchoBackend(label) {
  return http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ label, host: req.headers.host }));
  });
}

// Set back_host directly (no CLI/addMapping param exists for it).
function setBackHost(proxy, id, backHost) {
  return new Promise((resolve, reject) => {
    proxy.db.db.run(
      'UPDATE mappings SET back_host = ? WHERE id = ?',
      [backHost, id],
      err => (err ? reject(err) : resolve())
    );
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
      proxy.portScores.clear();
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
    proxy.portScores.clear();
    proxy.rrCounters.clear();

    const r = await httpGet(PROXY_PORT, 'alldown.ha.test');
    expect(r.status).toBe(502);
  }, 15000);

  test('dead port is penalized and skipped on next request', async () => {
    const b = makeBackend(200, 'recovered-4140');

    await proxy.db.addMapping('recover.ha.test', '', '4139,4140', '');
    proxy.portScores.clear();
    proxy.rrCounters.clear();

    try {
      // First request — 4139 is down, 4140 not started yet → both fail → 502
      const r1 = await httpGet(PROXY_PORT, 'recover.ha.test');
      expect(r1.status).toBe(502);

      // Both ports now have score 0; start 4140.
      await listenOn(b, 4140);

      // Second request — _requestHA tries ranked ports; both at 0 so round-robin,
      // but whichever is tried first and fails gets penalized again; eventually
      // 4140 is reached and responds 200.
      const r2 = await httpGet(PROXY_PORT, 'recover.ha.test');
      expect(r2.status).toBe(200);
      expect(r2.body).toBe('recovered-4140');

      // Reset scores so 4140 starts fresh; it's alive so the request succeeds.
      proxy.portScores.clear();
      proxy.rrCounters.clear();
      const r3 = await httpGet(PROXY_PORT, 'recover.ha.test');
      expect(r3.status).toBe(200);
    } finally {
      await closeServer(b).catch(() => {});
    }
  }, 15000);

  test('blue/green: GET fails over from a not-ready (accept-then-reset) backend', async () => {
    // 4160 accepts connections but never responds (deploy in progress);
    // 4161 is healthy. A GET must NOT return 504 — it must fail over to 4161.
    const notReady = makeNotReadyBackend();
    const healthy  = makeBackend(200, 'healthy-4161');
    await listenOn(notReady, 4160);
    await listenOn(healthy, 4161);
    try {
      // Order the not-ready port first and clear scores so it is tried first.
      await proxy.db.addMapping('bluegreen.ha.test', '', '4160,4161', '');
      proxy.portScores.clear();
      proxy.rrCounters.clear();

      const r = await httpGet(PROXY_PORT, 'bluegreen.ha.test');
      expect(r.status).toBe(200);
      expect(r.body).toBe('healthy-4161');

      // The not-ready port must have been penalized so it stops drawing traffic.
      const m = await proxy.db.getMapping('bluegreen.ha.test', '/');
      expect(proxy.getPortScore(m.id, 4160)).toBe(0);
    } finally {
      await closeServer(notReady).catch(() => {});
      await closeServer(healthy).catch(() => {});
    }
  }, 15000);

  test('blue/green: POST to a not-ready backend returns 504 and penalizes it (no unsafe retry)', async () => {
    const notReady = makeNotReadyBackend();
    const healthy  = makeBackend(200, 'healthy-4171');
    await listenOn(notReady, 4170);
    await listenOn(healthy, 4171);
    try {
      await proxy.db.addMapping('bluegreenpost.ha.test', '', '4170,4171', '');
      proxy.portScores.clear();
      proxy.rrCounters.clear();

      // Non-idempotent: may already have been processed, so no failover → 504.
      const r = await httpRequest(PROXY_PORT, 'bluegreenpost.ha.test', 'POST');
      expect(r.status).toBe(504);

      // But the bad port is penalized, so subsequent requests avoid it.
      const m = await proxy.db.getMapping('bluegreenpost.ha.test', '/');
      expect(proxy.getPortScore(m.id, 4170)).toBe(0);
    } finally {
      await closeServer(notReady).catch(() => {});
      await closeServer(healthy).catch(() => {});
    }
  }, 15000);

  test('non-2xx response from first responding backend is returned as-is', async () => {
    const b1 = makeBackend(503, 'unavailable');
    const b2 = makeBackend(404, 'not-found');
    await listenOn(b1, 4150);
    await listenOn(b2, 4151);
    try {
      await proxy.db.addMapping('besteffort.ha.test', '', '4150,4151', '');
      proxy.portScores.clear();
      proxy.rrCounters.clear();

      const r = await httpGet(PROXY_PORT, 'besteffort.ha.test');
      // _requestHA short-circuits on the first backend that responds (any status).
      // Both are alive so whichever ranks first wins; either response is correct.
      expect([503, 404]).toContain(r.status);
    } finally {
      await closeServer(b1).catch(() => {});
      await closeServer(b2).catch(() => {});
    }
  }, 15000);
});

// ─────────────────────────────────────────────────────────────────────────────
// Multi-host HA: `backend` is a comma list of full URLs. Failover happens across
// DISTINCT hosts (not just ports), and the Host header forwarded upstream is the
// original front Host by default, or the back_host rewrite when set — identical
// for every backend, so the front URL never leaks when back_host is configured.
// This path is security-sensitive, so the invariants are pinned explicitly.
// ─────────────────────────────────────────────────────────────────────────────
describe('HA / multi-host backend list (parsing)', () => {
  // Pure unit tests — no network. These lock the target-expansion rules that the
  // whole failover engine keys on. A ProxyServer needs no started servers for this.
  let proxy;
  beforeAll(() => { proxy = new ProxyServer({ info: jest.fn(), error: jest.fn(), warn: jest.fn() }); });

  test('_isHA triggers on a comma in back_port OR in backend', () => {
    expect(proxy._isHA({ back_port: '3000,3001', backend: 'http://x' })).toBe(true);
    expect(proxy._isHA({ back_port: '3000', backend: 'http://a,http://b' })).toBe(true);
    expect(proxy._isHA({ back_port: '3000', backend: 'http://x' })).toBe(false);
    expect(proxy._isHA({ back_port: '3000', backend: null })).toBe(false);
  });

  test('multi-host: port comes from the URL, scheme sets isHttps, key is host:port', () => {
    const t = proxy._backendTargets({ id: 'm', backend: 'http://a.com:8001,https://b.com:8002', back_port: '' });
    expect(t).toEqual([
      { hostname: 'a.com', port: 8001, isHttps: false, key: 'a.com:8001' },
      { hostname: 'b.com', port: 8002, isHttps: true,  key: 'b.com:8002' },
    ]);
  });

  test('multi-host: a URL without a port falls back to a single numeric back_port', () => {
    const t = proxy._backendTargets({ id: 'm', backend: 'http://a.com,http://b.com', back_port: '9000' });
    expect(t.map(x => x.port)).toEqual([9000, 9000]);
    expect(t.map(x => x.key)).toEqual(['a.com:9000', 'b.com:9000']);
  });

  test('multi-host: with no port anywhere, falls back to the scheme default (80/443)', () => {
    const t = proxy._backendTargets({ id: 'm', backend: 'http://a.com,https://b.com', back_port: '' });
    expect(t.map(x => x.port)).toEqual([80, 443]);
  });

  test('legacy port-list mode keeps bare-port score keys (backward compatible)', () => {
    const t = proxy._backendTargets({ id: 'm', backend: 'http://localhost', back_port: '3000,3001' });
    expect(t.map(x => x.key)).toEqual(['3000', '3001']);
    expect(t.every(x => x.hostname === 'localhost')).toBe(true);
  });
});

describe('HA / multi-host backend list (routing, Host, failover)', () => {
  let proxy;
  let logger;
  let testDataDir;
  const PROXY_PORT = 9201;

  beforeAll(async () => {
    testDataDir = path.join(__dirname, 'ha-multihost-test-data');
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

  test('round-robins across two DISTINCT backend hosts', async () => {
    const b1 = makeEchoBackend('host-4210');
    const b2 = makeEchoBackend('host-4211');
    await listenOn(b1, 4210);
    await listenOn(b2, 4211);
    try {
      await proxy.db.addMapping('mh-rr.test', '', '', '', 'http://localhost:4210,http://localhost:4211');
      proxy.portScores.clear();
      proxy.rrCounters.clear();

      const labels = new Set();
      for (let i = 0; i < 4; i++) {
        const r = await httpGet(PROXY_PORT, 'mh-rr.test');
        expect(r.status).toBe(200);
        labels.add(JSON.parse(r.body).label);
      }
      expect(labels.has('host-4210')).toBe(true);
      expect(labels.has('host-4211')).toBe(true);
    } finally {
      await closeServer(b1).catch(() => {});
      await closeServer(b2).catch(() => {});
    }
  }, 15000);

  test('DEFAULT: forwards the original front Host to every backend (never a backend hostname)', async () => {
    const b1 = makeEchoBackend('h1');
    const b2 = makeEchoBackend('h2');
    await listenOn(b1, 4212);
    await listenOn(b2, 4213);
    try {
      await proxy.db.addMapping('mh-hostdefault.test', '', '', '', 'http://localhost:4212,http://localhost:4213');
      proxy.portScores.clear();
      proxy.rrCounters.clear();

      // Whichever backend serves, it must see the front Host — not localhost:42xx.
      for (let i = 0; i < 4; i++) {
        const r = await httpGet(PROXY_PORT, 'mh-hostdefault.test');
        expect(r.status).toBe(200);
        expect(JSON.parse(r.body).host).toBe('mh-hostdefault.test');
      }
    } finally {
      await closeServer(b1).catch(() => {});
      await closeServer(b2).catch(() => {});
    }
  }, 15000);

  test('back_host REWRITES Host for all backends; the front URL never reaches them', async () => {
    const b1 = makeEchoBackend('r1');
    const b2 = makeEchoBackend('r2');
    await listenOn(b1, 4214);
    await listenOn(b2, 4215);
    try {
      const m = await proxy.db.addMapping('mh-rewrite.test', '', '', '', 'http://localhost:4214,http://localhost:4215');
      await setBackHost(proxy, m.id, 'internal-app.svc');
      proxy.portScores.clear();
      proxy.rrCounters.clear();

      for (let i = 0; i < 4; i++) {
        const r = await httpGet(PROXY_PORT, 'mh-rewrite.test');
        expect(r.status).toBe(200);
        const echoed = JSON.parse(r.body).host;
        expect(echoed).toBe('internal-app.svc');       // rewrite applied
        expect(echoed).not.toBe('mh-rewrite.test');    // front URL never leaks
      }
    } finally {
      await closeServer(b1).catch(() => {});
      await closeServer(b2).catch(() => {});
    }
  }, 15000);

  test('fails over to a healthy host when the first host is down', async () => {
    const alive = makeEchoBackend('alive-4219');
    await listenOn(alive, 4219);
    // 4218 intentionally not listening → first target is dead.
    try {
      await proxy.db.addMapping('mh-failover.test', '', '', '', 'http://localhost:4218,http://localhost:4219');
      proxy.portScores.clear();
      proxy.rrCounters.clear();

      const r = await httpGet(PROXY_PORT, 'mh-failover.test');
      expect(r.status).toBe(200);
      expect(JSON.parse(r.body).label).toBe('alive-4219');

      // The dead host must be scored 0, keyed by host:port (per-target scoring).
      const m = await proxy.db.getMapping('mh-failover.test', '/');
      expect(proxy.getPortScore(m.id, 'localhost:4218')).toBe(0);
    } finally {
      await closeServer(alive).catch(() => {});
    }
  }, 15000);

  test('returns 502 when every backend host is down', async () => {
    // 4220 / 4221 intentionally not listening.
    await proxy.db.addMapping('mh-alldown.test', '', '', '', 'http://localhost:4220,http://localhost:4221');
    proxy.portScores.clear();
    proxy.rrCounters.clear();

    const r = await httpGet(PROXY_PORT, 'mh-alldown.test');
    expect(r.status).toBe(502);
  }, 15000);

  test('streaming path (SSE) also fails over across hosts AND honors back_host', async () => {
    const alive = makeEchoBackend('stream-4223');
    await listenOn(alive, 4223);
    // 4222 not listening → first target dead; Accept: text/event-stream forces _streamHA.
    try {
      const m = await proxy.db.addMapping('mh-stream.test', '', '', '', 'http://localhost:4222,http://localhost:4223');
      await setBackHost(proxy, m.id, 'stream-app.svc');
      proxy.portScores.clear();
      proxy.rrCounters.clear();

      const r = await httpGetH(PROXY_PORT, 'mh-stream.test', { Accept: 'text/event-stream' });
      expect(r.status).toBe(200);
      const parsed = JSON.parse(r.body);
      expect(parsed.label).toBe('stream-4223');   // failed over to the alive host
      expect(parsed.host).toBe('stream-app.svc');  // back_host applied on the stream path too
    } finally {
      await closeServer(alive).catch(() => {});
    }
  }, 15000);
});
