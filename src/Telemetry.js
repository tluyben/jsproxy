'use strict';

/**
 * OTEL setup. Must be required before any HTTP servers start.
 *
 * Env vars:
 *   OTEL_SERVICE_NAME                     service name (default: jsproxy)
 *   OTEL_EXPORTER_OTLP_ENDPOINT           e.g. http://localhost:4318
 *   OTEL_EXPORTER_OTLP_TRACES_ENDPOINT    e.g. http://localhost:4318/v1/traces
 *   OTEL_EXPORTER_OTLP_HEADERS            comma-separated key=value pairs
 *   LOG_LEVEL=debug                        also prints spans to stdout
 */

const {
  NodeTracerProvider,
  BatchSpanProcessor,
  SimpleSpanProcessor,
  ConsoleSpanExporter,
} = require('@opentelemetry/sdk-trace-node');

const { OTLPTraceExporter }        = require('@opentelemetry/exporter-trace-otlp-http');
const { resourceFromAttributes }   = require('@opentelemetry/resources');
const { W3CTraceContextPropagator } = require('@opentelemetry/core');
const {
  trace, context, propagation,
  SpanKind, SpanStatusCode,
} = require('@opentelemetry/api');

const pkg         = require('../package.json');
const serviceName = process.env.OTEL_SERVICE_NAME || 'jsproxy';

const provider = new NodeTracerProvider({
  resource: resourceFromAttributes({
    'service.name':    serviceName,
    'service.version': pkg.version,
  }),
});

// OTLP exporter — active when either endpoint env var is set
const hasOtlp = !!(
  process.env.OTEL_EXPORTER_OTLP_ENDPOINT ||
  process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT
);
if (hasOtlp) {
  // OTLPTraceExporter reads env vars automatically (endpoint + headers)
  provider.addSpanProcessor(new BatchSpanProcessor(new OTLPTraceExporter()));
}

// Console exporter in debug mode (pretty-prints each span to stdout)
if (process.env.LOG_LEVEL === 'debug') {
  provider.addSpanProcessor(new SimpleSpanProcessor(new ConsoleSpanExporter()));
}

provider.register({
  propagator: new W3CTraceContextPropagator(),
});

const tracer = trace.getTracer(serviceName, pkg.version);

module.exports = { tracer, trace, context, propagation, SpanKind, SpanStatusCode };
