# TUTORIAL — Level 2 : Métriques Prometheus & alerting

> **Objectif** : exposer des métriques **RED** (Rate, Errors, Duration) depuis api et worker, ajouter des métriques de saturation (pool Postgres, queue Redis), construire un dashboard Grafana, et écrire vos **premières règles d'alerte** routées vers un récepteur local.
>
> Rappelez-vous votre chronologie du Level 0 : aujourd'hui, le même incident doit se voir sur un graphe en moins d'une minute.
>
> **Monitoring applicatif, pas infrastructure.** cAdvisor et node-exporter (CPU, RAM de la machine) sont scrapés mais ce TP ne les interroge jamais. Ce qui compte ici, c'est ce que **l'application** sait d'elle-même : ses requêtes (RED), ses dépendances (saturation) et surtout **ses commandes** (métriques métier, étape 4b).

> **Édition 3 h** : `metrics.js`, les gauges du pool DB / de la queue (`db.js`, `backlog.js`), les métriques métier à déclarer et le dashboard Grafana sont **déjà fournis** (étapes 1, 2, 6 et la partie gauges de l'étape 4 : à lire, pas à refaire). Vous codez les étapes **3, 4 (worker `/metrics` + `job_duration_seconds`), 4b, 5 et 7** — voir `docs/TP_3H.md`.

## Ce qui existe déjà (infra, à ne pas réinventer)

- `docker-compose.l2.yml` ajoute **Prometheus** (:9090), **cAdvisor** (métriques conteneurs, :8081), **node-exporter** (métriques VM, :9100), **Alertmanager** (:9093) et un **webhook-receiver** local (:5001) qui fait office de PagerDuty de poche.
- `prometheus/prometheus.yml` scrape déjà cadvisor et node-exporter ; les jobs `api`/`worker` sont **commentés** — c'est à vous de les activer.
- Le dossier `prometheus/rules/` est monté dans Prometheus et **vide** : vos fichiers de règles y seront chargés automatiquement.
- Des marqueurs `// TODO(student, L2)` indiquent les points d'instrumentation.

```bash
make up-l2
```

UI : Prometheus http://localhost:9090 — Grafana http://localhost:3002 — webhook http://localhost:5001/alerts

---

## Étape 1 — Installer prom-client

**Pourquoi** : Prometheus fonctionne en **pull** : il interroge (`scrape`) un endpoint `/metrics` que VOS services exposent. Le format est du texte simple (`nom{label} valeur`), mais une bibliothèque gère pour vous les types (counter, gauge, histogram) et le registre.

1. `prom-client` est déjà dans `app/package.json` (comme pour pino, le but du TP est l'instrumentation, pas npm). Reconstruisez : `docker compose build api worker`.
2. Rappel **RED** (services requêtés) : *Rate* (req/s), *Errors* (taux d'échec), *Duration* (latence). Rappel **USE** (ressources) : *Utilization*, *Saturation*, *Errors*. Nos cibles :
   - RED : api et worker (requêtes HTTP, jobs) ;
   - USE : pool de connexions Postgres, profondeur de la queue Redis.

## Étape 2 — Créer `app/shared/metrics.js`

**Pourquoi** : un registre unique partagé par tout le process. Chaque service expose le SIEN (api et worker sont des process distincts — ne partagez pas un registre global entre eux, chacun sert son propre `/metrics`).

Contrat attendu :

```js
const { register, httpRequestsTotal, httpRequestDuration, dbPoolActive, dbPoolIdle, dbPoolWaiting, redisQueueDepth } = require('../shared/metrics');
```

Noms de métriques **imposés** (ils servent aux dashboards du cours et au script de validation) :

| Métrique | Type | Labels |
|---|---|---|
| `http_requests_total` | Counter | `service`, `route`, `method`, `status` |
| `http_request_duration_seconds` | Histogram | `service`, `route` |
| `job_duration_seconds` | Histogram | `service` |
| `db_pool_active` / `db_pool_idle` / `db_pool_waiting` | Gauge | — |
| `redis_queue_depth` | Gauge | `service` |
| `orders_total` | Counter | `service`, `status` (`created` \| `completed` \| `failed`) |
| `order_processing_seconds` | Histogram | `service` (buckets jusqu'à 60 s, dont `10`) |
| `orders_in_flight` | Gauge | — |
| `orders_oldest_pending_seconds` | Gauge | — |

Le label `service` doit valoir `process.env.SERVICE_NAME`. Ajoutez aussi les métriques process par défaut (`collectDefaultMetrics`) : mémoire, GC, event loop — utiles pour l'analyse USE.

<details>
<summary>Indice (types de métriques)</summary>

Un **Counter** ne fait qu'augmenter (cumul) — on calcule les taux avec `rate()` côté PromQL. Un **Gauge** monte et descend (niveau courant). Un **Histogram** échantillonne des observations dans des buckets — c'est lui qui permet les p95/p99 via `histogram_quantile()`. Pourquoi pas une moyenne ? Parce que p99 et moyenne racontent des histoires différentes (revoir le cours).
</details>

## Étape 3 — Instrumenter l'api (middleware RED)

**Pourquoi** : une seule mesure bien placée donne Rate + Errors + Duration à la fois. Et *bien placée* compte : placez-la **en tête de pile**, avant tous les autres middlewares, pour mesurer la latence telle que le client la subit (délais des middlewares en amont inclus).

1. Dans `app/api/server.js` (marqueur `TODO(student, L2)`), ajoutez un middleware qui démarre un chronomètre, puis mesure **à l'émission de la réponse** (`res.on('finish', ...)`).
2. Incrémentez le counter et observez l'histogramme à chaque requête.
3. Ajoutez un endpoint `GET /metrics` qui renvoie `register.metrics()` (Content-Type : `register.contentType`).

⚠️ **Cardinalité** : le label `route` doit être le **pattern** de route (`/orders/:id`), jamais l'URL brute (`/orders/123`) — sinon chaque commande crée une nouvelle série temporelle et Prometheus explose. Comment obtenir le pattern ? Le middleware Express remplit `req.route.path` après le matching — c'est pour ça qu'on mesure dans le callback `finish` (exécuté en fin de requête), pas dans un middleware tardif.

<details>
<summary>Indice</summary>

`res.on('finish', ...)` se déclenche quand la réponse part : c'est là que vous connaissez le status code, la durée, et `req.route?.path ?? 'unmatched'`. Chronométrez avec `process.hrtime.bigint()` ou `Date.now()` au début du middleware.
</details>

### Checkpoint

```bash
curl -s http://localhost:3001/metrics | grep -E 'http_requests_total|http_request_duration_seconds_bucket' | head -5
curl -s -X POST http://localhost:3001/orders -H 'Content-Type: application/json' -d '{"item":"sonde","amount":1}' > /dev/null
curl -s http://localhost:3001/metrics | grep 'http_requests_total.*status="202"'
```

Attendu : une ligne `http_requests_total{...route="/orders"...status="202"} 1`.

## Étape 4 — Worker : /metrics + saturation

1. Le worker n'a pas de serveur HTTP : créez-en un minuscule (module `http` natif, port **3002**) qui sert `/metrics`.
2. Mesurez la durée de traitement de chaque job (`job_duration_seconds`).
3. Dans `app/shared/db.js`, mettez à jour les gauges du pool (`db_pool_active/idle/waiting`) — un `setInterval` de 1-2 s suffit (`.unref()` pour ne pas bloquer l'arrêt).
4. Dans `app/shared/queue.js`, exposez la profondeur de la queue (`redis_queue_depth`, via `LLEN`).

### Checkpoint

```bash
# le worker n'est pas publié sur l'hôte : on l'interroge depuis le conteneur Prometheus
docker compose exec prometheus wget -qO- http://worker:3002/metrics | grep redis_queue_depth
```

## Étape 4b — Métriques métier : que devient une commande ?

**Pourquoi** : les métriques HTTP disent que l'api **répond**. Elles ne disent pas que la commande a été **traitée**. Une api peut renvoyer 202 en 20 ms pendant que le worker perd la moitié des jobs : HTTP vert, CPU vert, queue vide... et des clients qui n'ont jamais leur commande. Seule une métrique **métier** le voit.

1. **api** (`POST /orders`) : juste après l'`INSERT`, incrémentez `orders_total{status="created"}` — la commande existe, quoi qu'il arrive ensuite.
2. **worker** : à la fin d'un traitement réussi, incrémentez `orders_total{status="completed"}` et observez `order_processing_seconds` = délai **création → completed** (utilisez `created_at` en base : `UPDATE ... RETURNING EXTRACT(EPOCH FROM (now() - created_at))`). Dans le `catch`, incrémentez `orders_total{status="failed"}`.
3. **worker**, toutes les 2 s : lisez en base le nombre de commandes `pending`/`processing` des 10 dernières minutes (`orders_in_flight`) et l'âge de la plus ancienne (`orders_oldest_pending_seconds`, 0 s s'il n'y en a pas).

> `orders_in_flight` et `orders_oldest_pending_seconds` sont des **gauges lues en base** : elles reflètent l'état réel des commandes, pas ce que le worker croit avoir fait. C'est ce qui permettra de détecter un job perdu.

### Checkpoint

```bash
curl -s -X POST http://localhost:3001/orders -H 'Content-Type: application/json' -d '{"item":"sonde","amount":1}' > /dev/null
sleep 3
docker compose exec prometheus wget -qO- http://worker:3002/metrics | grep -E 'orders_total|order_processing_seconds_count|orders_in_flight'
```

Attendu : `orders_total{status="completed"}` ≥ 1 côté worker (et `created` côté api), `order_processing_seconds_count` ≥ 1.

## Étape 5 — Brancher Prometheus

1. Dans `prometheus/prometheus.yml`, **décommentez** les jobs `api` et `worker`.
2. `docker compose restart prometheus` puis ouvrez http://localhost:9090/targets : `prometheus`, `api` et `worker` doivent être **UP** (en mode light, `cadvisor` et `node-exporter` sont DOWN : normal, ce TP ne les utilise pas).
3. Dans l'onglet Graph de Prometheus, testez :
   ```
   rate(http_requests_total[1m])
   histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket[5m])) by (le))
   ```

## Étape 6 — Dashboard Grafana (à construire, pas à décorer)

Grafana a la datasource Prometheus provisionnée, mais **aucun dashboard** : c'est l'exercice. Créez un dashboard "Orders — vue service" avec :

1. **Request rate** : `sum(rate(http_requests_total[1m])) by (service)`
2. **Error rate %** : `100 * sum(rate(http_requests_total{status=~"5.."}[1m])) by (service) / sum(rate(http_requests_total[1m])) by (service)`
3. **Latence p50/p95/p99** : `histogram_quantile(0.X, sum(rate(http_request_duration_seconds_bucket[5m])) by (le, service))`
4. **Saturation pool DB** : `db_pool_active` / `db_pool_waiting`
5. **Queue depth** : `redis_queue_depth`
6. **Commandes** (métier) : créées / terminées / échouées par seconde (`sum(rate(orders_total{status="created"}[1m]))`...)
7. **p95 création → terminée** : `histogram_quantile(0.95, sum(rate(order_processing_seconds_bucket[5m])) by (le))`
8. **Commandes en attente** : `max(orders_in_flight)` et **âge de la plus ancienne** : `max(orders_oldest_pending_seconds)`

Principes (vus en cours) : un titre qui pose une **question**, des unités affichées, des seuils visuels sur les panels d'erreur — un dashboard décoratif empile des graphes, un dashboard utile répond à "est-ce que ça va ?" en 3 secondes.

**Livrable** : exportez le dashboard en JSON dans `grafana/dashboards/` (Dashboards → votre dashboard → Share → Export → Save to file) : il sera provisionné automatiquement au redémarrage de Grafana.

## Étape 7 — Deux alertes utiles (pas bruyantes)

**Pourquoi alerter sur des symptômes** (ce que l'utilisateur subit) plutôt que sur des causes (CPU d'une machine) : un pic CPU sans impact utilisateur n'est pas une pagerie ; 20 % de 500 en est une.

Créez `prometheus/rules/alerts.yml` avec **deux règles**, routées automatiquement vers le webhook local (Alertmanager est déjà configuré pour ça) :

1. `ErrorRateTooHigh` : taux d'erreurs 5xx > 5 % sur 5 minutes.
2. `P99LatencyTooHigh` : p99 > 500 ms sur 5 minutes.

Utilisez `for: 30s` pour éviter les alertes sur micro-pics (et regardez ce que ça change pendant les salves du scénario).

<details>
<summary>Indice (structure d'une règle)</summary>

```yaml
groups:
  - name: orders
    rules:
      - alert: MonAlerte
        expr: <expression PromQL>
        for: 30s
        labels: { severity: warning }
        annotations:
          summary: "..."
```
Le calcul d'un taux d'erreur = erreurs / total. Attention à la division par zéro quand aucun trafic : `or vector(0)` ou une garde `> 0` sur le dénominateur.
</details>

### Checkpoint

```bash
curl -s http://localhost:9090/api/v1/rules | jq -r '.data.groups[].rules[].name'
curl -s http://localhost:5001/alerts | jq '.count'
```

## Étape 8 — L'incident, avec des yeux

Lancez la panne vous-même :

```bash
bash scripts/incident.sh l2          # en parallèle : bash scripts/traffic.sh 2
```

Générez du trafic (UI ou boucle curl du Level 0). Dans l'ordre :

1. Quelle alerte part en premier, et après combien de temps ? (`/api/v1/alerts`, puis le webhook : les deux alertes ?)
2. Sur le dashboard, quel panel décroche : rate, errors, latence, saturation ?
3. **Time box 5 min** : identifiez le service en cause et proposez une hypothèse de cause. Notez ce qui manque encore pour trancher (spoiler : le niveau 3).

## Étape 9 — Validation

```bash
./levels/level-2-metrics/validate.sh
```

Le script interroge l'API Prometheus (targets, métriques, règles) et le webhook — jamais votre code.

## Livrable

- `app/shared/metrics.js` + les sites instrumentés.
- `prometheus/rules/alerts.yml`.
- Le JSON du dashboard exporté dans `grafana/dashboards/` (avec les panneaux **métier**).
- Vos métriques métier (étape 4b).
- Réponses écrites de l'étape 8 (3 questions) + votre chronologie Level 0 mise à jour : « avec les dashboards, l'incident se voit en X secondes, mais la cause reste incertaine parce que… ».

---

<details>
<summary>Bloqué ? Référence</summary>

Une référence complète existe (api et worker instrumentés, `prometheus.yml`, `alerts.yml`). C'est le **plan B** : `bash scripts/apply-solutions.sh 2` (confirmation demandée, usage tracé dans `.solutions-used.log`, vos fichiers sont sauvegardés). Un niveau rattrapé perd ses points de code ; essayez d'abord les indices.
</details>
