'use strict';

// (Édition 3 h — fourni) Backlog de commandes lu en base : alimente les gauges
// métier orders_in_flight et orders_oldest_pending_seconds.
// À appeler une fois depuis le worker : require('../shared/backlog').startBacklogRefresh();
const { query } = require('./db');
const { ordersInFlight, ordersOldestPendingSeconds } = require('./metrics');

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
}

function startBacklogRefresh(intervalMs = 2000) {
  refreshOrderBacklog();
  return setInterval(refreshOrderBacklog, intervalMs).unref();
}

module.exports = { startBacklogRefresh, refreshOrderBacklog };
