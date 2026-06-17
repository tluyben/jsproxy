# JSProxy - Resilient HTTP/HTTPS Proxy Server

A high-performance, resilient proxy server that forwards HTTP/HTTPS traffic including WebSockets to backend services based on domain and URI mappings stored in SQLite. Features automatic SSL certificate generation via Let's Encrypt and zero-downtime database hot-swapping.

## Features

- **Multi-protocol Support**: HTTP, HTTPS, and WebSocket proxying
- **Raw TCP Proxying**: Optional, opt-in per-port TCP forwarding with TLS passthrough and the same score-based HA failover (zero impact on the HTTP path when unused)
- **Automatic SSL**: Let's Encrypt integration for automatic certificate generation
- **High Availability**: Cluster-based architecture with worker process management; multi-port score-based load balancing with automatic dead-port detection and background recovery probes
- **Zero Downtime**: Hot database replacement without service interruption
- **Flexible Routing**: Domain and URI-based traffic routing
- **IP Allowlisting**: Per-mapping IP restrictions with CIDR range support, works transparently behind nginx
- **Auth Protection**: Per-mapping HTTP Basic Auth, Bearer token, or password-only auth with optional expiry and use-count limits
- **Webhook Interceptor**: Optional pre-proxy webhook call to authorize, redirect, or block requests
- **Plugin System**: Intercept and transform requests/responses via external HTTP services — rewrite URLs, add headers, retry failures, short-circuit with custom responses, and more
- **External Backend Support**: Proxy to remote servers, not just localhost
- **SQLite Backend**: WAL mode for concurrent reads during updates
- **Structured Logging**: Single-line human-readable text format by default; switchable to newline-delimited JSON for log pipelines — all log entries include domain, method, URL, and backend context
- **OpenTelemetry**: Built-in distributed tracing with W3C `traceparent` propagation; plugs into any OTEL-compatible backend (Jaeger, Grafana Tempo, Honeycomb, etc.) via OTLP
- **Docker Ready**: Complete containerization with docker-compose
- **Comprehensive Testing**: Full test suite with integration tests

## Quick Start

### Using Docker (Recommended)

```bash
# Clone and start
git clone <repository>
cd jsproxy

# Development mode (ports 8080/8443, no HTTPS)
docker-compose --profile dev up jsproxy-dev

# Production mode (ports 80/443, with HTTPS) - requires sudo/root
sudo docker-compose up jsproxy

# With SQLite web interface on port 8080
docker-compose --profile tools up
```

### Manual Installation

```bash
# Install dependencies
npm install

# Development mode (default: ports 8080, no HTTPS)
npm run dev

# Development on port 80 (requires sudo)
sudo npm run dev:80

# Custom ports (3000/3443)
npm run dev:custom

# Production mode (ports 80/443, with HTTPS) - requires sudo
sudo npm run start:prod
```

## Port Configuration

The proxy server supports flexible port configuration through environment variables:

| Environment | HTTP Port | HTTPS Port | HTTPS Enabled | Command |
|-------------|-----------|------------|---------------|---------|
| Development | 8080 | 8443 | No | `npm run dev` |
| Development (port 80) | 80 | 443 | No | `sudo npm run dev:80` |
| Custom | 3000 | 3443 | No | `npm run dev:custom` |
| Production | 80 | 443 | Yes | `sudo npm run start:prod` |

### Environment Variables

```bash
# Server
NODE_ENV=development|production    # Environment mode
HTTP_PORT=8080                     # HTTP port (default: 8080 dev, 80 prod)
HTTPS_PORT=8443                    # HTTPS port (default: 8443 dev, 443 prod)
HTTP_HOST=0.0.0.0                  # Bind address (default: 0.0.0.0)
ENABLE_HTTPS=true|false            # Enable HTTPS (default: false dev, true prod)
FORCE_HTTPS=true                   # Redirect all HTTP → HTTPS (default: false)
DB_PATH=./data/current.db          # Path to SQLite database file

# Logging
LOG_LEVEL=debug|info|warn|error    # Log verbosity (default: info)
LOG_FORMAT=text|json               # Output format (default: text, see Logging section)

# OpenTelemetry tracing
OTEL_SERVICE_NAME=jsproxy          # Service name in traces (default: jsproxy)
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318   # OTLP collector base URL
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://localhost:4318/v1/traces  # Override traces URL
OTEL_EXPORTER_OTLP_HEADERS=api-key=xxx,x-scope=prod  # Comma-separated extra headers

# Caching
CACHE_HEADERS=true|false           # Inject Cache-Control headers on GET responses (default: false)
CACHE_EXPIRY=60                    # Cache expiry in minutes; omit or -1 for aggressive infinite cache

# Webhook interceptor
WEBHOOK_URL=https://…/hook         # Pre-proxy webhook endpoint (optional, see Webhook Interceptor)
WEBHOOK_TIMEOUT=5000               # Webhook response timeout in ms (default: 5000)
WEBHOOK_SECRET=<secret>            # HMAC-SHA256 signing secret for X-Webhook-Signature header

# Plugin system
PLUGIN=localhost:3001,localhost:3002  # Plugin endpoints (optional, see Plugin System)
PLUGIN_TIMEOUT=5000                # Per-plugin HTTP call timeout in ms (default: 5000)
```

## Configuration

### Database Schema

The proxy uses a SQLite database with the following schema:

```sql
CREATE TABLE mappings (
  id TEXT PRIMARY KEY,           -- UUID
  domain TEXT NOT NULL,          -- Frontend domain (e.g., "api.example.com")
  front_uri TEXT NOT NULL,       -- Frontend URI path (e.g., "v1/users")
  back_port TEXT NOT NULL,       -- Backend port (e.g., 3000); comma-separated for HA (e.g., "3000,3001,3002")
  back_uri TEXT NOT NULL,        -- Backend URI path (e.g., "api/v1/users")
  backend TEXT DEFAULT NULL,     -- Backend server URL (e.g., "https://api.example.com", defaults to "http://localhost")
  allowed_ips TEXT DEFAULT NULL,       -- IP allowlist: comma-separated IPs/CIDRs; NULL or empty = allow all
  auth_type TEXT DEFAULT NULL,         -- Auth mode: 'basic', 'bearer', 'password', or NULL (no auth)
  auth_credentials TEXT DEFAULT NULL,  -- JSON array of credential objects (see Auth Protection section)
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### Adding Mappings

#### Using the CLI Script (Recommended)

```bash
# Add domain with port
node scripts/add-mapping.js example.com 3000

# Add with frontend path mapping
node scripts/add-mapping.js example.com 3000 --frontend /app

# Add with backend API path
node scripts/add-mapping.js example.com 3000 --backend /api

# Add with both frontend and backend paths
node scripts/add-mapping.js example.com 3000 --frontend / --backend /api

# Add with external backend server
node scripts/add-mapping.js example.com 3000 --server https://api.example.com

# Add with external backend and path mapping
node scripts/add-mapping.js example.com 3000 --backend /api --server https://backend.example.com

# Use same path for both
node scripts/add-mapping.js example.com 3000 --both /

# List all mappings
node scripts/add-mapping.js --list

# Delete a mapping
node scripts/add-mapping.js example.com --delete

# Add and reload proxy automatically
node scripts/add-mapping.js example.com 3000 --frontend / --reload

# Show help
node scripts/add-mapping.js --help
```

#### Using SQLite CLI

```bash
# Using SQLite CLI
sqlite3 ./data/current.db

# Add a mapping (open to all IPs)
INSERT INTO mappings (id, domain, front_uri, back_port, back_uri, backend)
VALUES ('550e8400-e29b-41d4-a716-446655440000', 'api.example.com', '', 3000, '', NULL);

# Add with external backend server
INSERT INTO mappings (id, domain, front_uri, back_port, back_uri, backend)
VALUES ('550e8400-e29b-41d4-a716-446655440002', 'external.example.com', '', 3000, '', 'https://api.external.com');

# Add API version routing
INSERT INTO mappings (id, domain, front_uri, back_port, back_uri, backend)
VALUES ('550e8400-e29b-41d4-a716-446655440001', 'app.example.com', 'api/v1', 3001, 'v1', NULL);

# Add HA mapping with round-robin across 3 ports
INSERT INTO mappings (id, domain, front_uri, back_port, back_uri, backend)
VALUES ('550e8400-e29b-41d4-a716-446655440003', 'ha.example.com', '', '3000,3001,3002', '', NULL);

# Add mapping restricted to specific IPs / ranges
INSERT INTO mappings (id, domain, front_uri, back_port, back_uri, backend, allowed_ips)
VALUES ('550e8400-e29b-41d4-a716-446655440004', 'admin.example.com', '', 4000, '', NULL, '10.0.0.5,192.168.1.0/24');
```

### Using SQLite Web Interface

When running with `--profile tools`:

```bash
# Access SQLite web interface
open http://localhost:8080
```

## Routing Examples

| Request | Domain | URI | Backend | Server | Result |
|---------|---------|-----|---------|--------|---------|
| `GET https://api.example.com/users` | api.example.com | `` | :3000 | - | `GET http://localhost:3000/users` |
| `GET https://app.example.com/api/v1/data` | app.example.com | api/v1 | :3001 | - | `GET http://localhost:3001/v1/data` |
| `GET https://app.example.com/api/v2/data` | app.example.com | api/v2 | :3002 | - | `GET http://localhost:3002/v2/data` |
| `GET https://external.example.com/users` | external.example.com | `` | :3000 | https://api.external.com | `GET https://api.external.com:3000/users` |
| `GET https://remote.example.com/api/data` | remote.example.com | api | :8080 | https://backend.com | `GET https://backend.com:8080/data` |

The system matches the longest `front_uri` first, allowing for hierarchical routing.

## IP Allowlisting

Each mapping can optionally restrict access to specific IPs or CIDR ranges via the `allowed_ips` column.

- **NULL or empty** — all IPs allowed (default, fully backward compatible)
- **Set** — only listed IPs/ranges are allowed; everything else gets `403 Forbidden`

Supported formats (comma-separated):

| Format | Example | Matches |
|--------|---------|---------|
| Single IP | `192.168.1.5` | Exact address |
| CIDR range | `192.168.1.0/24` | 192.168.1.0 – 192.168.1.255 |
| Mixed | `10.0.0.5,192.168.0.0/16` | Both |

Works transparently behind nginx — the real client IP is read from the `X-Forwarded-For` header when present, falling back to the direct socket address.

```bash
# Nginx config — pass the real client IP through
proxy_set_header X-Forwarded-For $remote_addr;
```

```sql
-- Restrict admin panel to office subnet + one jump host
UPDATE mappings SET allowed_ips = '203.0.113.10,10.0.0.0/8' WHERE domain = 'admin.example.com';

-- Remove restriction (allow all again)
UPDATE mappings SET allowed_ips = NULL WHERE domain = 'admin.example.com';
```

WebSocket connections respect the same allowlist — blocked connections receive `403 Forbidden` before the upgrade is completed.

## Auth Protection

Each mapping can optionally require authentication via one of three modes. Only **one mode** is active per mapping at a time. Multiple credentials of the same type can coexist — any one match grants access. Auth is checked after IP allowlisting.

| Mode | `auth_type` | Header expected by clients |
|------|-------------|---------------------------|
| HTTP Basic Auth | `basic` | `Authorization: Basic base64(user:pass)` |
| Bearer token | `bearer` | `Authorization: Bearer <token>` |
| Password only | `password` | `Authorization: Bearer <password>` or `Authorization: Basic base64(:password)` |

- **NULL auth_type** — open access (default, fully backward compatible)
- **Auth set** — unauthenticated requests receive `401 Unauthorized` with a `WWW-Authenticate` header
- WebSocket upgrades are auth-checked the same way

### Managing auth with the CLI

```bash
# ── Set auth type (clears credentials if type changes) ──────────────────────
node scripts/manage-auth.js api.example.com --type bearer
node scripts/manage-auth.js api.example.com --type basic
node scripts/manage-auth.js api.example.com --type password

# ── Add credentials ──────────────────────────────────────────────────────────
# Bearer token
node scripts/manage-auth.js api.example.com --add-bearer mysecrettoken

# Basic auth
node scripts/manage-auth.js api.example.com --add-basic alice:s3cr3t
node scripts/manage-auth.js api.example.com --add-basic bob:p@ssw0rd

# Password only
node scripts/manage-auth.js api.example.com --add-password mysharedpassword

# ── Optional: expiry and/or max successful uses before credential is removed ─
node scripts/manage-auth.js api.example.com --add-bearer temptoken --expires 2025-12-31
node scripts/manage-auth.js api.example.com --add-bearer temptoken --max-uses 50
node scripts/manage-auth.js api.example.com --add-basic alice:pass --expires 2025-06-01 --max-uses 100

# ── List current auth config ─────────────────────────────────────────────────
node scripts/manage-auth.js api.example.com --list

# ── Remove a specific credential ─────────────────────────────────────────────
node scripts/manage-auth.js api.example.com --remove alice           # basic: remove by username
node scripts/manage-auth.js api.example.com --remove mysecrettoken   # bearer: remove by token
node scripts/manage-auth.js api.example.com --remove mysharedpassword # password: remove by value

# ── Remove all auth (open access again) ──────────────────────────────────────
node scripts/manage-auth.js api.example.com --clear
```

### Managing auth via SQLite directly

```sql
-- Enable bearer auth with two tokens
UPDATE mappings
  SET auth_type = 'bearer',
      auth_credentials = '[{"token":"abc123"},{"token":"xyz789","expires_at":"2025-12-31T00:00:00.000Z","max_uses":10}]'
  WHERE domain = 'api.example.com';

-- Enable basic auth
UPDATE mappings
  SET auth_type = 'basic',
      auth_credentials = '[{"user":"alice","pass":"s3cr3t"},{"user":"bob","pass":"other"}]'
  WHERE domain = 'api.example.com';

-- Enable password-only auth
UPDATE mappings
  SET auth_type = 'password',
      auth_credentials = '[{"pass":"mysharedpassword"}]'
  WHERE domain = 'api.example.com';

-- Remove auth entirely (open access)
UPDATE mappings SET auth_type = NULL, auth_credentials = NULL WHERE domain = 'api.example.com';
```

### Credential JSON format

Each entry in the `auth_credentials` JSON array supports these fields:

| Field | Required | Description |
|-------|----------|-------------|
| `user` | basic only | Username |
| `pass` | basic / password | Password |
| `token` | bearer only | Bearer token string |
| `expires_at` | optional | ISO 8601 datetime; credential rejected after this time |
| `max_uses` | optional | Remove credential automatically after N successful uses |
| `uses` | managed automatically | Running use count (do not set manually) |

Changes are active immediately — no proxy restart needed.

## Webhook Interceptor

When `WEBHOOK_URL` is set, the proxy fires a `POST` request to that URL for every inbound request whose domain is found in the database. The webhook call happens **in parallel with any certificate work**, so it adds no extra latency on the hot path. The proxy waits for the webhook response before forwarding the request.

### Behaviour by response code

| Webhook status | Proxy action |
|----------------|--------------|
| `200` | Continue — proxy the request as normal |
| `3xx` (with `Location` header) | Redirect the client to the `Location` URL using that status code |
| Any other non-200 | Serve the webhook's response (status + body) directly to the client |

If the webhook times out or is unreachable the proxy **fails open** — the request is proxied as normal and an error is logged.

### Configuration

```bash
# .env or environment variables
WEBHOOK_URL=https://auth.example.com/hook  # required to enable
WEBHOOK_TIMEOUT=5000                        # ms to wait (default: 5000)
WEBHOOK_SECRET=your-secret                  # optional HMAC-SHA256 signing
```

### Webhook request

The proxy sends a `POST` with `Content-Type: application/json`:

```json
{
  "domain":    "api.example.com",
  "url":       "/v1/users?page=1",
  "method":    "GET",
  "headers":   { "host": "api.example.com", "authorization": "Bearer …" },
  "ports":     ["3000"],
  "ip":        "203.0.113.42",
  "mappingId": "550e8400-e29b-41d4-a716-446655440000",
  "timestamp": "2024-01-15T10:30:00.000Z"
}
```

`ports` is always an array — for HA mappings it contains all configured ports (e.g. `["3000","3001","3002"]`).

### HMAC signature

When `WEBHOOK_SECRET` is set, a request header is added:

```
X-Webhook-Signature: sha256=<hex-encoded HMAC-SHA256 of the raw JSON body>
```

Verify in your webhook handler:

```javascript
const crypto = require('crypto');
function verify(secret, rawBody, header) {
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(header));
}
```

### Example: auth service that blocks unauthenticated requests

```javascript
// auth-service.js (runs alongside jsproxy)
const http = require('http');

http.createServer((req, res) => {
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const { headers } = JSON.parse(Buffer.concat(chunks).toString());
    const token = (headers['authorization'] || '').replace('Bearer ', '');

    if (!isValidToken(token)) {
      res.writeHead(401, { 'Content-Type': 'text/plain' });
      res.end('Unauthorized');
    } else {
      res.writeHead(200);
      res.end();
    }
  });
}).listen(9000);
```

```bash
WEBHOOK_URL=http://localhost:9000 node index.js
```

## Plugin System

Plugins let you intercept and transform requests and responses without modifying jsproxy.
Each plugin is a plain HTTP server — any language, any framework — that exposes three endpoints.

**When `PLUGIN` is not set the code path is identical to previous versions — zero overhead.**

### Configuration

```bash
PLUGIN=localhost:3001                        # single plugin
PLUGIN=localhost:3001,localhost:3002         # chain — called in order
PLUGIN_TIMEOUT=5000                          # per-call timeout in ms (default: 5000)
```

### How it works

```
1. POST /valid  (all plugins in parallel — no payload, very cheap)
                 → each returns { valid: true|false }
                 → if ALL return false: skip plugins, proxy normally, no buffering

2. POST /before  (interested plugins in order, request body as the raw HTTP body)
                 → first non-CONTINUE result wins

3. Forward to backend  (with any rewrite applied)

4. POST /after   (interested plugins in order, response body as the raw HTTP body)
                 → called even on 502 (backend down) so plugins can produce fallbacks
                 → first non-CONTINUE result wins

5. Send response to client
```

### Plugin endpoints

`/valid` exchanges small JSON. `/before` and `/after` carry the payload as the **raw HTTP
body** (never base64), with metadata in the `x-plugin-meta` header and the decision in the
`x-plugin-result` header — so bodies stream through untouched (a 100 MB upload costs 100 MB,
not ~1 GB). The bundled `plugins/_protocol.js` helper implements this; copy it into your own
plugin.

**`/valid`** — lightweight opt-in, called in parallel (JSON in, JSON out):
```json
// request
{ "requestId": "…", "domain": "example.com", "inPort": 8080, "uri": "/api/v1/users", "method": "GET" }
// response
{ "valid": true }
```

**`/before`** — full request available, called sequentially on interested plugins:
```
// request: metadata header + raw body bytes
x-plugin-meta: {"requestId":"…","domain":"example.com","inPort":8080,
                "uri":"/api/v1/users","method":"GET","headers":{…}}
<raw request body>

// response: decision header (+ optional meta), raw rewritten body
x-plugin-result: CONTINUE
x-plugin-result: IGNORE                                              // forward unchanged, skip /after
x-plugin-result: CANCEL          x-plugin-meta: {"statusCode":403}   // don't forward, respond now
x-plugin-result: REWRITE_REQUEST x-plugin-meta: {"uri":"…","headers":{…}}
//   null/omitted meta fields keep the original; empty body keeps the original payload
```

**`/after`** — full response available, called sequentially on interested plugins:
```
// request: metadata header + raw body bytes
x-plugin-meta: {"requestId":"…","domain":"example.com","inPort":8080,"statusCode":200,"headers":{…}}
<raw response body>

// response options:
x-plugin-result: CONTINUE
x-plugin-result: CANCEL           x-plugin-meta: {"statusCode":503}
x-plugin-result: REWRITE_RESPONSE x-plugin-meta: {"statusCode":200,"headers":{…}}
//   null/omitted meta fields keep the original backend value; empty body keeps the original payload
```

### Included plugins and demos

Three example plugins ship in `plugins/` alongside a demo backend:

| Plugin | Default port | What it does |
|---|---|---|
| `hello-world.js` | 3001 | Rewrites any `/hello` response to `"Hello World!"` |
| `rewrite.js` | 3002 | Rewrites `/api/v1/*` → `/api/v2/*`, adds version headers |
| `retry.js` | 3003 | Retries 5xx responses against the backend with exponential backoff |

Run a fully self-contained demo with a single command — starts jsproxy, the backend, and the plugin; adds the mapping; and runs a series of curl examples:

```bash
npm run demo:hello
npm run demo:rewrite
npm run demo:retry
```

Each demo prints the curl commands so you can copy-paste and keep experimenting. Press Ctrl+C to stop everything.

See [`docs/plugins.md`](docs/plugins.md) for the full API reference, plugin authoring guide, and demo walkthroughs.

## High Availability / Load Balancing

Set `back_port` to a comma-separated list of ports to enable HA mode for a mapping.

**Behaviour per request:**

1. Ports are ranked by a **score** (0–100, default 100). A successful response boosts the port to 100; a connection failure drops it to 0.
2. Ports are tried **best-score-first** (round-robin as a tie-breaker). The first port that responds at any HTTP status code wins immediately.
3. On a connection failure, the port is penalized (score → 0), a **background TCP probe** starts (retries every 5 s with a 3 s socket timeout), and the next port is tried.
4. When the probe succeeds, the port's score is restored to 50 so it gets one real-request trial before being fully trusted again.
5. If **all** ports fail, returns `502 Bad Gateway` and logs `error: all backends unavailable` with the domain and port list.

Each individual backend attempt has a **10 s timeout**. SSE and other streaming requests (`Accept: text/event-stream`) skip the buffered failover path and stream directly via one round-robin selected port.

```sql
-- HA mapping: domain.com balanced across three local ports
INSERT INTO mappings (id, domain, front_uri, back_port, back_uri, backend)
VALUES ('550e8400-e29b-41d4-a716-446655440003', 'ha.example.com', '', '3000,3001,3002', '', NULL);
```

> **WebSocket**: always uses a single port (the first ranked port). HA applies to HTTP/HTTPS only.

## Raw TCP Proxying

In addition to HTTP/HTTPS, jsproxy can forward **raw TCP** (e.g. databases, message
brokers, or any TLS service via passthrough). This is **fully opt-in**: a TCP listener
exists only because you've added a TCP route. With no TCP routes, the proxy behaves
exactly as a pure HTTP/HTTPS proxy — the HTTP path is untouched.

### How routing works (the port is the key)

Raw TCP has no Host header, so jsproxy **cannot** route by inspecting the data.
Instead, **the port the client connects to _is_ the routing decision** — each route
listens on its own dedicated port and forwards every byte to one backend host + port:

```
client → jsproxy:<listen_port> → <backend>:<back_port>
```

It's one wire per port, not a shared front door. Unlike HTTP (one port :443, many
hostnames demuxed by the `Host:` header), each TCP service needs **its own port**:

```
client → jsproxy:5432  → db.internal:5432      (Postgres)
client → jsproxy:6379  → cache.internal:6379   (Redis)
client → jsproxy:25565 → game.internal:25565   (a game server)
```

jsproxy never reads the payload — bytes arriving on `:5432` go to the `:5432` route's
backend, full stop. The client chooses the destination purely by which port it dials.

> A comma-separated `back_port` (HA) still does **not** inspect content — it just fails
> over between interchangeable copies of the *same* service behind that one port. There
> is no way to multiplex multiple hostnames onto a single TCP port (that would require
> TLS SNI peeking, which is intentionally out of scope for the raw passthrough path).

**Add / list / delete routes** with the CLI:

```bash
# Forward TCP :5432 -> localhost:5432 (e.g. Postgres)
node scripts/add-tcp-route.js 5432 localhost 5432

# HA across two backend ports (same score-based failover engine as HTTP HA)
node scripts/add-tcp-route.js 5432 db.internal 5432,5433

# Restrict to a CIDR (IP allowlist works on raw sockets too)
node scripts/add-tcp-route.js 6379 localhost 6379 10.0.0.0/8

node scripts/add-tcp-route.js --list
node scripts/add-tcp-route.js 5432 --delete
```

TCP routes are stored in the same `mappings` table with `protocol = 'tcp'` and a
`listen_port`. They are **invisible to the HTTP router** (filtered by `protocol`), so
they cannot affect domain-based HTTP routing.

**Behaviour:**

- **HA / failover**: a comma-separated `back_port` reuses the exact HTTP HA engine
  (best-score-first, penalize-and-probe, background recovery). TCP failover happens
  strictly at the connect phase — before any client bytes are forwarded — so it is
  always safe. If all backends are down, the client connection is closed.
- **TLS**: pure passthrough — bytes are forwarded untouched and the **backend
  terminates TLS**. jsproxy does not decrypt, and no certificate is needed on this path.
- **Not applied to TCP**: auth, webhooks, and plugins are HTTP-layer features and do
  **not** run for TCP routes. Only the IP allowlist applies.
- **Lifecycle**: TCP routes are read once at startup. **Restart jsproxy** after adding
  or removing them (unlike HTTP mappings, which are read per request).

**Tuning** (optional env vars):

| Variable | Default | Meaning |
|---|---|---|
| `TCP_CONNECT_TIMEOUT_MS` | `HA_CONNECT_TIMEOUT_MS` (3000) | Upstream connect timeout before failover |
| `TCP_IDLE_TIMEOUT_MS` | `0` (never) | Idle timeout for established connections |

> A TCP `listen_port` must differ from `HTTP_PORT`/`HTTPS_PORT`; a colliding route is
> logged and skipped.

### Chaining jsproxy → jsproxy (raw TCP)

Forwarding raw TCP from one jsproxy to another works **out of the box**, and it is
simpler than the HTTP case — you do **not** need (and there is no) `back_host`.

With **HTTP**, chaining uses `back_host` because the downstream jsproxy routes on the
`Host:` header, so the upstream hop rewrites it. **Raw TCP has no header in the byte
stream**, and the downstream jsproxy routes purely by **which port the connection
lands on**. So the "what to route as" decision is simply *which `back_port` you target
on the downstream* — there is nothing to override, and injecting bytes would corrupt
the protocol. (`back_host` is therefore ignored on `protocol='tcp'` routes.)

To chain, point the upstream hop's `backend` at the downstream host and its `back_port`
at the downstream's `listen_port`:

```bash
# Edge proxy A (public): listen :5432, forward to proxy B's host
#   on B's TCP listen port 5432
[on host A]  node scripts/add-tcp-route.js 5432 proxy-b.internal 5432

# Inner proxy B (near the DB): listen :5432, forward to the real database
[on host B]  node scripts/add-tcp-route.js 5432 db.internal 5432
```

```
client → A:5432 ──raw bytes──→ B:5432 ──raw bytes──→ db.internal:5432
         (backend=proxy-b      (B routes by the port
          back_port=5432)        it received on, not a header)
```

The full byte stream — TLS ClientHello, Postgres startup packet, anything — passes
through both hops untouched. HA still composes: give either hop a comma-separated
`back_port` to fail over between interchangeable downstreams (e.g. two inner proxies,
or two DB replicas).

> **Client IP across hops**: a raw TCP hop does not preserve the original client
> address — the downstream proxy sees the *previous* proxy's IP as the source. If you
> use `allowed_ips`, the inner hop's allowlist must permit the outer proxy's IP, and
> any client-IP-based restriction should be enforced at the **first** (edge) hop, where
> the real client address is still visible. (PROXY-protocol header injection, which
> would carry the original IP across hops, is intentionally out of scope for the raw
> passthrough path.)

## Hot Database Replacement

Replace the database contents without downtime:

```bash
# Method 1: Using SQLite restore command
sqlite3 ./data/current.db ".restore 'new-database.db'"

# Method 2: Using the API (if implemented)
curl -X POST http://localhost:8080/admin/reload-db \
  -H "Content-Type: application/json" \
  -d '{"dbPath": "/path/to/new-database.db"}'
```

The system uses SQLite WAL mode to ensure:
- Readers continue with consistent snapshots during replacement
- Zero downtime for active connections
- Atomic database content replacement

## SSL Certificates

### Automatic Certificate Generation

- Certificates are automatically generated for new domains on first HTTPS request
- Uses Let's Encrypt ACME v2 protocol
- Certificates stored in `./certs/` directory
- Automatic renewal (implementation pending)

### Custom Certificates

Place custom certificates in the `./certs/` directory:

```bash
# Certificate files
./certs/example.com.crt
./certs/example.com.key
```

## Development

### Running Tests

```bash
# Run all tests
npm test

# Run tests in watch mode  
npm run test:watch

# Run with coverage
npm test -- --coverage
```

### Linting

```bash
# Check code style
npm run lint

# Fix automatically
npm run lint:fix
```

### Development Mode

```bash
# Run with auto-reload
npm run dev
```

### Plugin demos

Self-contained demos that spin up jsproxy, a backend, and a plugin — then run curl examples:

```bash
npm run demo:hello    # /hello always returns "Hello World!"
npm run demo:rewrite  # /api/v1/* transparently rewritten to /api/v2/*
npm run demo:retry    # 5xx responses retried with exponential backoff
```

Each demo leaves services running so you can copy-paste the curl commands and experiment. Ctrl+C shuts everything down.

## Architecture

### Process Structure

```
Master Process
├── Worker 1 (HTTP/HTTPS Server)
├── Worker 2 (HTTP/HTTPS Server)  
├── Worker 3 (HTTP/HTTPS Server)
└── Worker N (HTTP/HTTPS Server)
```

### Request Flow

1. **Request Reception**: Worker receives HTTP/HTTPS request
2. **Domain Resolution**: Extract domain from Host header
3. **Database Query**: Find matching mapping by domain + URI
4. **IP Check**: If `allowed_ips` is set, verify client IP — return `403` if not allowed
5. **Parallel work** (runs concurrently):
   - **SSL Handling**: Ensure certificate exists for HTTPS requests
   - **Webhook** (if `WEBHOOK_URL` set): POST request metadata, await decision
6. **Webhook gate**: Redirect or block based on webhook response; continue on `200`
7. **Plugin `/valid`** (if `PLUGIN` set): fan-out to all plugins in parallel — each opts in or out; if none opt in, step 8–10 are skipped entirely
8. **Plugin `/before`**: interested plugins called in order; can rewrite, cancel, or ignore the request
9. **Proxy Forward**: Forward request to backend service (with any rewrites applied)
10. **Plugin `/after`**: interested plugins called in order; can rewrite or cancel the response
11. **Response Return**: Send response to client

### Error Handling

- **Worker Crashes**: Master process automatically restarts workers
- **Backend Unavailable**: Returns 502 Bad Gateway
- **SSL Errors**: Falls back to self-signed certificate
- **Database Errors**: Logs error, continues with cached mappings

## Observability

### Logging

All log output is structured and single-line. Two formats are available, switched with `LOG_FORMAT`:

**Text (default)** — human-readable, colourable with `grep` / `awk`:
```
[2026-05-06T09:12:33.123Z] [INFO ] HTTP server listening  service=jsproxy  worker_id=0  host=0.0.0.0  port=8080
[2026-05-06T09:12:33.456Z] [ERROR] proxy error  service=jsproxy  worker_id=1  domain=api.example.com  method=GET  url=/v1/users  error_code=ECONNREFUSED  address=127.0.0.1  port=3041
[2026-05-06T09:12:33.789Z] [INFO ] tls client disconnected during handshake  domain=api.example.com  client_ip=1.2.3.4  error_code=ECONNRESET
```

**JSON (`LOG_FORMAT=json`)** — newline-delimited JSON for log shippers (Loki, Fluentd, Vector, etc.):
```json
{"ts":"2026-05-06T09:12:33.123Z","level":"info","msg":"HTTP server listening","service":"jsproxy","worker_id":0,"host":"0.0.0.0","port":8080}
{"ts":"2026-05-06T09:12:33.456Z","level":"error","msg":"proxy error","service":"jsproxy","worker_id":1,"domain":"api.example.com","method":"GET","url":"/v1/users","error_code":"ECONNREFUSED","address":"127.0.0.1","port":3041,"trace_id":"a1b2c3…","span_id":"d4e5f6…"}
```

Every error log line includes `domain`, `method`, `url`, and backend context (`address`, `port`, `error_code`) — no more context-free connection-refused messages.

**Log levels:**

| Level | What's logged |
|-------|--------------|
| `error` | Proxy failures (502/503), unhandled exceptions, backend completely unavailable |
| `warn` | HA port failure (before fallover), TLS errors (non-disconnect), rate limits |
| `info` | Startup/shutdown, request lifecycle, TLS client disconnects, cert events (default) |
| `debug` | Every request entry, routing decision, proxy hop, span dumps via ConsoleSpanExporter |

**Routing to stdout / stderr:**
- `info` and `debug` → **stdout**
- `warn` and `error` → **stderr**

This means `2>errors.log` captures only genuine problems and `>access.log` captures the normal flow.

**Notable log behaviour:**
- `ECONNRESET` / "socket hang up" during TLS handshake → `info` (normal client disconnect, not an error)
- Backend 5xx responses → `error` with `domain`, `backend_status`, `mapping_id`
- HA failover → `warn` per failed port, then `error` only if all ports are exhausted
- Stack traces are suppressed in text mode unless `LOG_LEVEL=debug`

### Health Check

```bash
curl http://localhost:8080/health   # → 200 OK
```

### OpenTelemetry Tracing

Every proxied request creates an OTEL span with the following attributes:

| Attribute | Example |
|-----------|---------|
| `http.method` | `GET` |
| `http.url` | `/v1/users?page=1` |
| `http.host` | `api.example.com` |
| `http.scheme` | `https` |
| `http.status_code` | `200` |
| `net.peer.ip` | `203.0.113.42` |
| `proxy.domain` | `api.example.com` |
| `proxy.mapping_id` | `550e8400-…` |
| `proxy.backend_port` | `3000` |
| `proxy.backend_status` | `200` |
| `error.code` | `ECONNREFUSED` (on failure) |

Incoming `traceparent` / `tracestate` headers are extracted (W3C format), so the proxy participates in distributed traces originating from upstream services.

`trace_id` and `span_id` are automatically injected into every log line emitted while a span is active, linking logs to traces.

**Enabling OTLP export:**

```bash
# Jaeger all-in-one (docker run --rm -p 4318:4318 -p 16686:16686 jaegertracing/all-in-one)
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 node index.js

# Grafana Tempo
OTEL_EXPORTER_OTLP_ENDPOINT=http://tempo:4318 node index.js

# Honeycomb
OTEL_EXPORTER_OTLP_ENDPOINT=https://api.honeycomb.io \
OTEL_EXPORTER_OTLP_HEADERS=x-honeycomb-team=YOUR_API_KEY \
node index.js
```

When no endpoint is configured, spans are still created and linked to logs but not exported (zero overhead — the OTLP exporter is simply not registered).

**Debug: print spans to stdout:**
```bash
LOG_LEVEL=debug node index.js   # ConsoleSpanExporter also fires for every span
```

### Docker Environment

```yaml
environment:
  - NODE_ENV=production
  - LOG_LEVEL=info
  - LOG_FORMAT=json                                 # for Loki / Fluentd
  - OTEL_SERVICE_NAME=jsproxy
  - OTEL_EXPORTER_OTLP_ENDPOINT=http://tempo:4318   # optional
```

## Performance

### Benchmarks

- **Concurrent Connections**: 10,000+
- **Requests/Second**: 5,000+ (depends on backend)
- **Memory Usage**: ~50MB base + ~1MB per 1000 concurrent connections
- **SSL Handshake**: <100ms for cached certificates

### Optimization

- WAL mode for concurrent database reads
- Connection pooling to backend services
- Certificate caching in memory
- Worker process load balancing

## Troubleshooting

### Common Issues

1. **Port 80/443 Permission Denied**
   ```bash
   # Run with sudo or use port forwarding
   sudo npm start
   ```

2. **Certificate Generation Fails**
   ```bash
   # Check domain DNS points to server
   dig api.example.com
   
   # Verify port 80 accessible for ACME challenge
   curl http://api.example.com/.well-known/acme-challenge/test
   ```

3. **Database Locked Errors**
   ```bash
   # Verify WAL mode enabled
   sqlite3 ./data/current.db "PRAGMA journal_mode;"
   # Should return: wal
   ```

4. **Backend Connection Refused**
   ```bash
   # Verify backend service running
   curl http://localhost:3000/health
   ```

### Debug Mode

```bash
# Full verbose logging — every request, routing decision, span dump
LOG_LEVEL=debug npm start

# Debug with JSON output for piping into jq
LOG_LEVEL=debug LOG_FORMAT=json npm start | jq 'select(.level == "error")'

# Watch only errors in real time
npm start 2>&1 | grep '"level":"error"'
```

## Deno / Single Binary

The `deno/` directory is a self-contained Deno port of jsproxy. It produces
a single native binary using `deno compile` — no Node.js, no `node_modules`,
no install step on the target machine.

### What's different

| Aspect | Node.js version | Deno version |
|--------|----------------|--------------|
| Runtime | Node.js ≥ 20 | Deno ≥ 2.0 |
| SQLite driver | `npm:sqlite3` (native addon) | `jsr:@db/sqlite` (Deno FFI) |
| Multi-process | `cluster` module (up to 4 workers) | Single process — run multiple copies behind a load-balancer |
| `.env` loading | `npm:dotenv` | `jsr:@std/dotenv` |
| System requirement | Node.js | `libsqlite3` on the target (present on all Linux/macOS) |

Everything else — database schema, cert directory layout, environment
variables, routing behaviour, HA, webhook interceptor — is identical.

### Requirements

- [Deno 2.0+](https://deno.com) (`curl -fsSL https://deno.land/install.sh | sh`)
- `libsqlite3` on the target system (standard on macOS; `apt install libsqlite3-dev` on Debian/Ubuntu)

### Run directly (no compile step)

```bash
cd deno
deno task start
```

### Compile to a single binary

```bash
cd deno

# Current platform
deno task compile          # → ../dist/jsproxy-deno

# Cross-compile
deno task compile-linux-x86   # → ../dist/jsproxy-deno-linux-x86
deno task compile-linux-arm   # → ../dist/jsproxy-deno-linux-arm
deno task compile-macos-arm   # → ../dist/jsproxy-deno-macos-arm
```

The resulting binary bundles all JavaScript/TypeScript and npm dependencies.
Copy it to any machine that has `libsqlite3` and run it directly.

### Install into PATH

```bash
cd deno
deno task install          # installs as ~/.deno/bin/jsproxy

# then anywhere:
jsproxy
```

### Configuration

Identical to the Node.js version — same `.env` file, same environment
variables (see [Environment Variables](#environment-variables)).

### Development (hot reload)

```bash
cd deno
deno task dev
```

## Contributing

1. Fork the repository
2. Create feature branch: `git checkout -b feature-name`
3. Run tests: `npm test`
4. Submit pull request

## License

MIT License - see LICENSE file for details.

## Security

- Never commit certificate private keys
- Use environment variables for sensitive configuration
- Regularly update dependencies
- Monitor logs for unusual traffic patterns
- Consider rate limiting for production use

## API Reference

### Database Operations

The `DatabaseManager` class provides methods for managing mappings:

```javascript
// Add new mapping (single port, open to all IPs)
await db.addMapping(domain, frontUri, backPort, backUri, backend);

// Add mapping with IP allowlist
await db.addMapping(domain, frontUri, backPort, backUri, backend, '10.0.0.0/8,203.0.113.5');

// Add HA mapping (comma-separated ports in backPort)
await db.addMapping(domain, frontUri, '3000,3001,3002', backUri, backend);

// Get mapping for request
const mapping = await db.getMapping(domain, requestUrl);

// Get all mappings
const mappings = await db.getAllMappings();

// Hot replace database
await db.hotReplaceDatabase(newDbPath);
```

### Certificate Operations

The `CertificateManager` class handles SSL certificates:

```javascript
// Ensure certificate exists
const cert = await certManager.ensureCertificate(domain);

// Get default certificate
const defaultCert = await certManager.getDefaultCertificate();
```

## FAQ

**Q: Can I use wildcard certificates?**
A: Yes, the system will detect TLD patterns and request wildcard certificates when beneficial.

**Q: What happens during certificate renewal?**
A: Certificates are renewed automatically 30 days before expiration with zero downtime.

**Q: Can I run multiple instances?**
A: Yes, but each instance needs its own certificate storage or shared storage with proper locking.

**Q: Does it support HTTP/2?**
A: Yes, HTTP/2 is supported automatically with HTTPS connections.

**Q: What about WebSocket connections?**
A: WebSocket connections are fully supported and proxied transparently.