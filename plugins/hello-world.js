'use strict';

/**
 * hello-world plugin
 *
 * Intercepts any request to /hello (regardless of what the backend would return)
 * and responds with "Hello World!". All other routes are ignored entirely.
 *
 * Usage:
 *   node plugins/hello-world.js
 *   PLUGIN=localhost:3001 node index.js
 */

const http = require('http');
const PORT = parseInt(process.env.PORT || '3001', 10);

http.createServer((req, res) => {
  let raw = '';
  req.on('data', d => (raw += d));
  req.on('end', () => {
    let data;
    try {
      data = JSON.parse(raw);
    } catch {
      res.writeHead(400);
      return res.end('bad json');
    }

    if (req.url === '/valid') {
      // Only interested in /hello (with or without query string)
      const interested = data.uri === '/hello' || data.uri.startsWith('/hello?') || data.uri.startsWith('/hello/');
      return json(res, { valid: interested, needsBody: false });
    }

    if (req.url === '/before') {
      // Let the request reach the backend normally — we override in /after
      return json(res, { result: 'CONTINUE' });
    }

    if (req.url === '/after') {
      // Replace whatever the backend returned with a plain Hello World
      return json(res, {
        result: 'REWRITE_RESPONSE',
        statusCode: 200,
        headers: { 'content-type': 'text/plain' },
        payload: b64('Hello World!\n'),
      });
    }

    res.writeHead(404);
    res.end();
  });
}).listen(PORT, () => {
  console.log(`hello-world plugin listening on port ${PORT}`);
  console.log(`  Intercepts: GET /hello → "Hello World!"`);
});

function json(res, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function b64(str) {
  return Buffer.from(str).toString('base64');
}
