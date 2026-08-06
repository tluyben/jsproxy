const dgram = require('dgram');
const net = require('net');
const {
  getProbe, buildDnsQuery, isDnsResponse, probeDnsUdp, probeDnsTcp,
} = require('../src/ProtocolProbes');

// Minimal fake DNS server: echoes any query back with the QR (response) bit
// set, over both transports (TCP framed with the 2-byte length prefix).
function makeFakeDnsUdp(port) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    sock.on('message', (msg, rinfo) => {
      const reply = Buffer.from(msg);
      if (reply.length >= 3) reply[2] |= 0x80;
      sock.send(reply, rinfo.port, rinfo.address);
    });
    sock.bind(port, '127.0.0.1', () => resolve(sock));
  });
}

function makeFakeDnsTcp(port) {
  return new Promise((resolve) => {
    const server = net.createServer((conn) => {
      let buf = Buffer.alloc(0);
      conn.on('data', (d) => {
        buf = Buffer.concat([buf, d]);
        if (buf.length < 2) return;
        const len = buf.readUInt16BE(0);
        if (buf.length < 2 + len) return;
        const reply = Buffer.from(buf.slice(2, 2 + len));
        if (reply.length >= 3) reply[2] |= 0x80;
        const framed = Buffer.alloc(2 + reply.length);
        framed.writeUInt16BE(reply.length, 0);
        reply.copy(framed, 2);
        conn.write(framed);
      });
      conn.on('error', () => {});
    });
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

describe('ProtocolProbes', () => {
  test('registry: dns is a probe scheme, plain/http schemes are not', () => {
    expect(getProbe('dns')).toBeTruthy();
    expect(getProbe('DNS')).toBeTruthy();
    expect(getProbe('dns').defaultPort).toBe(53);
    expect(typeof getProbe('dns').udp).toBe('function');
    expect(typeof getProbe('dns').tcp).toBe('function');
    expect(getProbe('http')).toBeNull();
    expect(getProbe('https')).toBeNull();
    expect(getProbe('tcp')).toBeNull();
    expect(getProbe('udp')).toBeNull();
    expect(getProbe(null)).toBeNull();
  });

  test('buildDnsQuery produces a well-formed query that isDnsResponse rejects until QR is set', () => {
    const q = buildDnsQuery('example.com', 0x1234);
    expect(q.readUInt16BE(0)).toBe(0x1234);
    expect(q.readUInt16BE(4)).toBe(1);          // QDCOUNT
    expect(q[12]).toBe(7);                      // len('example')
    expect(q.slice(13, 20).toString()).toBe('example');
    expect(isDnsResponse(q, 0x1234)).toBe(false); // query, not response
    const r = Buffer.from(q);
    r[2] |= 0x80;
    expect(isDnsResponse(r, 0x1234)).toBe(true);
    expect(isDnsResponse(r, 0x9999)).toBe(false); // wrong transaction id
  });

  test('probeDnsUdp: alive server → true, closed port → false', async () => {
    const server = await makeFakeDnsUdp(9800);
    try {
      await expect(probeDnsUdp({ hostname: '127.0.0.1', port: 9800, name: 'example.com', timeoutMs: 2000 }))
        .resolves.toBe(true);
      await expect(probeDnsUdp({ hostname: '127.0.0.1', port: 9801, name: 'example.com', timeoutMs: 800 }))
        .resolves.toBe(false);
    } finally {
      server.close();
    }
  }, 10000);

  test('probeDnsTcp: alive server → true, closed port → false', async () => {
    const server = await makeFakeDnsTcp(9810);
    try {
      await expect(probeDnsTcp({ hostname: '127.0.0.1', port: 9810, name: 'example.com', timeoutMs: 2000 }))
        .resolves.toBe(true);
      await expect(probeDnsTcp({ hostname: '127.0.0.1', port: 9811, name: 'example.com', timeoutMs: 800 }))
        .resolves.toBe(false);
    } finally {
      await new Promise((r) => server.close(r));
    }
  }, 10000);

  test('probeDnsUdp: a TCP-only listener on the port does not count as alive', async () => {
    const server = await makeFakeDnsTcp(9820);
    try {
      await expect(probeDnsUdp({ hostname: '127.0.0.1', port: 9820, name: 'example.com', timeoutMs: 800 }))
        .resolves.toBe(false);
    } finally {
      await new Promise((r) => server.close(r));
    }
  }, 10000);
});
