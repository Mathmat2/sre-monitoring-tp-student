'use strict';

const pino = require('pino');

// Logger structuré (JSON) partagé par tous les services.
// Chaque ligne porte au minimum : level, time, service, msg (+ requestId via child).
const baseLogger = pino({
  level: process.env.LOG_LEVEL || 'info',
  timestamp: pino.stdTimeFunctions.isoTime,
  base: { service: process.env.SERVICE_NAME || 'unknown' },
});

module.exports = baseLogger;
