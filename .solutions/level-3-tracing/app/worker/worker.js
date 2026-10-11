'use strict';

const http = require('http');
const { trace, context, propagation } = require('@opentelemetry/api');
const baseLog = require('../shared/logger');
const chaos = require('../shared/chaos');
const { query } = require('../shared/db');
const { popJobBlocking, QUEUE_NAME } = require('../shared/queue');
const {
  register,
  jobDuration,
  redisQueueDepth,
  ordersTotal,
  orderProcessingSeconds,
  ordersInFlight,
  ordersOldestPendingSeconds,
} = require('../shared/metrics');
const queue = require('../shared/queue');

const SERVICE = process.env.SERVICE_NAME || 'worker';
const tracer = trace.getTracer('worker');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Endpoint /metrics du worker (L2).
const metricsServer = http.createServer(async (req, res) => {
  if (req.url === '/metrics') {
    res.setHeader('Content-Type', register.contentType);
    res.end(await register.metrics());
    return;
  }
  res.statusCode = 404;
  res.end('not found');
});
metricsServer.listen(Number(process.env.METRICS_PORT) || 3002);

// L2 : profondeur de la queue.
async function refreshQueueDepth() {
  try {
    redisQueueDepth.labels(SERVICE).set(await queue.redis.llen(QUEUE_NAME));
  } catch (err) {
    baseLog.error({ err }, 'impossible de lire la profondeur de la queue');
  }
}
setInterval(refreshQueueDepth, 2000).unref();
refreshQueueDepth();

// Métriques métier : l'état réel des commandes, lu en base (pas déduit du HTTP).
async function refreshOrderBacklog() {
  try {
    const r = await query(
      `SELECT count(*)::int AS n,
              COALESCE(EXTRACT(EPOCH FROM (now() - min(created_at))), 0)::float AS oldest
         FROM orders
        WHERE status IN ('pending', 'processing')
          AND created_at > now() - interval '10 minutes'`
    );
    ordersInFlight.set(r.rows[0].n);
    ordersOldestPendingSeconds.set(r.rows[0].oldest);
  } catch (err) {
    baseLog.error({ err }, 'impossible de lire le backlog de commandes');
  }
}
setInterval(refreshOrderBacklog, 2000).unref();
refreshOrderBacklog();

// L3 : span métier manuel, enfant du contexte propagé par la queue.
async function processOrderWithSpan(job) {
  return tracer.startActiveSpan('processOrder', async (span) => {
    try {
      await processOrder(job);
    } catch (err) {
      span.recordException(err);
      throw err;
    } finally {
      span.end();
    }
  });
}

async function processOrder(job) {
  const log = job.requestId ? baseLog.child({ requestId: job.requestId }) : baseLog;
  const start = process.hrtime.bigint();
  const faults = await chaos.applyFaults();
  if (faults.shouldError) {
    throw new Error('chaos: erreur injectée pendant le traitement');
  }
  if (faults.delayMs > 0) {
    await chaos.sleep(faults.delayMs);
  }
  if (faults.shouldDrop) {
    return; // chaos: job perdu en silence (acquitté sans traitement)
  }
  await query("UPDATE orders SET status = 'processing', updated_at = now() WHERE id = $1", [job.orderId]);
  await sleep(200 + Math.floor(Math.random() * 300));
  const done = await query(
    "UPDATE orders SET status = 'completed', updated_at = now() WHERE id = $1 RETURNING EXTRACT(EPOCH FROM (now() - created_at))::float AS age",
    [job.orderId]
  );
  ordersTotal.labels(SERVICE, 'completed').inc();
  orderProcessingSeconds.labels(SERVICE).observe(done.rows[0].age);
  jobDuration.labels(SERVICE).observe(Number(process.hrtime.bigint() - start) / 1e9);
  log.info({ orderId: job.orderId }, 'commande traitée');
}

async function handleJob(job) {
  // L3 : ré-ancrage du contexte de trace sérialisé par l'api dans le payload.
  const parentContext = propagation.extract(context.active(), job.traceCtx || {});
  await context.with(parentContext, () => processOrderWithSpan(job));
}

async function main() {
  baseLog.info('worker démarré, en attente de jobs...');
  while (true) {
    let job = null;
    try {
      job = await popJobBlocking(5);
      if (!job) continue;
      await handleJob(job);
    } catch (err) {
      baseLog.error({ err, orderId: job && job.orderId }, 'erreur traitement job');
      if (job) ordersTotal.labels(SERVICE, 'failed').inc();
      if (job && job.orderId) {
        try {
          await query('UPDATE orders SET status = $2, error = $3, updated_at = now() WHERE id = $1', [
            job.orderId,
            'failed',
            err.message.slice(0, 500),
          ]);
        } catch (dbErr) {
          baseLog.error({ err: dbErr }, 'impossible de marquer la commande en échec');
        }
      }
      await sleep(500);
    }
  }
}

main().catch((err) => {
  baseLog.error({ err }, 'worker arrêté');
  process.exit(1);
});
