'use strict';

const { trace } = require('@opentelemetry/api');

const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const _configured = LEVELS[process.env.LOG_LEVEL?.toLowerCase()] ?? LEVELS.info;
const _debug = _configured === 0;

// LOG_FORMAT=json  → newline-delimited JSON (machine-readable, for log pipelines)
// LOG_FORMAT=text  → human-readable [ts] [LEVEL] msg  key=val … (default)
const _json = process.env.LOG_FORMAT === 'json';

const _PAD = { debug: 'DEBUG', info: 'INFO ', warn: 'WARN ', error: 'ERROR' };

// ── helpers ────────────────────────────────────────────────────────────────

function _isPlainObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Error);
}

function _errFields(err) {
  const f = { error: err.message };
  if (err.code)            f.error_code = err.code;
  if (err.errno !== undefined) f.errno  = err.errno;
  if (err.syscall)         f.syscall    = err.syscall;
  if (err.address)         f.address    = err.address;
  if (err.port)            f.port       = err.port;
  if (_debug && err.stack) f.stack      = err.stack;
  return f;
}

// Render a single key=value token, quoting values that need it.
// Newlines are flattened so the line stays single-line.
function _kv(k, v) {
  if (v === undefined || v === null) return null;
  let s = typeof v === 'string' ? v : String(v);
  s = s.replace(/\r?\n/g, ' | ');           // flatten multi-line (e.g. stacks)
  if (/[ "=]/.test(s)) s = `"${s.replace(/"/g, '\\"')}"`;
  return `${k}=${s}`;
}

// ── formatters ─────────────────────────────────────────────────────────────

function _textLine(level, ts, msg, ctx, fields) {
  const label = _PAD[level] || level.toUpperCase();
  let line = `[${ts}] [${label}] ${msg}`;
  const all = Object.assign({}, ctx, fields);
  for (const [k, v] of Object.entries(all)) {
    if (k === 'stack' && !_debug) continue;  // hide stacks unless debug
    const tok = _kv(k, v);
    if (tok) line += '  ' + tok;
  }
  return line;
}

function _jsonLine(level, ts, msg, ctx, fields, traceCtx) {
  const e = { ts, level, msg, ...ctx, ...fields, ...traceCtx };
  // Remove undefined values so JSON stays clean
  for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k];
  return JSON.stringify(e);
}

// ── Logger class ───────────────────────────────────────────────────────────

class Logger {
  constructor(ctx = {}) {
    this._ctx = ctx;
  }

  _write(level, firstArg, secondArg) {
    if (LEVELS[level] < _configured) return;

    let msg;
    let fields = {};

    if (typeof firstArg === 'string' && secondArg !== undefined && _isPlainObj(secondArg)) {
      // Preferred: (msg, { structured fields })
      msg = firstArg;
      fields = secondArg;
    } else if (typeof firstArg === 'string' && secondArg instanceof Error) {
      // Legacy: ('label:', err)  — extract Error fields automatically
      msg = firstArg.replace(/:?\s*$/, '');
      fields = _errFields(secondArg);
    } else {
      // Legacy: template literal or plain string
      msg = typeof firstArg === 'string' ? firstArg : String(firstArg);
      if (secondArg !== undefined) {
        msg += ' ' + (_isPlainObj(secondArg) || Array.isArray(secondArg)
          ? JSON.stringify(secondArg) : String(secondArg));
      }
    }

    // Collect OTEL trace context from the active span
    const traceCtx = {};
    try {
      const span = trace.getActiveSpan();
      if (span) {
        const sc = span.spanContext();
        if (sc.traceId && !/^0+$/.test(sc.traceId)) {
          traceCtx.trace_id = sc.traceId;
          traceCtx.span_id  = sc.spanId;
        }
      }
    } catch { /* OTEL not initialised yet */ }

    const ts   = new Date().toISOString();
    const line = _json
      ? _jsonLine(level, ts, msg, this._ctx, fields, traceCtx)
      : _textLine(level, ts, msg, this._ctx, { ...fields, ...traceCtx });

    if (level === 'error' || level === 'warn') {
      process.stderr.write(line + '\n');
    } else {
      process.stdout.write(line + '\n');
    }
  }

  debug(msg, fields) { this._write('debug', msg, fields); }
  info(msg, fields)  { this._write('info',  msg, fields); }
  warn(msg, fields)  { this._write('warn',  msg, fields); }
  error(msg, fields) { this._write('error', msg, fields); }

  child(extra) { return new Logger({ ...this._ctx, ...extra }); }
}

function createLogger(ctx = {}) {
  return new Logger(ctx);
}

module.exports = { createLogger, Logger };
