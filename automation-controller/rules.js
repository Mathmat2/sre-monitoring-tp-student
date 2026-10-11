'use strict';

/**
 * Règles de remédiation — LE fichier à compléter (TODO(student, L5)).
 *
 * Chaque cycle (5 s), le contrôleur (index.js) vous passe un objet `state` :
 *   state.prom(query)      — async : interroge l'API Prometheus, renvoie result[]
 *   state.containers       — [{ name, service, state, status, scaled, project }]
 *   state.recentActions    — actions exécutées dans les 10 dernières minutes
 *   state.chaosStatus()    — async : état des faults actifs
 *   state.config           — seuils imposés : QUEUE_DEPTH_THRESHOLD (20),
 *                            WORKER_REPLICAS (3), CRASH_ESCALATION_MS (5 min),
 *                            ORDERS_STUCK_SECONDS (45), QUEUE_IDLE_DEPTH (3),
 *                            ORDERS_PAGE_DEDUP_MS (5 min)
 *
 * Retournez une liste d'actions :
 *   { type: 'start'|'restart', service: 'api' }
 *   { type: 'scale', service: 'worker', replicas: 3 }
 *   { type: 'page', message: 'pourquoi on vous réveille' }
 *   { type: 'circuitBreak', service: 'api' }   — no-op (le breaker vit dans l'app)
 *
 * Le contrôleur applique déjà un cooldown de 30 s par signature (type+service)
 * : inutile de craindre une tempête d'actions identiques, mais n'agissez que
 * sur des signaux soutenus, pas sur un instantané.
 */

module.exports.evaluateRules = async function evaluateRules(state) {
  const actions = [];
  const {
    CRASH_ESCALATION_MS,
    QUEUE_DEPTH_THRESHOLD,
    WORKER_REPLICAS,
    ORDERS_STUCK_SECONDS,
    QUEUE_IDLE_DEPTH,
    ORDERS_PAGE_DEDUP_MS,
  } = state.config;

  // ── Règle 1 — api crashée ────────────────────────────────────────────────
  // TODO(student, L5): si le conteneur du service 'api' n'est pas 'running',
  // le redémarrer (type 'start', service 'api'). S'il y a déjà eu une action
  // start/restart sur l'api il y a moins de CRASH_ESCALATION_MS (indice :
  // state.recentActions), c'est un crash-loop : escalader aussi (type 'page').

  // (Édition 3 h) Règles 2 et 3 fournies : lisez-les après avoir codé la règle 1.
  // La règle 3 réagit à un signal APPLICATIF (commandes), pas à l'infrastructure.
  // ── Règle 2 — queue Redis saturée de façon soutenue : scale workers ─────
  // avg_over_time évite de réagir à un pic d'un seul instant.
  const queue = await state.prom('avg_over_time(redis_queue_depth[30s])');
  const depth = queue.length ? Number(queue[0].value[1]) : 0;
  const workers = state.containers.filter(
    (c) => c.service === 'worker' && c.state === 'running'
  ).length;
  if (depth > QUEUE_DEPTH_THRESHOLD && workers < WORKER_REPLICAS) {
    actions.push({
      type: 'scale',
      service: 'worker',
      replicas: WORKER_REPLICAS,
    });
  }

  // ── Règle 3 — commandes bloquées (signal APPLICATIF, pas infra) ─────────
  // La plus ancienne commande non terminée attend depuis trop longtemps ALORS
  // QUE la queue est vide : ce n'est pas de la lenteur (la queue grossirait),
  // ce sont des jobs perdus. Aucune métrique d'infrastructure ne le montre, et
  // redémarrer ou scaler ne les récupère pas : on rend la main à un humain.
  const stuckRes = await state.prom('max(min_over_time(orders_oldest_pending_seconds[30s]))');
  const idleRes = await state.prom('max(avg_over_time(redis_queue_depth[30s]))');
  const oldest = stuckRes.length ? Number(stuckRes[0].value[1]) : 0;
  const queueDepth = idleRes.length ? Number(idleRes[0].value[1]) : 0;
  if (oldest > ORDERS_STUCK_SECONDS && queueDepth <= QUEUE_IDLE_DEPTH) {
    const alreadyPaged = state.recentActions.some(
      (a) =>
        a.action.type === 'page' &&
        String(a.action.message || '').startsWith('commandes bloquées') &&
        Date.now() - new Date(a.at).getTime() < ORDERS_PAGE_DEDUP_MS
    );
    if (!alreadyPaged) {
      actions.push({
        type: 'page',
        message: `commandes bloquées depuis ${Math.round(oldest)} s alors que la queue est vide : jobs perdus, intervention humaine requise`,
      });
    }
  }

  // ── Règle 4 — circuit breaker ────────────────────────────────────────────
  // TODO(student, L5): cette règle ne se programme PAS ici : le circuit breaker
  // s'implémente dans app/shared/db.js (voir le TODO dans ce fichier) —
  // l'application se protège elle-même sans attendre le contrôleur.

  return actions;
};
