'use strict';

/**
 * retry plugin
 *
 * When the backend returns a 5xx (or is unreachable → 502), retries the request
 * directly against the configured backend with exponential backoff.
 *
 * Environment variables:
 *   PORT          Plugin listen port         (default: 3003)
 *   BACKEND_URL   Backend to retry against   (default: http://localhost:3000)
 *   MAX_RETRIES   Max retry attempts         (default: 3)
 *   BASE_DELAY_MS First retry delay ms       (default: 200)
 *                 Subsequent delays: BASE_DELAY_MS * 2^attempt
 *
 * Usage:
 *   BACKEND_URL=http://localhost:3000 node plugins/retry.js
 *   PLUGIN=localhost:3003 node index.js
 *
 * How it works:
 *   /valid  → true for all requests (monitors everything)
 *   /before → saves request info (uri, method, headers, payload) keyed by requestId
 *   /after  → if statusCode ≥ 500, retries against BACKEND_URL with backoff;
 *             on success returns REWRITE_RESPONSE with the good response;
 *             on exhausted retries returns CONTINUE (passes through the error)
 */

const http = require('http');
const https = require('https');

const PORT = parseInt(process.env.PORT || '3003', 10);
const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3000';
const MAX_RETRIES = parseInt(process.env.MAX_RETRIES || '3', 10);
const BASE_DELAY_MS = parseInt(process.env.BASE_DELAY_MS || '200', 10);

const backendParsed = new URL(BACKEND_URL);
const backendLib = backendParsed.protocol === 'https:' ? https : http;
const backendPort = parseInt(backendParsed.port || (backendParsed.protocol === 'https:' ? '443' : '80'), 10);

// Stores request info between /before and /after calls.
// Each entry: { uri, method, headers, payload, ts }
// ts is used by the cleanup interval to evict stale entries (safety net).
const pending = new Map();

// Safety net: evict entries older than 2 minutes (covers dropped connections etc.)
const GC_INTERVAL = setInterval(() => {
  const cutoff = Date.now() - 120_000;
  for (const [id, info] of pending) {
    if (info.ts < cutoff) {
      pending.delete(id);
    }
  }
}, 60_000);
GC_INTERVAL.unref(); // don't keep the process alive just for this

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function doRequest(uri, method, headers, bodyBuf) {
  return new Promise((resolve, reject) => {
    const reqHeaders = Object.assign({}, headers, {
      host: `${backendParsed.hostname}:${backendPort}`,
    });
    if (bodyBuf && bodyBuf.length > 0) {
      reqHeaders['content-length'] = bodyBuf.length;
    } else {
      delete reqHeaders['content-length'];
    }

    const req = backendLib.request(
      {
        hostname: backendParsed.hostname,
        port: backendPort,
        path: uri,
        method,
        headers: reqHeaders,
        timeout: 10_000,
      },
      (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () =>
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks),
          })
        );
        res.on('error', reject);
      }
    );
    req.on('timeout', () => {
      req.destroy();
      const err = new Error('backend request timeout');
      err.code = 'ETIMEOUT';
      reject(err);
    });
    req.on('error', reject);
    if (bodyBuf && bodyBuf.length > 0) req.write(bodyBuf);
    req.end();
  });
}

http.createServer((req, res) => {
  let raw = '';
  req.on('data', d => (raw += d));
  req.on('end', async () => {
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      res.writeHead(400);
      return res.end('bad json');
    }

    try {
      if (req.url === '/valid') {
        // Monitor all requests
        return json(res, { valid: true });
      }

      if (req.url === '/before') {
        // Save request info for potential retry in /after
        pending.set(data.requestId, {
          uri: data.uri,
          method: data.method,
          headers: data.headers,
          payload: data.payload, // base64 or null
          ts: Date.now(),
        });
        return json(res, { result: 'CONTINUE' });
      }

      if (req.url === '/after') {
        const info = pending.get(data.requestId);
        pending.delete(data.requestId);

        // Only retry on 5xx
        if (data.statusCode < 500 || !info) {
          return json(res, { result: 'CONTINUE' });
        }

        const bodyBuf = info.payload ? Buffer.from(info.payload, 'base64') : Buffer.alloc(0);

        console.log(`[retry] ${info.method} ${info.uri} got ${data.statusCode} — retrying (max ${MAX_RETRIES})`);

        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
          const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
          console.log(`[retry] attempt ${attempt}/${MAX_RETRIES} after ${delay}ms`);
          await sleep(delay);

          try {
            const result = await doRequest(info.uri, info.method, info.headers, bodyBuf);
            console.log(`[retry] attempt ${attempt} → ${result.statusCode}`);

            if (result.statusCode < 500) {
              console.log(`[retry] success on attempt ${attempt}`);
              return json(res, {
                result: 'REWRITE_RESPONSE',
                statusCode: result.statusCode,
                headers: result.headers,
                payload: result.body.length > 0 ? result.body.toString('base64') : null,
              });
            }
            // 5xx again — keep trying
          } catch (err) {
            console.log(`[retry] attempt ${attempt} failed: ${err.message}`);
            // backend still down — keep trying
          }
        }

        console.log(`[retry] all ${MAX_RETRIES} retries exhausted — passing through error`);
        return json(res, { result: 'CONTINUE' });
      }

      res.writeHead(404);
      res.end();
    } catch (err) {
      console.error('[retry] plugin error:', err);
      json(res, { result: 'CONTINUE' }); // fail-open
    }
  });
}).listen(PORT, () => {
  console.log(`retry plugin listening on port ${PORT}`);
  console.log(`  Backend: ${BACKEND_URL}`);
  console.log(`  Max retries: ${MAX_RETRIES}, base delay: ${BASE_DELAY_MS}ms (exponential)`);
});

function json(res, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}
