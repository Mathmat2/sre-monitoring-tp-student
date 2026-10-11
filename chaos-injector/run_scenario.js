'use strict';

// Lecteur de scénarios : joue une liste ordonnée d'étapes {action, params, at_seconds}
// en appelant l'API HTTP du chaos-injector.
//   node run_scenario.js scenarios/l2-latency-spike.yaml
//   CHAOS_URL=http://localhost:4000 node run_scenario.js ...

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const http = require('http');

const CHAOS_URL = process.env.CHAOS_URL || 'http://localhost:4000';

const ACTIONS = {
  latency: '/chaos/latency',
  'error-rate': '/chaos/error-rate',
  'cpu-burn': '/chaos/cpu-burn',
  'mem-leak': '/chaos/mem-leak',
  'dep-slow': '/chaos/dep-slow',
  'job-drop': '/chaos/job-drop',
  'db-pool-exhaust': '/chaos/db-pool-exhaust',
  kill: '/chaos/kill',
  reset: '/chaos/reset',
};

function callInjector(action, params) {
  const endpoint = ACTIONS[action];
  if (!endpoint) {
    throw new Error(`action inconnue: "${action}" (valides: ${Object.keys(ACTIONS).join(', ')})`);
  }
  const body = JSON.stringify(params || {});
  return new Promise((resolve, reject) => {
    const req = http.request(
      `${CHAOS_URL}${endpoint}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          if (res.statusCode >= 400) {
            reject(new Error(`${action} -> HTTP ${res.statusCode}: ${data}`));
          } else {
            resolve(JSON.parse(data || '{}'));
          }
        });
      }
    );
    req.on('error', reject);
    req.end(body);
  });
}

async function main() {
  const scenarioPath = process.argv[2];
  if (!scenarioPath) {
    console.error('usage: node run_scenario.js <scenarios/xxx.yaml>');
    process.exit(1);
  }
  const scenario = yaml.load(fs.readFileSync(scenarioPath, 'utf8'));
  const steps = (scenario.steps || []).slice().sort((a, b) => (a.at_seconds || 0) - (b.at_seconds || 0));
  console.log(`scénario "${scenario.name || path.basename(scenarioPath)}" — ${steps.length} étape(s)`);

  const timers = steps.map((step) => {
    const at = (step.at_seconds || 0) * 1000;
    return setTimeout(async () => {
      try {
        await callInjector(step.action, step.params);
        console.log(`[${new Date().toISOString()}] +${step.at_seconds || 0}s → ${step.action} ${JSON.stringify(step.params || {})}`);
      } catch (err) {
        console.error(`[${new Date().toISOString()}] échec étape ${step.action}: ${err.message}`);
      }
    }, at);
  });

  const maxAt = steps.reduce((max, s) => Math.max(max, s.at_seconds || 0), 0);
  setTimeout(() => {
    console.log('scénario terminé (tous les timers programmés sont écoulés)');
    process.exit(0);
  }, maxAt * 1000 + 2000);
}

main().catch((err) => {
  console.error(`erreur: ${err.message}`);
  process.exit(1);
});
