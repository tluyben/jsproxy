'use strict';

/**
 * demo-backend — a simple HTTP server used in plugin demos.
 *
 * Routes:
 *   GET  /            echo request info as JSON
 *   GET  /hello       returns a backend greeting (overridden by hello-world plugin)
 *   GET  /api/v1/*    v1 API (should be rewritten to v2 by rewrite plugin)
 *   GET  /api/v2/*    v2 API (the actual target after rewrite)
 *   GET  /flaky       alternates between 200 and 500 on each request (for retry demo)
 *   GET  /health      always 200
 *
 * Usage:
 *   node plugins/demo-backend.js
 *   PORT=3000 node plugins/demo-backend.js
 */

const http = require('http');
const PORT = parseInt(process.env.PORT || '3000', 10);

let requestCount = 0;

http.createServer((req, res) => {
  requestCount++;
  const id = requestCount;
  console.log(`[backend #${id}] ${req.method} ${req.url}`);

  // Health
  if (req.url === '/health') {
    return send(res, 200, 'text/plain', 'OK');
  }

  // /hello — the hello-world plugin will replace this response
  if (req.url === '/hello' || req.url.startsWith('/hello?')) {
    return send(res, 200, 'text/plain',
      '(backend) Hi! You should see "Hello World!" if the hello-world plugin is active.\n');
  }

  // /api/v2/* — actual v2 endpoint (rewrite plugin sends requests here)
  if (req.url === '/api/v2' || req.url.startsWith('/api/v2/') || req.url.startsWith('/api/v2?')) {
    return send(res, 200, 'application/json', JSON.stringify({
      version: 'v2',
      path: req.url,
      note: 'You reached v2 — rewrite plugin worked!',
      receivedHeaders: {
        'x-api-version': req.headers['x-api-version'] || null,
        'x-rewritten-by': req.headers['x-rewritten-by'] || null,
      },
    }, null, 2));
  }

  // /api/v1/* — direct v1 endpoint (bypassed when rewrite plugin is active)
  if (req.url === '/api/v1' || req.url.startsWith('/api/v1/') || req.url.startsWith('/api/v1?')) {
    return send(res, 200, 'application/json', JSON.stringify({
      version: 'v1',
      path: req.url,
      note: 'You reached v1 directly — rewrite plugin is NOT active for this request.',
    }, null, 2));
  }

  // /flaky — alternates 200 / 500 for retry demo
  if (req.url === '/flaky' || req.url.startsWith('/flaky?')) {
    if (id % 2 === 0) {
      console.log(`[backend #${id}] /flaky → 500`);
      return send(res, 500, 'application/json', JSON.stringify({
        error: 'simulated failure',
        requestNumber: id,
      }, null, 2));
    }
    return send(res, 200, 'application/json', JSON.stringify({
      ok: true,
      requestNumber: id,
      note: 'retry plugin succeeded on this attempt',
    }, null, 2));
  }

  // Default: echo
  let body = '';
  req.on('data', d => (body += d));
  req.on('end', () => {
    send(res, 200, 'application/json', JSON.stringify({
      method: req.method,
      url: req.url,
      headers: req.headers,
      body: body || null,
    }, null, 2));
  });
}).listen(PORT, () => {
  console.log(`demo-backend listening on port ${PORT}`);
  console.log(`  Routes: / /hello /api/v1/* /api/v2/* /flaky /health`);
});

function send(res, status, type, body) {
  res.writeHead(status, { 'content-type': type, 'content-length': Buffer.byteLength(body) });
  res.end(body);
}
