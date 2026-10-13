// Per-SNI TLS passthrough on the HTTPS port: a ClientHello whose SNI matches an
// enabled tls_passthrough row is relayed as raw bytes (PROXY v2 header first) to
// a backend that terminates TLS with its OWN certificate; every other connection
// is terminated by jsproxy's HTTPS server exactly as before.
const net = require('net');
const tls = require('tls');
const http = require('http');
const https = require('https');
const path = require('path');
const os = require('os');
const fs = require('fs');
const { Readable } = require('stream');
const { execFileSync } = require('child_process');
const ProxyServer = require('../src/ProxyServer');
const { parseClientHello, buildProxyV2Header, _ipv6Bytes } = require('../src/TlsPassthrough');

const HTTP_PORT = 9870;
const HTTPS_PORT = 9871;
const BACK_PP = 9872;      // PROXY v2 + own TLS
const BACK_NOPP = 9873;    // plain own TLS (proxy_protocol=0)
const BACK_RAW = 9874;     // raw capture / bulk
const APP_PORT = 9875;     // plain HTTP app behind a normal mapping
const DEAD_PORT = 9879;    // nothing listens here

// RSA: CertificateManager parses certs with node-forge, which has no EC support.
function makeCert(dir, cn) {
  const key = path.join(dir, `${cn}.key`);
  const crt = path.join(dir, `${cn}.crt`);
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048',
    '-nodes', '-keyout', key, '-out', crt, '-days', '365', '-subj', `/CN=${cn}`], { stdio: 'ignore' });
  return { key: fs.readFileSync(key, 'utf8'), cert: fs.readFileSync(crt, 'utf8') };
}

// Reads a PROXY v2 header off `sock`, then calls cb(header, rest).
function readProxyV2(sock, cb) {
  let buf = Buffer.alloc(0);
  const onData = (d) => {
    buf = Buffer.concat([buf, d]);
    if (buf.length < 16) return;
    const len = buf.readUInt16BE(14);
    if (buf.length < 16 + len) return;
    sock.removeListener('data', onData);
    sock.pause();
    cb(buf.subarray(0, 16 + len), buf.subarray(16 + len));
  };
  sock.on('data', onData);
}

function parseProxyV2(h) {
  const out = { sig: h.subarray(0, 12).toString('hex'), verCmd: h[12], fam: h[13], len: h.readUInt16BE(14), tlvs: {} };
  let p = 16;
  if (out.fam === 0x11) {
    out.src = [...h.subarray(16, 20)].join('.');
    out.dst = [...h.subarray(20, 24)].join('.');
    out.srcPort = h.readUInt16BE(24);
    out.dstPort = h.readUInt16BE(26);
    p = 28;
  }
  while (p + 3 <= h.length) {
    const t = h[p]; const l = h.readUInt16BE(p + 1);
    out.tlvs[t] = h.subarray(p + 3, p + 3 + l).toString('ascii');
    p += 3 + l;
  }
  return out;
}

function tlsConnect(servername, extra = {}) {
  return new Promise((resolve) => {
    const s = tls.connect({ host: '127.0.0.1', port: HTTPS_PORT, servername, rejectUnauthorized: false, ...extra });
    let done = false;
    const fin = (r) => { if (!done) { done = true; resolve({ socket: s, ...r }); } };
    s.once('secureConnect', () => fin({ ok: true, cn: s.getPeerCertificate().subject.CN }));
    s.once('error', (e) => fin({ ok: false, error: e }));
    s.once('close', () => fin({ ok: false, closed: true }));
    s.setTimeout(5000, () => { s.destroy(); fin({ ok: false, timedOut: true }); });
  });
}

function rawConnect() {
  return new Promise((resolve, reject) => {
    const s = net.connect(HTTPS_PORT, '127.0.0.1', () => resolve(s));
    s.once('error', reject);
  });
}

function waitClose(sock, ms) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const timer = setTimeout(() => resolve({ closed: false, ms: Date.now() - t0 }), ms);
    sock.on('error', () => {});
    sock.on('data', () => {});
    sock.once('close', () => { clearTimeout(timer); resolve({ closed: true, ms: Date.now() - t0 }); });
  });
}

// Capture the exact ClientHello a real Node TLS client sends for `servername`.
function captureHello(servername) {
  return new Promise((resolve) => {
    const srv = net.createServer((sock) => {
      let buf = Buffer.alloc(0);
      sock.on('data', (d) => {
        buf = Buffer.concat([buf, d]);
        if (parseClientHello(buf).status === 'done') { sock.destroy(); srv.close(); resolve(buf); }
      });
      sock.on('error', () => {});
    });
    srv.listen(0, '127.0.0.1', () => {
      const c = tls.connect({ host: '127.0.0.1', port: srv.address().port, servername, rejectUnauthorized: false });
      c.on('error', () => {});
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('per-SNI TLS passthrough on the HTTPS port', () => {
  let proxy, logger, dataDir, certs;
  let backPP, backNoPP, backRaw, app;
  const ppHeaders = [];        // PROXY v2 headers seen by backPP
  const rawSessions = [];      // { header, bytes } seen by backRaw (capture mode)
  let bulkStats = null;

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsp-sni-'));
    const certDir = path.join(dataDir, 'certs');
    fs.mkdirSync(certDir);
    certs = {
      jsp: makeCert(dataDir, 'jsproxy-default'),
      own: makeCert(dataDir, 'backend-own'),
      ownNoPP: makeCert(dataDir, 'backend-nopp'),
      normal: makeCert(dataDir, 'normal.test'),
    };
    // jsproxy's own certs: the default, and one for the normally-served host.
    fs.writeFileSync(path.join(certDir, 'default.crt'), certs.jsp.cert);
    fs.writeFileSync(path.join(certDir, 'default.key'), certs.jsp.key);
    fs.writeFileSync(path.join(certDir, 'normal.test.selfsigned.crt'), certs.normal.cert);
    fs.writeFileSync(path.join(certDir, 'normal.test.selfsigned.key'), certs.normal.key);

    // Backend that expects PROXY v2 and then terminates TLS with its own cert.
    backPP = net.createServer((sock) => {
      sock.on('error', () => {});
      readProxyV2(sock, (hdr, rest) => {
        ppHeaders.push(parseProxyV2(hdr));
        if (rest.length) sock.unshift(rest);
        const t = new tls.TLSSocket(sock, { isServer: true, key: certs.own.key, cert: certs.own.cert });
        t.on('error', () => {});
        t.on('data', (d) => t.write(`own:${d}`));
        t.on('end', () => t.end());
      });
    });
    backNoPP = tls.createServer({ key: certs.ownNoPP.key, cert: certs.ownNoPP.cert }, (t) => {
      t.on('error', () => {});
      t.on('data', (d) => t.write(`nopp:${d}`));
    });
    // Raw backend: capture mode records exactly what arrives; for the bulk SNI
    // it streams BULK bytes down and counts what comes up.
    backRaw = net.createServer((sock) => {
      sock.on('error', () => {});
      readProxyV2(sock, (hdr, rest) => {
        const h = parseProxyV2(hdr);
        if (h.tlvs[2] === 'bulk.example.test') {
          // `rest` = the ClientHello plus whatever upload bytes shared its read.
          bulkStats.up += rest.length - bulkStats.helloLen;
          sock.on('data', (d) => { bulkStats.up += d.length; });
          sock.on('end', () => { bulkStats.upEnded = true; });
          const chunk = Buffer.alloc(64 * 1024, 0x61);
          let sent = 0;
          const pump = () => {
            while (sent < bulkStats.target) {
              sent += chunk.length;
              if (!sock.write(chunk)) { sock.once('drain', pump); return; }
            }
            sock.end();
          };
          pump();
          sock.resume();
          return;
        }
        const s = { header: h, bytes: rest };
        rawSessions.push(s);
        sock.on('data', (d) => { s.bytes = Buffer.concat([s.bytes, d]); });
        sock.resume();
      });
    });
    app = http.createServer((req, res) => {
      res.end(JSON.stringify({ host: req.headers.host, xff: req.headers['x-forwarded-for'] || null }));
    });
    await Promise.all([
      new Promise((r) => backPP.listen(BACK_PP, '127.0.0.1', r)),
      new Promise((r) => backNoPP.listen(BACK_NOPP, '127.0.0.1', r)),
      new Promise((r) => backRaw.listen(BACK_RAW, '127.0.0.1', r)),
      new Promise((r) => app.listen(APP_PORT, '127.0.0.1', r)),
    ]);

    process.env.HTTP_PORT = String(HTTP_PORT);
    process.env.HTTPS_PORT = String(HTTPS_PORT);
    process.env.HTTP_HOST = '127.0.0.1';
    process.env.ENABLE_HTTPS = 'true';
    process.env.TLS_PEEK_TIMEOUT_MS = '800';

    logger = { info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() };
    proxy = new ProxyServer(logger);
    proxy.db.dbPath = path.join(dataDir, 'test.db');
    proxy.certManager.certsDir = certDir;
    proxy.certManager.initializeAcmeClient = async () => {};   // never talk to Let's Encrypt
    await proxy.initialize();
    await proxy.db.addMapping('normal.test', '', String(APP_PORT), '', 'http://127.0.0.1');
    await proxy.db.addTlsPassthrough('pass.example.test', '127.0.0.1', BACK_PP, true);
    await proxy.db.addTlsPassthrough('nopp.example.test', '127.0.0.1', BACK_NOPP, false);
    await proxy.db.addTlsPassthrough('raw.example.test', '127.0.0.1', BACK_RAW, true);
    await proxy.db.addTlsPassthrough('bulk.example.test', '127.0.0.1', BACK_RAW, true);
    await proxy.db.addTlsPassthrough('disabled.example.test', '127.0.0.1', BACK_PP, true, false);
    await proxy.db.addTlsPassthrough('dead.example.test', '127.0.0.1', DEAD_PORT, true);
    await proxy.start();
    expect(proxy.httpsEnabled).toBe(true);
  }, 30000);

  afterAll(async () => {
    if (proxy) await proxy.stop();
    for (const s of [backPP, backNoPP, backRaw, app]) await new Promise((r) => s.close(r));
    for (const k of ['HTTP_PORT', 'HTTPS_PORT', 'HTTP_HOST', 'ENABLE_HTTPS', 'TLS_PEEK_TIMEOUT_MS']) delete process.env[k];
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  test('schema: tls_passthrough has the contract columns', async () => {
    const cols = await new Promise((res, rej) => proxy.db.db.all('PRAGMA table_info(tls_passthrough)', (e, r) => (e ? rej(e) : res(r))));
    const byName = Object.fromEntries(cols.map((c) => [c.name, c]));
    expect(Object.keys(byName).sort()).toEqual(['back_port', 'backend', 'enabled', 'proxy_protocol', 'sni', 'updated_at']);
    expect(byName.sni.pk).toBe(1);
    expect(byName.proxy_protocol.dflt_value).toBe('1');
    expect(byName.enabled.dflt_value).toBe('1');
  });

  test('passthrough host reaches the backend, which terminates TLS with its OWN cert', async () => {
    ppHeaders.length = 0;
    const r = await tlsConnect('pass.example.test');
    expect(r.ok).toBe(true);
    expect(r.cn).toBe('backend-own');
    const reply = await new Promise((resolve) => { r.socket.once('data', (d) => resolve(d.toString())); r.socket.write('ping'); });
    expect(reply).toBe('own:ping');
    const localPort = r.socket.localPort;
    r.socket.end();
    await sleep(100);

    // PROXY v2: signature, v2/PROXY, TCP over IPv4, real client addr/ports, AUTHORITY TLV = SNI.
    expect(ppHeaders).toHaveLength(1);
    const h = ppHeaders[0];
    expect(h.sig).toBe('0d0a0d0a000d0a515549540a');
    expect(h.verCmd).toBe(0x21);
    expect(h.fam).toBe(0x11);
    expect(h.src).toBe('127.0.0.1');
    expect(h.dst).toBe('127.0.0.1');
    expect(h.srcPort).toBe(localPort);
    expect(h.dstPort).toBe(HTTPS_PORT);
    expect(h.tlvs[0x02]).toBe('pass.example.test');
    expect(h.len).toBe(12 + 3 + 'pass.example.test'.length);

    const closed = logger.debug.mock.calls.find((c) => c[0] === 'tls passthrough closed' && c[1].sni === 'pass.example.test');
    expect(closed).toBeTruthy();
    expect(closed[1].bytes_in).toBeGreaterThan(0);
    expect(closed[1].bytes_out).toBeGreaterThan(0);
  });

  test('SNI matching is case-insensitive (ClientHello SNI is lowercased)', async () => {
    const r = await tlsConnect('PASS.Example.Test');
    expect(r.ok).toBe(true);
    expect(r.cn).toBe('backend-own');
    r.socket.destroy();
  });

  test('proxy_protocol=0: raw TLS bytes only, no PROXY header', async () => {
    const r = await tlsConnect('nopp.example.test');
    expect(r.ok).toBe(true);
    expect(r.cn).toBe('backend-nopp');
    const reply = await new Promise((resolve) => { r.socket.once('data', (d) => resolve(d.toString())); r.socket.write('x'); });
    expect(reply).toBe('nopp:x');
    r.socket.destroy();
  });

  test('non-matching SNI is served by jsproxy\'s normal HTTPS with its own cert, real client IP intact', async () => {
    const res = await new Promise((resolve, reject) => {
      const req = https.request({ host: '127.0.0.1', port: HTTPS_PORT, servername: 'normal.test', path: '/',
        headers: { Host: 'normal.test' }, rejectUnauthorized: false, agent: false }, (r) => {
        let body = '';
        r.on('data', (c) => { body += c; });
        r.on('end', () => resolve({ status: r.statusCode, body, cn: r.socket.getPeerCertificate().subject.CN }));
      });
      req.on('error', reject);
      req.end();
    });
    expect(res.status).toBe(200);
    expect(res.cn).toBe('normal.test');
    const body = JSON.parse(res.body);
    expect(body.xff).toMatch(/127\.0\.0\.1/);

    const unknown = await tlsConnect('unknown.example.test');
    expect(unknown.ok).toBe(true);
    expect(unknown.cn).toBe('jsproxy-default');
    unknown.socket.destroy();
  });

  test('no SNI at all → normal termination', async () => {
    const r = await tlsConnect(undefined, { servername: '' });
    expect(r.ok).toBe(true);
    expect(r.cn).toBe('jsproxy-default');
    r.socket.destroy();
  });

  test('ClientHello split across many small TCP writes is reassembled and forwarded byte-exact', async () => {
    const hello = await captureHello('raw.example.test');
    expect(hello.length).toBeGreaterThan(100);
    rawSessions.length = 0;
    const s = await rawConnect();
    s.setNoDelay(true);
    s.on('error', () => {});
    for (let i = 0; i < hello.length; i += 7) {
      s.write(hello.subarray(i, i + 7));
      await sleep(i < 60 ? 15 : 1);
    }
    await sleep(200);
    s.write('after');
    await sleep(200);
    expect(rawSessions).toHaveLength(1);
    expect(rawSessions[0].header.tlvs[2]).toBe('raw.example.test');
    expect(Buffer.compare(rawSessions[0].bytes, Buffer.concat([hello, Buffer.from('after')]))).toBe(0);
    s.destroy();
  });

  test('handshake split across two TLS records is still parsed', () => {
    return captureHello('raw.example.test').then((hello) => {
      const body = hello.subarray(5, 5 + hello.readUInt16BE(3));
      const cut = 40;
      const rec = (b) => Buffer.concat([Buffer.from([0x16, 0x03, 0x01, b.length >> 8, b.length & 0xff]), b]);
      const two = Buffer.concat([rec(body.subarray(0, cut)), rec(body.subarray(cut))]);
      expect(parseClientHello(two.subarray(0, 30)).status).toBe('more');
      expect(parseClientHello(two)).toEqual({ status: 'done', sni: 'raw.example.test' });
      expect(parseClientHello(hello)).toEqual({ status: 'done', sni: 'raw.example.test' });
      expect(parseClientHello(Buffer.from('GET / HTTP/1.1\r\n'))).toEqual({ status: 'not-tls' });
    });
  });

  test('garbage / non-TLS bytes go to the HTTPS server (closed by TLS), port keeps working', async () => {
    const s = await rawConnect();
    const closed = waitClose(s, 3000);
    s.write('GET / HTTP/1.1\r\nHost: pass.example.test\r\n\r\n');
    expect((await closed).closed).toBe(true);

    const s2 = await rawConnect();
    const closed2 = waitClose(s2, 3000);
    s2.write(Buffer.from([0x16, 0x03, 0x01, 0x00, 0x08, 0x01, 0, 0, 4, 0xde, 0xad, 0xbe, 0xef]));
    expect((await closed2).closed).toBe(true);

    const ok = await tlsConnect('unknown.example.test');
    expect(ok.ok).toBe(true);
    ok.socket.destroy();
  });

  test('slowloris: no bytes (or a partial ClientHello) → closed after the peek timeout', async () => {
    const s = await rawConnect();
    const r = await waitClose(s, 4000);
    expect(r.closed).toBe(true);
    expect(r.ms).toBeGreaterThanOrEqual(700);
    expect(r.ms).toBeLessThan(2500);

    const s2 = await rawConnect();
    const r2p = waitClose(s2, 4000);
    s2.write(Buffer.from([0x16, 0x03, 0x01, 0x02, 0x00, 0x01]));
    const r2 = await r2p;
    expect(r2.closed).toBe(true);
    expect(r2.ms).toBeLessThan(2500);
  });

  test('ClientHello larger than the 16 KB cap is closed', async () => {
    const s = await rawConnect();
    const p = waitClose(s, 3000);
    // A record header promising 18 KB, then 17 KB of filler.
    s.write(Buffer.concat([Buffer.from([0x16, 0x03, 0x01, 0x48, 0x00, 0x01, 0x00, 0x47, 0xfc]), Buffer.alloc(17 * 1024)]));
    const r = await p;
    expect(r.closed).toBe(true);
    expect(r.ms).toBeLessThan(700);   // closed on the cap, not the timeout
  });

  test('disabled row → normal termination by jsproxy', async () => {
    const r = await tlsConnect('disabled.example.test');
    expect(r.ok).toBe(true);
    expect(r.cn).toBe('jsproxy-default');
    r.socket.destroy();
  });

  test('backend connect failure closes the client socket', async () => {
    const r = await tlsConnect('dead.example.test');
    expect(r.ok).toBe(false);
    expect(r.timedOut).toBeFalsy();
    expect(logger.warn.mock.calls.some((c) => c[0] === 'tls passthrough backend connect failed; closing client')).toBe(true);
  });

  test('DB error → fail safe to normal termination', async () => {
    proxy.tlsPassthroughLookup.clear();
    const spy = jest.spyOn(proxy.db, 'getTlsPassthrough').mockRejectedValue(new Error('SQLITE_IOERR: boom'));
    const spy2 = jest.spyOn(proxy.db, 'hasEnabledTlsPassthrough').mockRejectedValue(new Error('SQLITE_IOERR: boom'));
    try {
      const r = await tlsConnect('pass.example.test');
      expect(r.ok).toBe(true);
      expect(r.cn).toBe('jsproxy-default');
      r.socket.destroy();
      expect(logger.warn.mock.calls.some((c) => c[0] === 'tls passthrough lookup failed; terminating TLS locally')).toBe(true);
    } finally {
      spy.mockRestore();
      spy2.mockRestore();
      proxy.tlsPassthroughLookup.clear();
    }
    // …and the very next lookup works again (errors are not cached).
    const r2 = await tlsConnect('pass.example.test');
    expect(r2.cn).toBe('backend-own');
    r2.socket.destroy();
  });

  test('lookups are cached (TTL) — a burst of connections hits the DB once', async () => {
    proxy.tlsPassthroughLookup.clear();
    const spy = jest.spyOn(proxy.db, 'getTlsPassthrough');
    try {
      for (let i = 0; i < 4; i++) {
        const r = await tlsConnect('nopp.example.test');
        expect(r.cn).toBe('backend-nopp');
        r.socket.destroy();
      }
      expect(spy.mock.calls.filter((c) => c[0] === 'nopp.example.test')).toHaveLength(1);
    } finally { spy.mockRestore(); }
  });

  // Pushes `size` bytes up and pulls `size` bytes down through one passthrough
  // connection; resolves with the downloaded byte count.
  async function bulkTransfer(hello, size) {
    bulkStats = { target: size, up: 0, upEnded: false, helloLen: hello.length };
    return new Promise((resolve, reject) => {
      // Half-open aware client: the download's FIN must not cut the upload.
      const s = net.connect({ port: HTTPS_PORT, host: '127.0.0.1', allowHalfOpen: true });
      let got = 0;
      s.on('error', reject);
      s.on('data', (d) => { got += d.length; });
      s.on('close', () => resolve(got));
      s.on('connect', () => {
        s.write(hello);
        const chunk = Buffer.alloc(64 * 1024, 0x62);
        let n = 0;
        Readable.from((function* () { while (n < size) { n += chunk.length; yield chunk; } })()).pipe(s);
      });
    });
  }

  test('200 MB each way through passthrough with flat RSS', async () => {
    const TARGET = 200 * 1024 * 1024;
    const hello = await captureHello('bulk.example.test');
    // Warm-up so socket/allocator pools exist before the baseline is taken.
    expect(await bulkTransfer(hello, 16 * 1024 * 1024)).toBe(16 * 1024 * 1024);
    await sleep(100);

    const rss0 = process.memoryUsage().rss;
    let peak = rss0;
    const sampler = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 50);
    const down = await bulkTransfer(hello, TARGET);
    clearInterval(sampler);
    const rss1 = process.memoryUsage().rss;
    const growthMb = (rss1 - rss0) / 1048576;
    const peakMb = (peak - rss0) / 1048576;
    // eslint-disable-next-line no-console
    console.log(`passthrough 2x200MB: rss growth ${growthMb.toFixed(1)} MB, peak +${peakMb.toFixed(1)} MB`);

    expect(down).toBe(TARGET);
    await sleep(100);
    expect(bulkStats.up).toBe(TARGET);       // half-close: upload fully delivered
    expect(bulkStats.upEnded).toBe(true);
    expect(growthMb).toBeLessThan(50);
    expect(peakMb).toBeLessThan(50);
  }, 120000);
});

describe('TLS passthrough helpers', () => {
  test('PROXY v2 header for IPv6 and IPv4-mapped peers', () => {
    const h4 = buildProxyV2Header({ srcAddr: '::ffff:10.0.0.1', srcPort: 1234, dstAddr: '::ffff:10.0.0.2', dstPort: 443, authority: 'a.b' });
    expect(h4[13]).toBe(0x11);
    expect([...h4.subarray(16, 20)]).toEqual([10, 0, 0, 1]);
    const h6 = buildProxyV2Header({ srcAddr: '2001:db8::1', srcPort: 1, dstAddr: '10.0.0.2', dstPort: 443, authority: null });
    expect(h6[13]).toBe(0x21);
    expect(h6.readUInt16BE(14)).toBe(36);
    expect(h6.subarray(16, 32).toString('hex')).toBe('20010db8000000000000000000000001');
    expect(h6.subarray(32, 48).toString('hex')).toBe('00000000000000000000ffff0a000002');
    const hu = buildProxyV2Header({ srcAddr: undefined, srcPort: 0, dstAddr: undefined, dstPort: 0, authority: 'x' });
    expect(hu[13]).toBe(0x00);
    expect(hu.readUInt16BE(14)).toBe(4);
    expect(_ipv6Bytes('::1').toString('hex')).toBe('00000000000000000000000000000001');
    expect(_ipv6Bytes('fe80::1%eth0').toString('hex')).toBe('fe800000000000000000000000000001');
  });
});
