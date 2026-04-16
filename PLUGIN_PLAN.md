# Plugin System Implementation Plan

## Overview

Add a plugin system to jsproxy that allows intercepting and transforming requests
before they are forwarded to backends, and responses before they are sent to clients.

---

## Configuration

Plugins are specified via an environment variable:

```
PLUGIN=../path/to/plugin.js,./another.js
```

- Comma-separated list of paths (resolved relative to `process.cwd()`)
- Loaded once at startup by each worker process
- Executed in order (first listed = first to run)

---

## Plugin File Format

A plugin file must export a **factory function** that receives `Result` and returns a
plugin object with `before` and/or `after` methods. Using a factory avoids requiring
plugins to know jsproxy's internal module paths.

```js
// my-plugin.js
module.exports = (Result) => ({
  before(requestId, uri, method, headers, payload) {
    // ...
    return Result.CONTINUE;
  },

  after(requestId, statusCode, headers, payload) {
    // ...
    return Result.CONTINUE;
  },
});
```

Both `before` and `after` are optional. A plugin may implement only one.

A plugin file may also export an **array** of plugin objects (each a factory result),
allowing a single file to bundle multiple logical plugins.

---

## The `Result` API

A `Result` object is returned from `before()` or `after()`. Constructors:

### Shared

| Expression | Meaning |
|---|---|
| `Result.CONTINUE` | Proceed normally; the next plugin (and eventually the backend/client) receives the original data. |

### `before()` only

| Expression | Meaning |
|---|---|
| `Result.IGNORE` | Same as CONTINUE (request forwarded unchanged) **but `after()` will never be called** for this request. |
| `Result.cancel(statusCode)` | Do not forward to backend. Respond to client with the given HTTP status and an empty body. |
| `Result.rewriteRequest(uri, method, headers, payload)` | Forward to backend but with the supplied values. Any `null` field retains the original value. |

### `after()` only

| Expression | Meaning |
|---|---|
| `Result.cancel(statusCode)` | Discard backend response. Respond to client with the given HTTP status and an empty body. |
| `Result.rewriteResponse(statusCode, headers, payload)` | Send the supplied values to the client instead of the backend response. Any `null` field retains the original value. |

`Result` is a plain-object namespace (no class instantiation needed by plugin authors):

```js
const Result = {
  CONTINUE:  { type: 'CONTINUE' },
  IGNORE:    { type: 'IGNORE' },
  cancel:             (statusCode)                    => ({ type: 'CANCEL',            statusCode }),
  rewriteRequest:     (uri, method, headers, payload) => ({ type: 'REWRITE_REQUEST',   uri, method, headers, payload }),
  rewriteResponse:    (statusCode, headers, payload)  => ({ type: 'REWRITE_RESPONSE',  statusCode, headers, payload }),
};
```

---

## `before()` Signature

```js
before(requestId, uri, method, headers, payload)
```

| Param | Type | Description |
|---|---|---|
| `requestId` | `string` (UUID v4) | Unique ID for this request; correlates with `after()` |
| `uri` | `string` | Full request path + query string (e.g. `/api/users?page=2`) |
| `method` | `string` | HTTP method (uppercase) |
| `headers` | `object` | Incoming request headers (shallow copy) |
| `payload` | `Buffer \| null` | Request body, or `null` for bodyless methods |

Called **after** mapping/IP lookup and **before** forwarding to the backend.
If multiple plugins are loaded, they run in order. The first non-CONTINUE/non-IGNORE
result short-circuits the rest.

If any plugin returns `IGNORE`, the `after()` chain is skipped entirely for this request
(even plugins earlier in the list that returned `CONTINUE`).

---

## `after()` Signature

```js
after(requestId, statusCode, headers, payload)
```

| Param | Type | Description |
|---|---|---|
| `requestId` | `string` (UUID v4) | Same ID passed to `before()` |
| `statusCode` | `number` | HTTP status of the backend response (e.g. 502 for Bad Gateway) |
| `headers` | `object` | Response headers from backend (shallow copy) |
| `payload` | `Buffer` | Response body |

Called **after** the backend responds (including error cases like 502 Bad Gateway).
The first non-CONTINUE result short-circuits the rest.

`after()` is **not called** if the corresponding `before()` returned `IGNORE`.

---

## Request ID lifecycle and memory safety

A UUID v4 is generated at the top of `handleRequest` (and `handleWebSocket`) and passed
through the entire request/response cycle so `before()` and `after()` can be correlated.

### What PluginManager stores per request

The Map only stores the minimum needed flag — **nothing else**:

```js
// inside PluginManager
this._requests = new Map(); // requestId → { ignore: bool }
```

Request body buffers and response body buffers are **local variables** in `handleRequest`
and are never stored on the Map. They go out of scope (and become GC-eligible) as soon
as the enclosing function returns.

### Guaranteed cleanup — the safety net

`ProxyServer` registers a `res.on('close', ...)` listener **immediately after generating
the requestId**, before any async work:

```js
const requestId = crypto.randomUUID();
pluginManager.register(requestId);             // insert { ignore: false }
res.once('close', () => pluginManager.cleanup(requestId));  // always fires
```

`res` emits `'close'` in every termination case: normal finish, client disconnect,
socket reset, timeout, or unhandled error. This is the unconditional backstop.

`pluginManager.cleanup(requestId)` is **idempotent** — safe to call multiple times:

```js
cleanup(requestId) {
  this._requests.delete(requestId);  // no-op if already gone
}
```

### Normal-path deletions (happen before the safety net fires)

| Situation | When Map entry is removed |
|---|---|
| `before()` returns `IGNORE` | Immediately in `runBefore`, before forwarding |
| `before()` returns `CANCEL` | Immediately in `runBefore`, before sending 4xx |
| `after()` completes normally | At the end of `runAfter`, before response is written |
| `after()` returns `CANCEL` or `REWRITE_RESPONSE` | Same — at end of `runAfter` |

The `res.on('close')` safety net fires afterwards in all these cases and calls
`cleanup()` again, which is a no-op.

### Cases where only the safety net fires (no `after()` call)

- Client disconnects before backend responds
- Backend connection hangs and the socket is destroyed
- Any unhandled error path that does not go through the 502 handler
- `before()` returned `IGNORE` (no `after()` by design — but `close` still fires)

In all these cases `res.on('close')` fires and the Map entry is removed.

The UUID is also forwarded as `X-Request-Id` on the proxied request (if not already set).

---

## New File: `src/PluginManager.js`

Responsible for:

1. **Loading** – parse `PLUGIN` env var, `require()` each path, call the factory with `Result`,
   flatten arrays, validate shape.
2. **`register(requestId)`** – insert `{ ignore: false }` into the Map at request start.
3. **`runBefore(requestId, req, payload)`** – iterate plugins with `before` method, handle
   results. On IGNORE or CANCEL: calls `cleanup(requestId)` before returning.
4. **`runAfter(requestId, statusCode, headers, payload)`** – iterate plugins with `after` method,
   handle results. No-op if `ignore` flag is set. Calls `cleanup(requestId)` before returning
   regardless of result type.
5. **`cleanup(requestId)`** – idempotent `Map.delete`; called explicitly on early exits and
   always by the `res.on('close')` safety net in `ProxyServer`.
6. **Exporting `Result`** so `ProxyServer.js` can interpret return values without reimporting.

```
src/
  PluginManager.js   ← new
  ProxyServer.js     ← modified
  DatabaseManager.js
  CertificateManager.js
index.js             ← modified (pass pluginManager to ProxyServer)
```

---

## Changes to `ProxyServer.js`

### Constructor

Accept `pluginManager` as an optional argument (defaults to a no-op stub so the rest of
the code never needs null checks):

```js
constructor(db, certManager, pluginManager = noopPluginManager)
```

### `handleRequest` changes

**1. Generate request ID** at the top of the method (before mapping lookup):
```js
const requestId = crypto.randomUUID();
```

**2. Buffer request body** when plugins are loaded (after mapping lookup, before `before()`):

```js
const payload = pluginManager.hasPlugins ? await readBody(req) : null;
```

Helper `readBody(req)` collects `data` events into a `Buffer`.

**3. Call `before()`** after buffering, before forwarding:

```js
const beforeResult = await pluginManager.runBefore(requestId, req, payload);

switch (beforeResult.type) {
  case 'CANCEL':
    res.writeHead(beforeResult.statusCode);
    return res.end();
  case 'REWRITE_REQUEST':
    // apply non-null fields to req / payload
    break;
  // CONTINUE, IGNORE: fall through
}
```

**4. Forward buffered body** when a payload was collected (re-pipe or set `body` option on
`http-proxy`). Use `http-proxy`'s `buffer` option with a readable stream wrapping the buffer.

**5. Collect backend response for `after()`** when plugins are loaded:

Attach a one-time listener to the `proxyRes` event, buffer the response body, then call
`runAfter()`. If the result is `REWRITE_RESPONSE` or `CANCEL`, suppress the default
piped response and write the plugin-supplied one.

**6. Error path (502)** — in the existing `proxy.on('error')` handler, call:
```js
const afterResult = await pluginManager.runAfter(requestId, 502, {}, Buffer.alloc(0));
// then send afterResult-modified or default 502
```

---

## Changes to `index.js`

```js
const PluginManager = require('./src/PluginManager');

// In worker startup:
const pluginManager = new PluginManager(process.env.PLUGIN);
await pluginManager.load();
const server = new ProxyServer(db, certManager, pluginManager);
```

---

## Payload buffering — performance note

Buffering is only activated when `PLUGIN` is set **and** at least one loaded plugin
implements `before` or `after`. Without plugins, the existing streaming path is unchanged.

For WebSocket connections, `before()` is called with the initial HTTP upgrade request
(same as HTTP). `after()` is **not** called for WebSocket frame traffic — only for the
upgrade handshake response. (WS frames are bidirectional streams; buffering them would
break the protocol.)

---

## Error handling for plugins

- If a plugin's `before()` or `after()` throws, log the error and treat it as `CONTINUE`
  (fail-open). This prevents a buggy plugin from taking down the proxy entirely.
- Plugin load errors (file not found, bad export) are fatal at startup.

---

## Example Plugin

```js
// block-admin.js
module.exports = (Result) => ({
  before(requestId, uri, method, headers, payload) {
    if (uri.startsWith('/admin') && !headers['x-internal-token']) {
      return Result.cancel(403);
    }
    return Result.CONTINUE;
  },

  after(requestId, statusCode, headers, payload) {
    if (statusCode === 502) {
      return Result.rewriteResponse(503, { 'content-type': 'application/json' },
        Buffer.from(JSON.stringify({ error: 'service_unavailable' })));
    }
    return Result.CONTINUE;
  },
});
```

```
PLUGIN=./plugins/block-admin.js
```

---

## Implementation Order

1. `src/PluginManager.js` — load, Result, runBefore/runAfter logic, no-op stub
2. `index.js` — instantiate and pass to ProxyServer
3. `ProxyServer.js` — requestId generation, readBody helper, before/after integration,
   error-path after() call
4. Unit tests for PluginManager (Result types, plugin chaining, IGNORE behaviour)
5. Integration test with a real plugin file exercising CANCEL and REWRITE paths
