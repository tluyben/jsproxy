'use strict';

/**
 * Optional SauroMON log shipping (https://sauromon.com).
 *
 * Completely inert unless SAUROMON_INGEST_KEY is set: nothing is queued, no
 * timers run, no listeners are attached anywhere. When enabled, every Logger
 * line at or above SAUROMON_LEVEL plus jsproxy's own diagnostic events (failed
 * or aborted HTTP requests, abnormal raw TCP sessions, lifecycle + heartbeat)
 * are batched and POSTed to `{endpoint}/api/v1/ingest`.
 *
 * Shipping can never hurt proxying: the queue is bounded (oldest dropped), the
 * event rate is capped per process, sends use their own agent, and every
 * failure is swallowed (a rate-limited notice goes to stderr, never through
 * Logger — that would recurse).
 *
 * Env vars:
 *   SAUROMON_INGEST_KEY    slk_… project ingest key — enables shipping
 *   SAUROMON_ENDPOINT      base URL (default https://sauromon.com)
 *   SAUROMON_LEVEL         lowest Logger level shipped: debug|info|warn|error
 *                          (default info; independent of LOG_LEVEL)
 *   SAUROMON_HOST          host tag (default os.hostname())
 *   SAUROMON_SERVICE       service tag (default jsproxy)
 *   SAUROMON_SAMPLE        0..1 share of HEALTHY requests / TCP sessions that
 *                          are shipped too (default 0 — only problems)
 *   SAUROMON_MAX_PER_MIN   per-process event cap (default 1200)
 *   SAUROMON_HEARTBEAT_MS  heartbeat interval, 0 = off (default 60000)
 */

const http = require('http');
const https = require('https');
const os = require('os');

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };

const key = (process.env.SAUROMON_INGEST_KEY || '').trim();
const enabled = key.length > 0;
const endpoint = (process.env.SAUROMON_ENDPOINT || 'https://sauromon.com').trim().replace(/\/+$/, '');
const minLevel = LEVELS[(process.env.SAUROMON_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;
const hostTag = process.env.SAUROMON_HOST || os.hostname();
const service = process.env.SAUROMON_SERVICE || 'jsproxy';
const sampleRate = Math.min(1, Math.max(0, parseFloat(process.env.SAUROMON_SAMPLE || '0') || 0));
const maxPerMin = parseInt(process.env.SAUROMON_MAX_PER_MIN || '1200', 10);

const MAX_QUEUE = 10000;
const BATCH = 250;
const FLUSH_MS = 2000;

const queue = [];
const stats = { shipped: 0, dropped: 0, capped: 0, failedSends: 0 };
let windowStart = Date.now();
let windowCount = 0;
let sending = false;
let backoffUntil = 0;
let backoffMs = 0;
let timer = null;
let lastNotice = 0;

const target = enabled ? new URL(`${endpoint}/api/v1/ingest`) : null;
const lib = target && target.protocol === 'http:' ? http : https;
const agent = enabled ? new lib.Agent({ keepAlive: true, maxSockets: 1 }) : null;

function notice(msg) {
  const now = Date.now();
  if (now - lastNotice < 60000) return;
  lastNotice = now;
  process.stderr.write(`[sauromon] ${msg}\n`);
}

function underCap() {
  const now = Date.now();
  if (now - windowStart >= 60000) { windowStart = now; windowCount = 0; }
  if (windowCount >= maxPerMin) { stats.capped++; return false; }
  windowCount++;
  return true;
}

function ensureTimer() {
  if (timer) return;
  timer = setInterval(flush, FLUSH_MS);
  if (timer.unref) timer.unref();
}

function push(level, message, fields) {
  if (!enabled || !underCap()) return;
  const f = {};
  if (fields) {
    for (const [k, v] of Object.entries(fields)) {
      if (v === undefined || v === null) continue;
      f[k] = v instanceof Error ? v.message : v;
    }
  }
  const entry = {
    ts: new Date().toISOString(),
    level,
    message: String(message).slice(0, 60000),
    source: 'jsproxy',
    host: hostTag,
    service,
    fields: f,
  };
  if (f.trace_id) entry.traceId = String(f.trace_id);
  queue.push(entry);
  if (queue.length > MAX_QUEUE) { queue.splice(0, queue.length - MAX_QUEUE); stats.dropped++; }
  ensureTimer();
  if (queue.length >= BATCH) setImmediate(flush);
}

function send(batch) {
  return new Promise((resolve) => {
    const body = Buffer.from(JSON.stringify({ logs: batch }));
    const req = lib.request(target, {
      method: 'POST',
      agent,
      headers: {
        'content-type': 'application/json',
        'content-length': body.length,
        authorization: `Bearer ${key}`,
      },
      timeout: 10000,
    }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
      res.on('error', () => resolve(0));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => resolve(0));
    req.end(body);
  });
}

async function flush() {
  if (!enabled || sending || queue.length === 0 || Date.now() < backoffUntil) return;
  sending = true;
  try {
    while (queue.length > 0 && Date.now() >= backoffUntil) {
      const batch = queue.splice(0, BATCH);
      const status = await send(batch);
      if (status >= 200 && status < 300) {
        stats.shipped += batch.length;
        backoffMs = 0;
      } else if (status === 0 || status === 429 || status >= 500) {
        // Transient: put it back (bounded) and back off.
        stats.failedSends++;
        queue.unshift(...batch);
        if (queue.length > MAX_QUEUE) { stats.dropped += queue.length - MAX_QUEUE; queue.length = MAX_QUEUE; }
        backoffMs = Math.min(60000, backoffMs ? backoffMs * 2 : 2000);
        backoffUntil = Date.now() + backoffMs;
        notice(`ingest failed (HTTP ${status || 'network error'}), retrying in ${backoffMs} ms`);
      } else {
        // 400/401/403/413 — retrying the same batch cannot succeed.
        stats.failedSends++;
        stats.dropped += batch.length;
        notice(`ingest rejected a batch with HTTP ${status}; dropped ${batch.length} entries`);
      }
    }
  } finally {
    sending = false;
  }
}

/** Should a Logger line at `level` be shipped? */
function wants(level) {
  return enabled && (LEVELS[level] ?? LEVELS.info) >= minLevel;
}

/** Ship a Logger line (called by Logger for levels `wants()` accepted). */
function log(level, message, fields) {
  push(level, message, fields);
}

/** Ship a diagnostic event (not written to the console). */
function event(level, message, fields) {
  push(level, message, fields);
}

/** True for a SAUROMON_SAMPLE share of calls — gate for healthy-traffic events. */
function sampled() {
  return sampleRate > 0 && Math.random() < sampleRate;
}

/**
 * Periodic heartbeat. `collect` returns extra fields (connection counts …);
 * a missing heartbeat in SauroMON means the process or instance went away.
 */
function startHeartbeat(collect) {
  const every = parseInt(process.env.SAUROMON_HEARTBEAT_MS || '60000', 10);
  if (!enabled || !(every > 0)) return null;
  const t = setInterval(() => {
    let extra = {};
    try { extra = collect ? collect() : {}; } catch (_) { /* best effort */ }
    const mem = process.memoryUsage();
    event('info', 'heartbeat', {
      kind: 'heartbeat',
      uptime_s: Math.round(process.uptime()),
      rss_mb: Math.round(mem.rss / 1048576),
      queue: queue.length,
      ...stats,
      ...extra,
    });
  }, every);
  if (t.unref) t.unref();
  return t;
}

module.exports = { enabled, wants, log, event, sampled, flush, startHeartbeat, stats };
