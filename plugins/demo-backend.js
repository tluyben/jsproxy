'use strict';

/**
 * demo-backend — a simple HTTP server used in plugin demos.
 *
 * Routes:
 *   GET  /                  echo request info as JSON
 *   GET  /hello             returns a backend greeting (overridden by hello-world plugin)
 *   GET  /api/v1/*          v1 API (should be rewritten to v2 by rewrite plugin)
 *   GET  /api/v2/*          v2 API (the actual target after rewrite)
 *   GET  /flaky             alternates between 200 and 500 on each request (for retry demo)
 *   GET  /api/users         user list with PII fields (pii demo)
 *   GET  /api/user/profile  single user profile with PII (pii demo)
 *   POST /api/register      echoes registration body back (pii demo — request scrubbing)
 *   POST /api/orders        echoes order body back (pii demo — nested PII in shipping)
 *   GET  /api/slow          artificial 500ms delay (telemetry demo — latency)
 *   GET  /api/crash         always returns 500 (telemetry demo — error spans)
 *   GET  /health            always 200
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

  // ── telemetry demo routes ─────────────────────────────────────────────────

  // /api/slow — artificial 500ms delay (demonstrates latency capture in telemetry plugin)
  if (req.url === '/api/slow' || req.url.startsWith('/api/slow?')) {
    return setTimeout(() => {
      send(res, 200, 'application/json', JSON.stringify({
        ok: true,
        note: 'This response was delayed 500ms — check the latency in the telemetry span.',
        delayMs: 500,
      }, null, 2));
    }, 500);
  }

  // /api/crash — always 500 (demonstrates error span in telemetry plugin)
  if (req.url === '/api/crash' || req.url.startsWith('/api/crash?')) {
    console.log(`[backend #${id}] /api/crash → 500`);
    return send(res, 500, 'application/json', JSON.stringify({
      error: 'simulated crash',
      note: 'telemetry plugin will emit this as an error span',
    }, null, 2));
  }

  // ── pii demo routes ───────────────────────────────────────────────────────

  // /api/users — user list with PII (response scrubbed by pii plugin)
  if (req.url === '/api/users' || req.url.startsWith('/api/users?')) {
    return send(res, 200, 'application/json', JSON.stringify({
      users: [
        { id: 1, name: 'Jane Doe',     email: 'jane@real-company.com',  phone: '555-867-5309', username: 'jdoe' },
        { id: 2, name: 'John Smith',   email: 'john@real-company.com',  phone: '555-321-7654', username: 'jsmith' },
        { id: 3, name: 'Alice Walker', email: 'alice@real-company.com', phone: '555-111-2222', username: 'awalker' },
      ],
    }, null, 2));
  }

  // /api/user/profile — single user profile with rich PII (response scrubbed by pii plugin)
  if (req.url === '/api/user/profile' || req.url.startsWith('/api/user/profile?')) {
    return send(res, 200, 'application/json', JSON.stringify({
      id: 42,
      name: 'Jane Doe',
      email: 'jane.doe@real-company.com',
      username: 'janedoe',
      phone: '555-867-5309',
      dob: '1990-04-15',
      ssn: '123-45-6789',
      address: '742 Evergreen Terrace',
      city: 'Springfield',
      state: 'IL',
      zip: '62701',
      country: 'US',
      ip_address: '203.0.113.42',
      avatar: 'https://cdn.real-company.com/avatars/jane.jpg',
      payment: {
        card_number: '4111111111111111',
        cvv: '737',
        billing_address: '742 Evergreen Terrace',
      },
    }, null, 2));
  }

  // /api/register — POST: echoes the request body back so you can see what the backend received
  // The pii plugin scrubs the request body before it arrives here.
  if (req.url === '/api/register' || req.url.startsWith('/api/register')) {
    let body = '';
    req.on('data', d => (body += d));
    return req.on('end', () => {
      let parsed = null;
      try { parsed = JSON.parse(body); } catch {}
      send(res, 200, 'application/json', JSON.stringify({
        ok: true,
        note: 'Backend received this body — PII should be scrubbed if the plugin is active.',
        receivedBody: parsed || body || null,
      }, null, 2));
    });
  }

  // /api/orders — POST: echoes nested order body (shipping/billing PII) back
  if (req.url === '/api/orders' || req.url.startsWith('/api/orders')) {
    let body = '';
    req.on('data', d => (body += d));
    return req.on('end', () => {
      let parsed = null;
      try { parsed = JSON.parse(body); } catch {}
      send(res, 200, 'application/json', JSON.stringify({
        ok: true,
        note: 'Backend received this order — customer/shipping PII should be scrubbed.',
        receivedOrder: parsed || body || null,
      }, null, 2));
    });
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
  console.log(`  Routes: / /hello /api/v1/* /api/v2/* /flaky`);
  console.log(`          /api/users /api/user/profile /api/register /api/orders`);
  console.log(`          /api/slow /api/crash /health`);
});

function send(res, status, type, body) {
  res.writeHead(status, { 'content-type': type, 'content-length': Buffer.byteLength(body) });
  res.end(body);
}
