'use strict';

const baseLog = require('../shared/logger');
const chaos = require('../shared/chaos');
const { query } = require('../shared/db');
const { popJobBlocking } = require('../shared/queue');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function processOrder(job) {
  const log = job.requestId ? baseLog.child({ requestId: job.requestId }) : baseLog;
  const faults = await chaos.applyFaults();
  if (faults.shouldError) {
    throw new Error('chaos: erreur injectée pendant le traitement');
  }
  if (faults.delayMs > 0) {
    await chaos.sleep(faults.delayMs);
  }
  if (faults.shouldDrop) {
    return; // chaos (infra fournie) : job acquitté sans traitement = perte silencieuse (L4/L5)
  }
  await query("UPDATE orders SET status = 'processing', updated_at = now() WHERE id = $1", [job.orderId]);
  await sleep(200 + Math.floor(Math.random() * 300));
  await query("UPDATE orders SET status = 'completed', updated_at = now() WHERE id = $1", [job.orderId]);
  // TODO(student, L2): métriques MÉTIER — orders_total{status="completed"} et
  // order_processing_seconds (durée création → terminé : calculez-la en base, ex. via
  // RETURNING EXTRACT(EPOCH FROM (now() - created_at)) sur l'UPDATE),
  // seulement APRÈS le succès ; orders_total{status="failed"} dans le catch de main().
  // Aussi job_duration_seconds autour de processOrder (étape 4).
  log.info({ orderId: job.orderId }, 'commande traitée');
}

async function main() {
  baseLog.info('worker démarré, en attente de jobs...');
  // TODO(student, L2): exposer /metrics sur un petit serveur HTTP (port 3002) et
  // appeler require('../shared/backlog').startBacklogRefresh() (fourni).
  while (true) {
    let job = null;
    try {
      job = await popJobBlocking(5);
      if (!job) continue;
      await processOrder(job);
    } catch (err) {
        baseLog.error({ err, orderId: job && job.orderId }, 'erreur traitement job');
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
