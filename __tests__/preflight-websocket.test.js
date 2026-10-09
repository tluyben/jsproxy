'use strict';

// The preflight header rewrite (PREFLIGHT_SCRIPT) must apply to WebSocket
// upgrades exactly like it applies to plain requests.
//
// Production shape (fluxwall behind a Bunny pull zone): the CDN pins
// `Host: <platform zone>` and names the real site in `cdn-host`; the preflight
// script copies cdn-host into Host before routing. Plain requests worked, but
// handleWebSocket skipped the preflight, routed the upgrade by the platform
// Host to the platform's own app — which never answers an upgrade — and the
// client hung forever. Every WebSocket behind the CDN was dead (found
// 2026-10-09 while testing the InferMux Dave gateway).

const http = require('http');
const path = require('path');
const fs = require('fs').promises;
const ProxyServer = require('../src/ProxyServer');

const PROXY_PORT = 9470;
const PLATFORM_PORT = 4701; // the platform app: ignores upgrades (like Next without a handler)
const SITE_PORT = 4702; // the site: accepts upgrades

function wsAttempt(headers) {
  return new Promise(resolve => {
    const req = http.request({
      hostname: 'localhost', port: PROXY_PORT, path: '/ws', method: 'GET',
      headers: {
        Connection: 'Upgrade', Upgrade: 'websocket',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==', 'Sec-WebSocket-Version': '13',
        ...headers,
      },
    });
    req.on('upgrade', (res, socket) => { socket.destroy(); resolve({ kind: 'upgrade', host: res.headers['x-seen-host'] }); });
    req.on('response', res => { res.resume(); resolve({ kind: 'response', status: res.statusCode }); });
    req.on('error', err => resolve({ kind: 'error', code: err.code }));
    req.setTimeout(3000, () => { req.destroy(); resolve({ kind: 'timeout' }); });
    req.end();
  });
}

let proxy;
let platform;
let site;
let testDataDir;
const seen = [];
const hung = [];

beforeAll(async () => {
  testDataDir = path.join(__dirname, 'preflight-ws-data');
  await fs.mkdir(testDataDir, { recursive: true }).catch(() => {});

  platform = http.createServer((req, res) => { res.writeHead(200); res.end('platform'); });
  platform.on('upgrade', (req, socket) => { hung.push(socket); /* never answers — the hang */ });
  site = http.createServer((req, res) => { res.writeHead(200); res.end('site'); });
  site.on('upgrade', (req, socket) => {
    seen.push({ host: req.headers.host, xfh: req.headers['x-forwarded-host'] });
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nX-Seen-Host: ${req.headers.host}\r\n\r\n`);
    socket.end();
  });
  await new Promise(r => platform.listen(PLATFORM_PORT, r));
  await new Promise(r => site.listen(SITE_PORT, r));

  // Same contract as fluxwall's proxy/preflight-cdn-host.js: adopt cdn-host,
  // decline (null) when told to.
  const script = path.join(testDataDir, 'preflight.js');
  await fs.writeFile(script, `module.exports = function (h) {
    if (h['x-decline']) return null;
    if (h['cdn-host']) { h.host = h['cdn-host']; h['x-forwarded-host'] = h['cdn-host']; }
    return h;
  };`);
  process.env.PREFLIGHT_SCRIPT = script;
  process.env.HTTP_PORT = String(PROXY_PORT);
  process.env.ENABLE_HTTPS = 'false';

  const logger = { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() };
  proxy = new ProxyServer(logger);
  proxy.db.dbPath = path.join(testDataDir, 'test.db');
  proxy.certManager.certsDir = path.join(testDataDir, 'certs');
  await proxy.initialize();
  await proxy.start();
  await proxy.db.addMapping('platform.test', '', String(PLATFORM_PORT), '', 'http://127.0.0.1');
  await proxy.db.addMapping('site.test', '', String(SITE_PORT), '', 'http://127.0.0.1');
}, 15000);

afterAll(async () => {
  for (const s of hung) s.destroy();
  if (proxy) await proxy.stop();
  await new Promise(r => platform.close(r));
  await new Promise(r => site.close(r));
  delete process.env.PREFLIGHT_SCRIPT;
  delete process.env.HTTP_PORT;
  delete process.env.ENABLE_HTTPS;
  await fs.rm(testDataDir, { recursive: true, force: true }).catch(() => {});
});

test('an upgrade with Host=platform + cdn-host=site reaches the SITE (preflight applied)', async () => {
  const out = await wsAttempt({ Host: 'platform.test', 'cdn-host': 'site.test' });
  expect(out.kind).toBe('upgrade');
  // jsproxy re-targets Host at the backend; the site name travels in x-forwarded-host.
  expect(seen.at(-1).xfh).toBe('site.test');
});

test('a direct upgrade (no cdn-host) still routes by Host', async () => {
  expect((await wsAttempt({ Host: 'site.test' })).kind).toBe('upgrade');
  expect(seen.at(-1).xfh).toBe('site.test');
});

test('a preflight decline answers 403 instead of proxying the upgrade', async () => {
  expect(await wsAttempt({ Host: 'site.test', 'x-decline': '1' })).toEqual({ kind: 'response', status: 403 });
});

test('plain requests keep working the same way', async () => {
  const body = await new Promise((resolve, reject) => {
    http.get({ hostname: 'localhost', port: PROXY_PORT, path: '/', headers: { Host: 'platform.test', 'cdn-host': 'site.test' } }, res => {
      let b = '';
      res.on('data', c => { b += c; });
      res.on('end', () => resolve(b));
    }).on('error', reject);
  });
  expect(body).toBe('site');
});
