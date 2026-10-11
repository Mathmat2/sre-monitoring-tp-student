'use strict';

const Redis = require('ioredis');
const chaos = require('./chaos');

const QUEUE_NAME = 'orders:queue';

const redis = new Redis(process.env.REDIS_URL || 'redis://redis:6379');

// Infra du TP : la queue de jobs est une simple liste Redis (LPUSH/BRPOP).
// Le hook dep-slow du chaos-injector retarde les opérations quand la faute
// "dep-slow redis" est active.

// Solution L2 : profondeur de la queue pour la gauge redis_queue_depth.
// (Tracing L3 : le span "redis.<op>" enveloppe le délai injecté — no-op sans SDK.)
let queueTracer = null;
try {
  queueTracer = require('@opentelemetry/api').trace.getTracer('tp-queue');
} catch (err) {
  queueTracer = null;
}

async function traced(name, fn) {
  if (!queueTracer) {
    return fn();
  }
  return queueTracer.startActiveSpan(name, async (span) => {
    try {
      return await fn();
    } catch (err) {
      span.recordException(err);
      throw err;
    } finally {
      span.end();
    }
  });
}

async function pushJob(payload) {
  return traced('redis.lpush', async () => {
    await chaos.applyDepSlow(redis, 'redis');
    return redis.lpush(QUEUE_NAME, JSON.stringify(payload));
  });
}

async function popJobBlocking(timeoutSeconds) {
  return traced('redis.brpop', async () => {
    await chaos.applyDepSlow(redis, 'redis');
    const res = await redis.brpop(QUEUE_NAME, timeoutSeconds);
    if (!res) return null;
    return JSON.parse(res[1]);
  });
}

// Exposé pour la mise à jour de la gauge redis_queue_depth (solution L2).
async function depth() {
  return redis.llen(QUEUE_NAME);
}

module.exports = { redis, pushJob, popJobBlocking, QUEUE_NAME, depth };
