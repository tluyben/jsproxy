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
      const interested = RULES.some(r => r.match(data.uri, data.method));
      return json(res, { valid: interested });
    }

    if (req.url === '/before') {
      const rule = RULES.find(r => r.match(data.uri, data.method));
      if (!rule) return json(res, { result: 'CONTINUE' });

      const rewritten = rule.rewrite(data);
      return json(res, { result: 'REWRITE_REQUEST', ...rewritten });
    }

    if (req.url === '/after') {
      return json(res, { result: 'CONTINUE' });
    }

    res.writeHead(404);
    res.end();
  });
}).listen(PORT, () => {
  console.log(`rewrite plugin listening on port ${PORT}`);
  console.log(`  Rule: /api/v1/* → /api/v2/*`);
});

function json(res, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}
