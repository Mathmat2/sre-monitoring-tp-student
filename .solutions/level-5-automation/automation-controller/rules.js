'use strict';

/**
 * Solution L5 — règles de remédiation du contrôleur.
 * Deux règles actives + un renvoi vers l'app pour le circuit breaker.
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

  // ── Règle 1 — api crashée : restart ; escalade si crash-loop ────────────
  const api = state.containers.find((c) => c.service === 'api');
  if (api && api.state !== 'running') {
    // Y a-t-il déjà eu un redémarrage récent ? → le crash se répète.
    const recentRestart = state.recentActions.some(
      (a) =>
        (a.action.type === 'start' || a.action.type === 'restart') &&
        a.action.service === 'api' &&
        Date.now() - new Date(a.at).getTime() < CRASH_ESCALATION_MS
    );
    actions.push({ type: 'start', service: 'api' });
    if (recentRestart) {
      actions.push({
        type: 'page',
        message: `api en crash-loop (2e arret en moins de ${
          CRASH_ESCALATION_MS / 60000
        } min) — intervention humaine requise`,
      });
    }
  }

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

  // ── Règle 4 — circuit breaker : implémenté dans app/shared/db.js ────────
  return actions;
};
