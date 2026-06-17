'use strict';

/**
 * rewrite plugin
 *
 * Rewrites requests before they reach the backend. Ships with one example rule:
 * /api/v1/* → /api/v2/* plus an x-api-version header.
 *
 * Add or modify RULES below to suit your needs.
 *
 * Usage:
 *   node plugins/rewrite.js
 *   PLUGIN=localhost:3002 node index.js
 */

const http = require('http');
const { readJson, readHook, sendValid, sendDecision } = require('./_protocol');
const PORT = parseInt(process.env.PORT || '3002', 10);

/**
 * Rewrite rules. Evaluated in order; first match wins.
 *
 * Each rule:
 *   match(uri, method)  - return true if this rule applies
 *   rewrite(data)       - return partial REWRITE_REQUEST fields (null = keep original)
 */
const RULES = [
  {
    // Rewrite /api/v1/* → /api/v2/* and stamp a version header
    match: (uri) => uri === '/api/v1' || uri.startsWith('/api/v1/') || uri.startsWith('/api/v1?'),
    rewrite: (data) => ({
      uri: data.uri.replace(/^\/api\/v1/, '/api/v2'),
      method: null,    // keep original
      headers: Object.assign({}, data.headers, {
        'x-api-version': '2',
        'x-rewritten-by': 'jsproxy-rewrite',
      }),
      payload: null,   // keep original body
    }),
  },

  // Add more rules here:
  // {
  //   match: (uri, method) => method === 'DELETE' && uri.startsWith('/protected'),
  //   rewrite: () => ({ uri: null, method: null, headers: null, payload: null,
  //                     // returning all nulls is the same as CONTINUE but you could CANCEL instead
  //                   }),
  // },
];

http.createServer((req, res) => {
  if (req.url === '/valid') {
    return readJson(req, (err, data) => {
      if (err) { res.writeHead(400); return res.end('bad json'); }
      const interested = RULES.some(r => r.match(data.uri, data.method));
      sendValid(res, interested, false);
    });
  }

  if (req.url === '/before') {
    return readHook(req, (err, meta) => {
      if (err) { res.writeHead(400); return res.end('bad meta'); }
      const rule = RULES.find(r => r.match(meta.uri, meta.method));
      if (!rule) return sendDecision(res, 'CONTINUE');

      const rw = rule.rewrite(meta);   // { uri, method, headers, payload }
      sendDecision(
        res,
        'REWRITE_REQUEST',
        { uri: rw.uri, method: rw.method, headers: rw.headers },
        rw.payload != null ? Buffer.from(rw.payload) : null,
      );
    });
  }

  if (req.url === '/after') {
    return readHook(req, () => sendDecision(res, 'CONTINUE'));
  }

  res.writeHead(404);
  res.end();
}).listen(PORT, () => {
  console.log(`rewrite plugin listening on port ${PORT}`);
  console.log(`  Rule: /api/v1/* → /api/v2/*`);
});
