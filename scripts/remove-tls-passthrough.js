#!/usr/bin/env node

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'current.db');

const arg = process.argv[2];
if (!arg || arg === '--help') {
  console.log(`
Usage: node scripts/remove-tls-passthrough.js <sni>

Deletes the TLS passthrough row for <sni>; connections for that host are
terminated by jsproxy again within the lookup cache TTL (default 5 s).
To keep the row but stop passing through, re-add it with --disabled.
`);
  process.exit(arg ? 0 : 1);
}

let sni = String(arg).trim().toLowerCase();
if (sni.endsWith('.')) sni = sni.slice(0, -1);

const db = new sqlite3.Database(dbPath, (err) => {
  if (err) { console.error('Error opening database:', err.message); process.exit(1); }
});
db.configure('busyTimeout', 10000);
db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'tls_passthrough'", (err, row) => {
  if (err) { console.error('Error reading schema:', err.message); db.close(); process.exit(1); }
  if (!row) { console.log(`No TLS passthrough row for ${sni}`); db.close(); return; }
  db.run('DELETE FROM tls_passthrough WHERE sni = ?', [sni], function (e) {
    if (e) { console.error('Error deleting TLS passthrough:', e.message); db.close(); process.exit(1); }
    if (this.changes > 0) console.log(`✓ Deleted TLS passthrough for ${sni}`);
    else console.log(`No TLS passthrough row for ${sni}`);
    db.close();
  });
});
