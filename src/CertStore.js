'use strict';

/**
 * Certificate storage backends.
 *
 * CertificateManager persists everything it needs — trusted/self-signed cert
 * pairs, the ACME account key, wildcard certs, ACME retry-state / lock JSON,
 * pending wildcard orders and HTTP-01 challenge files — through a single
 * key/value blob interface. A "key" is exactly the filename the disk backend
 * used to write (e.g. `example.com.trusted.crt`, `account-key.pem`,
 * `.well-known/acme-challenge/<token>`), so switching backends changes nothing
 * about the naming scheme the rest of the code relies on.
 *
 * Two backends, selected by CERT_STORAGE (default `disk`, backward compatible):
 *   - DiskCertStore — files under certsDir (the original behaviour)
 *   - DbCertStore   — a `cert_store` table in the same SQLite DB as mappings
 *
 * Interface (all async unless noted):
 *   init()              ensure the directory / table exists
 *   list()   -> [key]   top-level keys (used to discover existing certs)
 *   read(key)     -> Buffer | null
 *   readText(key) -> string | null
 *   write(key, data)    atomic where the backend allows it
 *   delete(key)         no-op if absent
 *   rename(from, to)    move a key (may throw if `from` is absent)
 */

const fs = require('fs').promises;
const path = require('path');

class DiskCertStore {
  // getDir is a function so tests (and hot config) can point certsDir somewhere
  // else after the manager is constructed — the store always resolves it live.
  constructor(logger, getDir) {
    this.logger = logger;
    this._getDir = getDir;
  }

  get dir() {
    return this._getDir();
  }

  _path(key) {
    return path.join(this.dir, key);
  }

  async init() {
    try {
      await fs.access(this.dir);
    } catch {
      await fs.mkdir(this.dir, { recursive: true });
      this.logger.info(`Created certificates directory: ${this.dir}`);
    }
  }

  async list() {
    try {
      return await fs.readdir(this.dir);
    } catch {
      return [];
    }
  }

  async read(key) {
    try {
      return await fs.readFile(this._path(key));
    } catch {
      return null; // missing file, or a directory entry — treat as absent
    }
  }

  async readText(key) {
    const buf = await this.read(key);
    return buf == null ? null : buf.toString('utf8');
  }

  // Atomic write via temp-file + rename, so a crash can't leave a half-written
  // cert or state file. Parent dirs (e.g. the acme-challenge path) are created
  // on demand.
  async write(key, data) {
    const full = this._path(key);
    await fs.mkdir(path.dirname(full), { recursive: true });
    const tmp = `${full}.tmp-${process.pid}`;
    await fs.writeFile(tmp, data);
    await fs.rename(tmp, full);
  }

  async delete(key) {
    await fs.unlink(this._path(key)).catch(() => {});
  }

  async rename(from, to) {
    const dst = this._path(to);
    await fs.mkdir(path.dirname(dst), { recursive: true });
    await fs.rename(this._path(from), dst);
  }
}

class DbCertStore {
  constructor(logger, dbManager) {
    this.logger = logger;
    this.dbManager = dbManager;
  }

  // Resolved lazily: the connection is opened by DatabaseManager.initialize(),
  // which always runs before CertificateManager.initialize().
  get db() {
    return this.dbManager.db;
  }

  _run(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.run(sql, params, function (err) {
        if (err) reject(err);
        else resolve(this);
      });
    });
  }

  _get(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
    });
  }

  _all(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows || [])));
    });
  }

  async init() {
    await this._run(`
      CREATE TABLE IF NOT EXISTS cert_store (
        key        TEXT PRIMARY KEY,
        value      BLOB,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    this.logger.info('Certificate store table ready (CERT_STORAGE=db)');
  }

  async list() {
    const rows = await this._all('SELECT key FROM cert_store');
    return rows.map(r => r.key);
  }

  async read(key) {
    const row = await this._get('SELECT value FROM cert_store WHERE key = ?', [key]);
    if (!row || row.value == null) return null;
    return Buffer.isBuffer(row.value) ? row.value : Buffer.from(row.value);
  }

  async readText(key) {
    const buf = await this.read(key);
    return buf == null ? null : buf.toString('utf8');
  }

  async write(key, data) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
    await this._run(
      `INSERT INTO cert_store (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
      [key, buf]
    );
  }

  async delete(key) {
    await this._run('DELETE FROM cert_store WHERE key = ?', [key]);
  }

  async rename(from, to) {
    const buf = await this.read(from);
    if (buf == null) throw new Error(`cert_store rename: source key '${from}' not found`);
    await this.write(to, buf);
    await this.delete(from);
  }
}

// mode: 'disk' | 'db' (anything else warns and falls back to disk).
function createCertStore(mode, logger, dbManager, getDir) {
  const normalized = String(mode || 'disk').toLowerCase();
  if (normalized === 'db') {
    if (!dbManager) throw new Error('CERT_STORAGE=db requires a database manager');
    return new DbCertStore(logger, dbManager);
  }
  if (normalized !== 'disk') {
    logger.warn(`Unknown CERT_STORAGE='${mode}', falling back to disk`);
  }
  return new DiskCertStore(logger, getDir);
}

module.exports = { DiskCertStore, DbCertStore, createCertStore };
