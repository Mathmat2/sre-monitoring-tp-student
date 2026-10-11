'use strict';

const { Pool } = require('pg');
const chaos = require('./chaos');
const { dbPoolActive, dbPoolIdle, dbPoolWaiting } = require('./metrics');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://app:apppass@postgres:5432/orders_db',
  max: Number(process.env.PG_POOL_MAX || 10),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
});

// Infra du TP : tout accès SQL de l'application passe par ce wrapper, qui
// applique la latence injectée par le chaos-injector sur la dépendance
// "postgres".

// Solution L2 : saturation du pool Postgres exposée via les gauges db_pool_*.
// (Tracing L3 : le span "postgres.<op>" enveloppe le délai injecté — no-op sans SDK.)
let dbTracer = null;
try {
  dbTracer = require('@opentelemetry/api').trace.getTracer('tp-db');
} catch (err) {
  dbTracer = null;
}

// ── Solution L5 : circuit breaker ────────────────────────────────────────────
// Quand le pool sature (beaucoup de requêtes en attente d'une connexion),
// on OUVERT le circuit : toute nouvelle requête SQL est refusée immédiatement
// (fail-fast) pendant BREAKER_OPEN_MS, au lieu de s'empiler et de faire
// exploser les latences de toute l'application. Passé ce délai, on tente
// à nouveau (semi-ouvert) : si le pool respire, tout revient à la normale.
const BREAKER_WAITING_THRESHOLD = 5;
const BREAKER_OPEN_MS = 10000;
let breakerOpenUntil = 0;

async function query(sql, params) {
  if (pool.waitingCount >= BREAKER_WAITING_THRESHOLD) {
    breakerOpenUntil = Date.now() + BREAKER_OPEN_MS;
  }
  if (Date.now() < breakerOpenUntil) {
    const err = new Error(
      'circuit breaker ouvert : pool Postgres sature, requete refusee (fail-fast)'
    );
    err.code = 'ECIRCUITBREAKER';
    throw err;
  }
  if (!dbTracer) {
    await chaos.applyDepSlow(pool, 'postgres');
    return pool.query(sql, params);
  }
  const op = sql.trim().split(/\s+/)[0].toLowerCase() || 'query';
  return dbTracer.startActiveSpan(`postgres.${op}`, async (span) => {
    try {
      await chaos.applyDepSlow(pool, 'postgres');
      return await pool.query(sql, params);
    } catch (err) {
      span.recordException(err);
      throw err;
    } finally {
      span.end();
    }
  });
}

setInterval(() => {
  dbPoolActive.set(Math.max(0, pool.totalCount - pool.idleCount));
  dbPoolIdle.set(pool.idleCount);
  dbPoolWaiting.set(pool.waitingCount);
}, 2000).unref();

module.exports = { pool, query };
