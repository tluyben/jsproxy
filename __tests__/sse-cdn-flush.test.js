'use strict';
// A CDN (Bunny) holds the last segment it got until more bytes follow, so an
// SSE event's closing blank line waited for the next event (2026-11-03: war
// room snapshot after 15 s). jsproxy writes a `:\n` comment once the feed goes
// idle after a complete event — never mid-event, never into a compressed body.
const http = require('http');
const { PassThrough } = require('stream');
const ProxyServer = require('../src/ProxyServer');
const { PluginManager } = require('../src/PluginManager');
const { SseCdnFlush, wantsSseFlush } = require('../src/SseCdnFlush');

const logger = { info() {}, warn() {}, error() {}, debug() {} };
const listen = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const close = async (server) => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function collect(stream) {
  const writes = [];
  stream.on('data', (c) => writes.push(c.toString()));
  return writes;
}

describe('SseCdnFlush', () => {
  test('a comment follows a complete event as its own write, once', async () => {
    const f = new SseCdnFlush(10);
    const out = collect(f);
    f.write('id: 1\nevent: snapshot\ndata: {"a":1}\n\n');
    await sleep(40);
    expect(out).toEqual(['id: 1\nevent: snapshot\ndata: {"a":1}\n\n', ':\n']);
    await sleep(40);
    expect(out.length).toBe(2); // no second comment while idle
    f.end();
  });

  test('nothing is injected mid-event (no blank line yet)', async () => {
    const f = new SseCdnFlush(10);
    const out = collect(f);
    f.write('event: snapshot\ndata: {"a":');
    await sleep(40);
    expect(out).toEqual(['event: snapshot\ndata: {"a":']);
    f.write('1}\n\n');
    await sleep(40);
    expect(out.slice(-1)).toEqual([':\n']);
    f.end();
  });

  test('a burst of events gets one comment after the last one', async () => {
    const f = new SseCdnFlush(20);
    const out = collect(f);
    for (let i = 0; i < 5; i++) f.write(`data: ${i}\n\n`);
    await sleep(60);
    expect(out.filter((w) => w === ':\n').length).toBe(1);
    expect(out[out.length - 1]).toBe(':\n');
    f.end();
  });

  test('CRLF event endings count as complete events', async () => {
    const f = new SseCdnFlush(10);
    const out = collect(f);
    f.write('data: x\r\n\r\n');
    await sleep(40);
    expect(out.slice(-1)).toEqual([':\n']);
    f.end();
  });

  test('a split blank line across chunks still counts', async () => {
    const f = new SseCdnFlush(10);
    const out = collect(f);
    f.write('data: x\n');
    f.write('\n');
    await sleep(40);
    expect(out.slice(-1)).toEqual([':\n']);
    f.end();
  });

  test('no timer survives destroy', async () => {
    const f = new SseCdnFlush(30);
    const out = collect(f);
    f.write('data: x\n\n');
    f.destroy();
    await sleep(60);
    expect(out).toEqual(['data: x\n\n']);
  });

  test('only plain event-streams qualify', () => {
    expect(wantsSseFlush({ 'content-type': 'text/event-stream; charset=utf-8' })).toBe(true);
    expect(wantsSseFlush({ 'content-type': 'text/event-stream', 'content-encoding': 'gzip' })).toBe(false);
    expect(wantsSseFlush({ 'content-type': 'application/json' })).toBe(false);
    const prev = process.env.SSE_CDN_FLUSH_MS;
    process.env.SSE_CDN_FLUSH_MS = '0';
    try { expect(wantsSseFlush({ 'content-type': 'text/event-stream' })).toBe(false); }
    finally { if (prev === undefined) delete process.env.SSE_CDN_FLUSH_MS; else process.env.SSE_CDN_FLUSH_MS = prev; }
  });

  test('EventSource-style parsing sees the same events (comments ignored)', async () => {
    const f = new SseCdnFlush(5);
    const src = new PassThrough();
    let text = '';
    src.pipe(f).on('data', (c) => { text += c; });
    src.write('id: 1\ndata: a\n\n');
    await sleep(20);
    src.write('id: 2\ndata: b\n\n');
    await sleep(20);
    src.end();
    await sleep(5);
    const events = text.split(/\n\n/).map((block) => block.split('\n').filter((l) => l && !l.startsWith(':')))
      .filter((lines) => lines.length);
    expect(events).toEqual([['id: 1', 'data: a'], ['id: 2', 'data: b']]);
  });
});

describe('through the proxy', () => {
  let backend, edge, plugin, proxy;
  beforeEach(async () => {
    backend = http.createServer((req, res) => {
      if (req.url === '/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        res.write('id: 1\nevent: snapshot\ndata: {"big":"' + 'x'.repeat(20000) + '"}\n\n');
        return; // then idle, like a quiet war room
      }
      if (req.url === '/json') { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}\n\n'); return; }
      res.writeHead(404); res.end();
    });
    plugin = http.createServer((req, res) => {
      req.resume(); res.setHeader('content-type', 'application/json');
      res.end(req.url === '/valid' ? JSON.stringify({ valid: false, needsBody: false }) : '');
    });
    await listen(backend); await listen(plugin);
    proxy = new ProxyServer(logger, new PluginManager(logger, '127.0.0.1:' + plugin.address().port));
    proxy.db.getMapping = async () => ({ id: 'sse-app', domain: 'app.test', front_uri: '', back_uri: '', backend: 'http://127.0.0.1', back_port: String(backend.address().port) });
    edge = http.createServer((req, res) => proxy.handleRequest(req, res, false));
    await listen(edge);
  });
  afterEach(async () => { await Promise.all([close(edge), close(backend), close(plugin)]); });

  const get = (path, accept) => new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: edge.address().port, path, agent: false,
      headers: { host: 'app.test', ...(accept ? { accept } : {}) } }, resolve);
    req.on('error', () => {});
    req.end();
  });

  test('an SSE event is followed by a separate :\\n comment once the feed idles', async () => {
    const res = await get('/events', 'text/event-stream');
    let text = '';
    res.on('data', (c) => { text += c; });
    for (let i = 0; i < 100 && !text.endsWith('\n\n:\n'); i++) await sleep(10);
    expect(text.endsWith('"}\n\n:\n')).toBe(true);
    expect(text.startsWith('id: 1\nevent: snapshot\n')).toBe(true);
    res.destroy();
  });

  test('a non-SSE response is untouched', async () => {
    const res = await get('/json');
    const body = await new Promise((resolve) => { let t = ''; res.on('data', (c) => { t += c; }); res.on('end', () => resolve(t)); });
    expect(body).toBe('{"ok":true}\n\n');
  });
});
