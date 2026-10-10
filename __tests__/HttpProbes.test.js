const http = require('http');
const https = require('https');
const net = require('net');
const path = require('path');
const fsSync = require('fs');
const fs = require('fs').promises;
const ProxyServer = require('../src/ProxyServer');
const { getProbe, probeHttpTcp, probeHttpsTcp } = require('../src/ProtocolProbes');

const certDir = path.join(__dirname, 'test-certs');
const tlsOpts = {
  key: fsSync.readFileSync(path.join(certDir, 'example.com.selfsigned.key')),
  cert: fsSync.readFileSync(path.join(certDir, 'example.com.selfsigned.crt')),
};

const listen = (srv, port) => new Promise((r) => srv.listen(port, '127.0.0.1', r));
const close = (srv) => new Promise((r) => srv.close(() => r()));
// Accepts connections (handshake succeeds) but never answers: the disk-stalled box.
function hangingTcp() {
  const socks = new Set();
  const srv = net.createServer((s) => { socks.add(s); s.on('error', () => {}); s.on('close', () => socks.delete(s)); });
  srv.destroyAll = () => socks.forEach((s) => s.destroy());
  return srv;
}

describe('http(s)+check protocol probes', () => {
  test('registry: +check schemes are TCP-only with web default ports', () => {
    expect(getProbe('http+check')).toMatchObject({ defaultPort: 80 });
    expect(getProbe('https+check')).toMatchObject({ defaultPort: 443 });
    expect(typeof getProbe('https+check').tcp).toBe('function');
    expect(getProbe('https+check').udp).toBeUndefined();
    expect(getProbe('https')).toBeNull(); // the mapping scheme stays probe-less
  });

  test('http: any status line is alive; hang, closed port and non-HTTP are dead', async () => {
    let seenHost = null;
    const live = http.createServer((req, res) => { seenHost = req.headers.host; res.writeHead(502); res.end(); });
    const hang = hangingTcp();
    const gSocks = new Set();
    const garbage = net.createServer((s) => { gSocks.add(s); s.on('error', () => {}); s.end('SSH-2.0-OpenSSH\r\n'); });
    await listen(live, 9601); await listen(hang, 9602); await listen(garbage, 9603);
    try {
      expect(await probeHttpTcp({ hostname: '127.0.0.1', port: 9601, name: 'fluxwall.eu', timeoutMs: 1000 })).toBe(true);
      expect(seenHost).toBe('fluxwall.eu');
      const t0 = Date.now();
      expect(await probeHttpTcp({ hostname: '127.0.0.1', port: 9602, name: 'x', timeoutMs: 400 })).toBe(false);
      expect(Date.now() - t0).toBeLessThan(1500);
      expect(await probeHttpTcp({ hostname: '127.0.0.1', port: 9609, name: 'x', timeoutMs: 400 })).toBe(false);
      expect(await probeHttpTcp({ hostname: '127.0.0.1', port: 9603, name: 'x', timeoutMs: 400 })).toBe(false);
    } finally { hang.destroyAll(); gSocks.forEach((x) => x.destroy()); live.closeAllConnections?.(); await close(live); await close(hang); await close(garbage); }
  });

  test('https: TLS with SNI = name is alive (self-signed ok); TLS that hangs after handshake is dead', async () => {
    let sni = null;
    const live = https.createServer({ ...tlsOpts, SNICallback: (n, cb) => { sni = n; cb(null, require('tls').createSecureContext(tlsOpts)); } },
      (req, res) => { res.writeHead(200); res.end('ok'); });
    const hangTls = require('tls').createServer(tlsOpts, (s) => { s.on('error', () => {}); /* never answers */ });
    await listen(live, 9611); await listen(hangTls, 9612);
    try {
      expect(await probeHttpsTcp({ hostname: '127.0.0.1', port: 9611, name: 'example.com', timeoutMs: 1500 })).toBe(true);
      expect(sni).toBe('example.com');
      expect(await probeHttpsTcp({ hostname: '127.0.0.1', port: 9612, name: 'example.com', timeoutMs: 400 })).toBe(false);
    } finally { await close(live); hangTls.close(); }
  });
});

describe('raw TCP route fails over off a backend that accepts but hangs', () => {
  let proxy;
  const dir = path.join(__dirname, 'httpprobe-test-data');
  beforeAll(async () => {
    await fs.mkdir(dir, { recursive: true }).catch(() => {});
    process.env.PROTOCOL_PROBE_INTERVAL_MS = '200';
    process.env.PROTOCOL_PROBE_TIMEOUT_MS = '300';
    process.env.HTTP_PORT = '9620';
    process.env.ENABLE_HTTPS = 'false';
    proxy = new ProxyServer({ info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() });
    proxy.db.dbPath = path.join(dir, 'test.db');
    proxy.certManager.certsDir = path.join(dir, 'certs');
    await proxy.initialize();
    await proxy.start();
  }, 15000);
  afterAll(async () => {
    if (proxy) await proxy.stop();
    ['PROTOCOL_PROBE_INTERVAL_MS', 'PROTOCOL_PROBE_TIMEOUT_MS', 'HTTP_PORT', 'ENABLE_HTTPS'].forEach((k) => delete process.env[k]);
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  });

  test('_rawTargets: ?host= sets the probe host, combines with ?backup=1', () => {
    const t = proxy._rawTargets({ id: 'r', backend: 'https+check://10.0.0.1:443?host=fluxwall.eu,https+check://10.0.0.2:443?host=fluxwall.eu&backup=1', back_port: '' });
    expect(t.map((x) => [x.key, x.probe, x.probeHost, !!x.backup])).toEqual([
      ['10.0.0.1:443', 'https+check', 'fluxwall.eu', false],
      ['10.0.0.2:443', 'https+check', 'fluxwall.eu', true],
    ]);
  });

  test('primary accepts connections but never answers HTTP → probe scores it 0 → traffic goes to the standby', async () => {
    const hang = hangingTcp();
    const standby = http.createServer((req, res) => { res.writeHead(200); res.end('standby'); });
    await listen(hang, 9631); await listen(standby, 9632);
    try {
      await proxy.db.addTcpRoute(9630, 'http+check://127.0.0.1:9631?host=t.example,http+check://127.0.0.1:9632?host=t.example&backup=1', '');
      await proxy.startTcpListeners(9620, 0, '127.0.0.1');
      await new Promise((r) => setTimeout(r, 1200)); // a few probe ticks
      const route = (await proxy.db.getTcpRoutes()).find((r) => r.listen_port === 9630);
      expect(proxy.getPortScore(route.id, '127.0.0.1:9631')).toBe(0);
      const body = await new Promise((resolve, reject) => {
        const req = http.request({ hostname: '127.0.0.1', port: 9630, path: '/', headers: { Host: 't.example' }, timeout: 3000 }, (res) => {
          let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => resolve(b));
        });
        req.on('timeout', () => { req.destroy(); reject(new Error('timed out — still routed to the hung primary')); });
        req.on('error', reject); req.end();
      });
      expect(body).toBe('standby');
    } finally { hang.destroyAll(); await close(hang); await close(standby); }
  }, 20000);
});
