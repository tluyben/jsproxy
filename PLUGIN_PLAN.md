# Plugin System Implementation Plan

## Overview

Add a plugin system to jsproxy that allows intercepting and transforming requests/responses
via external HTTP services. Each plugin is a local HTTP server; jsproxy calls its `/before`
and `/after` endpoints as requests flow through the proxy.

Without `PLUGIN` configured, the code path is identical to the current jsproxy — zero overhead.

---

## Configuration

```
PLUGIN=localhost:3001,localhost:3002
```

- Comma-separated list of `host:port` values
- Called in order for every proxied request
- Loaded/validated at startup (jsproxy will warn if a plugin is unreachable, but won't refuse to start)

---

## Request flow

```
Incoming request
  → [jsproxy mapping/IP lookup — unchanged]
  → POST /valid to all plugins in parallel (no payload, no buffering)
      → plugins that return false are skipped entirely for this request
      → if ALL return false: no buffering, no before/after — identical to no-plugin path
  → buffer request body (only if ≥1 plugin returned true)
  → POST /before on interested plugins in order; first non-CONTINUE wins
  → forward to backend
  → buffer response body (only if ≥1 plugin returned true)
  → POST /after on interested plugins in order; first non-CONTINUE wins
  → send response to client
```

---

## HTTP API — `/valid`

Called on **all plugins in parallel** immediately after mapping lookup, before any buffering.
Payload is minimal — no headers, no body.

**jsproxy → plugin:**

```
POST /valid
Content-Type: application/json

{
  "requestId": "550e8400-e29b-41d4-a716-446655440000",
  "domain":    "example.com",
  "inPort":    443,
  "uri":       "/api/users?page=2",
  "method":    "GET"
}
```

**plugin → jsproxy:**

```json
{ "valid": true }
```
```json
{ "valid": false }
```

If a plugin returns `false` (or times out / errors), it is excluded from the `/before` and
`/after` chain for this request. If **all** plugins return `false`, jsproxy skips buffering
entirely and the request proceeds as if no plugins are configured.

---

## HTTP API — `/before`

**jsproxy → plugin:**

```
POST /before
Content-Type: application/json

{
  "requestId":  "550e8400-e29b-41d4-a716-446655440000",
  "domain":     "example.com",
  "inPort":     443,
  "uri":        "/api/users?page=2",
  "method":     "GET",
  "headers":    { "accept": "application/json", ... },
  "payload":    "<base64-encoded body, or null>"
}
```

`domain` and `inPort` are the frontend domain and port the client connected to on jsproxy
(not the backend). This lets plugins make routing/auth decisions based on the virtual host.

**plugin → jsproxy:**

```json
{ "result": "CONTINUE" }

{ "result": "IGNORE" }

{ "result": "CANCEL", "statusCode": 403 }

{
  "result":   "REWRITE_REQUEST",
  "uri":      "/internal/users?page=2",
  "method":   "GET",
  "headers":  { "x-internal": "1" },
  "payload":  "<base64 or null>"
}
```

Any field in `REWRITE_REQUEST` that is `null` (or omitted) retains its original value.

---

## HTTP API — `/after`

**jsproxy → plugin:**

```
POST /after
Content-Type: application/json

{
  "requestId":  "550e8400-e29b-41d4-a716-446655440000",
  "domain":     "example.com",
  "inPort":     443,
  "statusCode": 200,
  "headers":    { "content-type": "application/json", ... },
  "payload":    "<base64-encoded response body>"
}
```

`/after` is also called when the backend is unreachable — in that case jsproxy supplies
`statusCode: 502` with an empty payload, giving the plugin a chance to rewrite the error.

**plugin → jsproxy:**

```json
{ "result": "CONTINUE" }

{ "result": "CANCEL", "statusCode": 503 }

{
  "result":     "REWRITE_RESPONSE",
  "statusCode": 200,
  "headers":    { "content-type": "application/json" },
  "payload":    "<base64>"
}
```

Any field in `REWRITE_RESPONSE` that is `null` (or omitted) retains its original value.

---

## Result semantics

| Result | `before` | `after` |
|---|---|---|
| `CONTINUE` | proceed, pass through unchanged | proceed, send backend response unchanged |
| `IGNORE` | proceed unchanged, **skip `after()` for this request** | n/a |
| `CANCEL` | do not forward to backend, respond with given status + empty body | discard backend response, respond with given status + empty body |
| `REWRITE_REQUEST` | forward to backend with supplied values | n/a |
| `REWRITE_RESPONSE` | n/a | send supplied values to client |

First non-CONTINUE result from any plugin in the chain wins; remaining plugins are skipped.

`IGNORE` from any plugin in the `/before` chain means `/after` is not called for that
request at all (on any plugin).

---

## Memory safety

Per-request state in jsproxy is only the `requestId` → `{ ignore: bool }` entry in a Map.
No buffers are stored there. The lifecycle:

- Map entry is created when `requestId` is generated
- `res.once('close', () => pluginManager.cleanup(requestId))` is registered immediately —
  this fires in every termination case (normal finish, client disconnect, socket reset,
  timeout) and is the unconditional backstop
- `cleanup()` is idempotent (`Map.delete`) — early exits (IGNORE, CANCEL, end of `/after`)
  also call it explicitly so the entry is gone as soon as possible
- Request body and response body buffers are local variables in `handleRequest`; they go
  out of scope and are GC-eligible as soon as the function returns

---

## New file: `src/PluginManager.js`

1. **`load()`** — parse `PLUGIN` env var, build list of `{ host, port }` entries, optionally
   ping each one to warn on startup if unreachable
2. **`register(requestId)`** — insert `{ ignore: false, interested: [] }` into Map
3. **`runValid(requestId, domain, inPort, uri, method)`** — POST `/valid` to all plugins
   **in parallel**, collect the ones that returned `true` into `interested[]` on the Map entry.
   Returns whether any plugin is interested (i.e. whether buffering is needed).
4. **`runBefore(requestId, domain, inPort, req, bodyBuffer)`** — POST `/before` to interested
   plugins in order, interpret result, call `cleanup()` on IGNORE/CANCEL before returning
5. **`runAfter(requestId, domain, inPort, statusCode, headers, bodyBuffer)`** — POST `/after`
   to interested plugins in order; no-op if `ignore` is set, calls `cleanup()` before returning
6. **`cleanup(requestId)`** — idempotent `Map.delete`

HTTP calls to plugins use Node's built-in `http` module (no extra dependency). A
reasonable hardcoded timeout (e.g. 5 s) prevents a hung plugin from stalling requests;
on timeout, fail-open (treat as CONTINUE) and log a warning.

---

## Changes to `ProxyServer.js`

- **Constructor**: accept optional `pluginManager` (defaults to no-op stub — zero overhead
  when `PLUGIN` is not set)
- **`handleRequest`**: generate `requestId`, register it, attach `res.once('close', cleanup)`,
  call `runValid` (if any plugins configured), buffer request body **only if** `runValid`
  returned true, call `runBefore`, handle result, forward (with buffer re-piped if needed),
  buffer response via `proxyRes` listener **only if** `runValid` returned true, call `runAfter`,
  handle result
- **Error path (502)**: call `runAfter` with `statusCode: 502` and empty payload so plugins
  can rewrite backend-down errors

---

## Changes to `index.js`

```js
const PluginManager = require('./src/PluginManager');
const pluginManager = new PluginManager(process.env.PLUGIN);
await pluginManager.load();
const server = new ProxyServer(db, certManager, pluginManager);
```

---

## Example plugin (Node.js)

```js
const http = require('http');

http.createServer((req, res) => {
  let body = '';
  req.on('data', d => body += d);
  req.on('end', () => {
    const data = JSON.parse(body);

    if (req.url === '/valid') {
      // only interested in /admin requests
      return respond(res, { valid: data.uri.startsWith('/admin') });
    }

    if (req.url === '/before') {
      if (!data.headers['x-internal-token']) {
        return respond(res, { result: 'CANCEL', statusCode: 403 });
      }
      return respond(res, { result: 'CONTINUE' });
    }

    if (req.url === '/after') {
      if (data.statusCode === 502) {
        return respond(res, {
          result: 'REWRITE_RESPONSE',
          statusCode: 503,
          headers: { 'content-type': 'application/json' },
          payload: Buffer.from(JSON.stringify({ error: 'service_unavailable' })).toString('base64'),
        });
      }
      return respond(res, { result: 'CONTINUE' });
    }
  });
}).listen(3001);

function respond(res, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(body);
}
```

```
PLUGIN=localhost:3001
```

---

## Implementation order

1. `src/PluginManager.js` — load, register/cleanup, runBefore/runAfter, no-op stub
2. `index.js` — instantiate and pass to ProxyServer
3. `ProxyServer.js` — requestId, res.close safety net, body buffering, before/after integration,
   502 error-path hook
4. Tests — PluginManager unit tests (CONTINUE, CANCEL, REWRITE, IGNORE chain, timeout/fail-open,
   all-false /valid skips buffering, partial-true /valid only calls interested plugins),
   integration test spinning up a real plugin HTTP server
