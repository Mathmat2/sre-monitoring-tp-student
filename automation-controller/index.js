'use strict';

/**
 * Contrôleur d'auto-remédiation — squelette fourni (INFRA).
 *
 * Responsabilités (volontairement séparées) :
 *   1. OBSERVER  : collecter l'état du monde (Docker, Prometheus, chaos) toutes
 *      les POLL_INTERVAL_MS.
 *   2. DÉCIDER   : déléguer à rules.js (export evaluateRules(state)) — c'est le
 *      fichier que vous complétez.
 *   3. AGIR      : exécuter les actions retournées, avec un cooldown par
 *      signature (rate limiting anti-tempête) et une piste d'audit complète
 *      (logs JSON + GET /actions).
 *
 * Actions supportées par l'exécuteur :
 *   { type: 'start'|'restart', service: 'api' }   — démarrer/redémarrer un conteneur
 *   { type: 'scale', service: 'worker', replicas: N } — cloner des réplicas via l'API Docker
 *   { type: 'page', message: '...' }              — escalade humaine (webhook-receiver)
 *   { type: 'circuitBreak', ... }                 — no-op ici : le circuit breaker
 *                                                    vit dans app/shared/db.js
 */

const express = require('express');
const Docker = require('dockerode');
const pino = require('pino');

const rules = require('./rules.js');

const log = pino({ base: { service: 'automation-controller' } });

const PROMETHEUS_URL = process.env.PROMETHEUS_URL || 'http://prometheus:9090';
const CHAOS_URL = process.env.CHAOS_URL || 'http://chaos-injector:4000';
const WEBHOOK_URL = process.env.WEBHOOK_URL || '';
const DOCKER_SOCKET = process.env.DOCKER_SOCKET || '/var/run/docker.sock';
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS) || 5000;
const ACTION_COOLDOWN_MS = Number(process.env.ACTION_COOLDOWN_MS) || 30000;
const RECENT_WINDOW_MS = 10 * 60 * 1000;

const docker = new Docker({ socketPath: DOCKER_SOCKET });
const app = express();
app.use(express.json());

/** Piste d'audit en mémoire : { at, action, result } */
const actions = [];

async function prom(query) {
  const res = await fetch(
    `${PROMETHEUS_URL}/api/v1/query?query=${encodeURIComponent(query)}`
  );
  if (!res.ok) throw new Error(`prometheus HTTP ${res.status}`);
  const json = await res.json();
  return json.data.result;
}

async function chaosStatus() {
  const res = await fetch(`${CHAOS_URL}/chaos/status`);
  if (!res.ok) throw new Error(`chaos HTTP ${res.status}`);
  return res.json();
}

async function listContainers() {
  const list = await docker.listContainers({ all: true });
  return list.map((c) => ({
    id: c.Id,
    name: (c.Names[0] || '').replace(/^\//, ''),
    service: c.Labels['com.docker.compose.service'] || null,
    project: c.Labels['com.docker.compose.project'] || null,
    state: c.State,
    status: c.Status,
    scaled: c.Labels['tp.scaled'] === 'true',
  }));
}

function signatureOf(action) {
  // Une page est identifiée par son message : deux escalades différentes
  // (crash-loop, commandes bloquées) ne s'étouffent pas mutuellement, mais la
  // même escalade n'est pas répétée à chaque cycle de 5 s.
  const target = action.type === 'page' ? action.message || '' : action.service || action.container || '';
  return [action.type, target].join(':');
}

function resolveContainerName(service) {
  return listContainers().then((list) => {
    const found = list.find(
      (c) => c.service === service && c.state === 'running'
    ) || list.find((c) => c.service === service);
    if (!found) throw new Error(`aucun conteneur pour le service "${service}"`);
    return found.name;
  });
}

/** Scale par clonage Docker : inspecte le worker principal, crée des
 *  réplicas identiques (même image, env, cmd, réseau) nommés worker-scale-N. */
async function scaleService(service, replicas) {
  const list = await listContainers();
  const sameProject = list.filter((c) => c.project);
  const project =
    (sameProject[0] && sameProject[0].project) || 'sre-monitoring-tp';
  const all = list.filter((c) => c.service === service);
  const primary = all.find((c) => !c.scaled) || all[0];
  if (!primary) throw new Error(`aucun conteneur de base pour "${service}"`);
  if (replicas <= all.length) {
    // scale down : arrêter les réplicas excédentaires
    const extras = all.filter((c) => c.scaled).slice(replicas - (all.length - all.filter((c) => !c.scaled).length));
    for (const extra of extras) {
      await docker.getContainer(extra.id).stop().catch(() => {});
    }
    return { ok: true, replicas: replicas, scaledDown: extras.length };
  }
  const info = await docker.getContainer(primary.id).inspect();
  const created = [];
  for (let i = all.length; i < replicas; i++) {
    const name = `${project}-${service}-scale-${i - 1}`;
    const existing = list.find((c) => c.name === name);
    if (existing) {
      await docker.getContainer(existing.id).start().catch(() => {});
      created.push(name);
      continue;
    }
    const container = await docker.createContainer({
      name,
      Image: info.Config.Image,
      Env: info.Config.Env,
      Cmd: info.Config.Cmd,
      Labels: { ...info.Config.Labels, 'tp.scaled': 'true' },
      HostConfig: { NetworkMode: info.HostConfig.NetworkMode },
    });
    await container.start();
    created.push(name);
  }
  return { ok: true, replicas: replicas, created };
}

async function page(message) {
  await fetch(WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      status: 'firing',
      labels: { alertname: 'AutomationEscalation', severity: 'page' },
      annotations: { summary: message },
    }),
  });
}

async function act(action) {
  const entry = { at: new Date().toISOString(), action, result: null };
  const sig = signatureOf(action);
  const last = actions.find((a) => signatureOf(a.action) === sig);
  if (last && Date.now() - new Date(last.at).getTime() < ACTION_COOLDOWN_MS) {
    entry.result = {
      ok: false,
      skipped: `cooldown ${ACTION_COOLDOWN_MS}ms (${sig})`,
    };
    actions.push(entry);
    log.warn({ action: entry }, 'remediation skipped (cooldown)');
    return entry;
  }
  try {
    if (action.type === 'restart' || action.type === 'start') {
      const name = await resolveContainerName(action.service);
      const container = docker.getContainer(name);
      if (action.type === 'restart') await container.restart();
      else await container.start().catch(() => {});
      entry.result = { ok: true, container: name };
    } else if (action.type === 'scale') {
      entry.result = await scaleService(action.service, action.replicas);
    } else if (action.type === 'page') {
      await page(action.message);
      entry.result = { ok: true, webhook: WEBHOOK_URL };
    } else if (action.type === 'circuitBreak') {
      entry.result = {
        ok: true,
        note: 'le circuit breaker est implémenté dans app/shared/db.js',
      };
    } else {
      throw new Error(`type d'action inconnu : ${action.type}`);
    }
  } catch (err) {
    entry.result = { ok: false, error: err.message };
  }
  actions.push(entry);
  log.info({ action: entry }, 'remediation');
  return entry;
}

async function tick() {
  const containers = await listContainers();
  const state = {
    now: Date.now(),
    prom,
    chaosStatus,
    containers,
    recentActions: actions.filter(
      (a) => Date.now() - new Date(a.at).getTime() < RECENT_WINDOW_MS
    ),
    config: {
      QUEUE_DEPTH_THRESHOLD: 20,
      WORKER_REPLICAS: 3,
      CRASH_ESCALATION_MS: 5 * 60 * 1000,
      ORDERS_STUCK_SECONDS: 45,
      QUEUE_IDLE_DEPTH: 3,
      ORDERS_PAGE_DEDUP_MS: 5 * 60 * 1000,
    },
  };
  const decided = await rules.evaluateRules(state);
  for (const action of Array.isArray(decided) ? decided : []) {
    await act(action);
  }
  return decided;
}

async function loop() {
  for (;;) {
    try {
      await tick();
    } catch (err) {
      log.error({ err: err.message }, 'erreur de la boucle de décision');
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

app.get('/health', (req, res) => res.json({ ok: true }));
app.get('/actions', (req, res) => res.json({ actions }));
app.get('/containers', async (req, res) => {
  try {
    res.json({ containers: await listContainers() });
  } catch (err) {
    res.status(503).json({ error: err.message });
  }
});
app.post('/evaluate', async (req, res) => {
  try {
    res.json({ decided: await tick() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = Number(process.env.PORT) || 5002;
app.listen(PORT, () => log.info({ port: PORT }, 'contrôleur prêt'));
loop();
