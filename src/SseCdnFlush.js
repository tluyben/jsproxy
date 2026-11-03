'use strict';
// A CDN in front of us (Bunny, 2026-11-03) holds the LAST segment it received
// from the origin until the origin writes more bytes. For an SSE feed that
// means every event's closing blank line waits for the next event (or ping):
// a 38 KB war-room snapshot reached the browser after 15 s, not 0.2 s, and the
// page sat on "CONNECTING…".
//
// The fix: once a text/event-stream response goes idle right after a complete
// event (the bytes written so far end in a blank line), write one SSE comment
// line `:\n` as its own write. The CDN then holds those 2 bytes instead of the
// event. A comment line is ignored by EventSource and, with no blank line after
// it, never dispatches an empty event. Nothing is injected mid-event or into a
// compressed body.
//
// SSE_CDN_FLUSH_MS: idle delay before the comment (default 25 ms); 0 disables.
const { Transform } = require('stream');

const COMMENT = Buffer.from(':\n');

function flushDelayMs() {
  const v = parseInt(process.env.SSE_CDN_FLUSH_MS ?? '25', 10);
  return Number.isFinite(v) && v >= 0 ? v : 25;
}

// True when the bytes so far end an SSE event (blank line, any of the three
// line terminators the spec allows).
function endsEvent(tail) {
  const s = tail.toString('latin1');
  return s.endsWith('\n\n') || s.endsWith('\r\n\r\n') || s.endsWith('\r\r');
}

class SseCdnFlush extends Transform {
  constructor(delayMs = flushDelayMs()) {
    super();
    this.delayMs = delayMs;
    this.tail = Buffer.alloc(0);
    this.timer = null;
  }

  _transform(chunk, _enc, cb) {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.push(chunk);
    this.tail = Buffer.concat([this.tail, chunk.subarray(Math.max(0, chunk.length - 4))]).subarray(-4);
    if (endsEvent(this.tail)) {
      this.timer = setTimeout(() => {
        this.timer = null;
        if (this.destroyed || this.writableEnded) return;
        this.push(COMMENT);
        this.tail = COMMENT;
      }, this.delayMs);
      this.timer.unref?.();
    }
    cb();
  }

  _flush(cb) {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    cb();
  }

  _destroy(err, cb) {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    cb(err);
  }
}

// Should this response get the flush comments? Only a plain (uncompressed)
// text/event-stream, and only while the feature is on.
function wantsSseFlush(headers) {
  if (flushDelayMs() === 0 || !headers) return false;
  const type = String(headers['content-type'] ?? headers['Content-Type'] ?? '');
  const enc = String(headers['content-encoding'] ?? headers['Content-Encoding'] ?? '').trim().toLowerCase();
  return /text\/event-stream/i.test(type) && (enc === '' || enc === 'identity');
}

// Pipe a backend response body to the client, adding the flush comments to an
// SSE feed. Errors and 'end' are still observed on `src` by the callers.
function pipeBody(src, res, headers) {
  if (!wantsSseFlush(headers)) return src.pipe(res);
  const flush = new SseCdnFlush();
  res.once('close', () => flush.destroy());
  src.on('error', () => flush.destroy());
  return src.pipe(flush).pipe(res);
}

module.exports = { SseCdnFlush, pipeBody, wantsSseFlush, endsEvent };
