'use strict';

/**
 * dlq-resurrect — move items from retry_dlq back to retry_queue
 *
 * Usage (from project root):
 *   ./dlq-resurrect.sh            # resurrect ALL DLQ items
 *   ./dlq-resurrect.sh --list     # list DLQ items without touching them
 *   ./dlq-resurrect.sh --id=<id>  # resurrect a single item by ID
 *
 * Items are re-queued with next_retry = now (due immediately) and
 * created_at = now (resetting the DLQ clock so they get a fresh hour).
 */

const sqlite3 = require('sqlite3');

const DB_PATH = process.env.RETRY_DB_PATH || '/app/jsproxy/data/retry_queue.db';

const args  = process.argv.slice(2);
const list  = args.includes('--list');
const idArg = (args.find(a => a.startsWith('--id=')) || '').replace('--id=', '').trim();

const db = new sqlite3.Database(DB_PATH, (err) => {
  if (err) { console.error(`Cannot open DB at ${DB_PATH}: ${err.message}`); process.exit(1); }
});

function run(sql, params) {
  return new Promise((resolve, reject) =>
    db.run(sql, params, function (err) { err ? reject(err) : resolve(this.changes); })
  );
}
function all(sql, params) {
  return new Promise((resolve, reject) =>
    db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows))
  );
}

async function main() {
  // ── list ────────────────────────────────────────────────────────────────────
  if (list) {
    const rows = await all(`SELECT id, method, uri, attempts, last_error, created_at, dlq_at FROM retry_dlq ORDER BY dlq_at ASC`, []);
    if (rows.length === 0) {
      console.log('DLQ is empty.');
    } else {
      console.log(`DLQ — ${rows.length} item(s):\n`);
      for (const r of rows) {
        const age = Math.round((Date.now() - r.created_at) / 60000);
        const dlqAgo = Math.round((Date.now() - r.dlq_at) / 60000);
        console.log(`  ${r.id}`);
        console.log(`    ${r.method} ${r.uri}`);
        console.log(`    attempts: ${r.attempts}  |  last error: ${r.last_error}`);
        console.log(`    created ${age}min ago, DLQ'd ${dlqAgo}min ago`);
        console.log();
      }
    }
    db.close();
    return;
  }

  // ── resurrect ───────────────────────────────────────────────────────────────
  const rows = idArg
    ? await all(`SELECT * FROM retry_dlq WHERE id = ?`, [idArg])
    : await all(`SELECT * FROM retry_dlq ORDER BY dlq_at ASC`, []);

  if (rows.length === 0) {
    console.log(idArg ? `No DLQ item found with id=${idArg}` : 'DLQ is empty — nothing to resurrect.');
    db.close();
    return;
  }

  const now = Date.now();
  let ok = 0;

  for (const r of rows) {
    try {
      await run(
        `INSERT INTO retry_queue (id, uri, method, headers, payload, attempts, next_retry, last_error, created_at)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)`,
        // attempts reset to 0, created_at reset to now → fresh DLQ clock
        [r.id, r.uri, r.method, r.headers, r.payload, now, r.last_error, now]
      );
      await run(`DELETE FROM retry_dlq WHERE id = ?`, [r.id]);
      console.log(`resurrected: ${r.method} ${r.uri}  (${r.id})`);
      ok++;
    } catch (err) {
      console.error(`failed to resurrect ${r.id}: ${err.message}`);
    }
  }

  console.log(`\nDone. ${ok}/${rows.length} item(s) moved back to retry queue.`);
  db.close();
}

main().catch(err => { console.error(err); process.exit(1); });
