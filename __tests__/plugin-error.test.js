'use strict';

// Regression tests for the /error plugin hook: when jsproxy generates one of its
// OWN synthetic gateway responses (a 502/504 because the backend is unreachable),
// it offers a plugin the chance to substitute a branded body via POST /error
// (PluginManager.runError → ProxyServer._sendGatewayError). Guards:
//   1. the branded ERROR_PAGE body + status replace the plain-text default;
//   2. fail-open — a plugin that declines (CONTINUE) or errors leaves the default.

const http = require('http');
const path = require('path');
const fs   = require('fs').promises;
const ProxyServer       = require('../src/ProxyServer');
const { PluginManager } = require('../src/PluginManager');

const logger = { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() };

function listen(server, port) { return new Promise(r => server.listen(port, r)); }
function close(server) { return new Promise(r => server.close(r)); }

// A plugin that stays out of the request path (/valid → valid:false) but answers
// /error per the supplied handler. Records the meta it was called with.
function makeErrorPlugin(onError) {
  const calls = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      if (req.url === '/valid') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ valid: false }));
      }
      if (req.url === '/error') {
        const meta = req.headers['x-plugin-meta'] ? JSON.parse(req.headers['x-plugin-meta']) : {};
        calls.push(meta);
        const out = onError(meta) || { result: 'CONTINUE' };
        const headers = { 'x-plugin-result': out.result };
        if (out.meta) headers['x-plugin-meta'] = JSON.stringify(out.meta);
        const body = out.body || Buffer.alloc(0);
        headers['content-length'] = body.length;
        res.writeHead(200, headers);
        return res.end(body);
      }
      res.writeHead(200, { 'x-plugin-result': 'CONTINUE', 'content-length': 0 });
      res.end();
    });
  });
  server.calls = calls;
  return server;
}

function send(proxyPort, host, { method = 'GET', pathName = '/' } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: proxyPort, method, path: pathName, headers: { Host: host } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

// A TCP port that nothing is listening on (bind then release), so the backend
// connection is refused and jsproxy synthesises a 502.
async function deadPort() {
  const s = http.createServer();
  await listen(s, 0);
  const p = s.address().port;
  await close(s);
  return p;
}

async function startProxy(testDataDir, pluginPort, backendPort, host) {
  process.env.HTTP_PORT = '0';
  process.env.ENABLE_HTTPS = 'false';
  const pm = new PluginManager(logger, `127.0.0.1:${pluginPort}`);
  const proxy = new ProxyServer(logger, pm);
  proxy.db.dbPath = path.join(testDataDir, `db-${host}.db`);
  proxy.certManager.certsDir = path.join(testDataDir, 'certs');
  await proxy.initialize();
  await proxy.start();
  await proxy.db.addMapping(host, '', String(backendPort), '', 'http://127.0.0.1', null);
  return proxy;
}

let TEST_DIR;
beforeAll(async () => {
  TEST_DIR = path.join(__dirname, 'plugin-error-data');
  await fs.mkdir(TEST_DIR, { recursive: true }).catch(() => {});
});
afterAll(async () => {
  delete process.env.HTTP_PORT;
  delete process.env.ENABLE_HTTPS;
  try {
    const files = await fs.readdir(TEST_DIR);
    await Promise.all(files.map(f => fs.unlink(path.join(TEST_DIR, f)).catch(() => {})));
    await fs.rmdir(TEST_DIR).catch(() => {});
  } catch (_) {}
});

describe('/error hook — branded gateway page', () => {
  let plugin, proxy, dead;
  beforeAll(async () => {
    dead = await deadPort();
    plugin = makeErrorPlugin(() => ({
      result: 'ERROR_PAGE',
      meta: { statusCode: 502, headers: { 'content-type': 'text/html; charset=utf-8', 'x-fluxwall-error': '1' } },
      body: Buffer.from('<h1>FluxWall — gateway down</h1>'),
    }));
    await listen(plugin, 0);
    proxy = await startProxy(TEST_DIR, plugin.address().port, dead, 'brand.test');
  }, 15000);
  afterAll(async () => { await proxy.stop(); await close(plugin); });

  test('a synthetic 502 is replaced by the plugin body + headers', async () => {
    const r = await send(proxy.httpServer.address().port, 'brand.test', { pathName: '/anything' });
    expect(r.status).toBe(502);
    expect(r.body.toString()).toBe('<h1>FluxWall — gateway down</h1>');
    expect(r.headers['content-type']).toMatch(/text\/html/);
    expect(r.headers['x-fluxwall-error']).toBe('1');
    // the hook saw the real host, status, and a machine reason for stats
    expect(plugin.calls.length).toBeGreaterThan(0);
    expect(plugin.calls[0].domain).toBe('brand.test');
    expect(plugin.calls[0].statusCode).toBe(502);
    expect(typeof plugin.calls[0].reason).toBe('string');
  }, 15000);
});

describe('/error hook — fail-open when the plugin declines', () => {
  let plugin, proxy, dead;
  beforeAll(async () => {
    dead = await deadPort();
    plugin = makeErrorPlugin(() => ({ result: 'CONTINUE' })); // no branded page
    await listen(plugin, 0);
    proxy = await startProxy(TEST_DIR, plugin.address().port, dead, 'plain.test');
  }, 15000);
  afterAll(async () => { await proxy.stop(); await close(plugin); });

  test('the plain-text 502 default is served unchanged', async () => {
    const r = await send(proxy.httpServer.address().port, 'plain.test', { pathName: '/x' });
    expect(r.status).toBe(502);
    expect(r.body.toString()).toMatch(/Bad Gateway/);
    expect(r.headers['content-type']).toMatch(/text\/plain/);
  }, 15000);
});
