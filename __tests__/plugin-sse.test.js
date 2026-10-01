'use strict';

// An SSE response must stream even when a plugin asked for bodies (needsBody:true).
// Regression: fluxwall's plugin asks for bodies on every extension-less GET of a
// domain with an HTML injection, so jsproxy buffered `text/event-stream` responses
// that never end — the client got 0 bytes until the CDN gave up with a 502.

const http = require('http');
const path = require('path');
const fs   = require('fs').promises;
const ProxyServer       = require('../src/ProxyServer');
const { PluginManager } = require('../src/PluginManager');

const logger = { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() };

function listen(server, port) { return new Promise(r => server.listen(port, r)); }
function close(server) { return new Promise(r => { server.closeAllConnections?.(); server.close(r); }); }

// Backend: /stream answers with headers + one event and then stays open forever;
// it records the Host and body it saw.
function makeSseBackend(seen) {
  return http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      seen.push({ host: req.headers.host, body: Buffer.concat(chunks).toString(), url: req.url });
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      res.write('event: hello\ndata: {}\n\n');
    });
  });
}

function makePlugin(calls) {
  return http.createServer((req, res) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      if (req.url === '/valid') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ valid: true, needsBody: true }));
      }
      calls.push({ hook: req.url, payload: Buffer.concat(chunks).toString() });
      res.writeHead(200, { 'x-plugin-result': 'CONTINUE', 'content-length': 0 });
      res.end();
    });
  });
}

// Resolve with the first chunk of the response body (or reject on timeout).
function firstChunk(port, host, { method = 'GET', body = null } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { Host: host, Accept: 'text/event-stream' };
    if (body) headers['content-length'] = Buffer.byteLength(body);
    const timer = setTimeout(() => { req.destroy(); reject(new Error('no bytes within 3 s')); }, 3000);
    const req = http.request({ hostname: '127.0.0.1', port, method, path: '/stream', headers }, res => {
      res.once('data', c => { clearTimeout(timer); resolve({ status: res.statusCode, headers: res.headers, chunk: c.toString() }); req.destroy(); });
    });
    req.on('error', () => {});
    if (body) req.write(body);
    req.end();
  });
}

let TEST_DIR, backend, plugin, proxy;
const seen = [];
const calls = [];

beforeAll(async () => {
  TEST_DIR = path.join(__dirname, 'plugin-sse-data');
  await fs.mkdir(TEST_DIR, { recursive: true }).catch(() => {});
  backend = makeSseBackend(seen); await listen(backend, 0);
  plugin = makePlugin(calls); await listen(plugin, 0);
  process.env.HTTP_PORT = '0';
  process.env.ENABLE_HTTPS = 'false';
  proxy = new ProxyServer(logger, new PluginManager(logger, `127.0.0.1:${plugin.address().port}`));
  proxy.db.dbPath = path.join(TEST_DIR, 'db.db');
  proxy.certManager.certsDir = path.join(TEST_DIR, 'certs');
  await proxy.initialize();
  await proxy.start();
  await proxy.db.addMapping('sse.test', '', String(backend.address().port), '', 'http://127.0.0.1', null);
}, 15000);

afterAll(async () => {
  await proxy.stop(); await close(plugin); await close(backend);
  delete process.env.HTTP_PORT;
  delete process.env.ENABLE_HTTPS;
  await fs.rm(TEST_DIR, { recursive: true, force: true }).catch(() => {});
});

test('GET event stream reaches the client while the backend keeps it open', async () => {
  const r = await firstChunk(proxy.httpServer.address().port, 'sse.test');
  expect(r.status).toBe(200);
  expect(r.headers['content-type']).toBe('text/event-stream');
  expect(r.chunk).toContain('event: hello');
  expect(seen.at(-1).host).toBe('sse.test');                 // client Host, like the buffered path
  expect(calls.map(c => c.hook)).toEqual(['/before', '/after']);
}, 10000);

test('POST event stream: before() sees the request body and the backend gets it', async () => {
  calls.length = 0;
  const r = await firstChunk(proxy.httpServer.address().port, 'sse.test', { method: 'POST', body: '{"prompt":"hi"}' });
  expect(r.chunk).toContain('event: hello');
  expect(seen.at(-1).body).toBe('{"prompt":"hi"}');
  expect(calls[0]).toEqual({ hook: '/before', payload: '{"prompt":"hi"}' });
}, 10000);
