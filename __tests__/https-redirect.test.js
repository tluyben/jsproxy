// Automatic HTTP → HTTPS redirect: once a served domain has a certificate we can
// terminate TLS with (trusted/ACME, self-signed, or a covering wildcard), plain
// HTTP requests get a permanent 301 to https — no HTTP-only fronting layer needed.
// A certless domain is proxied over HTTP once and its cert is warmed in the
// background so the next request redirects.
const http = require('http');
const path = require('path');
const fs = require('fs').promises;
const ProxyServer = require('../src/ProxyServer');

function makeBackend(statusCode, body) {
  return http.createServer((req, res) => {
    res.writeHead(statusCode, { 'Content-Type': 'text/plain' });
    res.end(body);
  });
}
function listenOn(server, port) {
  return new Promise(resolve => server.listen(port, resolve));
}
function closeServer(server) {
  return new Promise(resolve => server.close(resolve));
}
// Raw GET that does NOT follow redirects, so we can assert the 301 + Location.
function httpGet(port, host, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: 'localhost', port, path: '/', headers: { Host: host, ...extraHeaders } },
      res => {
        let body = '';
        res.on('data', c => { body += c; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

describe('automatic HTTP → HTTPS redirect', () => {
  let proxy, backend, testDataDir;
  const PROXY_PORT = 9280;
  const BACK_PORT = 9281;

  beforeAll(async () => {
    testDataDir = path.join(__dirname, 'https-redirect-data');
    await fs.mkdir(testDataDir, { recursive: true }).catch(() => {});

    backend = makeBackend(200, 'from-backend');
    await listenOn(backend, BACK_PORT);

    const logger = { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() };
    proxy = new ProxyServer(logger);
    proxy.db.dbPath = path.join(testDataDir, 'test.db');
    proxy.certManager.certsDir = path.join(testDataDir, 'certs');

    process.env.HTTP_PORT = String(PROXY_PORT);
    process.env.ENABLE_HTTPS = 'false';   // no real TLS server; we simulate it below

    await proxy.initialize();
    await proxy.start();

    // Simulate "HTTPS is being served on 8443" without standing up a real TLS
    // listener — the redirect only consults these two fields.
    proxy.httpsEnabled = true;
    proxy.resolvedHttpsPort = 8443;

    await proxy.db.addMapping('redir.test', '', String(BACK_PORT), '');
  }, 15000);

  afterAll(async () => {
    if (proxy) await proxy.stop();
    if (backend) await closeServer(backend);
    delete process.env.HTTP_PORT;
    delete process.env.ENABLE_HTTPS;
    delete process.env.AUTO_HTTPS_REDIRECT;
    delete process.env.FORCE_HTTPS;
    try {
      const files = await fs.readdir(testDataDir);
      await Promise.all(files.map(f => fs.unlink(path.join(testDataDir, f)).catch(() => {})));
      await fs.rmdir(testDataDir).catch(() => {});
    } catch (_) {}
  });

  // Track only the spies THIS suite creates so we don't clobber the global
  // console spies installed by jest.setup.js (jest.restoreAllMocks() would).
  let spies = [];
  const spyOn = (obj, method) => {
    const s = jest.spyOn(obj, method);
    spies.push(s);
    return s;
  };
  afterEach(() => {
    spies.forEach(s => s.mockRestore());
    spies = [];
    delete process.env.AUTO_HTTPS_REDIRECT;
    delete process.env.FORCE_HTTPS;
  });

  test('301 to https when the domain already has a certificate', async () => {
    spyOn(proxy.certManager, 'hasCertificateFor').mockResolvedValue(true);

    const res = await httpGet(PROXY_PORT, 'redir.test');
    expect(res.status).toBe(301);
    expect(res.headers.location).toBe('https://redir.test:8443/');
  });

  test('port suffix omitted when HTTPS runs on 443', async () => {
    spyOn(proxy.certManager, 'hasCertificateFor').mockResolvedValue(true);
    proxy.resolvedHttpsPort = 443;
    try {
      const res = await httpGet(PROXY_PORT, 'redir.test');
      expect(res.headers.location).toBe('https://redir.test/');
    } finally {
      proxy.resolvedHttpsPort = 8443;
    }
  });

  test('no cert yet → proxies over HTTP and warms a cert in the background', async () => {
    spyOn(proxy.certManager, 'hasCertificateFor').mockResolvedValue(false);
    const warm = spyOn(proxy.certManager, 'ensureCertificate').mockResolvedValue({ cert: 'x', key: 'y' });

    const res = await httpGet(PROXY_PORT, 'redir.test');
    expect(res.status).toBe(200);
    expect(res.body).toBe('from-backend');
    expect(warm).toHaveBeenCalledWith('redir.test', true);
  });

  test('AUTO_HTTPS_REDIRECT=false disables the redirect even with a cert', async () => {
    spyOn(proxy.certManager, 'hasCertificateFor').mockResolvedValue(true);
    process.env.AUTO_HTTPS_REDIRECT = 'false';

    const res = await httpGet(PROXY_PORT, 'redir.test');
    expect(res.status).toBe(200);
    expect(res.body).toBe('from-backend');
  });

  test('no redirect when HTTPS is not actually being served', async () => {
    spyOn(proxy.certManager, 'hasCertificateFor').mockResolvedValue(true);
    proxy.httpsEnabled = false;
    try {
      const res = await httpGet(PROXY_PORT, 'redir.test');
      expect(res.status).toBe(200);
      expect(res.body).toBe('from-backend');
    } finally {
      proxy.httpsEnabled = true;
    }
  });
});

describe('CertificateManager.hasCertificateFor', () => {
  const { CertificateManager } = requireCertManager();

  function requireCertManager() {
    const mod = require('../src/CertificateManager');
    return { CertificateManager: mod.CertificateManager || mod };
  }

  function makeManager(storeReads = {}) {
    const logger = { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() };
    const cm = new CertificateManager(logger, { getMapping: async () => null });
    // Replace the store with an in-memory stub keyed exactly like the real one.
    cm.store = { read: async (key) => (key in storeReads ? storeReads[key] : null) };
    return cm;
  }

  test('true when the exact domain is cached in memory', async () => {
    const cm = makeManager();
    cm.certificates.set('a.test', { cert: 'c', key: 'k', type: 'selfsigned' });
    expect(await cm.hasCertificateFor('a.test')).toBe(true);
  });

  test('true for a subdomain covered by a cached wildcard', async () => {
    const cm = makeManager();
    cm.wildcardCerts.set('example.com', { cert: 'c', key: 'k' });
    expect(await cm.hasCertificateFor('app.example.com')).toBe(true);
  });

  test('true when a self-signed cert exists only in the store', async () => {
    const cm = makeManager({ 'b.test.selfsigned.crt': 'PEM' });
    expect(await cm.hasCertificateFor('b.test')).toBe(true);
  });

  test('false when nothing is cached or stored', async () => {
    const cm = makeManager();
    expect(await cm.hasCertificateFor('nope.test')).toBe(false);
  });

  test('false (not a throw) when the store errors', async () => {
    const cm = makeManager();
    cm.store = { read: async () => { throw new Error('boom'); } };
    expect(await cm.hasCertificateFor('err.test')).toBe(false);
  });
});
