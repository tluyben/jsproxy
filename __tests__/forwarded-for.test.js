const http = require('http');
const path = require('path');
const fs = require('fs').promises;
const ProxyServer = require('../src/ProxyServer');

// Backend that echoes back the X-Forwarded-For header it received, so a test can
// assert exactly what the proxy forwarded.
function makeXffEchoBackend() {
  return http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(req.headers['x-forwarded-for'] || '<none>');
  });
}

function listenOn(server, port) {
  return new Promise(resolve => server.listen(port, resolve));
}

function closeServer(server) {
  return new Promise(resolve => server.close(resolve));
}

// GET through the proxy, optionally sending a pre-existing X-Forwarded-For to
// simulate this proxy being a middle/last hop in a jsproxy chain.
function proxyGet(port, host, xff) {
  return new Promise((resolve, reject) => {
    const headers = { Host: host };
    if (xff) headers['X-Forwarded-For'] = xff;
    const req = http.request({ hostname: '127.0.0.1', port, path: '/', headers }, res => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('X-Forwarded-For propagation through jsproxy chains', () => {
  // ── Unit: the two IP helpers ────────────────────────────────────────────────
  describe('getPeerIp / _appendForwardedFor', () => {
    const proxy = Object.create(ProxyServer.prototype);

    test('getPeerIp returns the raw socket peer and never trusts headers', () => {
      const req = {
        headers: { 'x-forwarded-for': '1.2.3.4' },      // must be ignored
        socket: { remoteAddress: '10.0.0.9' },
      };
      expect(proxy.getPeerIp(req)).toBe('10.0.0.9');
    });

    test('getPeerIp strips the IPv6-mapped IPv4 prefix', () => {
      const req = { headers: {}, socket: { remoteAddress: '::ffff:192.168.1.5' } };
      expect(proxy.getPeerIp(req)).toBe('192.168.1.5');
    });

    test('_appendForwardedFor sets the peer when no inbound XFF exists', () => {
      const req = { headers: {}, socket: { remoteAddress: '203.0.113.1' } };
      proxy._appendForwardedFor(req);
      expect(req.headers['x-forwarded-for']).toBe('203.0.113.1');
    });

    test('_appendForwardedFor appends the peer to an inbound XFF chain', () => {
      const req = {
        headers: { 'x-forwarded-for': '198.51.100.7' },  // the original client, from an upstream hop
        socket: { remoteAddress: '10.0.0.9' },           // the upstream jsproxy's socket to us
      };
      proxy._appendForwardedFor(req);
      // Original client stays leftmost; this hop's peer is appended.
      expect(req.headers['x-forwarded-for']).toBe('198.51.100.7, 10.0.0.9');
    });
  });

  // ── Unit: trust-aware client resolution ─────────────────────────────────────
  describe('getClientIp / _isTrusted / isClientHttps', () => {
    // Build a bare instance with a given TRUSTED_PROXIES spec.
    const withTrust = (spec) => {
      const p = Object.create(ProxyServer.prototype);
      p.trustedProxies = p._parseTrustedProxies(spec);
      return p;
    };
    const reqFrom = (peer, headers = {}) => ({ headers, socket: { remoteAddress: peer }, connection: {} });

    test('_isTrusted: empty spec trusts nothing (edge default)', () => {
      const p = withTrust('');
      expect(p._isTrusted('127.0.0.1')).toBe(false);
      expect(p._isTrusted('10.0.0.1')).toBe(false);
    });

    test('_isTrusted: `private` keyword covers RFC1918 + loopback + IPv6 ULA', () => {
      const p = withTrust('private');
      for (const ip of ['10.1.2.3', '172.16.5.5', '192.168.1.1', '127.0.0.1', '::1', 'fd00::1']) {
        expect(p._isTrusted(ip)).toBe(true);
      }
      expect(p._isTrusted('8.8.8.8')).toBe(false);
      expect(p._isTrusted('172.32.0.1')).toBe(false); // just outside 172.16/12
    });

    test('_isTrusted: `loopback`, explicit CIDR, literal IP, and `all`', () => {
      expect(withTrust('loopback')._isTrusted('127.0.0.9')).toBe(true);
      expect(withTrust('loopback')._isTrusted('10.0.0.1')).toBe(false);
      expect(withTrust('203.0.113.0/24')._isTrusted('203.0.113.50')).toBe(true);
      expect(withTrust('203.0.113.0/24')._isTrusted('203.0.114.1')).toBe(false);
      expect(withTrust('203.0.113.7')._isTrusted('203.0.113.7')).toBe(true);
      expect(withTrust('203.0.113.7')._isTrusted('203.0.113.8')).toBe(false);
      expect(withTrust('all')._isTrusted('8.8.8.8')).toBe(true);
    });

    test('getClientIp: edge posture ignores inbound XFF (anti-spoof)', () => {
      const p = withTrust('');
      // Attacker connects from 5.5.5.5 and forges a chain — the socket wins.
      expect(p.getClientIp(reqFrom('5.5.5.5', { 'x-forwarded-for': '9.9.9.9' }))).toBe('5.5.5.5');
      expect(p.getClientIp(reqFrom('5.5.5.5'))).toBe('5.5.5.5');
    });

    test('getClientIp: trusted peer resolves the real client from the chain', () => {
      const p = withTrust('private');
      // One trusted hop.
      expect(p.getClientIp(reqFrom('10.0.0.2', { 'x-forwarded-for': '9.9.9.9' }))).toBe('9.9.9.9');
      // Several trusted internal hops — skip them all, stop at the first public IP.
      expect(p.getClientIp(reqFrom('10.0.0.2', { 'x-forwarded-for': '9.9.9.9, 10.0.0.5, 172.16.0.9' }))).toBe('9.9.9.9');
    });

    test('getClientIp: a trusted CIDR does not extend trust to an untrusted peer', () => {
      const p = withTrust('private');
      // Peer is public (this jsproxy is the edge): ignore XFF even though it names a trusted IP.
      expect(p.getClientIp(reqFrom('8.8.8.8', { 'x-forwarded-for': '9.9.9.9' }))).toBe('8.8.8.8');
    });

    test('isClientHttps: TLS socket is always https', () => {
      const p = withTrust('');
      const req = { headers: {}, connection: { encrypted: true }, socket: { remoteAddress: '5.5.5.5' } };
      expect(p.isClientHttps(req)).toBe(true);
    });

    test('isClientHttps: edge ignores forwarded scheme headers', () => {
      const p = withTrust('');
      expect(p.isClientHttps(reqFrom('5.5.5.5', { 'x-forwarded-proto': 'https' }))).toBe(false);
      expect(p.isClientHttps(reqFrom('5.5.5.5', { 'front-end-https': 'on' }))).toBe(false);
    });

    test('isClientHttps: trusted peer is believed', () => {
      const p = withTrust('private');
      expect(p.isClientHttps(reqFrom('10.0.0.2', { 'x-forwarded-proto': 'https' }))).toBe(true);
      expect(p.isClientHttps(reqFrom('10.0.0.2', { 'x-forwarded-ssl': 'on' }))).toBe(true);
      expect(p.isClientHttps(reqFrom('10.0.0.2', {}))).toBe(false);
    });
  });

  // ── End-to-end: real proxy + real backend ───────────────────────────────────
  describe('end-to-end forwarding', () => {
    let proxy;
    let backend;
    let testDataDir;
    const PROXY_PORT = 9260;
    const SIMPLE_BACKEND = 4260;
    const HA_BACKEND_A = 4261;
    const HA_BACKEND_B = 4262;
    // A pre-existing chain, as an upstream jsproxy hop would send it.
    const UPSTREAM_XFF = '203.0.113.50, 198.51.100.60';

    beforeAll(async () => {
      testDataDir = path.join(__dirname, 'xff-test-data');
      await fs.mkdir(testDataDir, { recursive: true }).catch(() => {});

      const logger = { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() };
      proxy = new ProxyServer(logger);
      proxy.db.dbPath = path.join(testDataDir, 'test.db');
      proxy.certManager.certsDir = path.join(testDataDir, 'certs');

      process.env.HTTP_PORT = String(PROXY_PORT);
      process.env.ENABLE_HTTPS = 'false';

      await proxy.initialize();
      await proxy.start();

      // One echo backend, reachable on three ports (simple + two HA members).
      backend = [makeXffEchoBackend(), makeXffEchoBackend(), makeXffEchoBackend()];
      await listenOn(backend[0], SIMPLE_BACKEND);
      await listenOn(backend[1], HA_BACKEND_A);
      await listenOn(backend[2], HA_BACKEND_B);

      await proxy.db.addMapping('simple.xff.test', '', String(SIMPLE_BACKEND), '');
      await proxy.db.addMapping('ha.xff.test', '', `${HA_BACKEND_A},${HA_BACKEND_B}`, '');
      // Allowlisted to a public IP the test client (loopback) is NOT part of.
      await proxy.db.addMapping('allow.xff.test', '', String(SIMPLE_BACKEND), '', null, '203.0.113.7');
      // Allowlisted to loopback — the real socket peer of the test client.
      await proxy.db.addMapping('loopok.xff.test', '', String(SIMPLE_BACKEND), '', null, '127.0.0.1');
    }, 15000);

    afterAll(async () => {
      if (proxy) await proxy.stop();
      await Promise.all(backend.map(b => closeServer(b).catch(() => {})));
      delete process.env.HTTP_PORT;
      delete process.env.ENABLE_HTTPS;
      try {
        const files = await fs.readdir(testDataDir);
        await Promise.all(files.map(f => fs.unlink(path.join(testDataDir, f)).catch(() => {})));
        await fs.rmdir(testDataDir).catch(() => {});
      } catch (_) {}
    });

    // proxy.web path — user hits jsproxy directly (no inbound XFF).
    test('simple path: direct client IP is recorded as the sole XFF entry', async () => {
      const r = await proxyGet(PROXY_PORT, 'simple.xff.test');
      expect(r.status).toBe(200);
      // Loopback client → 127.0.0.1 is the whole chain.
      expect(r.body).toBe('127.0.0.1');
    });

    // proxy.web path — jsproxy is a middle/last hop; inbound chain preserved.
    test('simple path: appends this hop to an existing XFF chain', async () => {
      const r = await proxyGet(PROXY_PORT, 'simple.xff.test', UPSTREAM_XFF);
      expect(r.status).toBe(200);
      expect(r.body).toBe(`${UPSTREAM_XFF}, 127.0.0.1`);
    });

    // Buffered HA path — this is the path that previously dropped the IP entirely.
    test('HA path: direct client IP is recorded (was previously dropped)', async () => {
      const r = await proxyGet(PROXY_PORT, 'ha.xff.test');
      expect(r.status).toBe(200);
      expect(r.body).toBe('127.0.0.1');
    });

    test('HA path: appends this hop to an existing XFF chain', async () => {
      const r = await proxyGet(PROXY_PORT, 'ha.xff.test', UPSTREAM_XFF);
      expect(r.status).toBe(200);
      // The original client (leftmost) survives to the backend across the HA hop.
      expect(r.body).toBe(`${UPSTREAM_XFF}, 127.0.0.1`);
    });

    // Anti-spoof: default edge posture (no TRUSTED_PROXIES) means a forged
    // X-Forwarded-For cannot satisfy an IP allowlist.
    test('allowlist: spoofed X-Forwarded-For cannot bypass allowed_ips', async () => {
      const r = await proxyGet(PROXY_PORT, 'allow.xff.test', '203.0.113.7');
      expect(r.status).toBe(403); // resolved client is the loopback socket, not the forged IP
    });

    test('allowlist: real socket peer is allowed through', async () => {
      const r = await proxyGet(PROXY_PORT, 'loopok.xff.test', '203.0.113.7');
      expect(r.status).toBe(200); // 127.0.0.1 matches; forged XFF is irrelevant
    });
  });
});
