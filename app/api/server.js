'use strict';

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const log = require('../shared/logger');
const chaos = require('../shared/chaos');
const { query } = require('../shared/db');
const { pushJob } = require('../shared/queue');

const app = express();

app.use(cors());
app.use(express.json());

// TODO(student, L2): middleware RED (rate / errors / duration) — il doit être le
// PREMIER middleware de la pile (avant le hook chaos ci-dessous), sinon la
// latence injectée est invisible dans le p99. Label `route` = pattern
// (req.route.path), jamais l'URL brute. Puis exposer GET /metrics.
// Voir levels/level-2-metrics/TUTORIAL.md, étapes 3 et 4. (Les noms de métriques
// sont déjà définis dans app/shared/metrics.js.)

// ---- Corrélation de requêtes (L1, fourni) ----
app.use((req, res, next) => {
  const requestId = req.get('x-request-id') || crypto.randomUUID();
  res.set('x-request-id', requestId);
  req.requestId = requestId;
  req.log = log.child({ requestId });
  next();
});

// ---- Hook d'injection de fautes (infra fournie, ne pas modifier) ----
// Lit chaos:config dans Redis à chaque requête et applique cpu-burn / mem-leak /
// latence / taux d'erreur injectés par le chaos-injector.
app.use(async (req, res, next) => {
  try {
    const faults = await chaos.applyFaults();
    if (faults.shouldError) {
      req.log.error({ injected: true }, 'chaos: requête rejetée (erreur injectée)');
      return res.status(500).json({ error: 'internal error' });
    }
    if (faults.delayMs > 0) {
      return setTimeout(next, faults.delayMs);
    }
    next();
  } catch (err) {
    next();
  }
});

app.use((req, res, next) => {
  req.log.debug({ method: req.method, url: req.url }, 'requête entrante');
  next();
});

app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'api' });
});

app.post('/orders', async (req, res) => {
  const { item, amount } = req.body || {};
  if (!item || typeof item !== 'string' || !Number.isFinite(Number(amount))) {
    req.log.warn({ body: req.body }, 'requête invalide');
    return res.status(400).json({ error: 'item (string) et amount (number) requis' });
  }
  try {
    const result = await query(
      "INSERT INTO orders (item, amount, status) VALUES ($1, $2, 'pending') RETURNING id, status",
      [item.slice(0, 200), Number(amount)]
    );
    const order = result.rows[0];
    // TODO(student, L2): métrique métier — incrémenter orders_total{status="created"} ici,
    // APRÈS l'INSERT réussi (étape 4b du tutoriel).
    await pushJob({ orderId: order.id, requestId: req.requestId, createdAt: new Date().toISOString() });
    req.log.info({ orderId: order.id, item: order.item }, 'commande créée');
    res.status(202).json({ id: order.id, status: order.status });
  } catch (err) {
    req.log.error({ err }, 'erreur création commande');
    res.status(500).json({ error: 'internal error' });
  }
});

app.get('/orders', async (req, res) => {
  try {
    const result = await query(
      'SELECT id, item, amount, status, created_at, updated_at FROM orders ORDER BY id DESC LIMIT 50'
    );
    res.json(result.rows);
  } catch (err) {
    req.log.error({ err }, 'erreur listing commandes');
    res.status(500).json({ error: 'internal error' });
  }
});

app.get('/orders/:id', async (req, res) => {
  try {
    const result = await query(
      'SELECT id, item, amount, status, created_at, updated_at FROM orders WHERE id = $1',
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'commande introuvable' });
    }
    res.json(result.rows[0]);
  } catch (err) {
    req.log.error({ err }, 'erreur lecture commande');
    res.status(500).json({ error: 'internal error' });
  }
});

const port = Number(process.env.PORT) || 3001;
app.listen(port, () => {
  log.info({ port }, 'api prête');
});
