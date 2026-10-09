/**
 * Regression (2026-10-09): every cluster worker runs the schema migrations at the
 * same moment on the same SQLite file. "Check column, then ALTER" raced and the
 * losing workers crashed with "duplicate column name" / SQLITE_BUSY on every
 * fresh-DB boot (each Bunny edge pod start). Schema setup now runs in one
 * BEGIN IMMEDIATE transaction with a busy timeout.
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const WORKER = `
const DM = require(${JSON.stringify(path.resolve(__dirname, '../src/DatabaseManager.js'))});
const log = { info(){}, warn(){}, error(){}, debug(){} };
new DM(log).initialize().then(() => process.exit(0)).catch((e) => { console.error(e.message); process.exit(1); });
`;

function boot(dbPath) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, ['-e', WORKER], { env: { ...process.env, DB_PATH: dbPath } });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('exit', (code) => resolve({ code, err }));
  });
}

describe('DatabaseManager concurrent initialize', () => {
  it('4 workers initialising one fresh DB at once all succeed (10 rounds)', async () => {
    for (let round = 0; round < 10; round++) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsp-db-'));
      const db = path.join(dir, 'current.db');
      const results = await Promise.all([boot(db), boot(db), boot(db), boot(db)]);
      fs.rmSync(dir, { recursive: true, force: true });
      for (const r of results) expect(r).toEqual({ code: 0, err: '' });
    }
  }, 120000);
});
