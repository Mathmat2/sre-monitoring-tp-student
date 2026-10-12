# Édition 3 h — TP Monitoring & SRE (version autonome)

Une séance de 3 h, **sans intervenant** : vous lancez les pannes, vous vérifiez votre travail, vous gérez votre temps.
Le TP porte sur le **monitoring applicatif** : ce qui est mesuré, ce sont les requêtes, les dépendances et surtout les
**commandes**, pas la machine. Arc complet (aveugle → logs → métriques → traces → SLO → auto-remédiation), mais vous ne
**codez** que trois morceaux : l'instrumentation RED et les alertes (L2), une alerte burn-rate (L4) et la règle de
redémarrage (L5). Le reste est fourni et exploré.

## Avant la séance (≈ 20 min, réseau requis)

```bash
make check
make prefetch
```

L'arbre livré est déjà au bon état : L1 appliqué (logs JSON), L2 avec `metrics.js`, les gauges DB/queue,
`backlog.js` (qui alimente aussi `redis_queue_depth`) et le dashboard fournis, L5 avec les règles 2 et 3 pré-écrites. `docker-compose.light.yml` retire cAdvisor
et node-exporter (laptops) : leurs targets seront DOWN dans Prometheus, c'est normal.

## Déroulé conseillé

Lisez la section du niveau dans `docs/NOTIONS.md` (5-8 min) avant chaque bloc de code.

| Durée | Bloc | Mode | Commandes |
|---|---|---|---|
| 0:00–0:10 | Lire `README.md` et la section « Socle » de `docs/NOTIONS.md` | Lecture | |
| 0:10–0:25 | **L0** : incident à l'aveugle (2 min 30 de panne) | Vécu | `make up-l0`, `make traffic`, `make incident-l0` (puis `reveal`) |
| 0:25–0:45 | **L1** : visite guidée des logs, Grafana :3002 | Sans code | `make up-l1`, `make incident-l1` |
| 0:45–1:30 | **L2** : métriques et alertes (≈ 40 min de code) | **Code** | `make up-l2`, `make incident-l2`, `make validate-l2` |
| 1:30–1:40 | Pause | | |
| 1:40–1:55 | **L3** : démo traces et propagation, Jaeger :16686 | Démo | `bash scripts/apply-solutions.sh 3`, `make up-l3`, `make incident-l3` |
| 1:55–2:27 | **L4** : SLI commandes + burn-rate (≈ 24 min de code) | **Code** | `make incident-l4`, `make validate-l4` |
| 2:27–2:57 | **L5** : règle 1 (15 min) + capstone (10 min) | **Code** + capstone | `make up-l5`, `make validate-l5`, `make surprise`, `make reveal` |
| 2:57–3:00 | Bilan, consigne du postmortem (à rendre sous 24 h, voir `RENDU.md`) | | |

### Hygiène entre deux niveaux (évite 90 % des « ça ne valide pas »)

- `bash scripts/incident.sh reset` avant de changer de niveau : une faute lancée au niveau précédent peut durer plusieurs minutes.
- `make stop-traffic` (ou Ctrl-C) avant un validateur : les validateurs injectent leurs propres fautes ; du trafic ambiant les rend plus lents à conclure.
- Les fenêtres 6 h / 3 j des SLO couvrent **toute la séance** : les fautes de L1-L3 y sont comptées, d'où des alertes « lentes » déjà actives en L4 (c'est normal ici).
- `validate-l5` abandonne lui-même les commandes restées `pending` et attend la fin de la déduplication de 5 min du contrôleur ; il laisse la base propre pour le capstone.

⚠️ **L3 écrase vos fichiers L2** : la référence L3 est cumulative (elle contient les métriques). Validez L2 *avant*.
`apply-solutions.sh` sauvegarde vos fichiers dans `.student-backup/` ; `make restore-l2` les récupère après la démo (à faire avant le rendu, voir `RENDU.md`).

## L2 — ce que vous codez (≈ 40 min)

Déjà fournis : `app/shared/metrics.js` (noms et labels imposés, **y compris les métriques métier**), les gauges du
pool DB et de la queue, `app/shared/backlog.js`, le dashboard Grafana (`grafana/dashboards/orders.json`). Lisez
`levels/level-2-metrics/TUTORIAL.md` pour le *pourquoi*, mais ne faites que :

1. **Étape 3** — middleware RED en tête de pile dans `app/api/server.js` + `GET /metrics`
   (attention à la cardinalité : `route` = pattern, pas URL brute).
2. **Étape 4** — `/metrics` du worker (port 3002) + `job_duration_seconds`.
   **Étape 4b** — métriques **métier** : `orders_total{status="created"}` dans l'api après l'`INSERT` ;
   `orders_total{status="completed"|"failed"}` et `order_processing_seconds` dans le worker ;
   appeler `startBacklogRefresh()` (fourni : gauges backlog **et** `redis_queue_depth`) au démarrage du worker.
3. **Étape 5** — décommenter les jobs `api` / `worker` dans `prometheus/prometheus.yml`, `docker compose restart prometheus`.
4. **Étape 7** — `prometheus/rules/alerts.yml` : `ErrorRateTooHigh`, `P99LatencyTooHigh`.
5. `bash scripts/traffic.sh 2` + `make incident-l2`, regardez dashboard + alertes, puis `make validate-l2`.

**Time box dur** : à 1:30, pas de panique — `bash scripts/apply-solutions.sh 2` et on continue (votre travail est sauvegardé).

## L4 — ce que vous codez (≈ 30 min)

Dans `prometheus/rules/slo.yml` (à créer ; voir `docs/MULTI_BURN_RATE_ALERTING.md`) :

1. Recording rules **métier** `sli_orders_ratio_5m` et `_1h` : commandes terminées en < 10 s
   (`order_processing_seconds_bucket{le="10"}`) ÷ commandes **créées** (`orders_total{status="created"}`),
   encadrées par `clamp_max(…, 1)`.
2. Alerte `SLOOrdersBurnFast` (burn > 14.4 sur 5 m **et** 1 h, `for: 2m`).
3. `bash scripts/traffic.sh 2` (≥ 10 min avant et pendant), puis `make incident-l4` : le worker perd des jobs en
   silence. Observez l'alerte partir, puis **comparez** avec le taux de succès HTTP
   (`sum(rate(http_requests_total{status!~"5.."}[5m])) / sum(rate(http_requests_total[5m]))`) : il reste à 1.
4. `make validate-l4`

Hors séance : SLI de disponibilité HTTP, SLI latence, alertes lentes, **postmortem** (`docs/POSTMORTEM_TEMPLATE.md`).

## L5 — ce que vous codez (≈ 30 min)

`make up-l5`. Dans `automation-controller/rules.js`, les règles 2 (scale) et 3 (**commandes bloquées**, signal
applicatif) sont déjà écrites : codez la **règle 1** (api crashée → `start`, crash-loop → `page`), puis relisez la
règle 3. Le circuit breaker se regarde via `make demo-circuit-breaker` (il copie seulement `app/shared/db.js` de référence).

Puis `make validate-l5` (≈ 4 min en mode 3 h), et le **capstone** : `make surprise`. Une panne tirée au hasard se
déclenche d'ici 1 à 3 minutes, sans nom. Une des trois est la **perte silencieuse de jobs** : conteneurs `running`, CPU
normal, HTTP 202, queue vide — l'infrastructure reste verte, seul le SLI commandes (`SLOOrdersBurnFast`) et la règle 3
du contrôleur (« commandes bloquées ») la voient. Diagnostiquez, *puis* `make reveal`.

## Plan B

| Retard | Action |
|---|---|
| L2 pas fini à 1:30 | `bash scripts/apply-solutions.sh 2` |
| L4 pas fini à 2:25 | `bash scripts/apply-solutions.sh 4`, lire la solution |
| L5 pas fini à 2:50 | `bash scripts/apply-solutions.sh 5` |

Un niveau « rattrapé » perd ses points de code ; l'usage est tracé dans `.solutions-used.log`.

## Entre deux exécutions du validateur

- Attendez ≥ **40 s** après un redémarrage de service (les requêtes ne retiennent que des séries fraîches).
- L5 : entre deux exécutions, `docker compose exec postgres psql -U app orders_db -c 'truncate orders'` ou attendez 10 min
  (la règle 3 ne repagine pas dans les 5 min qui suivent une page).
