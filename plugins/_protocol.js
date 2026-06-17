'use strict';

/**
 * Shared helpers for the jsproxy plugin wire protocol.
 *
 * Two shapes:
 *   /valid          — metadata only, carried as a small JSON request body.
 *   /before, /after — metadata in the `x-plugin-meta` header (compact JSON),
 *                     the payload as the RAW request/response body. No base64:
 *                     bodies stream through untouched, so a 100 MB upload costs
 *                     100 MB, not ~1 GB.
 *
 * Reply with the same shape: the decision verb goes in `x-plugin-result`,
 * verb-specific fields (statusCode, uri, method, headers) in `x-plugin-meta`,
 * and any rewritten payload as the raw response body.
 */

// Buffer + JSON-parse the small metadata body sent to /valid.
function readJson(req, cb) {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    try { cb(null, JSON.parse(Buffer.concat(chunks).toString() || '{}')); }
    catch (e) { cb(e); }
  });
}

// Read a /before or /after call: metadata from the header, payload buffered raw.
// The callback receives (err, meta, payloadBuffer). payloadBuffer is always a
// Buffer (zero-length when there is no body).
function readHook(req, cb) {
  let meta = {};
  try { meta = req.headers['x-plugin-meta'] ? JSON.parse(req.headers['x-plugin-meta']) : {}; }
  catch (e) { return cb(e); }
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => cb(null, meta, Buffer.concat(chunks)));
}

// Reply to /valid.
function sendValid(res, valid, needsBody = true) {
  const body = JSON.stringify({ valid, needsBody });
  res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

// Reply to /before or /after. `meta` carries the verb-specific fields
// (statusCode/uri/method/headers); `payload` is the raw body Buffer, or null to
// keep the original body.
function sendDecision(res, result, meta = {}, payload = null) {
  const body = payload && payload.length > 0
    ? (Buffer.isBuffer(payload) ? payload : Buffer.from(payload))
    : Buffer.alloc(0);
  res.writeHead(200, {
    'content-type': 'application/octet-stream',
    'content-length': body.length,
    'x-plugin-result': result,
    'x-plugin-meta': JSON.stringify(meta),
  });
  res.end(body);
}

module.exports = { readJson, readHook, sendValid, sendDecision };
