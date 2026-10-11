# Niveau 5 — Auto-remédiation : quand la plateforme se répare seule

> **Prérequis** : niveaux 1 et 2 appliqués (le contrôleur lit vos métriques et
> vos logs JSON). Le niveau 3 (tracing) n'est pas requis pour ce TP mais la
> stack complète l'utilise.
>
> **Durée** : ~2 h. **Fichiers** : `automation-controller/rules.js` et
> `app/shared/db.js`.

Jusqu'ici vous avez **observé** (logs, métriques, traces) puis **alerté**
(SLO). Reste le chaînon final : quand l'alerte se déclenche à 3 h du matin,
qui agit ? Un humain ? Ou la plateforme elle-même ? Ce niveau construit un
**contrôleur d'auto-remédiation** et discute ses limites.

## Le contrôleur, en 3 verbes

Le service `automation-controller` (port 5002, **déjà fourni**, monté avec le
socket Docker et branché sur Prometheus) tourne en boucle :

1. **OBSERVER** — toutes les 5 s, il collecte l'état du monde : liste des
   conteneurs (via le socket Docker), métriques (API Prometheus), faults actifs.
2. **DÉCIDER** — il appelle `evaluateRules(state)` dans `rules.js`. **C'est
   votre fichier.** Vous recevez l'état, vous retournez des actions.
3. **AGIR** — il exécute : `start`/`restart` (conteneur), `scale` (cloner des
   réplicas worker), `page` (escalade humaine via webhook-receiver). Chaque
   action est loggée en JSON et visible sur `GET /actions` : **une action
   automatisée sans piste d'audit est une bombe à retardement**.

Un cooldown de 30 s par type d'action est appliqué par l'infra (rate limiting
anti-tempête : un contrôleur qui redémarre en boucle un conteneur qui crashe
en boucle est pire que pas de contrôleur).

```bash
docker compose -f docker-compose.yml -f docker-compose.l1.yml -f docker-compose.l2.yml -f docker-compose.l5.yml up -d --build
docker compose logs -f automation-controller   # boucle OBSERVER en continu
curl -s localhost:5002/containers | jq         # ce que le contrôleur voit
curl -s localhost:5002/actions | jq            # piste d'audit (vide pour l'instant)
curl -s -X POST localhost:5002/evaluate | jq   # force un cycle de décision
```

## Étape 1 — Règle 1 : api crashée → restart, crash-loop → page

**Pourquoi** : un conteneur qui meurt est le cas le plus simple à automatiser.
Le piège est le **crash-loop** : si le crash se répète, redémarrer en boucle ne
sert à rien — il faut escalader.

Dans `automation-controller/rules.js` :
- si le conteneur du service `api` n'est pas `running` → action
  `{ type: 'start', service: 'api' }` ;
- s'il y a déjà eu un start/restart sur l'api il y a moins de
  `state.config.CRASH_ESCALATION_MS` → action `{ type: 'page', message: ... }`
  en plus (le webhook-receiver reçoit une alerte « AutomationEscalation »).

<details>
<summary>Indice : lire state</summary>

```js
const api = state.containers.find((c) => c.service === 'api');
const crashedRecently = state.recentActions.some(
  (a) => ['start', 'restart'].includes(a.action.type)
     && a.action.service === 'api'
     && Date.now() - new Date(a.at).getTime() < state.config.CRASH_ESCALATION_MS
);
```
</details>

Testez : `curl -X POST localhost:4000/chaos/kill -H 'Content-Type: application/json' -d '{"target":"api"}'`
puis regardez `/actions` — le contrôleur doit démarrer l'api en ~10 s. Tuez-le
encore une fois : cette fois une `page` doit apparaître.

## Étape 2 — Règle 2 : queue Redis saturée → scale workers

**Pourquoi** : les commandes s'accumulent plus vite que le worker ne les
traite. Remédiation : augmenter le nombre de consommateurs.

Dans `rules.js` : interrogez Prometheus (`state.prom`) — la métrique
`redis_queue_depth` vient de votre niveau 2 — et si `avg_over_time(redis_queue_depth[30s])`
dépasse `QUEUE_DEPTH_THRESHOLD` alors qu'il y a moins de `WORKER_REPLICAS`
workers actifs, retournez `{ type: 'scale', service: 'worker', replicas: WORKER_REPLICAS }`.

⚠️ **Pourquoi `avg_over_time` et pas la valeur instantanée** : réagir à un pic
d'un instant, c'est scaler pour rien. Le seuil doit être **soutenu**.

⚠️ Le `scale` fonctionne par **clonage Docker** : le contrôleur inspecte le
worker principal et crée des réplicas identiques (`worker-scale-N`, même image,
env, cmd, réseau). Comparez avec `docker compose up -d --scale worker=3` :
même effet, mais sans dépendre des fichiers compose — et sans le risque de
recréer les services avec une config partielle.

Testez la règle : sans fault, le worker absorbe ~30 commandes/s et la queue ne
sature jamais — comme en production, la saturation vient d'une dépendance
ralentie. Injectez d'abord une latence SQL, puis générez la salve :

```bash
curl -X POST localhost:4000/chaos/dep-slow -H 'Content-Type: application/json' -d '{"dependency":"postgres","ms":400}'
for i in $(seq 1 60); do curl -s -o /dev/null -X POST localhost:3001/orders -H 'Content-Type: application/json' -d '{"item":"flood","amount":1}' & done
curl -X POST localhost:4000/chaos/reset   # après avoir observé le scale
```

Regardez `/actions` + `docker compose ps` : les réplicas `worker-scale-*`
doivent apparaître et drainer la queue à trois.

## Étape 3a — Règle 3 : commandes bloquées (un signal applicatif)

Les règles 1 et 2 réagissent à l'**infrastructure** (conteneur arrêté, queue qui grossit). La règle 3 réagit à ce que **l'application** sait de ses commandes.

Panne simulée : le worker **acquitte les jobs sans les traiter**. Les conteneurs sont `running`, le CPU est normal, HTTP renvoie 202, la queue est **vide** : aucune métrique d'infrastructure n'alerte. Seul `orders_oldest_pending_seconds` (L2, étape 4b) grimpe.

Dans `rules.js`, paginez un humain quand :

- la plus ancienne commande non terminée attend depuis plus de `ORDERS_STUCK_SECONDS`, **de façon soutenue** (`max(min_over_time(orders_oldest_pending_seconds[30s]))`) ;
- **ET** la queue est vide (`avg_over_time(redis_queue_depth[30s])` ≤ `QUEUE_IDLE_DEPTH`) : sinon c'est de la lenteur, pas de la perte, et `scale` est la bonne réponse (règle 2) ;
- sans repaginer si une page « commandes bloquées » existe déjà dans `state.recentActions` (`ORDERS_PAGE_DEDUP_MS`).

Pourquoi `page` et pas `restart` ? Redémarrer le worker ne récupère pas les commandes déjà perdues ; seule une personne peut décider de les rejouer. **Une bonne automatisation sait quand rendre la main.**

## Étape 3 — Règle 4 : circuit breaker (dans l'application, pas dans le contrôleur)

**Pourquoi** : quand Postgres sature, l'api met les requêtes SQL en file et
tout explose (vous l'avez vu au niveau 0 et 4). La bonne remédiation est **dans
l'application** : un **circuit breaker** refuse les nouvelles requêtes SQL en
fail-fast tant que le pool sature, au lieu de les empiler.

Dans `app/shared/db.js` (fourni sous forme de démo, voir plus bas) : si `pool.waitingCount >= 5`, ouvrez
le circuit ~10 s — `query()` throw une erreur claire (`code: 'ECIRCUITBREAKER'`)
pendant l'ouverture, puis retente (semi-ouvert). L'utilisateur reçoit un 500
immédiat au lieu d'attendre 30 s ; la charge redescend.

C'est un point d'architecture important : **une partie de l'auto-remédiation
vive dans l'application** (circuit breakers, backoff, timeouts), le contrôleur
ne gère que ce qui est hors de son périmètre (processus, réplicas, escalade).
La règle 4 ne se programme donc **pas** dans `rules.js`.

Le code du circuit breaker n'est pas fourni dans `db.js`. Pour le voir fonctionner : `make demo-circuit-breaker` (copie *uniquement* le `db.js` de référence, sans toucher à vos règles), `make up-l5`, puis `bash scripts/incident.sh l5-pool`
et observez `db_pool_waiting` + les 500 immédiats pendant l'ouverture.

## Étape 4 — Les actions elles-mêmes sont observables

Chaque remédiation est un log JSON (`service="automation-controller"`) →
retrouvez-les dans Grafana/Explore (Loki) :

```logql
{service="automation-controller"} | json | line_format "{{.action.type}} {{.action.service}} {{.result.ok}}"
```

Et `GET /actions` est la piste d'audit à présenter en soutenance. **Discipline
SRE** : toute action automatisée doit être (1) loggée, (2) réversible ou
bornée, (3) notifiable.

## Étape 5 — Discussion : le socket Docker, un rooted-on-host en échange

Le contrôleur a le socket Docker monté : techniquement il peut tout faire sur
l'hôte (c'est root). C'est **explicitement** un compromis :

| Option | Avantage | Risque |
|---|---|---|
| socket Docker (ce TP) | simple, pédagogique | root sur l'hôte |
| socket proxy filtré (ex. tecnativa/docker-socket-proxy) | Whitelist d'API | config à maintenir |
| agent par nœud + API métier | périmètre minimal | plus d'infra |
| Kubernetes operators (à l'échelle) | RBAC, reconciliation | tout un écosystème |

Question de séance : votre contrôleur redémarre l'api automatiquement. Quel
incident **ne faut-il pas** auto-remédier ? (indice : et si le crash est causé
par une migration SQL fautive ? redémarrer n'aide pas et masque le signal.)

## Étape 6 — Capstone : scenario non annoncé

Lancez `bash scripts/incident.sh surprise` : une panne tirée au hasard (crash-loop, saturation de pool ou perte
silencieuse de jobs) se déclenchera d'ici 1 à 3 minutes, sans nom ni indice. Pendant ce temps, générez du trafic
(`bash scripts/traffic.sh 2`) et travaillez comme en production. Quand c'est terminé : `bash scripts/incident.sh reveal`.
Pas de notice, pas de filtre.

Score d'équipe :
1. **% auto-remédié** : proportion d'incidents résolus sans intervention humaine (visible via `/actions` + état des conteneurs).
2. **Time-to-remediate** : délai entre le début de l'incident et le retour au vert (métriques L2 + `at` de `/actions`).
3. **Postmortem** (24 h) : un incident réel avec le template du niveau 4 — le contrôleur et ses logs sont vos sources.

## Validation

```bash
bash levels/level-5-automation/validate.sh
```

Vérifie : contrôleur up, règle 1 (kill api → start dans les 45 s), escalade
(2e kill → page), règle 2 (salve → scale à 3 workers dans les 90 s), règle 3 (jobs perdus → page « commandes bloquées » dans les 150 s), piste
d'audit `/actions` non vide. Le circuit breaker est vérifié par revue de code
(étape 3).
