#!/usr/bin/env node

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'current.db');

function printUsage() {
  console.log(`
Usage: node scripts/add-udp-route.js <listen_port> <backend> [back_port] [allowed_ips] [--name=<dns-name>] [--bind=<ip>]

Raw UDP proxying. jsproxy listens on <listen_port> and forwards datagrams per
client flow to a backend. For HA, give a comma-separated backend list using a
probe-capable scheme — e.g. dns://10.0.0.2:5353,dns://10.0.0.3:5353 — so each
backend is health-checked with a REAL protocol exchange (a DNS query over UDP).
UDP has no handshake, so probe schemes are what makes failover reliable; without
them only best-effort ICMP detection applies. Fully opt-in, no effect on HTTP(S).

Arguments:
  listen_port   Port jsproxy listens on (UDP; may equal a TCP route's port)
  backend       Upstream host, or comma list of scheme'd URLs (dns:// udp://)
  back_port     Upstream port (or comma list for HA on a single host);
                optional when every backend URL carries its own port
  allowed_ips   Optional comma-separated IPs/CIDRs (default: allow all)

Options:
  --name=<dns-name>  Domain the dns:// health probe queries (default example.com)
  --bind=<ip>        Bind only this local IP (default: HTTP_HOST / all
                     interfaces). Lets the route share a port with another
                     service owning the same port on a different IP (e.g. a
                     local resolver on 127.0.0.53:53 next to a route on the
                     box's public IP).
  --delete           Remove the UDP route for <listen_port>
  --list             List all UDP routes
  --help             Show this help

Examples:
  # Forward UDP :5353 -> localhost:5353
  node scripts/add-udp-route.js 5353 localhost 5353

  # HA DNS across two resolvers, probed with real DNS queries over UDP
  node scripts/add-udp-route.js 53 dns://10.0.0.2:5353,dns://10.0.0.3:5353

  # Same backends but probe with a specific query name, restricted to a CIDR
  node scripts/add-udp-route.js 53 dns://10.0.0.2,dns://10.0.0.3 53 10.0.0.0/8 --name=health.internal

  # Bind only the public IP; the local resolver keeps 127.0.0.53:53
  node scripts/add-udp-route.js 53 dns://10.0.0.2:5353,dns://10.0.0.3:5353 '' '' --bind=203.0.113.10

  # Delete / list
  node scripts/add-udp-route.js 53 --delete
  node scripts/add-udp-route.js --list

Note: UDP routes are read once at proxy startup. Restart jsproxy after changing them.
`);
}

function connectDB() {
  return new sqlite3.Database(dbPath, (err) => {
    if (err) {
      console.error('Error opening database:', err.message);
      process.exit(1);
    }
  });
}

// Ensure the protocol/listen_port columns exist even if the proxy hasn't
// migrated this DB yet (same columns the TCP routes use).
function ensureColumns(db, cb) {
  db.all('PRAGMA table_info(mappings)', (err, columns) => {
    if (err) { console.error('Error reading schema:', err.message); db.close(); process.exit(1); }
    const names = new Set((columns || []).map(c => c.name));
    const toAdd = [];
    if (!names.has('protocol')) toAdd.push("ALTER TABLE mappings ADD COLUMN protocol TEXT DEFAULT 'http'");
    if (!names.has('listen_port')) toAdd.push('ALTER TABLE mappings ADD COLUMN listen_port INTEGER DEFAULT NULL');
    if (!names.has('listen_host')) toAdd.push('ALTER TABLE mappings ADD COLUMN listen_host TEXT DEFAULT NULL');
    let i = 0;
    const next = () => {
      if (i >= toAdd.length) return cb();
      db.run(toAdd[i++], (e) => { if (e) { console.error('Error migrating schema:', e.message); db.close(); process.exit(1); } next(); });
    };
    next();
  });
}

function listRoutes() {
  const db = connectDB();
  ensureColumns(db, () => {
    db.all("SELECT listen_port, listen_host, backend, back_port, allowed_ips, domain, created_at FROM mappings WHERE protocol = 'udp' ORDER BY listen_port", (err, rows) => {
      if (err) { console.error('Error listing UDP routes:', err.message); db.close(); process.exit(1); }
      console.log('\nUDP routes:\n');
      console.log('Listen'.padEnd(10), 'Bind'.padEnd(16), 'Backend'.padEnd(44), 'BackPort'.padEnd(12), 'ProbeName'.padEnd(20), 'AllowedIPs');
      console.log('-'.repeat(126));
      if (!rows || rows.length === 0) {
        console.log('No UDP routes found.');
      } else {
        rows.forEach(r => console.log(
          String(r.listen_port).padEnd(10),
          (r.listen_host || '(all)').padEnd(16),
          (r.backend || 'localhost').padEnd(44),
          String(r.back_port || '').padEnd(12),
          (r.domain || '(default)').padEnd(20),
          r.allowed_ips || '(all)'
        ));
      }
      db.close();
    });
  });
}

function deleteRoute(listenPort) {
  const db = connectDB();
  ensureColumns(db, () => {
    db.run("DELETE FROM mappings WHERE protocol = 'udp' AND listen_port = ?", [listenPort], function (err) {
      if (err) { console.error('Error deleting UDP route:', err.message); db.close(); process.exit(1); }
      if (this.changes > 0) console.log(`✓ Deleted UDP route on port ${listenPort}`);
      else console.log(`No UDP route found on port ${listenPort}`);
      console.log('\nRestart jsproxy for the change to take effect.');
      db.close();
    });
  });
}

function addRoute(listenPort, backend, backPort, allowedIps, probeName, bindHost) {
  const db = connectDB();
  ensureColumns(db, () => {
    db.get("SELECT id FROM mappings WHERE protocol = 'udp' AND listen_port = ?", [listenPort], (err, row) => {
      if (err) { console.error('Error checking route:', err.message); db.close(); process.exit(1); }
      const done = (verb) => {
        console.log(`✓ ${verb} UDP route: ${bindHost || '*'}:${listenPort} -> ${backend}${backPort ? `:${backPort}` : ''}${allowedIps ? `  (allow ${allowedIps})` : ''}${probeName ? `  (probe ${probeName})` : ''}`);
        console.log('\nRestart jsproxy for the change to take effect.');
        db.close();
      };
      if (row) {
        db.run(
          "UPDATE mappings SET backend = ?, back_port = ?, allowed_ips = ?, domain = ?, listen_host = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
          [backend, String(backPort || ''), allowedIps || null, probeName || '', bindHost || null, row.id],
          (e) => { if (e) { console.error('Error updating UDP route:', e.message); db.close(); process.exit(1); } done('Updated'); }
        );
      } else {
        const id = require('crypto').randomUUID();
        db.run(
          `INSERT INTO mappings (id, domain, front_uri, back_port, back_uri, backend, allowed_ips, protocol, listen_port, listen_host, created_at, updated_at)
           VALUES (?, ?, '', ?, '', ?, ?, 'udp', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
          [id, probeName || '', String(backPort || ''), backend, allowedIps || null, listenPort, bindHost || null],
          (e) => { if (e) { console.error('Error adding UDP route:', e.message); db.close(); process.exit(1); } done('Added'); }
        );
      }
    });
  });
}

// Parse arguments
const rawArgs = process.argv.slice(2);
const nameArg = rawArgs.find(a => a.startsWith('--name='));
const probeName = nameArg ? nameArg.slice('--name='.length) : '';
const bindArg = rawArgs.find(a => a.startsWith('--bind='));
const bindHost = bindArg ? bindArg.slice('--bind='.length) : '';
const args = rawArgs.filter(a => !a.startsWith('--name=') && !a.startsWith('--bind='));

if (args.length === 0 || args.includes('--help')) {
  printUsage();
  process.exit(0);
}

if (args.includes('--list')) {
  listRoutes();
} else if (args.includes('--delete')) {
  const listenPort = parseInt(args[0], 10);
  if (!Number.isInteger(listenPort)) { console.error('Error: a valid listen_port is required'); process.exit(1); }
  deleteRoute(listenPort);
} else {
  const listenPort = parseInt(args[0], 10);
  const backend = args[1];
  const backPort = args[2] || '';
  const allowedIps = args[3] || null;
  const hasPerUrlPorts = backend && /:\/\//.test(backend);
  if (!Number.isInteger(listenPort) || !backend || (!backPort && !hasPerUrlPorts)) {
    console.error('Error: listen_port and backend are required (and back_port, unless backend URLs carry ports or a probe-scheme default applies)');
    printUsage();
    process.exit(1);
  }
  addRoute(listenPort, backend, backPort, allowedIps, probeName, bindHost);
}
