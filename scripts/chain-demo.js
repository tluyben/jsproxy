// Spin up an echo backend behind a chain of jsproxy hops, all on this host:
//
//   you --> edge(9001) --> hop(9002) --> hop(9003) --> echo-backend(9000)
//
// Hit the edge port from anywhere and the backend prints the X-Forwarded-For
// chain it received; the leftmost entry is your real IP (the edge records it
// from the raw socket, every hop appends its own peer).
//
//   node scripts/chain-demo.js [numHops]
//
const http = require('http');
const path = require('path');
const os   = require('os');
const fs   = require('fs');
const ProxyServer = require('../src/ProxyServer');

const NUM_HOPS     = parseInt(process.argv[2] || '3', 10);
const BACKEND_PORT = 9000;
const EDGE_PORT    = 9001;                    // you hit this
const PORTS        = Array.from({ length: NUM_HOPS }, (_, i) => EDGE_PORT + i);
const NEXT         = PORTS.map((_, i) => (i + 1 < PORTS.length ? PORTS[i + 1] : BACKEND_PORT));

// Near-silent logger so the backend's request dumps stand out.
const logger = {
  info: () => {}, warn: () => {}, debug: () => {},
  error: (...a) => console.error('[proxy-error]', ...a),
  child() { return this; },
};

function startBackend() {
  return new Promise((resolve) => {
    // A backend (e.g. nextjs) sees the whole XFF chain. The RIGHTMOST address
    // that isn't one of the trusted proxy hops is the real client the edge
    // recorded — NOT necessarily the leftmost, which a client can forge by
    // sending its own X-Forwarded-For (the edge appends to it, never strips it).
    const strip = (ip) => (ip || '').replace(/^::ffff:/, '');
    const isProxyHop = (ip) => /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|::1|f[cd])/i.test(strip(ip));
    const server = http.createServer((req, res) => {
      const xff   = req.headers['x-forwarded-for'] || '';
      const chain = xff.split(',').map(s => s.trim()).filter(Boolean);
      const all   = [...chain, strip(req.socket.remoteAddress)];
      let resolved = all[0];
      for (let i = all.length - 1; i >= 0; i--) { if (!isProxyHop(all[i])) { resolved = all[i]; break; } }
      const info = {
        your_ip_RESOLVED:       resolved,                          // trust-aware, anti-spoof — use this
        your_ip_naive_leftmost: chain[0] || strip(req.socket.remoteAddress), // spoofable — do NOT use
        x_forwarded_for:        xff || '(none)',
        hops_recorded:          chain.length,
        x_forwarded_proto:      req.headers['x-forwarded-proto'],
        x_forwarded_host:       req.headers['x-forwarded-host'],
        socket_peer_at_backend: req.socket.remoteAddress,
      };
      console.log(`\n=== [backend] ${req.method} ${req.url} ===`);
      console.log(JSON.stringify(info, null, 2));
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(info, null, 2) + '\n');
    });
    server.listen(BACKEND_PORT, '127.0.0.1', () => resolve(server));
  });
}

async function startHop(port, nextPort, trusted) {
  // Env is read at construction (TRUSTED_PROXIES) and at start() (HTTP_PORT), so
  // set it immediately before booting this hop; instances start sequentially.
  process.env.HTTP_PORT       = String(port);
  process.env.HTTP_HOST       = '0.0.0.0';
  process.env.ENABLE_HTTPS    = 'false';
  process.env.TRUSTED_PROXIES = trusted;

  const proxy = new ProxyServer(logger);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `chain-hop-${port}-`));
  proxy.db.dbPath = path.join(dir, 'db.sqlite');
  proxy.certManager.certsDir = path.join(dir, 'certs');

  await proxy.initialize();
  await proxy.start();
  // Global '*' catch-all → forwards ANY host to localhost:nextPort.
  await proxy.db.addMapping('*', '', String(nextPort), '');
  return proxy;
}

(async () => {
  await startBackend();
  for (let i = 0; i < PORTS.length; i++) {
    // Edge (first hop) is internet-facing → trust nothing (real client = socket).
    // Internal hops sit behind the previous jsproxy on loopback → trust loopback.
    const trusted = i === 0 ? '' : 'loopback';
    await startHop(PORTS[i], NEXT[i], trusted);
  }

  const ips = Object.values(os.networkInterfaces())
    .flat()
    .filter(n => n && n.family === 'IPv4' && !n.internal)
    .map(n => n.address);

  console.log('\njsproxy chain is UP:');
  console.log(`  you -> edge(${EDGE_PORT}) -> ${PORTS.slice(1).map(p => `hop(${p})`).join(' -> ')}${PORTS.length > 1 ? ' -> ' : ' -> '}echo-backend(${BACKEND_PORT})`);
  console.log(`\nHit the EDGE port ${EDGE_PORT} from your machine:`);
  console.log(`  curl http://localhost:${EDGE_PORT}/            # if you're on this host`);
  for (const ip of ips) console.log(`  curl http://${ip}:${EDGE_PORT}/   # from another machine (if reachable)`);
  console.log('\nWaiting for requests... (Ctrl-C to stop)\n');
})().catch(err => { console.error('chain-demo failed:', err); process.exit(1); });
