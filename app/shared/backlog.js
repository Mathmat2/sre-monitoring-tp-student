'use strict';

// (Édition 3 h — fourni) Backlog de commandes lu en base : alimente les gauges
// métier orders_in_flight et orders_oldest_pending_seconds, ainsi que la gauge
// de saturation redis_queue_depth.
// À appeler une fois depuis le worker : require('../shared/backlog').startBacklogRefresh();
const { query } = require('./db');
const { ordersInFlight, ordersOldestPendingSeconds, redisQueueDepth } = require('./metrics');
const { depth } = require('./queue');

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
    console.error(`impossible de lire le backlog de commandes: ${err.message}`);
  }
  // Profondeur de la queue Redis (USE : saturation), lue à chaque rafraîchissement.
  try {
    redisQueueDepth.set(await depth());
  } catch (err) {
    console.error(`impossible de lire la profondeur de la queue: ${err.message}`);
  }
}

function startBacklogRefresh(intervalMs = 2000) {
  refreshOrderBacklog();
  return setInterval(refreshOrderBacklog, intervalMs).unref();
}

module.exports = { startBacklogRefresh, refreshOrderBacklog };
