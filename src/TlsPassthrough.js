'use strict';

// Per-SNI TLS passthrough on the HTTPS port.
//
// Every connection to the HTTPS port is first held by a small gate that peeks
// the TLS ClientHello (never decrypting anything) and reads its SNI. If an
// enabled `tls_passthrough` row matches that exact hostname, the raw bytes go
// to row.backend:row.back_port (optionally preceded by a PROXY protocol v2
// header) and TLS is terminated by whoever sits behind that backend — jsproxy
// never holds that certificate. Anything else (no match, no SNI, not TLS, DB
// error) is handed back, byte-for-byte, to the regular HTTPS server's own
// 'connection' listeners, so local termination behaves exactly as before.

const net = require('net');
const dnsCache = require('./DnsCache');

const MAX_PEEK_BYTES = 16 * 1024;

// ── ClientHello / SNI parsing ──────────────────────────────────────────────
//
// Returns one of:
//   { status: 'more' }              need more bytes
//   { status: 'not-tls' }           not a TLS handshake (hand to HTTPS as-is)
//   { status: 'done', sni }         ClientHello complete; sni is a lowercase
//                                   hostname or null (none / malformed)
// The handshake message may be split across several TLS records, and records
// across several TCP segments: handshake payloads of consecutive records are
// concatenated until the full ClientHello is present.
function parseClientHello(buf) {
  if (buf.length < 1) return { status: 'more' };
  if (buf[0] !== 0x16) return { status: 'not-tls' };       // handshake record
  if (buf.length >= 2 && buf[1] !== 0x03) return { status: 'not-tls' }; // SSL3/TLS major

  const parts = [];
  let have = 0;
  let need = -1;     // total handshake bytes required (4-byte header + body)
  let off = 0;
  while (off + 5 <= buf.length) {
    if (buf[off] !== 0x16) return { status: 'done', sni: null };
    const len = buf.readUInt16BE(off + 3);
    if (len === 0) return { status: 'done', sni: null };
    if (off + 5 + len > buf.length) {
      // Partial record: its available bytes still count toward the header.
      parts.push(buf.subarray(off + 5));
      have += buf.length - off - 5;
      break;
    }
    parts.push(buf.subarray(off + 5, off + 5 + len));
    have += len;
    off += 5 + len;
    if (need < 0 && have >= 4) {
      const hs = Buffer.concat(parts);
      if (hs[0] !== 0x01) return { status: 'done', sni: null };   // not ClientHello
      need = 4 + hs.readUIntBE(1, 3);
    }
    if (need >= 0 && have >= need) break;
  }
  if (need < 0) {
    const hs = Buffer.concat(parts);
    if (hs.length >= 1 && hs[0] !== 0x01) return { status: 'done', sni: null };
    if (hs.length >= 4) need = 4 + hs.readUIntBE(1, 3);
  }
  if (need < 0 || have < need) return { status: 'more' };
  const hs = Buffer.concat(parts).subarray(0, need);
  return { status: 'done', sni: extractSni(hs) };
}

function extractSni(hs) {
  try {
    let p = 4;                     // handshake header
    p += 2 + 32;                   // client_version + random
    p += 1 + hs[p];                // session_id
    p += 2 + hs.readUInt16BE(p);   // cipher_suites
    p += 1 + hs[p];                // compression_methods
    if (p + 2 > hs.length) return null;
    const extEnd = Math.min(hs.length, p + 2 + hs.readUInt16BE(p));
    p += 2;
    while (p + 4 <= extEnd) {
      const type = hs.readUInt16BE(p);
      const len = hs.readUInt16BE(p + 2);
      p += 4;
      if (p + len > extEnd) return null;
      if (type === 0x0000) {
        let q = p + 2;                       // server_name_list length
        const listEnd = Math.min(p + len, q + hs.readUInt16BE(p));
        while (q + 3 <= listEnd) {
          const nameType = hs[q];
          const nameLen = hs.readUInt16BE(q + 1);
          q += 3;
          if (q + nameLen > listEnd) return null;
          if (nameType === 0) return normalizeSni(hs.toString('latin1', q, q + nameLen));
          q += nameLen;
        }
        return null;
      }
      p += len;
    }
  } catch (_) { /* truncated / malformed */ }
  return null;
}

function normalizeSni(name) {
  let s = String(name || '').trim().toLowerCase();
  if (s.endsWith('.')) s = s.slice(0, -1);
  // Hostnames only: anything else (NUL, spaces, …) is treated as "no SNI".
  if (!s || s.length > 253 || !/^[a-z0-9.\-_]+$/.test(s)) return null;
  return s;
}

// ── PROXY protocol v2 ──────────────────────────────────────────────────────

const PP2_SIGNATURE = Buffer.from([0x0d, 0x0a, 0x0d, 0x0a, 0x00, 0x0d, 0x0a, 0x51, 0x55, 0x49, 0x54, 0x0a]);
const PP2_TYPE_AUTHORITY = 0x02;

function ipv4Bytes(ip) {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
  return Buffer.from(p);
}

function ipv6Bytes(ip) {
  let s = String(ip).split('%')[0];
  const out = Buffer.alloc(16);
  // Embedded dotted IPv4 tail (::ffff:1.2.3.4).
  const m = s.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  let tail = null;
  if (m) {
    tail = ipv4Bytes(m[2]);
    if (!tail) return null;
    s = m[1] + '0:0';
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : [];
  if (halves.length === 1 && head.length !== 8) return null;
  if (head.length + rest.length > 8) return null;
  const groups = [...head, ...new Array(8 - head.length - rest.length).fill('0'), ...rest];
  for (let i = 0; i < 8; i++) {
    if (!/^[0-9a-f]{1,4}$/i.test(groups[i])) return null;
    out.writeUInt16BE(parseInt(groups[i], 16), i * 2);
  }
  if (tail) tail.copy(out, 12);
  return out;
}

function unmapV4(ip) {
  const s = String(ip || '');
  return s.toLowerCase().startsWith('::ffff:') && net.isIPv4(s.slice(7)) ? s.slice(7) : s;
}

// PROXY v2 header for a TCP connection (cmd PROXY). Addresses go out as IPv4
// when both ends are IPv4 (IPv4-mapped IPv6 is unmapped first), otherwise as
// IPv6 (IPv4 sides then written as ::ffff:a.b.c.d). Unknown addresses →
// AF_UNSPEC with no address block. `authority` (the SNI) is sent as a
// PP2_TYPE_AUTHORITY TLV.
function buildProxyV2Header({ srcAddr, srcPort, dstAddr, dstPort, authority }) {
  const src = unmapV4(srcAddr);
  const dst = unmapV4(dstAddr);
  let famByte = 0x00;
  let addr = Buffer.alloc(0);
  if (net.isIPv4(src) && net.isIPv4(dst)) {
    famByte = 0x11;   // AF_INET, STREAM
    addr = Buffer.alloc(12);
    ipv4Bytes(src).copy(addr, 0);
    ipv4Bytes(dst).copy(addr, 4);
    addr.writeUInt16BE(srcPort & 0xffff, 8);
    addr.writeUInt16BE(dstPort & 0xffff, 10);
  } else if (net.isIP(src) && net.isIP(dst)) {
    const s6 = net.isIPv4(src) ? ipv6Bytes(`::ffff:${src}`) : ipv6Bytes(src);
    const d6 = net.isIPv4(dst) ? ipv6Bytes(`::ffff:${dst}`) : ipv6Bytes(dst);
    if (s6 && d6) {
      famByte = 0x21; // AF_INET6, STREAM
      addr = Buffer.alloc(36);
      s6.copy(addr, 0);
      d6.copy(addr, 16);
      addr.writeUInt16BE(srcPort & 0xffff, 32);
      addr.writeUInt16BE(dstPort & 0xffff, 34);
    }
  }
  const tlvs = [];
  if (authority) {
    const v = Buffer.from(String(authority), 'ascii');
    const t = Buffer.alloc(3);
    t[0] = PP2_TYPE_AUTHORITY;
    t.writeUInt16BE(v.length, 1);
    tlvs.push(t, v);
  }
  const body = Buffer.concat([addr, ...tlvs]);
  const hdr = Buffer.alloc(16);
  PP2_SIGNATURE.copy(hdr, 0);
  hdr[12] = 0x21;     // version 2, command PROXY
  hdr[13] = famByte;
  hdr.writeUInt16BE(body.length, 14);
  return Buffer.concat([hdr, body]);
}

// ── Lookup cache ───────────────────────────────────────────────────────────

class PassthroughLookup {
  constructor(db, { ttlMs = 5000, maxEntries = 10000 } = {}) {
    this.db = db;
    this.ttlMs = ttlMs;
    this.maxEntries = maxEntries;
    this.cache = new Map();    // sni -> { row|null, exp }
    // "Does any enabled row exist?" — when not, connections skip the peek
    // entirely. Starts unknown (true) so the first connections are peeked.
    this.anyEnabled = true;
    this.anyCheckedAt = 0;
    this._anyInflight = null;
  }

  // Refreshes the any-rows flag in the background at most once per TTL;
  // always answers from the last known value (never blocks a connection).
  maybeAny() {
    const now = Date.now();
    if (now - this.anyCheckedAt >= this.ttlMs && !this._anyInflight) {
      this.anyCheckedAt = now;
      this._anyInflight = Promise.resolve()
        .then(() => this.db.hasEnabledTlsPassthrough())
        .then((v) => { this.anyEnabled = !!v; })
        .catch(() => { this.anyEnabled = true; })   // unknown → peek; lookups fail safe
        .finally(() => { this._anyInflight = null; });
    }
    return this.anyEnabled;
  }

  // Resolves to the enabled row for `sni`, or null. Throws on DB error (the
  // caller treats that as "terminate normally"); errors are not cached.
  async get(sni) {
    const now = Date.now();
    const hit = this.cache.get(sni);
    if (hit && hit.exp > now) return hit.row;
    if (hit) this.cache.delete(sni);
    const row = (await this.db.getTlsPassthrough(sni)) || null;
    if (this.cache.size >= this.maxEntries) {
      // Drop the oldest insertions (Map preserves insertion order).
      const drop = Math.max(1, Math.floor(this.maxEntries / 10));
      let i = 0;
      for (const k of this.cache.keys()) { if (i++ >= drop) break; this.cache.delete(k); }
    }
    this.cache.set(sni, { row, exp: now + this.ttlMs });
    if (row) this.anyEnabled = true;
    return row;
  }

  clear() { this.cache.clear(); this.anyCheckedAt = 0; }
}

// ── Gate on the HTTPS server ───────────────────────────────────────────────

// Re-routes `server`'s 'connection' event through the SNI gate. The listeners
// that were registered (tls.Server's own tlsConnectionListener) are captured
// and invoked unchanged for every connection that is not passed through, on
// the very same net.Socket — so remoteAddress/remotePort (client IP for
// logging and X-Forwarded-For), connection tracking, timeouts, SNICallback,
// ALPN and upgrades all work exactly as before. Node's TLSSocket drains bytes
// already buffered on the wrapped net.Socket (initRead), so the unshifted
// ClientHello is consumed by the TLS stack as if it had just arrived.
function installGate(server, { lookup, logger, peekTimeoutMs = 5000, connectTimeoutMs = 3000, idleTimeoutMs = 0 }) {
  const original = server.listeners('connection');
  server.removeAllListeners('connection');
  const handOff = (socket) => {
    for (const l of original) l.call(server, socket);
  };

  const live = new Set();   // sockets in the gate or passed through (stop() destroys them)
  server.on('connection', (socket) => {
    let peek = true;
    try { peek = lookup.maybeAny(); } catch (_) { peek = true; }
    if (!peek) { handOff(socket); return; }
    live.add(socket);
    socket.once('close', () => live.delete(socket));
    gateConnection(socket, {
      lookup, logger, peekTimeoutMs, connectTimeoutMs, idleTimeoutMs,
      // Handed to HTTPS: from here the HTTPS server owns (and tracks) it.
      handOff: (s) => { live.delete(s); handOff(s); },
    });
  });
  return {
    original,
    destroyAll() { for (const s of live) s.destroy(); live.clear(); },
  };
}

function gateConnection(socket, opts) {
  const { lookup, logger, handOff, peekTimeoutMs } = opts;
  const chunks = [];
  let total = 0;
  let finished = false;

  const cleanup = () => {
    finished = true;
    clearTimeout(timer);
    socket.removeListener('data', onData);
    socket.removeListener('error', onError);
    socket.removeListener('end', onEnd);
    socket.removeListener('close', onClose);
  };
  const giveBack = (buffered) => {
    socket.pause();
    if (buffered.length) socket.unshift(buffered);
    try {
      handOff(socket);
    } catch (err) {
      logger.warn('tls passthrough: hand-off to HTTPS failed', { error: err.message });
      socket.destroy();
    }
  };
  const onError = () => { if (!finished) { cleanup(); socket.destroy(); } };
  const onEnd = () => { if (!finished) { cleanup(); socket.destroy(); } };
  const onClose = () => { if (!finished) cleanup(); };
  const timer = setTimeout(() => {
    if (finished) return;
    cleanup();
    logger.debug('tls passthrough: no complete ClientHello in time; closing', {
      client_ip: unmapV4(socket.remoteAddress), bytes: total, timeout_ms: peekTimeoutMs,
    });
    socket.destroy();
  }, peekTimeoutMs);

  const onData = (chunk) => {
    if (finished) return;
    chunks.push(chunk);
    total += chunk.length;
    const buf = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks);
    if (chunks.length > 1) { chunks.length = 0; chunks.push(buf); }
    const res = parseClientHello(buf);
    if (res.status === 'more') {
      if (total >= MAX_PEEK_BYTES) {
        cleanup();
        logger.debug('tls passthrough: ClientHello over peek cap; closing', {
          client_ip: unmapV4(socket.remoteAddress), bytes: total,
        });
        socket.destroy();
      }
      return;
    }
    cleanup();
    socket.pause();
    if (res.status === 'not-tls' || !res.sni) { giveBack(buf); return; }
    // The lookup may be async: keep the socket's errors handled meanwhile.
    const onLookupError = () => socket.destroy();
    socket.on('error', onLookupError);

    let decided = false;
    const decide = (row) => {
      if (decided) return;
      decided = true;
      socket.removeListener('error', onLookupError);
      if (socket.destroyed) return;
      if (row && Number(row.enabled) === 1) passThrough(socket, buf, res.sni, row, opts);
      else giveBack(buf);
    };
    let p;
    try { p = lookup.get(res.sni); } catch (err) { p = Promise.reject(err); }
    Promise.resolve(p).then(decide, (err) => {
      // Fail SAFE: a DB problem must never break the HTTPS port.
      logger.warn('tls passthrough lookup failed; terminating TLS locally', { sni: res.sni, error: err && err.message });
      decide(null);
    });
  };

  socket.on('data', onData);
  socket.on('error', onError);
  socket.on('end', onEnd);
  socket.on('close', onClose);
}

function passThrough(client, hello, sni, row, { logger, connectTimeoutMs, idleTimeoutMs }) {
  const backend = String(row.backend || '').trim();
  const port = parseInt(row.back_port, 10);
  const clientIp = unmapV4(client.remoteAddress);
  const t0 = Date.now();
  if (!backend || !Number.isInteger(port) || port <= 0 || port > 65535) {
    logger.warn('tls passthrough row invalid; closing', { sni, backend, back_port: row.back_port });
    client.destroy();
    return;
  }

  // Half-close must propagate both ways (a client FIN must not tear down a
  // response still in flight), so the client side becomes half-open aware.
  client.allowHalfOpen = true;
  const upstream = new net.Socket({ allowHalfOpen: true });
  let connected = false;

  const onEarlyClientError = () => { client.destroy(); upstream.destroy(); };
  client.on('error', onEarlyClientError);
  client.once('close', () => { if (!connected) upstream.destroy(); });

  const fail = (err) => {
    if (connected) return;
    connected = true;   // settle
    logger.warn('tls passthrough backend connect failed; closing client', {
      sni, backend: `${backend}:${port}`, client_ip: clientIp, error: err ? (err.code || err.message) : 'connect-timeout',
    });
    upstream.destroy();
    client.destroy();
  };
  upstream.setTimeout(connectTimeoutMs, () => fail(null));
  upstream.once('error', fail);

  upstream.connect({ host: backend, port, lookup: dnsCache.lookup }, () => {
    if (connected || client.destroyed) { upstream.destroy(); return; }
    connected = true;
    upstream.setTimeout(0);
    upstream.removeListener('error', fail);
    client.removeListener('error', onEarlyClientError);

    if (Number(row.proxy_protocol) !== 0) {
      upstream.write(buildProxyV2Header({
        srcAddr: client.remoteAddress, srcPort: client.remotePort,
        dstAddr: client.localAddress, dstPort: client.localPort,
        authority: sni,
      }));
    }
    upstream.write(hello);

    if (idleTimeoutMs > 0) {
      client.setTimeout(idleTimeoutMs, () => client.destroy());
      upstream.setTimeout(idleTimeoutMs, () => upstream.destroy());
    }

    let closed = 0;
    const teardown = () => { client.destroy(); upstream.destroy(); };
    // A side that closed CLEANLY (its read side ended → the peer was end()ed,
    // and everything destined to it was flushed) leaves the peer to finish
    // flushing and close on its own. Any other close (error, idle destroy,
    // reset, peer still owed bytes) destroys the peer so nothing lingers.
    const onClosed = (self, peer) => () => {
      if (!(peer.writableEnded && self.writableFinished)) peer.destroy();
      if (++closed < 2) return;
      logger.debug('tls passthrough closed', {
        sni,
        backend: `${backend}:${port}`,
        client_ip: clientIp,
        bytes_in: client.bytesRead,
        bytes_out: client.bytesWritten,
        duration_ms: Date.now() - t0,
      });
    };
    client.on('error', teardown);
    upstream.on('error', teardown);
    client.on('close', onClosed(client, upstream));
    upstream.on('close', onClosed(upstream, client));
    // pipe(): backpressure both ways, end() on the peer when a side ends
    // (half-close). Bytes are never accumulated beyond stream highWaterMarks.
    client.pipe(upstream);
    upstream.pipe(client);
    client.resume();
  });
}

module.exports = {
  MAX_PEEK_BYTES,
  parseClientHello,
  extractSni,
  buildProxyV2Header,
  PassthroughLookup,
  installGate,
  _ipv6Bytes: ipv6Bytes,
};
