#!/usr/bin/env node
'use strict';

/**
 * Migrate certificate material between the two CERT_STORAGE backends.
 *
 *   npm run cert-migrate-disk-db   # certs/ files  ->  cert_store table in the DB
 *   npm run cert-migrate-db-disk   # cert_store table in the DB  ->  certs/ files
 *
 * Copies every stored blob (trusted/self-signed/wildcard cert pairs, the ACME
 * account key, ACME state/lock JSON, pending wildcard orders — everything the
 * running proxy persists) from the source backend to the destination. Existing
 * destination entries with the same key are overwritten; the source is left
 * intact so a migration can be verified before switching CERT_STORAGE over.
 *
 * DB location: DB_PATH (default ./data/current.db).
 * Disk location: CERTS_DIR (default ./certs).
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const path = require('path');
const DatabaseManager = require('../src/DatabaseManager');
const { DiskCertStore, DbCertStore } = require('../src/CertStore');

// Minimal logger — the stores only call info/warn/error.
const logger = {
  info: (...a) => console.log(...a),
  warn: (...a) => console.warn(...a),
  error: (...a) => console.error(...a),
};

function usage(msg) {
  if (msg) console.error(`Error: ${msg}\n`);
  console.error(`Usage: node scripts/cert-migrate.js <disk-db|db-disk>

  disk-db   copy certs/ files into the cert_store table (for CERT_STORAGE=db)
  db-disk   copy the cert_store table out to certs/ files (for CERT_STORAGE=disk)
`);
  process.exit(msg ? 1 : 0);
}

async function main() {
  const direction = process.argv[2];
  if (!direction || direction === '--help' || direction === '-h') usage();
  if (direction !== 'disk-db' && direction !== 'db-disk') {
    usage(`unknown direction '${direction}'`);
  }

  const certsDir = process.env.CERTS_DIR || path.join(__dirname, '..', 'certs');

  const db = new DatabaseManager(logger);
  await db.initialize();

  const disk = new DiskCertStore(logger, () => certsDir);
  const dbStore = new DbCertStore(logger, db);
  await disk.init();
  await dbStore.init();

  const [src, dest, label] = direction === 'disk-db'
    ? [disk, dbStore, `disk (${certsDir})  ->  db (${db.dbPath})`]
    : [dbStore, disk, `db (${db.dbPath})  ->  disk (${certsDir})`];

  console.log(`Migrating certificates: ${label}\n`);

  const keys = await src.list();
  let copied = 0;
  let skipped = 0;

  for (const key of keys) {
    const data = await src.read(key);
    if (data == null) {
      // Directory entry (e.g. .well-known) or unreadable — nothing to copy.
      skipped++;
      continue;
    }
    await dest.write(key, data);
    console.log(`  COPIED  ${key}  (${data.length} bytes)`);
    copied++;
  }

  await db.close();

  console.log(`
Done:
  ${copied}  copied
  ${skipped}  skipped (directories / unreadable)

Set CERT_STORAGE=${direction === 'disk-db' ? 'db' : 'disk'} to use the ${direction === 'disk-db' ? 'database' : 'disk'} backend.`);
}

main().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
