#!/usr/bin/env node

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'current.db');

function printUsage() {
  console.log(`
Usage: node scripts/add-tcp-route.js <listen_port> <backend> <back_port[,back_port...]> [allowed_ips] [--bind=<ip>]

Raw TCP proxying (passthrough). jsproxy listens on <listen_port> and forwards raw
bytes to <backend>:<back_port>. Provide a comma-separated back_port list for HA
(score-based failover, same engine as HTTP HA). TLS is forwarded untouched —
the backend terminates it. This is fully opt-in and does not affect HTTP/HTTPS.

Arguments:
  listen_port   Port jsproxy listens on (must differ from HTTP_PORT/HTTPS_PORT)
  backend       Upstream host (e.g. localhost, db.internal); scheme optional
  back_port     Upstream port, or comma-separated list for HA (e.g. 5432,5433)
  allowed_ips   Optional comma-separated IPs/CIDRs (default: allow all)

Options:
  --bind=<ip>   Bind only this local IP (default: HTTP_HOST / all interfaces).
                Lets the route share a port with another service that owns the
                same port on a different IP (e.g. a local resolver on :53).
  --delete      Remove the TCP route for <listen_port>
  --list        List all TCP routes
  --help        Show this help

Examples:
  # Forward TCP :5432 -> localhost:5432 (e.g. Postgres)
  node scripts/add-tcp-route.js 5432 localhost 5432

  # HA across two backend ports
  node scripts/add-tcp-route.js 5432 db.internal 5432,5433

  # Restrict to a CIDR
  node scripts/add-tcp-route.js 6379 localhost 6379 10.0.0.0/8

  # Bind only the public IP (leave 127.0.0.53:53 to the local resolver)
  node scripts/add-tcp-route.js 53 dns://10.0.0.2:5353,dns://10.0.0.3:5353 '' '' --bind=203.0.113.10

  # Delete / list
  node scripts/add-tcp-route.js 5432 --delete
  node scripts/add-tcp-route.js --list

Note: TCP routes are read once at proxy startup. Restart jsproxy after changing them.
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

// Ensure the TCP columns exist even if the proxy hasn't migrated this DB yet.
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
    db.all("SELECT listen_port, listen_host, backend, back_port, allowed_ips, created_at FROM mappings WHERE protocol = 'tcp' ORDER BY listen_port", (err, rows) => {
      if (err) { console.error('Error listing TCP routes:', err.message); db.close(); process.exit(1); }
      console.log('\nTCP routes:\n');
      console.log('Listen'.padEnd(10), 'Bind'.padEnd(16), 'Backend'.padEnd(24), 'BackPort'.padEnd(20), 'AllowedIPs');
      console.log('-'.repeat(96));
      if (!rows || rows.length === 0) {
        console.log('No TCP routes found.');
      } else {
        rows.forEach(r => console.log(
          String(r.listen_port).padEnd(10),
          (r.listen_host || '(all)').padEnd(16),
          (r.backend || 'localhost').padEnd(24),
          String(r.back_port).padEnd(20),
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
    db.run("DELETE FROM mappings WHERE protocol = 'tcp' AND listen_port = ?", [listenPort], function (err) {
      if (err) { console.error('Error deleting TCP route:', err.message); db.close(); process.exit(1); }
      if (this.changes > 0) console.log(`✓ Deleted TCP route on port ${listenPort}`);
      else console.log(`No TCP route found on port ${listenPort}`);
      console.log('\nRestart jsproxy for the change to take effect.');
      db.close();
    });
  });
}

function addRoute(listenPort, backend, backPort, allowedIps, bindHost) {
  const db = connectDB();
  ensureColumns(db, () => {
    db.get("SELECT id FROM mappings WHERE protocol = 'tcp' AND listen_port = ?", [listenPort], (err, row) => {
      if (err) { console.error('Error checking route:', err.message); db.close(); process.exit(1); }
      const done = (verb) => {
        console.log(`✓ ${verb} TCP route: ${bindHost || '*'}:${listenPort} -> ${backend}${backPort ? `:${backPort}` : ''}${allowedIps ? `  (allow ${allowedIps})` : ''}`);
        console.log('\nRestart jsproxy for the change to take effect.');
        db.close();
      };
      if (row) {
        db.run(
          "UPDATE mappings SET backend = ?, back_port = ?, allowed_ips = ?, listen_host = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
          [backend, String(backPort || ''), allowedIps || null, bindHost || null, row.id],
          (e) => { if (e) { console.error('Error updating TCP route:', e.message); db.close(); process.exit(1); } done('Updated'); }
        );
      } else {
        const id = require('crypto').randomUUID();
        db.run(
          `INSERT INTO mappings (id, domain, front_uri, back_port, back_uri, backend, allowed_ips, protocol, listen_port, listen_host, created_at, updated_at)
           VALUES (?, '', '', ?, '', ?, ?, 'tcp', ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
          [id, String(backPort || ''), backend, allowedIps || null, listenPort, bindHost || null],
          (e) => { if (e) { console.error('Error adding TCP route:', e.message); db.close(); process.exit(1); } done('Added'); }
        );
      }
    });
  });
}

// Parse arguments
const rawArgs = process.argv.slice(2);
const bindArg = rawArgs.find(a => a.startsWith('--bind='));
const bindHost = bindArg ? bindArg.slice('--bind='.length) : '';
const args = rawArgs.filter(a => !a.startsWith('--bind='));

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
  // back_port may be omitted when the backend URLs carry their own ports
  // (tcp://host:port,…) or a probe scheme supplies a default (dns:// → 53).
  const hasPerUrlPorts = backend && /:\/\//.test(backend);
  if (!Number.isInteger(listenPort) || !backend || (!backPort && !hasPerUrlPorts)) {
    console.error('Error: listen_port, backend, and back_port are required (back_port may be omitted only when backend URLs carry ports)');
    printUsage();
    process.exit(1);
  }
  addRoute(listenPort, backend, backPort, allowedIps, bindHost);
}
