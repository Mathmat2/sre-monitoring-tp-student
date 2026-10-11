'use strict';

const client = require('prom-client');

// Registre unique du process courant. Chaque service (api, worker) possède
// le sien : ne jamais partager un registre entre process.
const register = new client.Registry();

// Label par défaut : toutes les métriques du process portent le nom du service.
register.setDefaultLabels({ service: process.env.SERVICE_NAME || 'unknown' });

// Métriques process (mémoire, GC, event loop, ...) — utiles pour l'analyse USE.
client.collectDefaultMetrics({ register });

// ---- RED (Rate, Errors, Duration) ----
const httpRequestsTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Nombre total de requêtes HTTP traitées',
  labelNames: ['service', 'route', 'method', 'status'],
  registers: [register],
});

const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Durée des requêtes HTTP (secondes)',
  labelNames: ['service', 'route'],
  buckets: [0.05, 0.1, 0.2, 0.3, 0.5, 0.8, 1, 2, 5],
  registers: [register],
});

const jobDuration = new client.Histogram({
  name: 'job_duration_seconds',
  help: 'Durée de traitement des jobs (secondes)',
  labelNames: ['service'],
  buckets: [0.1, 0.25, 0.5, 1, 2, 5, 10],
  registers: [register],
});

// ---- Métier (monitoring applicatif) : que devient une commande ? ----
const ordersTotal = new client.Counter({
  name: 'orders_total',
  help: 'Commandes par statut (created côté api, completed|failed côté worker)',
  labelNames: ['service', 'status'],
  registers: [register],
});

const orderProcessingSeconds = new client.Histogram({
  name: 'order_processing_seconds',
  help: 'Délai entre la création d\'une commande et son statut completed (secondes)',
  labelNames: ['service'],
  buckets: [0.5, 1, 2, 5, 10, 30, 60],
  registers: [register],
});

const ordersInFlight = new client.Gauge({
  name: 'orders_in_flight',
  help: 'Commandes pending|processing des 10 dernières minutes',
  registers: [register],
});

const ordersOldestPendingSeconds = new client.Gauge({
  name: 'orders_oldest_pending_seconds',
  help: 'Âge (s) de la plus ancienne commande pending|processing des 10 dernières minutes',
  registers: [register],
});

// ---- Saturation (USE) ----
const dbPoolActive = new client.Gauge({
  name: 'db_pool_active',
  help: 'Connexions Postgres actives du pool',
  registers: [register],
});

const dbPoolIdle = new client.Gauge({
  name: 'db_pool_idle',
  help: 'Connexions Postgres inactives du pool',
  registers: [register],
});

const dbPoolWaiting = new client.Gauge({
  name: 'db_pool_waiting',
  help: 'Requêtes en attente d\'une connexion Postgres',
  registers: [register],
});

const redisQueueDepth = new client.Gauge({
  name: 'redis_queue_depth',
  help: 'Nombre de jobs en attente dans la queue Redis',
  labelNames: ['service'],
  registers: [register],
});

module.exports = {
  register,
  httpRequestsTotal,
  httpRequestDuration,
  jobDuration,
  ordersTotal,
  orderProcessingSeconds,
  ordersInFlight,
  ordersOldestPendingSeconds,
  dbPoolActive,
  dbPoolIdle,
  dbPoolWaiting,
  redisQueueDepth,
};
