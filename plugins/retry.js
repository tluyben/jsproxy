'use strict';

/**
 * retry plugin — async, SQLite-backed, with Dead Letter Queue
 *
 * Retry policy:
 *   502/503/504 → always queue for retry (backend unreachable / infrastructure error)
 *   500         → inspect response body:
 *                   if body matches PERMANENT_FAIL_PATTERNS → immediate DLQ (external rejection,
 *                   e.g. MailChannels blocked address — hammering it again won't help)
 *                   otherwise → queue for retry (our own crash: disk full, DB error, etc.)
 *   4xx / 2xx   → pass through untouched
 *
 * After DLQ_AFTER_MS total age a retrying item is moved to retry_dlq.
 * Use dlq-resurrect.js to move DLQ items back to the live queue.
 *
 * Every queued/DLQ'd item stores fail_status + fail_reason (truncated body)
 * so you can inspect exactly why something failed.
 *
 * Environment variables:
 *   PORT                    Plugin listen port                         (default: 3003)
 *   BACKEND_URLS            Comma-separated backends, round-robin      (default: http://localhost:3000)
 *   BACKEND_URL             Single-backend fallback
 *   PLUGIN_ROUTES           URI prefixes to intercept                  (default: /send,/api/send)
 *   BASE_DELAY_MS           First retry delay ms                       (default: 1000)
 *   MAX_BACKOFF_MS          Backoff ceiling ms                         (default: 3600000 = 1h)
 *   DLQ_AFTER_MS            Age before promoting to DLQ                (default: 3600000 = 1h)
 *   RETRY_DB_PATH           SQLite queue file                          (default: /app/jsproxy/data/retry_queue.db)
 *   POLL_INTERVAL_MS        Worker poll interval ms                    (default: 5000)
 *   PERMANENT_FAIL_PATTERNS Comma-separated case-insensitive substrings in a 500 body
 *                           that mean "do not retry, DLQ immediately"
 *                           (default: mailchannels,delivery rejected,no such user,user unknown,550 ,551 ,552 ,553 ,554 )
 */

const http  = require('http');
const https = require('https');
const { randomUUID } = require('crypto');
const { readJson, readHook, sendValid, sendDecision } = require('./_protocol');

const PORT             = parseInt(process.env.PORT             || '3003',        10);
const BASE_DELAY_MS    = parseInt(process.env.BASE_DELAY_MS    || '1000',        10);
const MAX_BACKOFF_MS   = parseInt(process.env.MAX_BACKOFF_MS   || String(60 * 60 * 1000), 10);
const DLQ_AFTER_MS     = parseInt(process.env.DLQ_AFTER_MS     || String(60 * 60 * 1000), 10);
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS || '5000',        10);
const RETRY_DB_PATH    = process.env.RETRY_DB_PATH || '/app/jsproxy/data/retry_queue.db';
const REASON_MAX       = 500; // chars to store from response body

const PLUGIN_ROUTES = (process.env.PLUGIN_ROUTES || '/send,/api/send')
  .split(',').map(r => r.trim()).filter(Boolean);

const BACKEND_URLS = (process.env.BACKEND_URLS || process.env.BACKEND_URL || 'http://localhost:3000')
  .split(',').map(u => u.trim()).filter(Boolean);

const PERMANENT_FAIL_PATTERNS = (
  process.env.PERMANENT_FAIL_PATTERNS ||
  'mailchannels,delivery rejected,no such user,user unknown,550 ,551 ,552 ,553 ,554 '
).split(',').map(p => p.trim().toLowerCase()).filter(Boolean);

/** Returns true if a 500 response body indicates a permanent external failure */
function isPermanentFailure(bodyText) {
  const lower = bodyText.toLowerCase();
  return PERMANENT_FAIL_PATTERNS.some(p => lower.includes(p));
}

// ── SQLite queue ──────────────────────────────────────────────────────────────

const sqlite3 = require('sqlite3');
const db = new sqlite3.Database(RETRY_DB_PATH, (err) => {
  if (err) {
    console.error(`[retry] FATAL: could not open SQLite queue at ${RETRY_DB_PATH}: ${err.message}`);
    process.exit(1);
  }
  console.log(`[retry] queue DB: ${RETRY_DB_PATH}`);
});

db.serialize(() => {
  db.run('PRAGMA journal_mode = WAL');
  db.run(`
    CREATE TABLE IF NOT EXISTS retry_queue (
      id           TEXT    PRIMARY KEY,
      uri          TEXT    NOT NULL,
      method       TEXT    NOT NULL,
      headers      TEXT    NOT NULL,
      payload      TEXT,
      attempts     INTEGER NOT NULL DEFAULT 0,
      next_retry   INTEGER NOT NULL DEFAULT 0,
      fail_status  INTEGER,
      fail_reason  TEXT,
      created_at   INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS retry_dlq (
      id           TEXT    PRIMARY KEY,
      uri          TEXT    NOT NULL,
      method       TEXT    NOT NULL,
      headers      TEXT    NOT NULL,
      payload      TEXT,
      attempts     INTEGER NOT NULL DEFAULT 0,
      fail_status  INTEGER,
      fail_reason  TEXT,
      created_at   INTEGER NOT NULL,
      dlq_at       INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
    )
  `);
  // Migrations: add columns if they don't exist yet (ALTER TABLE errors are silently ignored)
  db.run(`ALTER TABLE retry_queue ADD COLUMN fail_status INTEGER`, () => {});
  db.run(`ALTER TABLE retry_queue ADD COLUMN fail_reason TEXT`,   () => {});
  db.run(`ALTER TABLE retry_dlq   ADD COLUMN fail_status INTEGER`, () => {});
  db.run(`ALTER TABLE retry_dlq   ADD COLUMN fail_reason TEXT`,   () => {});
});

function dbRun(sql, params) {
  return new Promise((resolve, reject) =>
    db.run(sql, params, function (err) { err ? reject(err) : resolve(this); })
  );
}
function dbAll(sql, params) {
  return new Promise((resolve, reject) =>
    db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows))
  );
}

// ── helpers ───────────────────────────────────────────────────────────────────

function isInterested(uri) {
  const path = uri.split('?')[0];
  return PLUGIN_ROUTES.some(r => path === r || path.startsWith(r + '/') || path.startsWith(r + '?'));
}

function parseBackend(url) {
  const parsed = new URL(url);
  return {
    url,
    lib:      parsed.protocol === 'https:' ? https : http,
    hostname: parsed.hostname,
    port:     parseInt(parsed.port || (parsed.protocol === 'https:' ? '443' : '80'), 10),
  };
}

const backends = BACKEND_URLS.map(parseBackend);

function backoff(attempts) {
  return Math.min(BASE_DELAY_MS * Math.pow(2, attempts), MAX_BACKOFF_MS);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function doRequest(backend, uri, method, headers, bodyBuf) {
  return new Promise((resolve, reject) => {
    const reqHeaders = Object.assign({}, headers, {
      host: `${backend.hostname}:${backend.port}`,
    });
    if (bodyBuf && bodyBuf.length > 0) {
      reqHeaders['content-length'] = bodyBuf.length;
    } else {
      delete reqHeaders['content-length'];
    }

    const req = backend.lib.request(
      { hostname: backend.hostname, port: backend.port, path: uri, method, headers: reqHeaders, timeout: 10_000 },
      (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on('error', reject);
      }
    );
    req.on('timeout', () => { req.destroy(); const e = new Error('timeout'); e.code = 'ETIMEOUT'; reject(e); });
    req.on('error', reject);
    if (bodyBuf && bodyBuf.length > 0) req.write(bodyBuf);
    req.end();
  });
}

// ── background worker ─────────────────────────────────────────────────────────

async function moveToDlq(row, failStatus, failReason) {
  const age = Math.round((Date.now() - row.created_at) / 60000);
  console.log(`[retry] DLQ: ${row.method} ${row.uri} — status=${failStatus} reason="${failReason}" (age ${age}min, ${row.attempts} attempts)`);
  await dbRun(
    `INSERT INTO retry_dlq (id, uri, method, headers, payload, attempts, fail_status, fail_reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [row.id, row.uri, row.method, row.headers, row.payload,
     row.attempts, failStatus, failReason, row.created_at]
  );
  await dbRun(`DELETE FROM retry_queue WHERE id = ?`, [row.id]);
}

async function rescheduleOrDlq(row, failStatus, failReason) {
  const age = Date.now() - row.created_at;
  if (age >= DLQ_AFTER_MS) {
    await moveToDlq(row, failStatus, failReason);
  } else {
    const delay = backoff(row.attempts + 1);
    console.log(`[retry] rescheduling ${row.uri} in ${Math.round(delay / 1000)}s — status=${failStatus} reason="${failReason}"`);
    await dbRun(
      `UPDATE retry_queue SET attempts = ?, next_retry = ?, fail_status = ?, fail_reason = ? WHERE id = ?`,
      [row.attempts + 1, Date.now() + delay, failStatus, failReason, row.id]
    );
  }
}

async function processQueue() {
  const now  = Date.now();
  const rows = await dbAll(`SELECT * FROM retry_queue WHERE next_retry <= ? ORDER BY next_retry ASC LIMIT 10`, [now]);
  if (rows.length === 0) return;

  console.log(`[retry] worker: ${rows.length} item(s) due`);

  for (const row of rows) {
    const bodyBuf = row.payload ? Buffer.from(row.payload, 'base64') : Buffer.alloc(0);
    const headers = JSON.parse(row.headers);

    // Try every backend in order — only back off if ALL fail
    let delivered = false;
    let lastStatus = 0;
    let lastReason = '';

    for (let i = 0; i < backends.length; i++) {
      const backend = backends[(row.attempts + i) % backends.length];
      console.log(`[retry] attempt ${row.attempts + 1} for ${row.method} ${row.uri} → ${backend.url}`);

      try {
        const result = await doRequest(backend, row.uri, row.method, headers, bodyBuf);
        const bodyText = result.body.toString('utf8').slice(0, REASON_MAX);

        if (result.statusCode < 500) {
          console.log(`[retry] success (${result.statusCode}) for ${row.uri} — removing from queue`);
          await dbRun(`DELETE FROM retry_queue WHERE id = ?`, [row.id]);
          delivered = true;
          break;
        }

        // 500: check if it's a permanent external failure or our own crash
        if (result.statusCode === 500 && isPermanentFailure(bodyText)) {
          console.log(`[retry] permanent failure (500) for ${row.uri} — DLQ immediately`);
          await moveToDlq(row, 500, bodyText);
          delivered = true; // don't reschedule
          break;
        }

        lastStatus = result.statusCode;
        lastReason = bodyText;
      } catch (err) {
        lastStatus = 0;
        lastReason = err.message;
      }
    }

    if (!delivered) {
      // All backends failed — back off
      await rescheduleOrDlq(row, lastStatus, lastReason);
    }
  }
}

const worker = setInterval(async () => {
  try { await processQueue(); } catch (err) { console.error('[retry] worker error:', err); }
}, POLL_INTERVAL_MS);
worker.unref();

// ── plugin HTTP server ────────────────────────────────────────────────────────

const pending = new Map();

const GC = setInterval(() => {
  const cutoff = Date.now() - 120_000;
  for (const [id, info] of pending) {
    if (info.ts < cutoff) pending.delete(id);
  }
}, 60_000);
GC.unref();

http.createServer((req, res) => {
  if (req.url === '/valid') {
    return readJson(req, (err, data) => {
      if (err) { res.writeHead(400); return res.end('bad json'); }
      sendValid(res, isInterested(data.uri));
    });
  }

  if (req.url === '/before') {
    return readHook(req, (err, meta, payloadBuffer) => {
      if (err) { res.writeHead(400); return res.end('bad meta'); }
      pending.set(meta.requestId, {
        uri:     meta.uri,
        method:  meta.method,
        headers: meta.headers,
        payload: payloadBuffer,
        ts:      Date.now(),
      });
      sendDecision(res, 'CONTINUE');
    });
  }

  if (req.url === '/after') {
    return readHook(req, async (err, meta, payloadBuffer) => {
      if (err) { res.writeHead(400); return res.end('bad meta'); }

      try {
        const info = pending.get(meta.requestId);
        pending.delete(meta.requestId);

        // 4xx and below — pass through
        if (meta.statusCode < 500 || !info) {
          return sendDecision(res, 'CONTINUE');
        }

        // Decode response body for inspection
        const bodyText = payloadBuffer.length
          ? payloadBuffer.toString('utf8').slice(0, REASON_MAX)
          : '';

        // DB stores the captured request body base64-encoded (TEXT column).
        const payloadB64 = info.payload && info.payload.length
          ? info.payload.toString('base64')
          : null;

        // 500: check if permanent external failure → pass through to client, DLQ for record
        if (meta.statusCode === 500 && isPermanentFailure(bodyText)) {
          // Store in DLQ for visibility but don't retry — pass the real error back to client
          const id = randomUUID();
          const now = Date.now();
          await dbRun(
            `INSERT INTO retry_dlq (id, uri, method, headers, payload, attempts, fail_status, fail_reason, created_at)
             VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)`,
            [id, info.uri, info.method, JSON.stringify(info.headers), payloadB64,
             500, bodyText, now]
          );
          console.log(`[retry] permanent 500 for ${info.uri} — DLQ'd (id=${id}), passing error to client`);
          return sendDecision(res, 'CONTINUE'); // client sees the real 500
        }

        // 500 (our crash) or 502/503/504 → queue for retry, return 202 to client
        const id = randomUUID();
        await dbRun(
          `INSERT INTO retry_queue (id, uri, method, headers, payload, next_retry, fail_status, fail_reason)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [id, info.uri, info.method, JSON.stringify(info.headers), payloadB64,
           Date.now(), meta.statusCode, bodyText]
        );

        console.log(`[retry] queued ${info.method} ${info.uri} (${meta.statusCode}) id=${id} — "${bodyText.slice(0, 80)}"`);

        const body = Buffer.from(JSON.stringify({ queued: true, id, message: 'Request accepted and queued for delivery' }));
        return sendDecision(res, 'REWRITE_RESPONSE', {
          statusCode: 202,
          headers:    { 'content-type': 'application/json', 'content-length': String(body.length) },
        }, body);
      } catch (e) {
        console.error('[retry] plugin error:', e);
        sendDecision(res, 'CONTINUE');
      }
    });
  }

  res.writeHead(404); res.end();
}).listen(PORT, () => {
  console.log(`[retry] plugin listening on :${PORT}`);
  console.log(`[retry]   routes:            ${PLUGIN_ROUTES.join(', ')}`);
  console.log(`[retry]   backends:          ${BACKEND_URLS.join(', ')} (round-robin)`);
  console.log(`[retry]   backoff:           ${BASE_DELAY_MS}ms base, ${MAX_BACKOFF_MS / 1000}s cap, DLQ after ${DLQ_AFTER_MS / 1000}s`);
  console.log(`[retry]   permanent-fail:    ${PERMANENT_FAIL_PATTERNS.join(' | ')}`);
  console.log(`[retry]   queue:             ${RETRY_DB_PATH}`);
});
