const dgram = require('dgram');
const net = require('net');
const crypto = require('crypto');

// ── Protocol-aware health probes ("hardcoded plugins") ──────────────────────
//
// Raw TCP/UDP routes can mark their backends with a probe scheme, e.g.
//
//   backend = 'dns://10.0.0.2:5353,dns://10.0.0.3:5353'
//
// The scheme selects one of the probes below, which performs a REAL protocol
// exchange against the backend to decide liveness — not just a TCP handshake.
// Each probe exists in two transports so the same backend pair can serve a TCP
// route and a UDP route simultaneously (e.g. DNS on 53/tcp + 53/udp):
//
//   - a UDP route probes over UDP (mandatory for UDP failover: datagrams have
//     no handshake, so without a protocol probe a dead backend is undetectable)
//   - a TCP route probes over TCP (its connect-phase failover still works via
//     plain handshake/timeout; the probe adds "is the service actually
//     answering" on top)
//
// A probe function receives { hostname, port, name, timeoutMs } and resolves
// to true (alive) / false (dead). It must never throw or leave sockets open.

// Minimal DNS query packet: header (random-id, RD=1, 1 question) + QNAME +
// QTYPE=A, QCLASS=IN.
function buildDnsQuery(name, id) {
  const header = Buffer.from([id >> 8, id & 0xff, 0x01, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00]);
  const parts = [header];
  for (const label of String(name).split('.').filter(Boolean)) {
    const l = Buffer.from(label, 'ascii');
    parts.push(Buffer.from([l.length]), l);
  }
  parts.push(Buffer.from([0x00, 0x00, 0x01, 0x00, 0x01]));
  return Buffer.concat(parts);
}

// A response counts as "alive" when it echoes our transaction id and has the
// QR (response) bit set. We deliberately don't require RCODE=0 — NXDOMAIN etc.
// still proves the server is up and answering DNS.
function isDnsResponse(buf, id) {
  return Buffer.isBuffer(buf) && buf.length >= 12 &&
         buf.readUInt16BE(0) === id && (buf[2] & 0x80) !== 0;
}

function probeDnsUdp({ hostname, port, name, timeoutMs }) {
  return new Promise((resolve) => {
    const id = crypto.randomBytes(2).readUInt16BE(0);
    const sock = dgram.createSocket(hostname.includes(':') ? 'udp6' : 'udp4');
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { sock.close(); } catch (_) {}
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    if (timer.unref) timer.unref();
    sock.on('error', () => done(false));
    sock.on('message', (msg) => done(isDnsResponse(msg, id)));
    sock.send(buildDnsQuery(name, id), port, hostname, (err) => { if (err) done(false); });
  });
}

// DNS over TCP frames the same packet with a 2-byte length prefix.
function probeDnsTcp({ hostname, port, name, timeoutMs }) {
  return new Promise((resolve) => {
    const id = crypto.randomBytes(2).readUInt16BE(0);
    const sock = new net.Socket();
    let buf = Buffer.alloc(0);
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs, () => done(false));
    sock.on('error', () => done(false));
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length < 2) return;
      const len = buf.readUInt16BE(0);
      if (buf.length >= 2 + len) done(isDnsResponse(buf.slice(2, 2 + len), id));
    });
    sock.connect(port, hostname, () => {
      const q = buildDnsQuery(name, id);
      const framed = Buffer.alloc(2 + q.length);
      framed.writeUInt16BE(q.length, 0);
      q.copy(framed, 2);
      sock.write(framed);
    });
  });
}

// Registry: scheme -> { udp, tcp, defaultPort }. Adding a new protocol probe
// (e.g. ntp://, syslog://) means adding one entry here — nothing else changes.
const PROBES = {
  dns: { udp: probeDnsUdp, tcp: probeDnsTcp, defaultPort: 53 },
};

// Returns the probe definition for a backend URL scheme, or null when the
// scheme carries no protocol probe (http/https/tcp/udp/bare hosts).
function getProbe(scheme) {
  return (scheme && PROBES[String(scheme).toLowerCase()]) || null;
}

module.exports = { getProbe, buildDnsQuery, isDnsResponse, probeDnsUdp, probeDnsTcp };
