'use strict';

// Récepteur d'alertes local : remplace Slack/PagerDuty pour le TP.
// Alertmanager y pousse ses notifications (POST /alerts), consultables via GET /alerts.
const express = require('express');

const app = express();
app.use(express.json({ limit: '1mb' }));

const received = [];

app.post('/alerts', (req, res) => {
  const at = new Date().toISOString();
  const payload = Array.isArray(req.body) ? req.body : [req.body];
  for (const alert of payload) {
    received.push({ at, alert });
    const name = alert && alert.labels ? alert.labels.alertname : 'inconnue';
    const status = alert && alert.status ? alert.status : '?';
    console.log(`[${at}] alerte "${name}" (${status})`);
  }
  res.json({ ok: true, count: received.length });
});

app.get('/alerts', (req, res) => {
  res.json({ count: received.length, alerts: received.slice(-50) });
});

app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'webhook-receiver' });
});

const port = Number(process.env.PORT) || 5001;
app.listen(port, () => {
  console.log(`webhook-receiver prêt sur le port ${port}`);
});
