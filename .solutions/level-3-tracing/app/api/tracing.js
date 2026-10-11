'use strict';

// Bootstrap OpenTelemetry : DOIT être chargé avant tout autre module
// (node --require ./api/tracing.js api/server.js — commande déjà définie
// dans docker-compose.l3.yml).
const { NodeSDK } = require('@opentelemetry/sdk-node');
const { getNodeAutoInstrumentations } = require('@opentelemetry/auto-instrumentations-node');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');

const sdk = new NodeSDK({
  serviceName: process.env.SERVICE_NAME || 'unknown',
  traceExporter: new OTLPTraceExporter({
    url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://jaeger:4318/v1/traces',
  }),
  instrumentations: [getNodeAutoInstrumentations()],
});

sdk.start();
