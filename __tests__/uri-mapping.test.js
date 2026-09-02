const http = require('http');
const path = require('path');
const fs = require('fs').promises;
const ProxyServer = require('../src/ProxyServer');

// Backend that echoes the exact request path it received, so a test can assert
// what path a URI mapping (front_uri / back_uri) produced at the backend.
function makePathEchoBackend() {
  return http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(req.url);
  });
}

function listenOn(server, port) {
  return new Promise(resolve => server.listen(port, resolve));
}

function closeServer(server) {
  return new Promise(resolve => server.close(resolve));
}

function proxyGet(port, host, reqPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: reqPath, headers: { Host: host } }, res => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

// The single-backend (non-HA) path hands http-proxy a target URL that already
// contains the rewritten path. http-proxy joins target.path with req.url unless
// told not to, which used to double the path at the backend
// (`/api/v1/x` -> `/api/v1/x/api/v1/x`). These tests pin the path the backend
// must see for every front_uri / back_uri combination.
describe('URI mappings on the single-backend path', () => {
  let proxy;
  let backend;
  let testDataDir;
  const PROXY_PORT = 9270;
  const BACKEND = 4270;

  beforeAll(async () => {
    testDataDir = path.join(__dirname, 'uri-mapping-test-data');
    await fs.mkdir(testDataDir, { recursive: true }).catch(() => {});

    const logger = { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() };
    proxy = new ProxyServer(logger);
    proxy.db.dbPath = path.join(testDataDir, 'test.db');
    proxy.certManager.certsDir = path.join(testDataDir, 'certs');

    process.env.HTTP_PORT = String(PROXY_PORT);
    process.env.ENABLE_HTTPS = 'false';

    await proxy.initialize();
    await proxy.start();

    backend = makePathEchoBackend();
    await listenOn(backend, BACKEND);

    // whole host, no URI mapping (control case)
    await proxy.db.addMapping('plain.uri.test', '', String(BACKEND), '');
    // prefix kept: front_uri == back_uri, path passed through unchanged
    await proxy.db.addMapping('keep.uri.test', 'api', String(BACKEND), 'api');
    // prefix rewritten: /api/... -> /v2/...
    await proxy.db.addMapping('rewrite.uri.test', 'api', String(BACKEND), 'v2');
    // prefix stripped: front_uri only
    await proxy.db.addMapping('strip.uri.test', 'api', String(BACKEND), '');
    // prefix prepended: back_uri only
    await proxy.db.addMapping('prepend.uri.test', '', String(BACKEND), 'base');
    // two mappings on one host: the longer front_uri must win for its subtree only
    await proxy.db.addMapping('mixed.uri.test', '', String(BACKEND), '');
    await proxy.db.addMapping('mixed.uri.test', '_runner', String(BACKEND), '_runner');
  }, 15000);

  afterAll(async () => {
    if (proxy) await proxy.stop();
    await closeServer(backend).catch(() => {});
    delete process.env.HTTP_PORT;
    delete process.env.ENABLE_HTTPS;
    try {
      const files = await fs.readdir(testDataDir);
      await Promise.all(files.map(f => fs.unlink(path.join(testDataDir, f)).catch(() => {})));
      await fs.rmdir(testDataDir).catch(() => {});
    } catch (_) {}
  });

  test('no URI mapping: the path reaches the backend unchanged', async () => {
    const r = await proxyGet(PROXY_PORT, 'plain.uri.test', '/a/b?x=1');
    expect(r.status).toBe(200);
    expect(r.body).toBe('/a/b?x=1');
  });

  test('front_uri == back_uri: the path is passed through exactly once (not doubled)', async () => {
    const r = await proxyGet(PROXY_PORT, 'keep.uri.test', '/api/users/7?full=1');
    expect(r.status).toBe(200);
    expect(r.body).toBe('/api/users/7?full=1');
  });

  test('front_uri -> back_uri: the prefix is rewritten and the rest of the path kept', async () => {
    const r = await proxyGet(PROXY_PORT, 'rewrite.uri.test', '/api/users/7?full=1');
    expect(r.status).toBe(200);
    expect(r.body).toBe('/v2/users/7?full=1');
  });

  test('front_uri only: the prefix is stripped', async () => {
    const r = await proxyGet(PROXY_PORT, 'strip.uri.test', '/api/users/7');
    expect(r.status).toBe(200);
    expect(r.body).toBe('/users/7');
  });

  test('front_uri only, exact prefix: the backend gets /', async () => {
    const r = await proxyGet(PROXY_PORT, 'strip.uri.test', '/api');
    expect(r.status).toBe(200);
    expect(r.body).toBe('/');
  });

  test('back_uri only: the prefix is prepended', async () => {
    const r = await proxyGet(PROXY_PORT, 'prepend.uri.test', '/users/7');
    expect(r.status).toBe(200);
    expect(r.body).toBe('/base/users/7');
  });

  test('longest front_uri wins for its subtree; the whole-host mapping serves the rest', async () => {
    const under = await proxyGet(PROXY_PORT, 'mixed.uri.test', '/_runner/images/3/download');
    expect(under.status).toBe(200);
    expect(under.body).toBe('/_runner/images/3/download');
    const rest = await proxyGet(PROXY_PORT, 'mixed.uri.test', '/login');
    expect(rest.status).toBe(200);
    expect(rest.body).toBe('/login');
  });
});
