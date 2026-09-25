// SauroMON shipping is configured from the environment at require time, so set
// it before anything from src/ is loaded (jest gives each file its own registry).
process.env.SAUROMON_INGEST_KEY = 'slk_test_key';
process.env.SAUROMON_ENDPOINT = 'http://127.0.0.1:9651';
process.env.SAUROMON_HEARTBEAT_MS = '0';
process.env.SAUROMON_HOST = 'test-host';
process.env.SAUROMON_FAILOVER_WINDOW_MS = '300';

const http = require('http');
const net = require('net');
const path = require('path');
const fs = require('fs').promises;
const sauromon = require('../src/Sauromon');
const { createLogger } = require('../src/Logger');
const ProxyServer = require('../src/ProxyServer');

const PROXY_PORT = 9650;
const INGEST_PORT = 9651;

function waitFor(predicate, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = async () => {
      await sauromon.flush();
      if (predicate() || Date.now() - started > timeoutMs) return resolve();
      setTimeout(tick, 50);
    };
    tick();
  });
}

describe('SauroMON shipping', () => {
  let ingest;
  let received = [];
  let auth = [];
  let failNext = 0;
  let proxy;
  let testDataDir;

  beforeAll(async () => {
    ingest = http.createServer((req, res) => {
      let body = '';
      req.on('data', (d) => { body += d; });
      req.on('end', () => {
        if (failNext > 0) { failNext--; res.writeHead(503); return res.end(); }
        auth.push(req.headers.authorization);
        received.push(...JSON.parse(body).logs);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"accepted":1}');
      });
    });
    await new Promise((r) => ingest.listen(INGEST_PORT, '127.0.0.1', r));

    testDataDir = path.join(__dirname, 'sauromon-test-data');
    await fs.mkdir(testDataDir, { recursive: true }).catch(() => {});
    const logger = { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() };
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
    await new Promise((r) => ingest.close(r));
    delete process.env.HTTP_PORT;
    delete process.env.ENABLE_HTTPS;
    await fs.rm(testDataDir, { recursive: true, force: true }).catch(() => {});
  });

  test('is enabled by SAUROMON_INGEST_KEY', () => {
    expect(sauromon.enabled).toBe(true);
  });

  test('lifts Node\'s 5-minute total request deadline (slow uploads)', () => {
    expect(proxy.httpServer.requestTimeout).toBe(0);
    expect(proxy.httpServer.headersTimeout).toBeGreaterThan(0);
  });

  test('announces the process start', async () => {
    await waitFor(() => received.some((l) => l.fields.kind === 'lifecycle'));
    const start = received.find((l) => l.fields.kind === 'lifecycle');
    expect(start).toBeDefined();
    expect(start.host).toBe('test-host');
    expect(start.service).toBe('jsproxy');
    expect(auth[0]).toBe('Bearer slk_test_key');
  });

  test('tees Logger lines regardless of the console level', async () => {
    createLogger({ service: 'jsproxy' }).warn('tee check', { answer: 42 });
    await waitFor(() => received.some((l) => l.message === 'tee check'));
    const line = received.find((l) => l.message === 'tee check');
    expect(line.level).toBe('warn');
    expect(line.fields.answer).toBe(42);
  });

  test('drain() ships queued lines through a failed send and its backoff', async () => {
    failNext = 1;
    sauromon.event('error', 'first line', { kind: 'drain-test' });
    await sauromon.flush();                       // 503 → requeued, backoff armed
    expect(received.some((l) => l.message === 'first line')).toBe(false);
    sauromon.event('error', 'last words', { kind: 'drain-test' });
    await sauromon.drain(1500);
    expect(received.filter((l) => l.fields.kind === 'drain-test').map((l) => l.message))
      .toEqual(['first line', 'last words']);
  });

  test('reports a gateway error with its reason', async () => {
    await proxy.db.addMapping('dead.test', '', '9659', '');
    const status = await new Promise((resolve) => {
      http.get({ port: PROXY_PORT, host: '127.0.0.1', path: '/x?secret=1', headers: { host: 'dead.test' } }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      }).on('error', () => resolve(0));
    });
    expect(status).toBeGreaterThanOrEqual(500);
    await waitFor(() => received.some((l) => l.fields.kind === 'http' && l.fields.host === 'dead.test'));
    const ev = received.find((l) => l.fields.kind === 'http' && l.fields.host === 'dead.test');
    expect(ev.level).toBe('error');
    expect(ev.fields.status).toBe(status);
    expect(ev.fields.path).toBe('/x');            // query string never shipped
    expect(ev.fields.socket_request_index).toBe(1);
  }, 15000);

  test('aggregates failovers into one warning per domain + backend + error', async () => {
    const backend = http.createServer((q, r) => r.end('ok'));
    await new Promise((r) => backend.listen(9671, '127.0.0.1', r));
    try {
      // 9670 is dead: every request fails over from it to 9671 (it may be
      // ranked first or second; penalized after the first failure).
      await proxy.db.addMapping('fo.test', '', '9670,9671', '');
      for (let i = 0; i < 4; i++) {
        proxy.portScores.clear();                 // keep the dead port ranked first
        const status = await new Promise((resolve) => {
          http.get({ port: PROXY_PORT, host: '127.0.0.1', path: '/', headers: { host: 'fo.test' } }, (res) => {
            res.resume(); res.on('end', () => resolve(res.statusCode));
          }).on('error', () => resolve(0));
        });
        expect(status).toBe(200);
      }
      await waitFor(() => received.some((l) => l.fields.kind === 'failover' && l.fields.domain === 'fo.test'));
      const evs = received.filter((l) => l.fields.kind === 'failover' && l.fields.domain === 'fo.test');
      expect(evs).toHaveLength(1);
      expect(evs[0].level).toBe('warn');
      expect(evs[0].fields.backend).toMatch(/:9670$/);
      expect(evs[0].fields.error).toBe('ECONNREFUSED');
      expect(evs[0].fields.count).toBeGreaterThanOrEqual(1);
      expect(evs[0].message).toMatch(/^failover: fo\.test → .*:9670 ECONNREFUSED ×\d+ in 1 min$/);
      // the per-request failover lines are info → below the default SAUROMON_LEVEL
      expect(received.some((l) => /^HA failover:/.test(l.message))).toBe(false);
    } finally {
      await new Promise((r) => backend.close(r));
    }
  }, 15000);

  test('flags the keep-alive race shape on a raw TCP session', async () => {
    const BACKEND_PORT = 9661;
    const LISTEN_PORT = 9660;
    // Answers the first message, then hangs up on the second without replying:
    // the client sent bytes after the last bytes it received.
    const backend = net.createServer((sock) => {
      let n = 0;
      sock.on('error', () => {});
      sock.on('data', () => { if (++n === 1) sock.write('pong'); else sock.destroy(); });
    });
    await new Promise((r) => backend.listen(BACKEND_PORT, '127.0.0.1', r));
    try {
      await proxy.db.addTcpRoute(LISTEN_PORT, '127.0.0.1', String(BACKEND_PORT));
      await proxy.startTcpListeners(PROXY_PORT, 0, '127.0.0.1');
      await new Promise((resolve) => {
        const c = net.connect(LISTEN_PORT, '127.0.0.1', () => c.write('ping'));
        c.on('data', () => setTimeout(() => c.write('second'), 50));
        c.on('error', () => {});
        c.on('close', resolve);
      });
      await waitFor(() => received.some((l) => l.fields.kind === 'tcp' && l.fields.listen_port === LISTEN_PORT));
      const ev = received.find((l) => l.fields.kind === 'tcp' && l.fields.listen_port === LISTEN_PORT);
      expect(ev).toBeDefined();
      expect(ev.fields.closer).toBe('upstream');
      expect(ev.fields.keepalive_race_suspect).toBe(true);
      expect(ev.level).toBe('error');
    } finally {
      await new Promise((r) => backend.close(r));
    }
  }, 15000);

  test('does not report a healthy TCP session (sample rate 0)', async () => {
    const BACKEND_PORT = 9663;
    const LISTEN_PORT = 9662;
    const backend = net.createServer((sock) => { sock.on('error', () => {}); sock.end('bye'); });
    await new Promise((r) => backend.listen(BACKEND_PORT, '127.0.0.1', r));
    try {
      await proxy.db.addTcpRoute(LISTEN_PORT, '127.0.0.1', String(BACKEND_PORT));
      await proxy.startTcpListeners(PROXY_PORT, 0, '127.0.0.1');
      await new Promise((resolve) => {
        const c = net.connect(LISTEN_PORT, '127.0.0.1');
        c.resume();
        c.on('error', () => {});
        c.on('close', resolve);
      });
      await new Promise((r) => setTimeout(r, 300));
      await sauromon.flush();
      expect(received.some((l) => l.fields.kind === 'tcp' && l.fields.listen_port === LISTEN_PORT)).toBe(false);
    } finally {
      await new Promise((r) => backend.close(r));
    }
  }, 15000);
});

describe('SauroMON without a key', () => {
  test('is fully inert', () => {
    jest.isolateModules(() => {
      const saved = process.env.SAUROMON_INGEST_KEY;
      delete process.env.SAUROMON_INGEST_KEY;
      try {
        const s = require('../src/Sauromon');
        expect(s.enabled).toBe(false);
        expect(s.wants('error')).toBe(false);
        s.event('error', 'nope', {});
        expect(s.startHeartbeat(() => ({}))).toBeNull();
      } finally {
        process.env.SAUROMON_INGEST_KEY = saved;
      }
    });
  });
});
