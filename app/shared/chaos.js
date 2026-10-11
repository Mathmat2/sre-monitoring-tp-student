'use strict';

const Redis = require('ioredis');

const CONFIG_KEY = 'chaos:config';
const MAX_CPU_BURN_MS = 60000;
const MAX_MEM_RETAINED_MB = 512;

let retainedMemory = [];
let chaosRedis = null;

function getRedisClient() {
  if (!chaosRedis) {
    chaosRedis = new Redis(process.env.REDIS_URL || 'redis://redis:6379');
    chaosRedis.on('error', () => {});
  }
  return chaosRedis;
}

async function getChaosConfig() {
  try {
    const client = getRedisClient();
    const raw = await client.get(CONFIG_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (err) {
    return {};
  }
}

function matchesTarget(entry) {
  if (!entry) return false;
  const target = entry.target || 'api';
  return target === 'all' || target === process.env.SERVICE_NAME;
}

function busyLoop(seconds) {
  const cappedMs = Math.min(Number(seconds || 0) * 1000, MAX_CPU_BURN_MS);
  const end = Date.now() + cappedMs;
  while (Date.now() < end) {
    for (let i = 0; i < 1000; i++) {}
  }
}

function allocMemory(rateMb) {
  const totalMb = retainedMemory.reduce((sum, buf) => sum + buf.length / (1024 * 1024), 0);
  if (totalMb >= MAX_MEM_RETAINED_MB) return;
  retainedMemory.push(Buffer.alloc(Number(rateMb || 1) * 1024 * 1024, 1));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Applique cpu-burn et mem-leak immédiatement, retourne {delayMs, shouldError}
// pour la latence et le taux d'erreur. Appelé par le middleware HTTP (api)
// et avant chaque job (worker).
async function applyFaults() {
  const cfg = await getChaosConfig();
  if (cfg.cpuBurn && matchesTarget(cfg.cpuBurn)) {
    busyLoop(cfg.cpuBurn.seconds);
  }
  if (cfg.memLeak && matchesTarget(cfg.memLeak)) {
    allocMemory(cfg.memLeak.rateMb);
  }
  const result = { delayMs: 0, shouldError: false, shouldDrop: false };
  if (cfg.latency && matchesTarget(cfg.latency)) {
    result.delayMs =
      Math.max(0, Number(cfg.latency.ms) || 0) +
      Math.floor(Math.random() * (Number(cfg.latency.jitter) || 0));
  }
  if (cfg.errorRate && matchesTarget(cfg.errorRate)) {
    result.shouldError = Math.random() < Number(cfg.errorRate.rate || 0);
  }
  // Perte silencieuse : le worker acquitte le job sans le traiter (la commande
  // reste « pending »). Ni HTTP, ni CPU, ni la queue ne le montrent.
  if (cfg.jobDrop && matchesTarget(cfg.jobDrop)) {
    result.shouldDrop = Math.random() < Number(cfg.jobDrop.rate || 0);
  }
  return result;
}

// Délai artificiel injecté sur les appels à une dépendance (redis | postgres).
async function applyDepSlow(redis, dependency) {
  const cfg = await getChaosConfig();
  const slow = cfg && cfg.depSlow && cfg.depSlow[dependency];
  if (slow && Number(slow.ms) > 0) {
    await sleep(slow.ms);
  }
}

module.exports = { CONFIG_KEY, getChaosConfig, applyFaults, applyDepSlow, busyLoop, allocMemory, sleep };
