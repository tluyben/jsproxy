# CLAUDE.md

Guidance for working in this repo. See `README.md` for the full, user-facing docs.

## What this is

`jsproxy` is a database-driven reverse proxy. Incoming requests are routed to
backends by looking up the request's domain + URI in a SQLite `mappings` table.
Entry point is `index.js`; the core server logic lives in `src/ProxyServer.js`.

## Common commands

```bash
npm start          # run the proxy
npm run dev        # run with --watch (auto-reload)
npm test           # jest
npm run lint       # eslint
```

## Certificate storage (disk vs db)

All cert material — trusted/self-signed/wildcard cert pairs, the ACME account key,
ACME retry-state / cross-worker lock JSON, pending wildcard orders, and HTTP-01
challenge files — is persisted through a single key/value blob interface in
`src/CertStore.js`. A "key" is exactly the filename the original disk code used
(`example.com.trusted.crt`, `account-key.pem`, `.well-known/acme-challenge/<token>`,
…), so the naming scheme is identical across backends.

- **`CERT_STORAGE=disk`** (default, backward compatible) — `DiskCertStore` writes
  files under `certsDir` (`CERTS_DIR`, default `./certs`). Writes are atomic
  (temp-file + rename). The dir is resolved through a live closure so tests that
  set `certManager.certsDir` after construction still work.
- **`CERT_STORAGE=db`** — `DbCertStore` keeps everything in a `cert_store(key,
  value BLOB, updated_at)` table in the **same SQLite DB as mappings** (`DB_PATH`),
  sharing the connection. No `certs/` directory is used.

`CertificateManager` never touches `fs`/`path` directly — it goes through
`this.store` (built by `createCertStore(mode, logger, dbManager, () => this.certsDir)`
in the constructor). An unknown mode warns and falls back to disk.

**Migration** (`scripts/cert-migrate.js`, one arg): copies every blob from one
backend to the other via the same store interface, overwriting same-key entries and
leaving the source intact.

```bash
npm run cert-migrate-disk-db   # certs/ files  -> cert_store table
npm run cert-migrate-db-disk   # cert_store table -> certs/ files
```

Tests: `__tests__/CertStore.test.js` — both stores' round-trip/list/rename/delete,
the factory, `CertificateManager` running in db mode (persist + reload + challenge
flow), and a disk→db copy. Disk-mode behaviour is still covered by
`__tests__/CertificateManager.test.js` unchanged.

## Request pipeline (high level)

Per request, in order: **preflight header rewrite** → domain resolution →
mapping lookup → **auto HTTP→HTTPS redirect** → IP allowlist → auth → webhook →
plugins (`/valid` `/before`) → forward to backend → plugins (`/after`) →
response. The health check and `/.well-known/acme-challenge/` endpoints
short-circuit before this pipeline.

## Automatic HTTP→HTTPS redirect

Once HTTPS is actually being served (`ProxyServer.httpsEnabled`, set true only
when the TLS listener binds) and a served domain has a cert we can terminate TLS
with, a plain-HTTP request to it gets a permanent `301` to `https://`. Wiring:

- Gate in `_handleRequest` runs right after the mapping is resolved (so only
  served domains, and before auth/IP so no creds cross HTTP). Conditions:
  `!isSecure && httpsEnabled && FORCE_HTTPS!=='true' && AUTO_HTTPS_REDIRECT!=='false'`.
- "Has a cert" = `CertificateManager.hasCertificateFor(domain)` — a NON-mutating
  check of the in-memory caches (`certificates`, wildcard `wildcardCerts`) then
  the store (`.trusted.crt` / `.selfsigned.crt` / `wildcard.<main>.crt`). Store
  errors resolve to `false`, never throw (no redirect loop on a storage hiccup).
- Certless domain → proxied over HTTP this once and `_warmCertificate(domain)`
  fires a deduped background `ensureCertificate` (self-signed immediately, ACME
  in the background), so the NEXT request redirects. Nothing is blackholed.
- Redirect URL uses `resolvedHttpsPort` (recorded in `start()`), omitting the
  port suffix for 443.
- `FORCE_HTTPS=true` (blanket, pre-mapping) takes precedence and is unchanged;
  `AUTO_HTTPS_REDIRECT=false` opts out. ACME/health short-circuit before either.

Tests: `__tests__/https-redirect.test.js` — redirect-with-cert, 443 suffix
elision, certless warm-then-proxy, opt-out, HTTPS-not-served, plus
`hasCertificateFor` unit cases.

## High Availability (multi-port and multi-host)

A mapping enters HA mode via `_isHA(mapping)` — true when **either** `back_port`
**or** `backend` contains a comma. Both modes share one score-based failover engine
(`src/ProxyServer.js`); the unit of failover differs:

- **Multi-port** — `back_port='3000,3001'`: many ports on the single `backend` host.
  Score key = the bare port string (unchanged from the original implementation).
- **Multi-host** — `backend='https://a.internal:8443,https://b.internal:8443'`: many
  distinct backend URLs. Score key = `host:port`, so each backend scores/probes
  independently. Per-entry port = URL port → else a single numeric `back_port`
  fallback → else scheme default (443/80).

Both modes are produced by one helper, `_backendTargets(mapping)`, which returns an
ordered list of `{ hostname, port, isHttps, key }`. Everything downstream
(`_requestHA` buffered, `_streamHA` streaming, WebSocket, plugin-stream) consumes
targets from it. Scoring/probe helpers are keyed on `target.key`:
`boostPort`/`penalizePort`/`getPortScore`/`startBackgroundCheckTarget`.

**Responses are NEVER buffered in memory.** Plain HA traffic (e.g. a GET
download) goes through `_streamResponseHA`: the small *request* body is buffered
(so any backend can be retried with an identical request), but the *response*
pipes straight to the client. Failover window = until response HEADERS arrive
(`HA_RESPONSE_TIMEOUT_MS`, default 30 s, bounds only that wait); after headers
the body streams under the shared byte-movement idle watch (`_makeIdleWatch`,
`STREAM_IDLE_TIMEOUT_MS` default 5 min), so an active download of any size or
duration is never torn down. `_isStreamingRequest` classifies only the REQUEST
side — that's why the response must stream unconditionally. The fully-buffered
`_requestHA`/`_tryTarget` pair remains ONLY for the plugin path (plugins need
the whole body). Regression tests: `__tests__/HA-response-stream.test.js`.

**Every forward path must fail over.** Buffered and streaming HTTP retry the next
ranked target on a connect-phase failure. The plugin streaming path
(`_streamWithPlugins`) does the same connect-phase failover (it once picked a
single target with no penalty — alternating 502s forever). WebSocket cannot retry
mid-upgrade (http-proxy ends the client socket on error), so on an HA mapping it
picks a live target FIRST via `_probeLiveTarget` (ranked TCP probes, penalizing
dead ones) and its `proxy.ws` error callback penalizes too. The shared
`proxy.on('error')` handler must never `writeHead` on a WS upgrade's raw socket —
that TypeError became an unhandled rejection that killed the process. Regression
tests: `__tests__/HA-backend-host.test.js` (the exact `backend='http://host'` +
`back_port='p1,p2'` production shape, all four paths).

**Host header invariant (security-sensitive).** The `Host` forwarded upstream is the
SAME for every backend and is `back_host || original-front-Host` — the backend's own
hostname is used ONLY as the TCP connect address, never as `Host`. So with `back_host`
set, the front URL never reaches the backends. This holds on both the buffered
(`_tryTarget`) and streaming (`_streamHA`) paths.

**Backward compatibility.** Multi-host activates only on a comma in `backend` — a
shape no single-URL config ever produced — so existing mappings, the multi-port
mode, and the public `getPortScore(id, port)` API are byte-for-byte unchanged.

Tests: `__tests__/HA.test.js` — parsing unit tests plus network tests for routing,
Host default/rewrite, host failover, all-down 502, and the streaming path.

## Raw TCP/UDP proxying + protocol probes

Opt-in, presence-based: rows with `protocol='tcp'` / `protocol='udp'` in the same
`mappings` table, keyed by `listen_port` (raw sockets have no Host to route on;
`getMapping` filters them out of HTTP routing). A TCP and a UDP route may share a
`listen_port` (different protocol space, e.g. DNS 53/tcp + 53/udp). CLI:
`scripts/add-tcp-route.js` / `scripts/add-udp-route.js`. Routes are read once at
startup. Only the IP allowlist applies — no auth/webhook/plugins.

Optional per-route bind IP: `listen_host` column (`--bind=<ip>` in both CLIs),
default NULL → bind `HTTP_HOST` as before. Set → the listener binds only that IP
(`tcpServers`/`udpServers` are keyed `host:port`), so a route can share a port
with another service on a different IP (local resolver on 127.0.0.53:53 vs the
public IP) — and a route bound to a non-`HTTP_HOST` IP does NOT trigger the
:80/:443 takeover; it coexists with the HTTP(S) servers.

- **Targets** come from `_rawTargets(route)`: legacy shape (single bare/http host +
  comma `back_port`) keeps bare-port score keys byte-for-byte; scheme'd or comma
  backend lists (`tcp://a:5432,tcp://b:5432`, `dns://10.0.0.2:5353,…`) get one
  target per entry keyed `host:port`. Both feed the shared score engine.
- **TCP** (`handleTcpConnection`): connect-phase-only failover (handshake/timeout,
  before any client byte is forwarded), then bidirectional pipe, TLS passthrough.
- **Port takeover**: a TCP route with `listen_port == HTTP_PORT/HTTPS_PORT` makes
  `start()` skip that HTTP(S) server entirely — the port becomes raw passthrough
  (no domain routing / local TLS / ACME HTTP-01 / redirects; logged as a warn).
  The TCP-vs-HTTP collision guard only covers ports an HTTP(S) server actually
  bound. Tests: `__tests__/TCP-takeover.test.js`.
- **UDP** (`startUdpListeners`/`_handleUdpDatagram`): per-client-flow connected
  dgram sockets (reply routing + backend stickiness), idle expiry
  (`UDP_SESSION_TIMEOUT_MS`), flow cap (`UDP_MAX_FLOWS`). A pre-reply socket error
  (ICMP unreachable) penalizes the target and replays the datagram on the next one.
- **Protocol probes** (`src/ProtocolProbes.js`) are hardcoded per-scheme health
  checks — `dns://` sends a real DNS query and any well-formed answer (id echo +
  QR bit, NXDOMAIN included) counts as alive. `_startProtocolProbes` runs them
  periodically (`PROTOCOL_PROBE_INTERVAL_MS`) over the route's own transport —
  UDP routes probe over UDP, TCP routes over TCP — driving scores in both
  directions (fail→0, success→100). For UDP HA probes are the only reliable
  failure signal (mandatory in practice); unprobed UDP targets get best-effort
  ICMP detection plus timed revival (`UDP_REVIVE_MS`). Probe query name:
  route's `domain` column → `DNS_PROBE_NAME` → `example.com`.

Tests: `__tests__/TCP.test.js`, `__tests__/UDP.test.js` (forwarding, stickiness,
dns:// probe failover, ICMP replay, allowlist, tcp+udp same-port coexistence,
HTTP regression), `__tests__/ProtocolProbes.test.js` (probe units).

## Preflight header rewrite

A user-supplied script that runs against every request's headers **before
routing**, so it can rewrite the `Host` (or any header) to influence which
backend is selected — e.g. adopting a CDN's forwarded hostname.

- **Configure**: `PREFLIGHT_SCRIPT=/path/to/script.js` env var, or the
  `--preflight-script=/path/to/script.js` CLI flag (env var wins if both set).
- **Loaded once** at startup by `ProxyServer._loadPreflight()`; called per
  request in `_handleRequest()`.
- **Script contract**: the module exports either a function directly or an
  object with a `main` function. It's called as `fn(req.headers)` and returns:
  - an **object** → replaces `req.headers`, request continues to routing
  - **`null`** → request is declined with `403 Forbidden`
  - anything else → headers left unchanged
- **Fail-open**: if the script throws, the error is logged and the request
  continues with its original headers, so a script bug can't blackhole traffic.
- If the script is unset or fails to load, the proxy runs without a preflight
  step (logs the reason and continues).

Minimal example:

```js
// preflight.js
module.exports = function (headers) {
  const forwarded = headers['x-forwarded-host'];
  if (forwarded) headers['host'] = forwarded;   // route by CDN-forwarded host
  if (!headers['x-tenant-id']) return null;      // → 403 Forbidden
  return headers;
};
```

Full docs: see the **Preflight Header Rewrite** section in `README.md`.
