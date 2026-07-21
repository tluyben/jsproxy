'use strict';

// Regression tests for HA failover when a backend HOST is set on the mapping —
// the production shape `backend='http://hetzner-1'` + `back_port='3038,3039'`
// that was reported broken ("multi-port HA works on localhost, fails with a
// backend host"). Every forward path must fail over from (and penalize) a dead
// target:
//
//   1. buffered requests   (_requestHA)          — worked, guarded here anyway
//   2. streaming requests  (_streamHA)           — worked, guarded here anyway
//   3. plugin streaming    (_streamWithPlugins)  — BROKEN: picked one target,
//      never penalized it, so on an HA mapping the dead backend kept being
//      picked by rotation and every other request 502'd forever
//   4. WebSocket upgrades  (handleWebSocket)     — BROKEN twice: picked a dead
//      target with no penalty (alternating failures forever), AND the shared
//      proxy error handler called writeHead on the raw upgrade socket — an
//      unhandled rejection that kills the whole process under Node's default
//      rejection policy (one WS client + one dead port = proxy down).

const http = require('http');
const path = require('path');
const fs = require('fs').promises;
const ProxyServer = require('../src/ProxyServer');

const PROXY_PORT = 9400;
const BACKEND_HOST = 'http://127.0.0.1'; // stands in for a remote host (hetzner-1)

function makeBackend(statusCode, body) {
  return http.createServer((req, res) => {
    let n = 0;
    req.on('data', c => { n += c.length; });
    req.on('end', () => {
      res.writeHead(statusCode, { 'Content-Type': 'text/plain' });
      res.end(`${body}:${n}`);
    });
  });
}

// Backend that accepts WebSocket upgrades with a bare 101.
function makeWsBackend() {
  const server = http.createServer((req, res) => { res.writeHead(200); res.end('http'); });
  server.on('upgrade', (req, socket) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    socket.end();
  });
  return server;
}

function listenOn(server, port) {
  return new Promise(resolve => server.listen(port, resolve));
}

function closeServer(server) {
  return new Promise(resolve => server.close(resolve));
}

function httpGet(host) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: 'localhost', port: PROXY_PORT, path: '/', headers: { Host: host } }, res => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

function httpPost(host, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: 'localhost', port: PROXY_PORT, path: '/', method: 'POST',
      headers: { Host: host, 'Content-Length': Buffer.byteLength(body) },
    }, res => {
      let b = '';
      res.on('data', c => { b += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

// Chunked POST (no content-length) → forced through the streaming path.
function chunkedPost(host, parts) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: 'localhost', port: PROXY_PORT, path: '/', method: 'POST',
      headers: { Host: host, 'Transfer-Encoding': 'chunked' },
    }, res => {
      let b = '';
      res.on('data', c => { b += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', reject);
    req.write(parts[0]);
    setTimeout(() => req.end(parts[1]), 30);
  });
}

// One WebSocket upgrade attempt. Resolves with what the client observed:
// {kind:'upgrade'} | {kind:'response', status} | {kind:'error', code} | {kind:'timeout'}
function wsAttempt(host) {
  return new Promise(resolve => {
    const req = http.request({
      hostname: 'localhost', port: PROXY_PORT, path: '/', method: 'GET',
      headers: {
        Host: host, Connection: 'Upgrade', Upgrade: 'websocket',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version': '13',
      },
    });
    req.on('upgrade', (res, socket) => { socket.destroy(); resolve({ kind: 'upgrade' }); });
    req.on('response', res => { res.resume(); resolve({ kind: 'response', status: res.statusCode }); });
    req.on('error', err => resolve({ kind: 'error', code: err.code }));
    req.setTimeout(8000, () => { req.destroy(); resolve({ kind: 'timeout' }); });
    req.end();
  });
}

// Plugin manager stub: one interested plugin that never needs the body, so
// every request takes the _streamWithPlugins path with CONTINUE before/after.
function stubPluginManager() {
  return {
    hasPlugins: true,
    runValid: async () => ({ interested: ['stub'], needsBody: false }),
    register: () => {},
    cleanup: () => {},
    runBefore: async () => ({ type: 'CONTINUE' }),
    runAfter: async () => ({ type: 'CONTINUE' }),
    runError: async () => null,
  };
}

let proxy;
let logger;
let testDataDir;

beforeAll(async () => {
  testDataDir = path.join(__dirname, 'ha-backend-host-data');
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
    await Promise.all(files.map(f => fs.unlink(path.join(testDataDir, f)).catch(() => {})));
    await fs.rmdir(testDataDir).catch(() => {});
  } catch (_) {}
});

function resetScores() {
  proxy.portScores.clear();
  proxy.portLastSeen.clear();
  proxy.rrCounters.clear();
  proxy.bgChecks.clear();
}

describe('HA multi-port with backend host set / buffered + streaming paths', () => {
  test('buffered GET fails over to the alive port and penalizes the dead one', async () => {
    const alive = makeBackend(200, 'alive-4611');
    await listenOn(alive, 4611);
    try {
      await proxy.db.addMapping('bget.bhost.test', '', '4610,4611', '', BACKEND_HOST);
      const m = await proxy.db.getMapping('bget.bhost.test', '/');
      resetScores();

      const r = await httpGet('bget.bhost.test');
      expect(r.status).toBe(200);
      expect(r.body).toBe('alive-4611:0');
      // Score-key contract for port-list mode is the bare port string.
      expect(proxy.getPortScore(m.id, '4610')).toBe(0);
      expect(proxy.getPortScore(m.id, '4611')).toBe(100);
    } finally {
      await closeServer(alive).catch(() => {});
    }
  }, 15000);

  test('buffered POST (connect-phase failure) fails over safely', async () => {
    const alive = makeBackend(200, 'alive-4613');
    await listenOn(alive, 4613);
    try {
      await proxy.db.addMapping('bpost.bhost.test', '', '4612,4613', '', BACKEND_HOST);
      resetScores();

      const r = await httpPost('bpost.bhost.test', 'payload');
      expect(r.status).toBe(200);
      expect(r.body).toBe('alive-4613:7');
    } finally {
      await closeServer(alive).catch(() => {});
    }
  }, 15000);

  test('streaming (chunked) POST fails over on connect failure', async () => {
    const alive = makeBackend(200, 'alive-4615');
    await listenOn(alive, 4615);
    try {
      await proxy.db.addMapping('stream.bhost.test', '', '4614,4615', '', BACKEND_HOST);
      resetScores();

      const r = await chunkedPost('stream.bhost.test', ['hello-', 'world']);
      expect(r.status).toBe(200);
      expect(r.body).toBe('alive-4615:11');
    } finally {
      await closeServer(alive).catch(() => {});
    }
  }, 15000);

  test('sequential requests never alternate into the dead port', async () => {
    const alive = makeBackend(200, 'alive-4617');
    await listenOn(alive, 4617);
    try {
      await proxy.db.addMapping('seq.bhost.test', '', '4616,4617', '', BACKEND_HOST);
      resetScores();

      for (let i = 0; i < 6; i++) {
        const r = await httpGet('seq.bhost.test');
        expect(r.status).toBe(200);
      }
    } finally {
      await closeServer(alive).catch(() => {});
    }
  }, 15000);

  test('502 when every port on the backend host is down', async () => {
    await proxy.db.addMapping('down.bhost.test', '', '4618,4619', '', BACKEND_HOST);
    resetScores();

    const r = await httpGet('down.bhost.test');
    expect(r.status).toBe(502);
  }, 15000);
});

describe('HA multi-port with backend host set / plugin streaming path', () => {
  let origPluginManager;

  beforeAll(() => {
    origPluginManager = proxy.pluginManager;
    proxy.pluginManager = stubPluginManager();
  });

  afterAll(() => {
    proxy.pluginManager = origPluginManager;
  });

  test('fails over from the dead port on EVERY request (no alternating 502s) and penalizes it', async () => {
    const alive = makeBackend(200, 'alive-4621');
    await listenOn(alive, 4621);
    try {
      await proxy.db.addMapping('plug.bhost.test', '', '4620,4621', '', BACKEND_HOST);
      const m = await proxy.db.getMapping('plug.bhost.test', '/');
      resetScores();

      // The old code picked one target per request with no penalty, so with the
      // round-robin rotation this produced 502,200,502,200,... — assert EVERY
      // request succeeds.
      const statuses = [];
      for (let i = 0; i < 8; i++) {
        const r = await httpGet('plug.bhost.test');
        statuses.push(r.status);
      }
      expect(statuses).toEqual([200, 200, 200, 200, 200, 200, 200, 200]);
      expect(proxy.getPortScore(m.id, '4620')).toBe(0);
      expect(proxy.getPortScore(m.id, '4621')).toBe(100);
    } finally {
      await closeServer(alive).catch(() => {});
    }
  }, 20000);

  test('502 when every port is down', async () => {
    await proxy.db.addMapping('plugdown.bhost.test', '', '4622,4623', '', BACKEND_HOST);
    resetScores();

    const r = await httpGet('plugdown.bhost.test');
    expect(r.status).toBe(502);
  }, 15000);

  test('multi-HOST backend list fails over too', async () => {
    const alive = makeBackend(200, 'alive-4625');
    await listenOn(alive, 4625);
    try {
      await proxy.db.addMapping(
        'plugmh.bhost.test', '', '',
        '', 'http://127.0.0.1:4624,http://127.0.0.1:4625'
      );
      const m = await proxy.db.getMapping('plugmh.bhost.test', '/');
      resetScores();

      for (let i = 0; i < 4; i++) {
        const r = await httpGet('plugmh.bhost.test');
        expect(r.status).toBe(200);
        expect(r.body).toBe('alive-4625:0');
      }
      // Multi-host mode keys scores on host:port.
      expect(proxy.getPortScore(m.id, '127.0.0.1:4624')).toBe(0);
    } finally {
      await closeServer(alive).catch(() => {});
    }
  }, 15000);
});

describe('HA multi-port with backend host set / WebSocket path', () => {
  test('upgrade succeeds FIRST TRY with the first port dead, and the dead port is penalized', async () => {
    const alive = makeWsBackend();
    await listenOn(alive, 4631);
    try {
      await proxy.db.addMapping('ws.bhost.test', '', '4630,4631', '', BACKEND_HOST);
      const m = await proxy.db.getMapping('ws.bhost.test', '/');
      resetScores();

      // The old code picked a target with no liveness check and no penalty, so
      // attempts alternated failure/success forever. Every attempt must upgrade.
      for (let i = 0; i < 4; i++) {
        const out = await wsAttempt('ws.bhost.test');
        expect(out.kind).toBe('upgrade');
      }
      expect(proxy.getPortScore(m.id, '4630')).toBe(0);
    } finally {
      await closeServer(alive).catch(() => {});
    }
  }, 20000);

  test('502 handshake response when every port is down', async () => {
    await proxy.db.addMapping('wsdown.bhost.test', '', '4632,4633', '', BACKEND_HOST);
    resetScores();

    const out = await wsAttempt('wsdown.bhost.test');
    expect(out.kind).toBe('response');
    expect(out.status).toBe(502);
  }, 15000);

  test('single dead backend does not crash the proxy (raw-socket writeHead regression)', async () => {
    // Non-HA mapping, single dead port: the proxy error path used to call
    // res.writeHead on the raw upgrade socket → unhandled rejection → process
    // exit under Node's default policy. The attempt must fail cleanly and the
    // proxy must keep serving.
    const alive = makeBackend(200, 'still-alive');
    await listenOn(alive, 4635);
    try {
      await proxy.db.addMapping('wsdead.bhost.test', '', '4634', '', BACKEND_HOST);
      await proxy.db.addMapping('health.bhost.test', '', '4635', '', BACKEND_HOST);
      resetScores();

      const out = await wsAttempt('wsdead.bhost.test');
      expect(['error', 'response']).toContain(out.kind); // torn down cleanly, no upgrade

      const r = await httpGet('health.bhost.test');
      expect(r.status).toBe(200);
      expect(r.body).toBe('still-alive:0');
    } finally {
      await closeServer(alive).catch(() => {});
    }
  }, 15000);
});
