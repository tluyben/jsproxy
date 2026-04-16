'use strict';

/**
 * telemetry plugin
 *
 * Captures per-request spans (method, route, status code, latency, error flag)
 * and forwards them to a configurable backend — without touching your application.
 *
 * Every request that passes through jsproxy gets a span. Plug this into your
 * existing observability stack by setting TELEMETRY_TARGET:
 *
 *   console  (default) — pretty-print spans to stdout; great for local dev / demos
 *   webhook  — POST a JSON span to any HTTP/HTTPS endpoint (custom ingestors,
 *              Slack/Discord webhooks, logging services, …)
 *   otel     — POST an OTLP/HTTP span to an OpenTelemetry collector
 *              (Jaeger, Grafana Tempo, Honeycomb, Datadog OTLP endpoint, …)
 *   sentry   — POST a Sentry transaction envelope (Performance Monitoring)
 *
 * Environment variables:
 *   PORT                      Plugin listen port                   (default: 3004)
 *   TELEMETRY_TARGET          console | webhook | otel | sentry    (default: console)
 *   TELEMETRY_SERVICE_NAME    Service name tag in every span       (default: jsproxy)
 *   TELEMETRY_SAMPLE_RATE     0.0–1.0 fraction of requests to capture (default: 1.0)
 *   TELEMETRY_IGNORE_PATHS    Comma-separated path prefixes to skip   (default: /health)
 *   TELEMETRY_WEBHOOK_URL     Required when target=webhook
 *   TELEMETRY_OTEL_ENDPOINT   OTLP/HTTP collector URL  (default: http://localhost:4318/v1/traces)
 *   TELEMETRY_SENTRY_DSN      Required when target=sentry
 *
 * Usage:
 *   node plugins/telemetry.js
 *   PLUGIN=localhost:3004 node index.js
 *
 * How it works:
 *   /valid  → returns false for ignored paths or when not sampled; true otherwise
 *   /before → records start time, method, uri, domain keyed by requestId
 *   /after  → computes latency, builds a span, emits it fire-and-forget, returns CONTINUE
 */

const http  = require('http');
const https = require('https');
const { randomBytes } = require('crypto');

const PORT          = parseInt(process.env.PORT || '3004', 10);
const TARGET        = (process.env.TELEMETRY_TARGET || 'console').toLowerCase();
const SERVICE_NAME  = process.env.TELEMETRY_SERVICE_NAME || 'jsproxy';
const SAMPLE_RATE   = parseFloat(process.env.TELEMETRY_SAMPLE_RATE || '1.0');
const IGNORE_PATHS  = (process.env.TELEMETRY_IGNORE_PATHS || '/health')
  .split(',').map(s => s.trim()).filter(Boolean);
const WEBHOOK_URL   = process.env.TELEMETRY_WEBHOOK_URL || '';
const OTEL_ENDPOINT = process.env.TELEMETRY_OTEL_ENDPOINT || 'http://localhost:4318/v1/traces';
const SENTRY_DSN    = process.env.TELEMETRY_SENTRY_DSN || '';

// ── per-request state ─────────────────────────────────────────────────────────
// Stores timing + request metadata between /before and /after.
// Entry: { startMs, method, uri, domain, inPort }

const state = new Map();

// Safety-net GC: evict entries older than 2 minutes (covers dropped connections).
const GC = setInterval(() => {
  const cutoff = Date.now() - 120_000;
  for (const [id, s] of state) {
    if (s.startMs < cutoff) state.delete(id);
  }
}, 60_000);
GC.unref();

// ── helpers ───────────────────────────────────────────────────────────────────

function isIgnored(uri) {
  return IGNORE_PATHS.some(p =>
    uri === p || uri.startsWith(p + '?') || uri.startsWith(p + '/')
  );
}

/** POST a JSON body to a URL. Returns the HTTP status code. */
function postJson(url, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const lib    = parsed.protocol === 'https:' ? https : http;
    const bodyStr = JSON.stringify(body);
    const req = lib.request(
      {
        hostname: parsed.hostname,
        port:     parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
        path:     parsed.pathname + parsed.search,
        method:   'POST',
        headers:  Object.assign({
          'content-type':   'application/json',
          'content-length': Buffer.byteLength(bodyStr),
        }, extraHeaders),
        timeout: 5000,
      },
      res => { res.resume(); resolve(res.statusCode); }
    );
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

// ── target: console ───────────────────────────────────────────────────────────

function emitConsole(span) {
  const R = '\x1b[0m', DIM = '\x1b[2m', BOLD = '\x1b[1m';
  const color =
    span.statusCode >= 500 ? '\x1b[31m' :   // red
    span.statusCode >= 400 ? '\x1b[33m' :   // yellow
                             '\x1b[32m';    // green
  const icon = span.statusCode >= 500 ? '✗' : span.statusCode >= 400 ? '⚠' : '✓';
  const traceShort = span.traceId.replace(/-/g, '').slice(0, 8);

  process.stdout.write(
    `[telemetry] ${color}${BOLD}${icon} ${span.method} ${span.uri}${R}` +
    `  ${color}${span.statusCode}${R}` +
    `  ${DIM}${span.latencyMs}ms  trace=${traceShort}…  svc=${span.service}${R}\n`
  );
}

// ── target: webhook ───────────────────────────────────────────────────────────

async function emitWebhook(span) {
  if (!WEBHOOK_URL) {
    console.error('[telemetry] TELEMETRY_WEBHOOK_URL is not set');
    return;
  }
  const status = await postJson(WEBHOOK_URL, span);
  console.log(`[telemetry] webhook → HTTP ${status}`);
}

// ── target: otel (OTLP/HTTP) ──────────────────────────────────────────────────
// Spec: https://opentelemetry.io/docs/specs/otlp/#otlphttp-request
// Compatible with: Jaeger, Grafana Tempo, Honeycomb, Datadog OTLP, Lightstep, …

async function emitOtel(span) {
  // traceId must be 32 lowercase hex chars (16 bytes); requestId is a UUID → strip dashes
  const traceId = span.traceId.replace(/-/g, '');
  // spanId must be 16 lowercase hex chars (8 bytes)
  const spanId  = randomBytes(8).toString('hex');
  // Timestamps in nanoseconds (BigInt to avoid precision loss)
  const startNs = String(BigInt(span.startMs) * 1_000_000n);
  const endNs   = String(BigInt(span.startMs + span.latencyMs) * 1_000_000n);

  const body = {
    resourceSpans: [{
      resource: {
        attributes: [
          { key: 'service.name',    value: { stringValue: span.service } },
          { key: 'service.version', value: { stringValue: '1.0.0' } },
        ],
      },
      scopeSpans: [{
        scope: { name: 'jsproxy-telemetry-plugin', version: '1.0.0' },
        spans: [{
          traceId,
          spanId,
          name:               `${span.method} ${span.uri.split('?')[0]}`,
          kind:               2,  // SPAN_KIND_SERVER
          startTimeUnixNano:  startNs,
          endTimeUnixNano:    endNs,
          attributes: [
            { key: 'http.method',      value: { stringValue: span.method } },
            { key: 'http.target',      value: { stringValue: span.uri } },
            { key: 'http.status_code', value: { intValue: span.statusCode } },
            { key: 'net.host.name',    value: { stringValue: span.domain } },
            { key: 'net.host.port',    value: { intValue: span.inPort } },
          ],
          status: { code: span.error ? 2 : 1 },  // 1=OK 2=ERROR
        }],
      }],
    }],
  };

  const status = await postJson(OTEL_ENDPOINT, body);
  console.log(`[telemetry] otel → HTTP ${status}`);
}

// ── target: sentry ────────────────────────────────────────────────────────────
// Uses the Sentry Envelope API for Performance Monitoring transactions.
// Spec: https://develop.sentry.dev/sdk/envelopes/
// DSN format: https://PUBLIC_KEY@oNNNNN.ingest.sentry.io/PROJECT_ID

async function emitSentry(span) {
  if (!SENTRY_DSN) {
    console.error('[telemetry] TELEMETRY_SENTRY_DSN is not set');
    return;
  }

  const dsn       = new URL(SENTRY_DSN);
  const publicKey = dsn.username;
  const projectId = dsn.pathname.replace(/^\//, '');
  const traceId   = span.traceId.replace(/-/g, '');
  const spanId    = randomBytes(8).toString('hex');
  const eventId   = randomBytes(16).toString('hex');
  const startTs   = span.startMs / 1000;
  const endTs     = (span.startMs + span.latencyMs) / 1000;
  const status    =
    span.statusCode < 400 ? 'ok' :
    span.statusCode < 500 ? 'invalid_argument' :
                            'internal_error';

  // The Sentry envelope format: three newline-delimited JSON objects.
  // Line 1 → envelope header
  // Line 2 → item header (type = transaction)
  // Line 3 → transaction payload
  const envelope = [
    JSON.stringify({
      event_id: eventId,
      sent_at:  new Date().toISOString(),
      dsn:      SENTRY_DSN,
    }),
    JSON.stringify({ type: 'transaction' }),
    JSON.stringify({
      event_id:         eventId,
      type:             'transaction',
      transaction:      `${span.method} ${span.uri.split('?')[0]}`,
      transaction_info: { source: 'route' },
      start_timestamp:  startTs,
      timestamp:        endTs,
      contexts: {
        trace: { trace_id: traceId, span_id: spanId, op: 'http.server', status },
      },
      tags: {
        'http.status_code': String(span.statusCode),
        'http.method':      span.method,
        service:            span.service,
      },
      spans: [],
    }),
  ].join('\n');

  const lib = dsn.protocol === 'https:' ? https : http;
  const bodyBuf = Buffer.from(envelope);
  await new Promise((resolve, reject) => {
    const req = lib.request(
      {
        hostname: dsn.hostname,
        path:     `/api/${projectId}/envelope/`,
        method:   'POST',
        headers: {
          'content-type':   'application/x-sentry-envelope',
          'content-length': bodyBuf.length,
          'x-sentry-auth':  `Sentry sentry_version=7, sentry_client=jsproxy/1.0.0, sentry_key=${publicKey}`,
        },
        timeout: 5000,
      },
      res => { res.resume(); resolve(res.statusCode); }
    );
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
    req.write(bodyBuf);
    req.end();
  });
  console.log('[telemetry] sentry transaction sent');
}

// ── dispatch ──────────────────────────────────────────────────────────────────

async function emit(span) {
  try {
    if (TARGET === 'webhook') return await emitWebhook(span);
    if (TARGET === 'otel')    return await emitOtel(span);
    if (TARGET === 'sentry')  return await emitSentry(span);
    /* default: console */    emitConsole(span);
  } catch (err) {
    console.error(`[telemetry] emit error (target=${TARGET}): ${err.message}`);
  }
}

// ── plugin server ─────────────────────────────────────────────────────────────

http.createServer((req, res) => {
  let raw = '';
  req.on('data', d => (raw += d));
  req.on('end', async () => {
    let data;
    try { data = JSON.parse(raw); } catch { res.writeHead(400); return res.end(); }

    try {
      // ── /valid ────────────────────────────────────────────────────────────
      if (req.url === '/valid') {
        if (isIgnored(data.uri))          return json(res, { valid: false });
        if (Math.random() > SAMPLE_RATE)  return json(res, { valid: false });
        return json(res, { valid: true });
      }

      // ── /before ───────────────────────────────────────────────────────────
      if (req.url === '/before') {
        state.set(data.requestId, {
          startMs: Date.now(),
          method:  data.method,
          uri:     data.uri,
          domain:  data.domain,
          inPort:  data.inPort,
        });
        return json(res, { result: 'CONTINUE' });
      }

      // ── /after ────────────────────────────────────────────────────────────
      if (req.url === '/after') {
        const saved = state.get(data.requestId);
        state.delete(data.requestId);

        if (saved) {
          const span = {
            traceId:    data.requestId,
            service:    SERVICE_NAME,
            method:     saved.method,
            uri:        saved.uri,
            domain:     saved.domain,
            inPort:     saved.inPort,
            statusCode: data.statusCode,
            latencyMs:  Date.now() - saved.startMs,
            error:      data.statusCode >= 500,
            timestamp:  new Date().toISOString(),
          };
          // Fire-and-forget: don't hold up the response waiting for the backend
          emit(span).catch(() => {});
        }

        return json(res, { result: 'CONTINUE' });
      }

      res.writeHead(404);
      res.end();
    } catch (err) {
      console.error('[telemetry] plugin error:', err);
      json(res, { result: 'CONTINUE' }); // always fail-open
    }
  });
}).listen(PORT, () => {
  console.log(`telemetry plugin listening on port ${PORT}`);
  console.log(`  Target:      ${TARGET}`);
  console.log(`  Service:     ${SERVICE_NAME}`);
  console.log(`  Sample rate: ${(SAMPLE_RATE * 100).toFixed(0)}%`);
  console.log(`  Ignore:      ${IGNORE_PATHS.join(', ') || '(none)'}`);
  if (TARGET === 'otel')    console.log(`  OTEL:        ${OTEL_ENDPOINT}`);
  if (TARGET === 'sentry')  console.log(`  Sentry DSN:  ${SENTRY_DSN ? '(set)' : '(NOT SET — set TELEMETRY_SENTRY_DSN)'}`);
  if (TARGET === 'webhook') console.log(`  Webhook URL: ${WEBHOOK_URL || '(NOT SET — set TELEMETRY_WEBHOOK_URL)'}`);
});

function json(res, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}
