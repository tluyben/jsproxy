#!/usr/bin/env node

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'current.db');

function printUsage() {
  console.log(`
Usage: node scripts/add-tls-passthrough.js <sni> <backend> <port> [--no-proxy-protocol] [--disabled]
       node scripts/add-tls-passthrough.js --list

Per-SNI TLS passthrough on the HTTPS port. A connection whose TLS ClientHello
carries SNI <sni> is NOT terminated by jsproxy: its raw bytes go to
<backend>:<port>, which (or whatever sits behind it) holds the certificate.
Every other connection on the HTTPS port is served exactly as before.

By default the backend first receives a PROXY protocol v2 header (real client
address/port, plus TLV PP2_TYPE_AUTHORITY = the SNI); --no-proxy-protocol sends
the raw TLS bytes only.

Arguments:
  sni           Exact hostname (lowercased; no wildcards), e.g. app.example.com
  backend       Backend host or IP
  port          Backend port

Options:
  --no-proxy-protocol   Do not send a PROXY v2 header
  --disabled            Store the row disabled (connections terminate normally)
  --list                List all rows
  --help                Show this help

Upserts by sni. No restart needed: workers pick changes up within the lookup
cache TTL (TLS_PASSTHROUGH_CACHE_TTL_MS, default 5 s).
Remove with: node scripts/remove-tls-passthrough.js <sni>
`);
}

function connectDB() {
  return new sqlite3.Database(dbPath, (err) => {
    if (err) { console.error('Error opening database:', err.message); process.exit(1); }
  });
}

// Same DDL as DatabaseManager.createTlsPassthroughTable (proxy may not have run yet).
function ensureTable(db, cb) {
  db.configure('busyTimeout', 10000);
  db.run(`CREATE TABLE IF NOT EXISTS tls_passthrough (
    sni TEXT PRIMARY KEY,
    backend TEXT NOT NULL,
    back_port INTEGER NOT NULL,
    proxy_protocol INTEGER NOT NULL DEFAULT 1,
    enabled INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT
  )`, (err) => {
    if (err) { console.error('Error creating tls_passthrough table:', err.message); db.close(); process.exit(1); }
    cb();
  });
}

function listRows() {
  const db = connectDB();
  ensureTable(db, () => {
    db.all('SELECT * FROM tls_passthrough ORDER BY sni', (err, rows) => {
      if (err) { console.error('Error listing:', err.message); db.close(); process.exit(1); }
      console.log('\nTLS passthrough:\n');
      console.log('SNI'.padEnd(40), 'Backend'.padEnd(28), 'PROXYv2'.padEnd(8), 'Enabled'.padEnd(8), 'Updated');
      console.log('-'.repeat(110));
      if (!rows || rows.length === 0) console.log('No TLS passthrough rows.');
      else rows.forEach((r) => console.log(
        String(r.sni).padEnd(40),
        `${r.backend}:${r.back_port}`.padEnd(28),
        (r.proxy_protocol ? 'yes' : 'no').padEnd(8),
        (r.enabled ? 'yes' : 'no').padEnd(8),
        r.updated_at || ''));
      db.close();
    });
  });
}

function addRow(sni, backend, port, proxyProtocol, enabled) {
  const db = connectDB();
  ensureTable(db, () => {
    db.run(`INSERT INTO tls_passthrough (sni, backend, back_port, proxy_protocol, enabled, updated_at)
            VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
            ON CONFLICT(sni) DO UPDATE SET backend = excluded.backend, back_port = excluded.back_port,
              proxy_protocol = excluded.proxy_protocol, enabled = excluded.enabled, updated_at = excluded.updated_at`,
    [sni, backend, port, proxyProtocol ? 1 : 0, enabled ? 1 : 0], (err) => {
      if (err) { console.error('Error saving TLS passthrough:', err.message); db.close(); process.exit(1); }
      console.log(`✓ TLS passthrough: ${sni} -> ${backend}:${port}  (PROXY v2 ${proxyProtocol ? 'on' : 'off'}${enabled ? '' : ', DISABLED'})`);
      console.log('\nActive within the lookup cache TTL (default 5 s); no restart needed.');
      db.close();
    });
  });
}

const rawArgs = process.argv.slice(2);
const flags = new Set(rawArgs.filter((a) => a.startsWith('--')));
const args = rawArgs.filter((a) => !a.startsWith('--'));

if (rawArgs.length === 0 || flags.has('--help')) { printUsage(); process.exit(0); }
if (flags.has('--list')) { listRows(); return; }

const unknown = [...flags].filter((f) => !['--no-proxy-protocol', '--disabled'].includes(f));
if (unknown.length) { console.error(`Error: unknown option(s) ${unknown.join(', ')}`); process.exit(1); }

let sni = String(args[0] || '').trim().toLowerCase();
if (sni.endsWith('.')) sni = sni.slice(0, -1);
const backend = String(args[1] || '').trim();
const port = parseInt(args[2], 10);
if (!sni || !/^[a-z0-9.\-_]+$/.test(sni) || sni.includes('*')) {
  console.error('Error: <sni> must be an exact hostname (no wildcards)'); printUsage(); process.exit(1);
}
if (!backend || /[\s/]/.test(backend)) {
  console.error('Error: <backend> must be a host or IP (no scheme)'); process.exit(1);
}
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error('Error: <port> must be 1-65535'); process.exit(1);
}
addRow(sni, backend, port, !flags.has('--no-proxy-protocol'), !flags.has('--disabled'));
