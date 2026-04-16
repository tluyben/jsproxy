# jsproxy Plugin System

Plugins let you intercept and transform requests and responses without touching jsproxy's
core. Each plugin is a plain HTTP server (any language, any framework) that jsproxy calls
on every request.

**When `PLUGIN` is not set, the code path is identical to the previous jsproxy — zero overhead.**

---

## Configuration

```bash
PLUGIN=localhost:3001                         # single plugin
PLUGIN=localhost:3001,localhost:3002          # chain of two plugins (called in order)
```

Set in `.env` or on the command line. Paths are `host:port`.

An optional timeout can be set:

```bash
PLUGIN_TIMEOUT=5000    # ms before a plugin call is abandoned (default: 5000)
                       # on timeout the plugin is treated as CONTINUE (fail-open)
```

---

## How it works

For every request that has a matching jsproxy mapping, the flow is:

```
1. POST /valid  → all plugins in parallel (no payload, no base64)
                  each plugin returns { valid: true|false }
                  if ALL return false → skip plugins entirely, proxy normally

2. Buffer request body  (only if ≥1 plugin returned true)

3. POST /before → interested plugins in order
                  first non-CONTINUE result wins

4. Forward to backend  (with any REWRITE_REQUEST applied)

5. Buffer response body (only if ≥1 plugin returned true)

6. POST /after  → interested plugins in order
                  first non-CONTINUE result wins

7. Send response to client  (with any REWRITE_RESPONSE applied)
```

`/after` is called even when the backend is unreachable (jsproxy passes `statusCode: 502`
and an empty payload), so plugins can catch and rewrite backend-down errors.

---

## HTTP API

### `POST /valid`

Called first on every request, to all plugins **in parallel**. Lightweight — no headers,
no body. Use this to opt in/out of intercepting a particular request.

**Request body:**
```json
{
  "requestId": "550e8400-e29b-41d4-a716-446655440000",
  "domain":    "example.com",
  "inPort":    8080,
  "uri":       "/api/users?page=2",
  "method":    "GET"
}
```

`domain` and `inPort` are the **frontend** domain and port the client connected to on
jsproxy (not the backend). This lets you filter by virtual host.

**Response:**
```json
{ "valid": true }
```
```json
{ "valid": false }
```

A plugin that returns `false` (or times out) is excluded from `/before` and `/after` for
this request. If **all** plugins return `false`, jsproxy proxies the request normally with
no buffering.

---

### `POST /before`

Called after `/valid` (to interested plugins only), **before** the request is forwarded
to the backend. Plugins are called in the order listed in `PLUGIN`.

**Request body:**
```json
{
  "requestId": "550e8400-e29b-41d4-a716-446655440000",
  "domain":    "example.com",
  "inPort":    8080,
  "uri":       "/api/users?page=2",
  "method":    "GET",
  "headers":   { "accept": "application/json", "host": "example.com" },
  "payload":   "<base64-encoded request body, or null>"
}
```

**Response options:**

```json
{ "result": "CONTINUE" }
```
Proceed to the next plugin. If this is the last plugin, forward to the backend normally.

```json
{ "result": "IGNORE" }
```
Forward to the backend unchanged **and skip `/after` entirely** for this request.
Use this when you've already done everything you need in `/before` and there's nothing
to inspect in the response.

```json
{ "result": "CANCEL", "statusCode": 403 }
```
Do not forward to the backend. Respond to the client with the given status and an empty body.

```json
{
  "result":  "REWRITE_REQUEST",
  "uri":     "/api/v2/users?page=2",
  "method":  null,
  "headers": { "accept": "application/json", "x-internal": "1" },
  "payload": null
}
```
Forward to the backend with the supplied values. Any field set to `null` (or omitted)
keeps the original value. `/after` will still be called.

---

### `POST /after`

Called after the backend responds (to interested plugins only). Plugins are called in order.

**Request body:**
```json
{
  "requestId":  "550e8400-e29b-41d4-a716-446655440000",
  "domain":     "example.com",
  "inPort":     8080,
  "statusCode": 200,
  "headers":    { "content-type": "application/json" },
  "payload":    "<base64-encoded response body, or null>"
}
```

When the backend is unreachable, jsproxy calls `/after` with `statusCode: 502` and
`payload: null`, giving plugins a chance to produce a fallback response.

**Response options:**

```json
{ "result": "CONTINUE" }
```
Send the backend response to the client unchanged.

```json
{ "result": "CANCEL", "statusCode": 503 }
```
Discard the backend response. Respond to the client with the given status and empty body.

```json
{
  "result":     "REWRITE_RESPONSE",
  "statusCode": 200,
  "headers":    { "content-type": "application/json" },
  "payload":    "<base64>"
}
```
Send the supplied values to the client instead of the backend response.
Any field set to `null` (or omitted) keeps the original backend value.

---

## Plugin chaining

When multiple plugins are listed in `PLUGIN`:

- `/valid` is called on all of them **in parallel**
- `/before` and `/after` are called **in order** on the plugins that returned `valid: true`
- The **first non-CONTINUE result** wins; remaining plugins are skipped for that phase

Example with three plugins where plugin 2 returns CANCEL from `/before`:

```
/valid → [plugin1: true, plugin2: true, plugin3: true]
/before plugin1 → CONTINUE
/before plugin2 → CANCEL 403       ← wins; plugin3 /before is NOT called
→ client receives 403; /after is NOT called for anyone
```

---

## Memory and performance

- **No plugins configured**: zero overhead — no Map entries, no UUIDs, no HTTP calls.
- **Plugins configured, none interested** (`/valid` all returned false): one parallel fan-out
  to `/valid`, no buffering, normal proxy path.
- **Plugins interested**: request and response bodies are buffered in memory as local
  variables for the duration of the request and freed when the function returns.
  No buffers are stored globally.
- **Per-request state** (just a `{ ignore, interested[] }` entry) is cleaned up as soon
  as `/after` completes, or immediately for IGNORE/CANCEL. A `res.on('close')` handler
  is the unconditional safety net for dropped connections.

---

## Included example plugins

All live in `plugins/`. Start each with `node plugins/<name>.js`.

| Plugin | Port | What it does |
|---|---|---|
| `hello-world.js` | 3001 | Rewrites any `/hello` response to "Hello World!" |
| `rewrite.js` | 3002 | Rewrites `/api/v1/*` requests to `/api/v2/*` |
| `retry.js` | 3003 | Retries 5xx responses against the backend with exponential backoff |
| `telemetry.js` | 3004 | Captures per-request spans; emits to console, webhook, OTEL, or Sentry |
| `pii.js` | 3005 | Detects and scrubs PII fields in JSON bodies (mock or redact mode) |
| `demo-backend.js` | 3000 | Test backend with routes for each demo |

---

## Demo: hello-world

The hello-world plugin intercepts requests to `/hello` and replaces whatever the backend
returned with "Hello World!".

### Setup

**Terminal 1 — backend:**
```bash
node plugins/demo-backend.js
```

**Terminal 2 — plugin:**
```bash
node plugins/hello-world.js
```

**Terminal 3 — jsproxy:**
```bash
# Add a mapping: localhost → port 3000
node scripts/add-mapping.js localhost 3000

PLUGIN=localhost:3001 node index.js
```

### Curl examples

```bash
# /hello is intercepted — backend response is replaced
curl http://localhost:8080/hello
# → Hello World!

# /hello with query string is also intercepted
curl "http://localhost:8080/hello?name=test"
# → Hello World!

# Any other route reaches the backend normally
curl http://localhost:8080/
# → {"method":"GET","url":"/", ...}

# Without the plugin, /hello returns the backend response
curl http://localhost:8080/hello
# → (backend) Hi! You should see "Hello World!" if the hello-world plugin is active.
```

### Verify /valid is working (plugin is skipped for non-/hello routes)

```bash
# Check jsproxy logs — you'll see no /before or /after calls for non-/hello routes
curl http://localhost:8080/api/something
# → backend echoes the request; plugin was not involved
```

---

## Demo: rewrite

The rewrite plugin transparently rewrites all `/api/v1/*` requests to `/api/v2/*` and
adds a couple of headers so the backend knows a rewrite happened.

### Setup

**Terminal 1 — backend:**
```bash
node plugins/demo-backend.js
```

**Terminal 2 — plugin:**
```bash
node plugins/rewrite.js
```

**Terminal 3 — jsproxy:**
```bash
node scripts/add-mapping.js localhost 3000
PLUGIN=localhost:3002 node index.js
```

### Curl examples

```bash
# Client requests /api/v1/users — plugin rewrites to /api/v2/users
curl http://localhost:8080/api/v1/users
# → {"version":"v2","path":"/api/v2/users","note":"You reached v2 — rewrite plugin worked!",...}

# The x-api-version and x-rewritten-by headers are visible in the response
curl -v http://localhost:8080/api/v1/users 2>&1 | grep x-

# Paths with query strings are rewritten correctly
curl "http://localhost:8080/api/v1/items?page=3&limit=10"
# → {"version":"v2","path":"/api/v2/items?page=3&limit=10",...}

# /api/v2 directly reaches v2 without the plugin (plugin only fires on /valid for v1)
curl http://localhost:8080/api/v2/users
# → {"version":"v2","path":"/api/v2/users",...}

# Non-/api/v1 routes are completely unaffected (plugin returns valid: false)
curl http://localhost:8080/health
# → OK
```

---

## Demo: retry

The retry plugin watches all requests. When the backend returns a 5xx (or is down → 502),
it retries the request directly against the configured backend with exponential backoff.

The demo-backend's `/flaky` endpoint alternates between 200 and 500 on each request.
The retry plugin will retry the 500 until it gets a 200.

### Setup

**Terminal 1 — backend:**
```bash
node plugins/demo-backend.js
```

**Terminal 2 — plugin:**
```bash
BACKEND_URL=http://localhost:3000 node plugins/retry.js
```

**Terminal 3 — jsproxy:**
```bash
node scripts/add-mapping.js localhost 3000
PLUGIN=localhost:3003 node index.js
```

### Curl examples

```bash
# /flaky alternates 200/500 at the backend, but the plugin retries — you always get 200
curl http://localhost:8080/flaky
# → {"ok":true,"requestNumber":...,"note":"retry plugin succeeded on this attempt"}

# Run several times — the backend logs will show attempts but the client always sees 200
for i in $(seq 1 6); do curl -s http://localhost:8080/flaky | python3 -m json.tool; done

# Watch the plugin terminal for retry log lines:
# [retry] GET /flaky got 500 — retrying (max 3)
# [retry] attempt 1/3 after 200ms
# [retry] attempt 1 → 200
# [retry] success on attempt 1

# Simulate backend fully down: stop demo-backend, then:
curl http://localhost:8080/flaky
# Plugin retries 3 times (200ms, 400ms, 800ms), then passes through the 502
# Watch plugin terminal: "all 3 retries exhausted — passing through error"
```

### Tune retry behaviour

```bash
MAX_RETRIES=5 BASE_DELAY_MS=100 BACKEND_URL=http://localhost:3000 node plugins/retry.js
# → retry plugin listening on port 3003
#   Backend: http://localhost:3000
#   Max retries: 5, base delay: 100ms (exponential)
```

---

## Demo: chaining plugins

Run hello-world and rewrite together. `/valid` is called to both in parallel; each only
fires for the routes it cares about.

### Setup

```bash
# Terminal 1
node plugins/demo-backend.js

# Terminal 2
node plugins/hello-world.js         # port 3001

# Terminal 3
node plugins/rewrite.js             # port 3002

# Terminal 4
node scripts/add-mapping.js localhost 3000
PLUGIN=localhost:3001,localhost:3002 node index.js
```

### Curl examples

```bash
# hello-world intercepts /hello
curl http://localhost:8080/hello
# → Hello World!

# rewrite transforms /api/v1/*
curl http://localhost:8080/api/v1/products
# → {"version":"v2","path":"/api/v2/products",...}

# /other is not claimed by either plugin — direct proxy, no buffering
curl http://localhost:8080/
# → {"method":"GET","url":"/", ...}
```

---

## Writing your own plugin

Any HTTP server that handles POST requests to `/valid`, `/before`, and `/after` works.
Both methods are optional — if you only need `/before`, you can return `CONTINUE` from
`/after` (or omit it and rely on the timeout fail-open).

### Minimal Node.js template

```js
'use strict';
const http = require('http');

http.createServer((req, res) => {
  let raw = '';
  req.on('data', d => (raw += d));
  req.on('end', () => {
    const data = JSON.parse(raw);

    if (req.url === '/valid') {
      // Return true for the routes you want to intercept
      return json(res, { valid: data.uri.startsWith('/my-route') });
    }

    if (req.url === '/before') {
      // Inspect or modify the request
      console.log(data.requestId, data.method, data.uri);
      return json(res, { result: 'CONTINUE' });
    }

    if (req.url === '/after') {
      // Inspect or modify the response
      if (data.statusCode >= 500) {
        return json(res, {
          result: 'REWRITE_RESPONSE',
          statusCode: 503,
          headers: { 'content-type': 'application/json' },
          payload: Buffer.from(JSON.stringify({ error: 'unavailable' })).toString('base64'),
        });
      }
      return json(res, { result: 'CONTINUE' });
    }

    res.writeHead(404); res.end();
  });
}).listen(3099, () => console.log('my-plugin on 3099'));

function json(res, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}
```

### Reading and writing payloads (base64)

```js
// Decode incoming payload
const buf = data.payload ? Buffer.from(data.payload, 'base64') : Buffer.alloc(0);
const text = buf.toString('utf8');

// Encode outgoing payload
const responsePayload = Buffer.from(JSON.stringify({ hello: 'world' })).toString('base64');
```

### Accessing original request context in /after

If you need request info (uri, method, headers) inside `/after`, save it in `/before`
keyed by `requestId`. Clean up in `/after`. See `plugins/retry.js` for a full example
including a safety-net GC interval for dropped connections.

```js
const state = new Map(); // requestId → saved info

// /before
state.set(data.requestId, { uri: data.uri, ts: Date.now() });
return json(res, { result: 'CONTINUE' });

// /after
const saved = state.get(data.requestId);
state.delete(data.requestId);
// use saved.uri ...
```
