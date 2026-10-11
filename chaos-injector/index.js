'use strict';

const express = require('express');

const CONFIG_KEY = 'chaos:config';
const REDIS_URL = process.env.REDIS_URL || 'redis://redis:6379';

const { Redis } = require('ioredis');
const redis = new Redis(REDIS_URL);

let exhaust = null;

async function readConfig() {
  try {
    const raw = await redis.get(CONFIG_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (err) {
    return {};
  }
}

async function updateConfig(mutate) {
  const cfg = await readConfig();
  mutate(cfg);
  await redis.set(CONFIG_KEY, JSON.stringify(cfg));
  return cfg;
}

function getDocker() {
  const Docker = require('dockerode');
  return new Docker({ socketPath: process.env.DOCKER_SOCKET || '/var/run/docker.sock' });
}

const app = express();
app.use(express.json());

app.post('/chaos/latency', async (req, res) => {
  const { target = 'api', ms = 500, jitter = 0 } = req.body || {};
  await updateConfig((cfg) => {
    cfg.latency = { target, ms: Number(ms), jitter: Number(jitter) };
  });
  res.json({ ok: true, latency: { target, ms: Number(ms), jitter: Number(jitter) } });
});

app.post('/chaos/error-rate', async (req, res) => {
  const { target = 'api', rate = 0.5 } = req.body || {};
  await updateConfig((cfg) => {
    cfg.errorRate = { target, rate: Number(rate) };
  });
  res.json({ ok: true, errorRate: { target, rate: Number(rate) } });
});

app.post('/chaos/cpu-burn', async (req, res) => {
  const { target = 'api', seconds = 5 } = req.body || {};
  await updateConfig((cfg) => {
    cfg.cpuBurn = { target, seconds: Number(seconds) };
  });
  res.json({ ok: true, cpuBurn: { target, seconds: Number(seconds) } });
});

app.post('/chaos/mem-leak', async (req, res) => {
  const { target = 'api', rateMb = 10 } = req.body || {};
  await updateConfig((cfg) => {
    cfg.memLeak = { target, rateMb: Number(rateMb) };
  });
  res.json({ ok: true, memLeak: { target, rateMb: Number(rateMb) } });
});

app.post('/chaos/job-drop', async (req, res) => {
  const { target = 'worker', rate = 0.5 } = req.body || {};
  await updateConfig((cfg) => {
    cfg.jobDrop = { target, rate: Number(rate) };
  });
  res.json({ ok: true, jobDrop: { target, rate: Number(rate) } });
});

app.post('/chaos/dep-slow', async (req, res) => {
  const { dependency = 'redis', ms = 200 } = req.body || {};
  if (!['redis', 'postgres'].includes(dependency)) {
    return res.status(400).json({ error: 'dependency doit valoir "redis" ou "postgres"' });
  }
  await updateConfig((cfg) => {
    cfg.depSlow = cfg.depSlow || {};
    cfg.depSlow[dependency] = { ms: Number(ms) };
  });
  res.json({ ok: true, depSlow: { dependency, ms: Number(ms) } });
});

app.post('/chaos/db-pool-exhaust', async (req, res) => {
  if (exhaust) {
    return res.status(409).json({ error: 'db-pool-exhaust déjà actif', status: exhaust });
  }
  const connections = Math.max(1, Number((req.body || {}).connections) || 8);
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgres://app:apppass@postgres:5432/appdb',
    max: connections,
  });
  const clients = [];
  try {
    for (let i = 0; i < connections; i++) {
      clients.push(await pool.connect());
    }
  } catch (err) {
    for (const c of clients) c.release();
    try { await pool.end(); } catch (e) {}
    return res.status(500).json({ error: `impossible d'ouvrir ${connections} connexions: ${err.message}` });
  }
  exhaust = { pool, clients, connections, since: new Date().toISOString() };
  res.json({ ok: true, connections, since: exhaust.since });
});

app.post('/chaos/kill', async (req, res) => {
  const { target } = req.body || {};
  if (!target) return res.status(400).json({ error: 'target requis' });
  try {
    const docker = getDocker();
    // target accepte un nom de conteneur exact OU un service compose
    // (ex. "api") — même convention que les autres faults.
    const all = await docker.listContainers({ all: true });
    const found =
      all.find((c) => c.Names.some((n) => n.replace(/^\//, '') === target)) ||
      all.find(
        (c) =>
          c.Labels['com.docker.compose.service'] === target &&
          c.State === 'running'
      ) ||
      all.find((c) => c.Labels['com.docker.compose.service'] === target);
    if (!found) {
      return res
        .status(404)
        .json({ error: `aucun conteneur pour la cible "${target}"` });
    }
    const name = found.Names[0].replace(/^\//, '');
    const container = docker.getContainer(found.Id);
    await container.kill({ signal: 'SIGKILL' });
    res.json({ ok: true, killed: name, note: 'conteneur arrêté (crash simulé)' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/chaos/reset', async (req, res) => {
  await redis.del(CONFIG_KEY);
  if (exhaust) {
    try {
      for (const client of exhaust.clients) client.release();
      await exhaust.pool.end();
    } catch (err) {}
    exhaust = null;
  }
  res.json({ ok: true, faults: {} });
});

app.get('/chaos/status', async (req, res) => {
  const cfg = await readConfig();
  res.json({ faults: cfg, dbPoolExhaust: exhaust ? { connections: exhaust.connections, since: exhaust.since } : null });
});

const port = Number(process.env.PORT) || 4000;
app.listen(port, () => {
  console.log(`chaos-injector prêt sur le port ${port}`);
});
