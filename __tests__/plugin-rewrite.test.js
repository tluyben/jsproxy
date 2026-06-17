'use strict';

// Regression tests for the plugin wire protocol (raw bodies, no base64) and for
// request/response REWRITE on BOTH the buffered (needsBody:true) and streaming
// (needsBody:false) plugin paths.
//
// Guards two bugs:
//   1. The streaming path used to silently drop a plugin's REWRITE_RESPONSE /
//      REWRITE_REQUEST body (pipe the backend body instead) — so hello-world,
//      which declares needsBody:false, never actually replaced the response.
//   2. base64 on the wire (now raw) — covered by a binary round-trip check.

const http = require('http');
const path = require('path');
const fs   = require('fs').promises;
const { spawn } = require('child_process');
const ProxyServer       = require('../src/ProxyServer');
const { PluginManager } = require('../src/PluginManager');

const logger = { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() };

function listen(server, port) { return new Promise(r => server.listen(port, r)); }
function close(server) { return new Promise(r => server.close(r)); }

// Backend that echoes the exact request body bytes it received (and reports its method/url).
function makeEchoBackend() {
  return http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'x-echo-url': req.url });
      res.end(Buffer.concat(chunks));
    });
  });
}

// Minimal raw-protocol plugin server driven by a handlers map:
//   { needsBody, before(meta, payload), after(meta, payload) }
// before/after return { result, meta, body } (body optional Buffer).
function makePlugin(handlers) {
  return http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      if (req.url === '/valid') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ valid: true, needsBody: handlers.needsBody !== false }));
      }
      const meta = req.headers['x-plugin-meta'] ? JSON.parse(req.headers['x-plugin-meta']) : {};
      const payload = Buffer.concat(chunks);
      const fn = req.url === '/before' ? handlers.before : handlers.after;
      const out = (fn && fn(meta, payload)) || { result: 'CONTINUE' };
      const headers = { 'x-plugin-result': out.result };
      if (out.meta) headers['x-plugin-meta'] = JSON.stringify(out.meta);
      const body = out.body || Buffer.alloc(0);
      headers['content-length'] = body.length;
      res.writeHead(200, headers);
      res.end(body);
    });
  });
}

// Send a request to the proxy; collect the response body as a Buffer.
function send(proxyPort, host, { method = 'GET', pathName = '/', body = null } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { Host: host };
    if (body) headers['content-length'] = body.length;
    const req = http.request({ hostname: '127.0.0.1', port: proxyPort, method, path: pathName, headers }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// Spin up a fresh proxy wired to a plugin manager, with one mapping.
async function startProxy(testDataDir, pluginPort, backendPort, host) {
  process.env.HTTP_PORT = '0';
  process.env.ENABLE_HTTPS = 'false';
  const pm = pluginPort ? new PluginManager(logger, `127.0.0.1:${pluginPort}`) : undefined;
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
  TEST_DIR = path.join(__dirname, 'plugin-rewrite-data');
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

describe('REWRITE_RESPONSE — streaming path (needsBody:false)', () => {
  let backend, plugin, proxy;
  beforeAll(async () => {
    backend = makeEchoBackend(); await listen(backend, 0);
    plugin = makePlugin({
      needsBody: false,
      after: () => ({
        result: 'REWRITE_RESPONSE',
        meta: { statusCode: 200, headers: { 'content-type': 'text/plain' } },
        body: Buffer.from('STREAM-REPLACED'),
      }),
    });
    await listen(plugin, 0);
    proxy = await startProxy(TEST_DIR, plugin.address().port, backend.address().port, 'stream-resp.test');
  }, 15000);
  afterAll(async () => { await proxy.stop(); await close(plugin); await close(backend); });

  test('plugin-produced body replaces the backend body', async () => {
    const r = await send(proxy.httpServer.address().port, 'stream-resp.test', { method: 'POST', pathName: '/x', body: Buffer.from('ORIGINAL') });
    expect(r.status).toBe(200);
    expect(r.body.toString()).toBe('STREAM-REPLACED');               // <-- the bug we fixed
    expect(Number(r.headers['content-length'])).toBe('STREAM-REPLACED'.length);
  }, 15000);
});

describe('REWRITE_REQUEST — streaming path (needsBody:false)', () => {
  let backend, plugin, proxy;
  beforeAll(async () => {
    backend = makeEchoBackend(); await listen(backend, 0);
    plugin = makePlugin({
      needsBody: false,
      before: () => ({ result: 'REWRITE_REQUEST', body: Buffer.from('INJECTED-BODY') }),
    });
    await listen(plugin, 0);
    proxy = await startProxy(TEST_DIR, plugin.address().port, backend.address().port, 'stream-req.test');
  }, 15000);
  afterAll(async () => { await proxy.stop(); await close(plugin); await close(backend); });

  test('plugin-produced request body reaches the backend', async () => {
    const r = await send(proxy.httpServer.address().port, 'stream-req.test', { method: 'POST', pathName: '/x', body: Buffer.from('CLIENT-ORIGINAL') });
    expect(r.status).toBe(200);
    expect(r.body.toString()).toBe('INJECTED-BODY');                 // backend echoed what the plugin injected
  }, 15000);
});

describe('REWRITE — buffered path (needsBody:true)', () => {
  let backend, respPlugin, reqPlugin, respProxy, reqProxy;
  beforeAll(async () => {
    backend = makeEchoBackend(); await listen(backend, 0);

    respPlugin = makePlugin({
      needsBody: true,
      after: () => ({ result: 'REWRITE_RESPONSE', meta: { statusCode: 201 }, body: Buffer.from('BUF-RESP') }),
    });
    await listen(respPlugin, 0);
    respProxy = await startProxy(TEST_DIR, respPlugin.address().port, backend.address().port, 'buf-resp.test');

    reqPlugin = makePlugin({
      needsBody: true,
      before: () => ({ result: 'REWRITE_REQUEST', body: Buffer.from('BUF-REQ') }),
    });
    await listen(reqPlugin, 0);
    reqProxy = await startProxy(TEST_DIR, reqPlugin.address().port, backend.address().port, 'buf-req.test');
  }, 15000);
  afterAll(async () => {
    await respProxy.stop(); await reqProxy.stop();
    await close(respPlugin); await close(reqPlugin); await close(backend);
  });

  test('response body + status are replaced', async () => {
    const r = await send(respProxy.httpServer.address().port, 'buf-resp.test', { method: 'POST', pathName: '/x', body: Buffer.from('ORIG') });
    expect(r.status).toBe(201);
    expect(r.body.toString()).toBe('BUF-RESP');
  }, 15000);

  test('request body is replaced before the backend', async () => {
    const r = await send(reqProxy.httpServer.address().port, 'buf-req.test', { method: 'POST', pathName: '/x', body: Buffer.from('ORIG') });
    expect(r.status).toBe(200);
    expect(r.body.toString()).toBe('BUF-REQ');
  }, 15000);
});

describe('raw payload integrity (no base64, binary-safe)', () => {
  let backend, plugin, proxy;
  beforeAll(async () => {
    backend = makeEchoBackend(); await listen(backend, 0);
    // needsBody:true so the body is buffered and passed to the plugin, then forwarded.
    plugin = makePlugin({ needsBody: true, before: () => ({ result: 'CONTINUE' }), after: () => ({ result: 'CONTINUE' }) });
    await listen(plugin, 0);
    proxy = await startProxy(TEST_DIR, plugin.address().port, backend.address().port, 'binary.test');
  }, 15000);
  afterAll(async () => { await proxy.stop(); await close(plugin); await close(backend); });

  test('every byte value 0x00–0xFF survives the round trip intact', async () => {
    const payload = Buffer.alloc(256 * 1024);
    for (let i = 0; i < payload.length; i++) payload[i] = i & 0xff;
    const r = await send(proxy.httpServer.address().port, 'binary.test', { method: 'POST', pathName: '/bin', body: payload });
    expect(r.status).toBe(200);
    expect(r.body.length).toBe(payload.length);
    expect(Buffer.compare(r.body, payload)).toBe(0);                 // identical bytes — no base64 corruption/inflation
  }, 15000);
});

describe('bundled hello-world plugin (real process)', () => {
  let backend, proxy, child;
  const PLUGIN_PORT = 9788;

  // Poll the spawned plugin's /valid until it answers (it's a separate process).
  function waitForPlugin(port, deadline) {
    return new Promise((resolve, reject) => {
      const attempt = () => {
        const body = JSON.stringify({ uri: '/health', method: 'GET' });
        const req = http.request({ hostname: '127.0.0.1', port, path: '/valid', method: 'POST',
          headers: { 'content-type': 'application/json', 'content-length': body.length } },
          res => { res.resume(); resolve(); });
        req.on('error', () => (Date.now() > deadline ? reject(new Error('plugin never came up')) : setTimeout(attempt, 100)));
        req.end(body);
      };
      attempt();
    });
  }

  beforeAll(async () => {
    backend = makeEchoBackend(); await listen(backend, 0);
    child = spawn(process.execPath, [path.join(__dirname, '..', 'plugins', 'hello-world.js')],
      { env: { ...process.env, PORT: String(PLUGIN_PORT) }, stdio: 'ignore' });
    await waitForPlugin(PLUGIN_PORT, Date.now() + 5000);
    proxy = await startProxy(TEST_DIR, PLUGIN_PORT, backend.address().port, 'hello.test');
  }, 15000);
  afterAll(async () => { await proxy.stop(); if (child) child.kill(); await close(backend); });

  test('GET /hello returns "Hello World!" (not the backend body)', async () => {
    const r = await send(proxy.httpServer.address().port, 'hello.test', { method: 'GET', pathName: '/hello' });
    expect(r.status).toBe(200);
    expect(r.body.toString()).toBe('Hello World!\n');
    expect(r.headers['content-type']).toMatch(/text\/plain/);
  }, 15000);

  test('non-/hello paths are ignored (plugin not interested → backend passthrough)', async () => {
    const r = await send(proxy.httpServer.address().port, 'hello.test', { method: 'POST', pathName: '/other', body: Buffer.from('PASSTHRU') });
    expect(r.status).toBe(200);
    expect(r.body.toString()).toBe('PASSTHRU');                      // backend echo, plugin stayed out
  }, 15000);
});
