# Raw TCP Proxy Support — Implementation Plan

## Goal

Add **raw TCP proxying** and **HA TCP proxying** alongside the existing HTTP/HTTPS
support, with:

- **Zero behavioral change** to the existing HTTP(S) path. If no TCP routes are
  configured, the proxy behaves exactly as it does today.
- **Maximum reuse** of the existing HA machinery (`portScores`, `rankedPorts`,
  `boostPort`, `penalizePort`, `startBackgroundCheck`). It is already
  protocol-agnostic — it TCP-probes ports regardless of L7.
- **Opt-in, presence-based**: a TCP listener exists only because a `protocol='tcp'`
  row exists. No new env flag required to "turn it on".
- **TLS passthrough only**: raw bytes are forwarded untouched, so TLS terminates at
  the backend. No certs, no SNI parsing on this path.

## Design decisions (confirmed)

| Decision | Choice |
|---|---|
| Storage | `protocol` + `listen_port` columns on the existing `mappings` table |
| Enablement | Presence-based — listeners start for `protocol='tcp'` rows only |
| TLS | Passthrough only (backend terminates TLS) |

## Why this is low-risk

- The HTTP/HTTPS request path is **never** entered for TCP traffic — TCP gets its
  own dedicated `net.Server` per `listen_port`, completely separate from the
  `http`/`https` servers.
- `getMapping()` (the domain router) is filtered to `protocol='http'`, so a TCP row
  can never leak into HTTP routing, and an HTTP row can never be picked as a TCP
  backend.
- The schema change is two **idempotent `ALTER TABLE ADD COLUMN`** migrations, the
  same pattern already used for `auth_type` / `auth_credentials`
  (`DatabaseManager.js:161-163`). Existing rows get `protocol='http'` by default.
- All new code is additive: new DB methods, new `ProxyServer` methods, a new CLI
  script, a new test file. No existing function is modified except `getMapping`
  (one `WHERE` clause) and `start()`/`stop()` (additive listener lifecycle).

---

## Routing model

Raw TCP has no Host header, so it cannot route by domain. Each TCP route is a
**dedicated listening port → backend** forward:

```
client → jsproxy:listen_port → backend:back_port   (one of N for HA)
```

For a `protocol='tcp'` row:

| Column | Meaning for TCP |
|---|---|
| `protocol` | `'tcp'` |
| `listen_port` | Port jsproxy listens on (required, unique) |
| `backend` | Upstream host, default `localhost` (scheme ignored; host only) |
| `back_port` | Upstream port, or `'5432,5433'` comma-separated for HA |
| `allowed_ips` | Reused as-is — L3 allowlist works on raw sockets |
| `domain`, `front_uri`, `back_uri` | Unused — stored as `''` to satisfy NOT NULL |
| `auth_type`, `auth_credentials` | **Ignored** for TCP (no L7 to authenticate) |

---

## Phase 1 — Schema + DatabaseManager

`src/DatabaseManager.js`

1. **Migration** (alongside the existing `ALTER TABLE` block ~line 161):
   ```sql
   ALTER TABLE mappings ADD COLUMN protocol TEXT DEFAULT 'http';
   ALTER TABLE mappings ADD COLUMN listen_port INTEGER DEFAULT NULL;
   ```
   Idempotent — wrap each in the existing "ignore duplicate column" try/catch.

2. **Filter `getMapping()`** so HTTP routing never sees TCP rows. Add to each of the
   three SELECTs (exact / wildcard / catch-all):
   ```sql
   AND (protocol = 'http' OR protocol IS NULL)
   ```

3. **New methods:**
   ```js
   async getTcpRoutes()            // SELECT * FROM mappings WHERE protocol = 'tcp'
   async addTcpRoute(listenPort, backend, backPort, allowedIps = null)
     // INSERT with protocol='tcp', domain='', front_uri='', back_uri='',
     //   listen_port=listenPort, back_port=String(backPort)
   async removeTcpRoute(listenPort) // optional symmetry with mappings
   ```

## Phase 2 — TCP listeners in ProxyServer (the core)

`src/ProxyServer.js`

1. **Constructor:** `this.tcpServers = new Map();  // listen_port -> net.Server`
   (`net` is already imported for `startBackgroundCheck`.)

2. **`start()`** — after the HTTPS server is listening, add:
   ```js
   await this.startTcpListeners();   // no-op if there are no tcp routes
   ```

3. **`startTcpListeners()`**
   ```js
   const routes = await this.db.getTcpRoutes();
   for (const route of routes) {
     const port = route.listen_port;
     if (port === httpPort || port === httpsPort) {
       this.logger.warn(`TCP route ${route.id} listen_port ${port} collides with HTTP/HTTPS; skipping`);
       continue;
     }
     const server = net.createServer(sock => this.handleTcpConnection(route, sock));
     server.on('error', err => this.logger.error(`TCP listener ${port} error: ${err.message}`));
     server.listen(port, httpHost, () => this.logger.info(`TCP proxy listening on ${httpHost}:${port} -> ${route.backend||'localhost'}:${route.back_port}`));
     this.tcpServers.set(port, server);
   }
   ```

4. **`handleTcpConnection(route, clientSocket)`** — the heart of it:
   - `clientSocket.pause()` immediately (don't lose bytes the client sends before the
     upstream is connected).
   - IP allowlist: reuse the existing allowlist check (extract the inline logic from
     `_handleRequest` into a small `isIpAllowed(remoteAddr, allowedIps)` helper and
     call it from both places). On deny → `clientSocket.destroy()`.
   - Parse `back_port` → ports (same `.split(',').map(parseInt)` as HA).
   - `const ordered = this.rankedPorts(route.id, ports);`
   - Try each port in order with a connect timeout
     (`TCP_CONNECT_TIMEOUT_MS`, default = `HA_CONNECT_TIMEOUT_MS` / 3000):
     - On **connect error/timeout**: `penalizePort` + `startBackgroundCheck`, try next.
       *(Safe to fail over — no client bytes have been forwarded yet.)*
     - On **connect success**: `boostPort(route.id, port)`, then wire up:
       ```js
       clientSocket.pipe(upstream);
       upstream.pipe(clientSocket);
       clientSocket.resume();
       ```
       plus `error`/`close` handlers on both sockets that `destroy()` the peer so
       neither half-open lingers.
   - All ports exhausted → `clientSocket.destroy()` (the TCP analogue of HTTP 502).

5. **`stop()`** — close TCP listeners too:
   ```js
   for (const s of this.tcpServers.values()) await new Promise(r => s.close(r));
   this.tcpServers.clear();
   ```

### Notes on HA reuse
- `rankedPorts` / `boostPort` / `penalizePort` / `getPortScore` work unchanged
  (keyed by `${route.id}:${port}` — `route.id` is a UUID, fully isolated from HTTP
  mappings).
- `startBackgroundCheck(route, port)` works unchanged: it only reads `route.id`,
  `route.backend`, `route.back_port` and TCP-probes the host. A TCP route has all
  three.
- TCP failover is **strictly connect-phase**, so it's always safe — there is no
  idempotency concern (no client bytes sent before upstream connect). Simpler than
  the HTTP path, and intentionally so.

### Worker/cluster note
`index.js` forks up to 4 workers, each running `ProxyServer.start()`. Node's cluster
module shares server handles for `net` servers exactly as it already does for the
`http`/`https` servers, so calling `.listen(listen_port)` in each worker is correct
and load is distributed automatically. **No special handling needed.**

## Phase 3 — Config / CLI / env

1. **`scripts/add-tcp-route.js`** — mirror `scripts/add-mapping.js`:
   ```
   node scripts/add-tcp-route.js <listen_port> <backend> <back_port[,back_port...]> [allowed_ips]
   # e.g. node scripts/add-tcp-route.js 5432 db.internal 5432,5433
   ```
2. **Env vars** (both optional, sane defaults — no change to default behavior):
   - `TCP_CONNECT_TIMEOUT_MS` (default falls back to `HA_CONNECT_TIMEOUT_MS`, 3000)
   - `TCP_IDLE_TIMEOUT_MS` (default `0` = no idle timeout; raw TCP / DB connections
     are long-lived, so we must not kill idle connections by default)
   - Document in `.env.example`.

## Phase 4 — Tests

`__tests__/TCP.test.js` (mirror `HA.test.js` structure & helpers):
- `makeEchoBackend()` via `net.createServer(s => s.pipe(s))`.
- `addTcpRoute` + start proxy on a test HTTP port; connect via `net.Socket` to the
  `listen_port`.
- Cases:
  1. **Basic forward** — bytes echo round-trip through the proxy.
  2. **HA round-robin** — two live backends, both get traffic across N connections.
  3. **Failover** — one dead port + one live; connection still succeeds, dead port
     scored `0`.
  4. **All down** — client socket is closed/refused.
  5. **IP allowlist** — disallowed source is rejected.
  6. **Idle/long-lived** — connection stays open and streams after a pause.
- **Regression:** existing `HA.test.js` / `integration.test.js` must pass unchanged,
  proving the `protocol` column + `getMapping` filter didn't disturb HTTP routing.

## Phase 5 — Docs

- `README.md`: a "Raw TCP proxying" section — schema columns, CLI usage, HA behavior,
  TLS-passthrough note, and the explicit caveat that auth/webhook/plugins do **not**
  apply to TCP routes (only IP allowlist does).
- `.env.example`: the two new TCP env vars.

---

## Touch list (files changed)

| File | Change | Risk |
|---|---|---|
| `src/DatabaseManager.js` | 2 migrations, `getMapping` WHERE filter, 2-3 new methods | Low |
| `src/ProxyServer.js` | `tcpServers` map, `startTcpListeners`, `handleTcpConnection`, `stop` cleanup, extract `isIpAllowed` helper | Low (additive) |
| `scripts/add-tcp-route.js` | New CLI | None |
| `__tests__/TCP.test.js` | New tests | None |
| `README.md`, `.env.example` | Docs | None |

**No changes** to: the `http-proxy` setup, WebSocket handling, cert manager, plugin
manager, telemetry, or any existing HTTP request/HA logic.

## Rollback

Drop all `protocol='tcp'` rows → every TCP listener disappears on next start; HTTP
behavior is untouched throughout. The two added columns are inert for HTTP rows.
