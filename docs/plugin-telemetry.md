# telemetry plugin

Captures per-request spans (method, route, status code, latency, error flag) for every
request that passes through jsproxy — without touching your application code.

Spans are forwarded to a configurable backend. Four targets are built in:

| Target | What it does |
|---|---|
| `console` | Pretty-prints coloured spans to stdout (default; great for local dev) |
| `webhook` | POSTs a JSON span to any HTTP/HTTPS endpoint |
| `otel` | POSTs an OTLP/HTTP span to an OpenTelemetry collector |
| `sentry` | POSTs a Sentry transaction envelope (Performance Monitoring) |

## Quick start

```bash
# Terminal 1 — plugin (console mode, no external service needed)
node plugins/telemetry.js

# Terminal 2 — jsproxy
node scripts/add-mapping.js localhost 3000
PLUGIN=localhost:3004 node index.js
```

Or run the self-contained demo:

```bash
npm run demo:telemetry
```

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3004` | Plugin listen port |
| `TELEMETRY_TARGET` | `console` | `console` · `webhook` · `otel` · `sentry` |
| `TELEMETRY_SERVICE_NAME` | `jsproxy` | Service name tag attached to every span |
| `TELEMETRY_SAMPLE_RATE` | `1.0` | Fraction of requests to capture (0.0–1.0) |
| `TELEMETRY_IGNORE_PATHS` | `/health` | Comma-separated path prefixes to skip |
| `TELEMETRY_WEBHOOK_URL` | — | Required when `target=webhook` |
| `TELEMETRY_OTEL_ENDPOINT` | `http://localhost:4318/v1/traces` | OTLP/HTTP collector URL |
| `TELEMETRY_SENTRY_DSN` | — | Required when `target=sentry` |

## Span shape

Every span emitted (regardless of target) has the same fields:

```json
{
  "traceId":    "550e8400-e29b-41d4-a716-446655440000",
  "service":    "jsproxy",
  "method":     "GET",
  "uri":        "/api/users?page=2",
  "domain":     "api.example.com",
  "inPort":     8080,
  "statusCode": 200,
  "latencyMs":  34,
  "error":      false,
  "timestamp":  "2025-01-15T12:34:56.789Z"
}
```

`error` is `true` when `statusCode >= 500`. `traceId` is the jsproxy `requestId` (UUID).

## How it works

```
/valid  → returns false for ignored paths or unsampled requests
/before → saves { startMs, method, uri, domain, inPort } keyed by requestId
/after  → computes latencyMs, builds span, emits fire-and-forget, returns CONTINUE
```

The emit is fire-and-forget: the plugin returns `CONTINUE` immediately without waiting
for the telemetry backend to acknowledge. On timeout or network error the span is dropped
silently (fail-open).

Per-request state is cleaned up in `/after`. A GC interval evicts stale entries older
than 2 minutes as a safety net for dropped connections.

## Target: console (demo / local dev)

No configuration needed. Spans are printed with colour-coded status:

```
[telemetry] ✓ GET /api/users  200  12ms  trace=550e8400…  svc=jsproxy
[telemetry] ⚠ GET /api/missing  404  8ms  trace=6ba7b810…  svc=jsproxy
[telemetry] ✗ GET /api/crash  500  3ms  trace=6ba7b811…  svc=jsproxy
```

## Target: webhook

POST a JSON span body to any endpoint. Use this to send to:

- A custom log aggregator
- A Slack or Discord incoming webhook (with a small adapter)
- Logtail, Axiom, Seq, or any HTTP ingestor

```bash
TELEMETRY_TARGET=webhook \
TELEMETRY_WEBHOOK_URL=https://hooks.slack.com/services/T00/B00/xxx \
node plugins/telemetry.js
```

The full span JSON is sent as the request body with `Content-Type: application/json`.

## Target: otel (OpenTelemetry)

POSTs an [OTLP/HTTP](https://opentelemetry.io/docs/specs/otlp/#otlphttp-request) trace
to any OpenTelemetry-compatible collector:

- **Jaeger** — set `TELEMETRY_OTEL_ENDPOINT=http://localhost:4318/v1/traces` (OTLP receiver)
- **Grafana Tempo** — same OTLP/HTTP endpoint
- **Honeycomb** — `https://api.honeycomb.io/v1/traces` (add auth header via a collector)
- **Datadog** — enable OTLP receiver in the Datadog agent, point at `localhost:4318`
- **otel-collector** — any standard collector pipeline

```bash
TELEMETRY_TARGET=otel \
TELEMETRY_OTEL_ENDPOINT=http://localhost:4318/v1/traces \
TELEMETRY_SERVICE_NAME=my-api \
node plugins/telemetry.js
```

**Span attributes set:**

| OTel attribute | Value |
|---|---|
| `service.name` | `TELEMETRY_SERVICE_NAME` |
| `http.method` | `GET`, `POST`, … |
| `http.target` | full URI including query string |
| `http.status_code` | HTTP status |
| `net.host.name` | frontend domain |
| `net.host.port` | frontend port |

**traceId:** derived from the jsproxy `requestId` UUID (32 hex chars).
**spanId:** 8 random bytes per span.

## Target: sentry

POSTs a [Sentry envelope](https://develop.sentry.dev/sdk/envelopes/) transaction for
**Performance Monitoring**. Transactions appear in Sentry's Perf tab.

```bash
TELEMETRY_TARGET=sentry \
TELEMETRY_SENTRY_DSN=https://PUBLIC_KEY@oNNNNN.ingest.sentry.io/PROJECT_ID \
node plugins/telemetry.js
```

**What you see in Sentry:**

- Transaction name: `GET /api/users` (method + path, no query string)
- Duration: request latency in ms
- Status: `ok` (2xx), `invalid_argument` (4xx), `internal_error` (5xx)
- Tags: `http.status_code`, `http.method`, `service`

**DSN format:** `https://PUBLIC_KEY@oNNNNN.ingest.sentry.io/PROJECT_ID`

The plugin uses the Sentry Envelope API directly — no `@sentry/node` SDK required.

## Sampling

Use `TELEMETRY_SAMPLE_RATE` to capture a fraction of requests. Sampling happens at
`/valid` time (before request buffering), so unsampled requests incur zero overhead
beyond the lightweight `/valid` call.

```bash
# Capture 10% of traffic
TELEMETRY_SAMPLE_RATE=0.1 node plugins/telemetry.js

# Capture everything (default)
TELEMETRY_SAMPLE_RATE=1.0 node plugins/telemetry.js
```

## Ignoring paths

`/health` is ignored by default. Add more paths with `TELEMETRY_IGNORE_PATHS`:

```bash
# Ignore health checks and asset paths
TELEMETRY_IGNORE_PATHS=/health,/ready,/static,/favicon.ico node plugins/telemetry.js
```

Matching is prefix-based: `/static` ignores `/static/css/main.css` and `/static?v=2`.

## Chaining with other plugins

The telemetry plugin always returns `CONTINUE` from both `/before` and `/after`, so it
is safe to chain with any other plugin. Put it last in the chain so it captures the
final status code (after rewrites, retries, etc.):

```bash
# Rewrite first, then capture telemetry on the rewritten request
PLUGIN=localhost:3002,localhost:3004 node index.js

# Retry first, then capture telemetry on the final outcome
PLUGIN=localhost:3003,localhost:3004 node index.js
```

## Running the demo

```bash
npm run demo:telemetry
```

Starts the demo backend, the telemetry plugin in `console` mode, and jsproxy. Then runs:

```bash
# 200 span
curl http://localhost:8080/api/users

# Slow span (500ms latency)
curl http://localhost:8080/api/slow

# Error span (500 → error=true)
curl http://localhost:8080/api/crash

# Ignored (no span emitted)
curl http://localhost:8080/health
```

Watch the plugin terminal for colour-coded spans after each request.

## Switching targets without code changes

```bash
# Local dev: console
TELEMETRY_TARGET=console node plugins/telemetry.js

# Staging: send to a local otel-collector
TELEMETRY_TARGET=otel TELEMETRY_OTEL_ENDPOINT=http://otel-collector:4318/v1/traces \
  node plugins/telemetry.js

# Production: send to Sentry
TELEMETRY_TARGET=sentry TELEMETRY_SENTRY_DSN=https://key@o123.ingest.sentry.io/456 \
  node plugins/telemetry.js
```

## Writing a custom target

If you need a target not listed above, set `TELEMETRY_TARGET=webhook` and write a thin
HTTP receiver that accepts the span JSON and forwards it to your backend.

Alternatively, fork `plugins/telemetry.js` and add an `emitMyBackend(span)` function
alongside the existing ones. The span object is a plain JavaScript object — no SDK
dependencies required.
