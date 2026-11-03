'use strict';
// A raw TCP route must deliver EVERY byte a backend wrote before it closed.
// 2026-11-03: a backend answering `Connection: close` (fluxwall serving
// MadeWithTech's 6.7 MB page) closed right after its last write; the relay's
// 'close' handler destroy()ed the client socket while ~67 KB were still queued
// for a slower client (a tailnet hop), so the page arrived short and KissUptime
// saw "ECONNRESET: aborted" every few minutes.
const net = require('net');
const path = require('path');
const fs = require('fs').promises;
const ProxyServer = require('../src/ProxyServer');

const HTTP_PORT = 9450;
const ROUTE_PORT = 9451;
const BACKEND_PORT = 9452;
const SIZE = 4 * 1024 * 1024;

const listenOn = (server, port) => new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
const closeServer = (server) => new Promise((resolve) => server.close(resolve));

// Reads slowly: pauses after every chunk so the proxy's client-side write
// buffer fills up while the backend has already finished and closed.
function slowRead(port) {
  return new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1');
    let got = 0;
    sock.on('connect', () => sock.write('GET / HTTP/1.1\r\n\r\n'));
    sock.on('data', (d) => {
      got += d.length;
      sock.pause();
      setTimeout(() => sock.resume(), 8);
    });
    sock.on('end', () => sock.end());
    sock.on('close', () => resolve(got));
    sock.on('error', () => {});
  });
}

describe('raw TCP relay drains on a clean close', () => {
  let proxy, backend, dir;

  beforeAll(async () => {
    dir = path.join(__dirname, 'tcp-drain-data');
    await fs.mkdir(dir, { recursive: true }).catch(() => {});
    const logger = { info() {}, error() {}, warn() {}, debug() {} };
    proxy = new ProxyServer(logger);
    proxy.db.dbPath = path.join(dir, 'test.db');
    proxy.certManager.certsDir = path.join(dir, 'certs');
    process.env.HTTP_PORT = String(HTTP_PORT);
    process.env.ENABLE_HTTPS = 'false';
    await proxy.initialize();
    await proxy.start();

    // Like `Connection: close`: write the whole response, then end at once.
    const payload = Buffer.alloc(SIZE, 0x61);
    backend = net.createServer((sock) => {
      sock.on('error', () => {});
      sock.once('data', () => { sock.end(payload); });
    });
    await listenOn(backend, BACKEND_PORT);
    await proxy.db.addTcpRoute(ROUTE_PORT, '127.0.0.1', String(BACKEND_PORT));
    await proxy.startTcpListeners(HTTP_PORT, 0, '127.0.0.1');
  }, 20000);

  afterAll(async () => {
    if (backend) await closeServer(backend);
    if (proxy) await proxy.stop();
    delete process.env.HTTP_PORT;
    delete process.env.ENABLE_HTTPS;
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  // A client whose writes complete slowly, like a congested tailnet hop: the
  // relay's writes queue in its buffer while the backend has long finished.
  function slowClient() {
    const { Duplex } = require('stream');
    let got = 0;
    let sentRequest = false;
    const d = new Duplex({
      writableHighWaterMark: 16 * 1024,
      read() { if (!sentRequest) { sentRequest = true; this.push('GET / HTTP/1.1\r\n\r\n'); } },
      write(chunk, _enc, cb) { setTimeout(() => { if (!d.destroyed) got += chunk.length; cb(); }, 3); },
      final(cb) { cb(); },
    });
    d.remoteAddress = '127.0.0.1';
    d.received = () => got;
    return d;
  }

  test('a slow client still receives every byte after the backend closed', async () => {
    const route = (await proxy.db.getTcpRoutes()).find((r) => r.listen_port === ROUTE_PORT);
    const clients = [slowClient(), slowClient()];
    const done = clients.map((c) => new Promise((resolve) => {
      c.on('finish', () => resolve('finish'));
      c.on('close', () => resolve('close'));
    }));
    for (const c of clients) proxy.handleTcpConnection(route, c);
    await Promise.all(done);
    expect(clients.map((c) => c.received())).toEqual([SIZE, SIZE]);
  }, 60000);
});
