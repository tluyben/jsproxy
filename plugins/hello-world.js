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
const { readJson, readHook, sendValid, sendDecision } = require('./_protocol');
const PORT = parseInt(process.env.PORT || '3001', 10);

http.createServer((req, res) => {
  if (req.url === '/valid') {
    return readJson(req, (err, data) => {
      if (err) { res.writeHead(400); return res.end('bad json'); }
      // Only interested in /hello (with or without query string).
      // needsBody:false — we never read the client's body; the "Hello World!"
      // reply is produced here, so the proxy streams (no buffering) and still
      // honors our REWRITE_RESPONSE payload.
      const interested = data.uri === '/hello' || data.uri.startsWith('/hello?') || data.uri.startsWith('/hello/');
      sendValid(res, interested, false);
    });
  }

  if (req.url === '/before') {
    // Let the request reach the backend normally — we override in /after
    return readHook(req, () => sendDecision(res, 'CONTINUE'));
  }

  if (req.url === '/after') {
    // Replace whatever the backend returned with a plain Hello World
    return readHook(req, () => sendDecision(
      res,
      'REWRITE_RESPONSE',
      { statusCode: 200, headers: { 'content-type': 'text/plain' } },
      Buffer.from('Hello World!\n'),
    ));
  }

  res.writeHead(404);
  res.end();
}).listen(PORT, () => {
  console.log(`hello-world plugin listening on port ${PORT}`);
  console.log(`  Intercepts: GET /hello → "Hello World!"`);
});
