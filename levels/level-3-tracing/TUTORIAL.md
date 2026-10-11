# TUTORIAL — Level 3 : Tracing distribué (OpenTelemetry + Jaeger)

> **Édition autonome** : le niveau 3 est une démonstration. Appliquez la référence avec `bash scripts/apply-solutions.sh 3` (après avoir validé L2 — la référence contient les métriques), lisez `app/api/tracing.js`, `app/worker/tracing.js` et les diffs dans `server.js` / `worker.js` / `queue.js`, puis faites les étapes de diagnostic (étape 6). Les étapes de codage 1 à 5 sont là si vous voulez les refaire par vous-même (hors séance).

> **Objectif** : instrumenter les trois services avec **OpenTelemetry**, propager le contexte de trace à travers la queue Redis, et utiliser la **waterfall Jaeger** pour localiser précisément où le temps part dans une chaîne d'appels.
>
> Le scénario final est un piège assumé : les dashboards du Level 2 pointent l'api, le tracing désigne la vraie coupable.

## Ce qui existe déjà (infra)

- `docker-compose.l3.yml` ajoute **Jaeger** (all-in-one, récepteur OTLP activé, UI sur http://localhost:16686) et **surcharge les commandes** de api/worker pour démarrer avec `--require ./…/tracing.js` : le SDK doit s'initialiser **avant** tout autre module, sinon l'auto-instrumentation rate des requêtes.
- Les wrappers `shared/db.js` et `shared/queue.js` créent déjà des spans `postgres.<op>` / `redis.<op>` englobant le délai injecté par le chaos — no-op tant que le SDK n'est pas bootstrappé.
- L'en-tête `TODO(student, L3)` marque les trois endroits à instrumenter.

```bash
docker compose -f docker-compose.yml -f docker-compose.l1.yml -f docker-compose.l2.yml -f docker-compose.l3.yml up -d --build
```

UI : Jaeger http://localhost:16686

---

## Étape 1 — Installer le SDK OpenTelemetry

**Pourquoi OpenTelemetry** : standard vendor-neutral d'instrumentation. Le même code exporte vers Jaeger, Tempo, Datadog… Les bibliothèques clientes (http, pg, ioredis) sont instrumentées **automatiquement** : chaque requête HTTP entrante, chaque requête SQL, chaque commande Redis devient un span, sans toucher au métier.

Les paquets sont déjà dans `app/package.json` (comme pino et prom-client). Reconstruisez :

```bash
docker compose build api worker
```

C'est long (~2-3 min) : `auto-instrumentations-node` tire tout l'écosystème d'instrumentations.

## Étape 2 — Bootstrapper le SDK (`tracing.js`)

**Pourquoi avant tout le reste** : l'auto-instrumentation doit wrapper les modules AVANT leur premier `require`. D'où le chargement via `node --require ./api/tracing.js` (la commande est déjà dans `docker-compose.l3.yml`).

1. Créez `app/api/tracing.js` et `app/worker/tracing.js` (presque identiques).
2. Le SDK a besoin de : un **exporter** (OTLP vers `process.env.OTEL_EXPORTER_OTLP_ENDPOINT`), un nom de service (`process.env.SERVICE_NAME`), et les auto-instrumentations.
3. Appelez `sdk.start()` — puis rien : le reste du code démarre normalement.

<details>
<summary>Indice (pièces à assembler)</summary>

Trois imports : `NodeSDK` (sdk-node), `getNodeAutoInstrumentations` (auto-instrumentations-node), `OTLPTraceExporter` (exporter-trace-otlp-http). L'exporter prend `url` = l'endpoint OTLP **HTTP** de Jaeger (le port 4318, chemin `/v1/traces`). Instanciez, passez `serviceName`, `traceExporter`, `instrumentations`, puis `start()`.
</details>

### Checkpoint

```bash
docker compose -f docker-compose.yml -f docker-compose.l1.yml -f docker-compose.l2.yml -f docker-compose.l3.yml up -d
curl -s -X POST http://localhost:3001/orders -H 'Content-Type: application/json' -d '{"item":"sonde trace","amount":1}'
```

Jaeger (http://localhost:16686) → Service: `api` → Find Traces : vous devez voir des traces `POST /orders` avec, à l'intérieur, des spans `postgres.insert` et `redis.lpush`. **Vérifiez aussi le service `worker`** : les traces `BRPOP` de 5 s y sont normales (le worker bloque sur la liste vide — bonne discussion : pourquoi ?).

⚠️ À ce stade, la trace du worker est **coupée** de celle de l'api : chaque service trace de son côté. C'est l'étape 4 qui les recoud.

## Étape 3 — Ce que l'auto-instrumentation couvre (et ne couvre pas)

Regardez une trace complète côté api : entrée HTTP, spans pg et redis en enfants. L'auto-instrumentation a capturé les **frontières techniques**. Ce qu'elle ne voit pas : vos **étapes métier** — et la frontière asynchrone de la queue.

## Étape 4 — Span métier manuel (worker)

Dans `app/worker/worker.js` (marqueur `TODO(student, L3)`), enveloppez `processOrder` dans un span nommé **`processOrder`** (nom imposé : il sert à la validation). En cas d'erreur : `span.recordException(err)` avant `span.end()`.

<details>
<summary>Indice</summary>

```js
const tracer = trace.getTracer('worker');
return tracer.startActiveSpan('processOrder', async (span) => {
  try { /* traitement */ } catch (err) { span.recordException(err); throw err; }
  finally { span.end(); }
});
```
Pourquoi un span manuel ici ? Parce que « le traitement d'une commande » est une notion MÉTIER : si demain le traitement fait 4 appels externes, le span les regroupera — exactement ce qu'un dashbaord ne peut pas montrer.
</details>

## Étape 5 — Propager le contexte à travers la queue (l'étape intéressante)

**Pourquoi** : la queue Redis est une frontière **asynchrone**. Un contexte de trace vit dans le process ; il ne traverse pas un `LPUSH` tout seul. Le mécanisme standard : **sérialiser** le contexte (format W3C `traceparent`) dans le payload du job, puis le **ré-extraire** côté worker.

1. Côté api (marqueur `TODO(student, L3)` dans `server.js`) : juste avant `pushJob`, injectez le contexte actif dans un objet vide (`propagation.inject(context.active(), carrier)`) et mettez ce carrier dans le payload (champ `traceCtx`).
2. Côté worker : au dépilement, extrayez (`propagation.extract(context.active(), job.traceCtx || {})`) et exécutez le traitement **dans** ce contexte (`context.with(parentContext, ...)`).
3. Le span `processOrder` (étape 4) doit être créé **dans** ce contexte — sinon il repart une nouvelle trace racine.

<details>
<summary>Indice (l'ordre des opérations)</summary>

```js
// api
const carrier = {};
propagation.inject(context.active(), carrier);
await pushJob({ orderId, requestId, traceCtx: carrier });

// worker
const parentContext = propagation.extract(context.active(), job.traceCtx || {});
await context.with(parentContext, async () => { /* span processOrder ici */ });
```
Le piège classique : créer le span `processOrder` HORS du `context.with` — le span existe mais sa trace ne rejoint jamais celle de l'api. Testez avant de passer à la suite.
</details>

### Checkpoint

Passez une commande, ouvrez Jaeger, cherchez la trace la plus récente du service `api` : elle doit contenir **api + worker + postgres + redis** dans le même arbre. Le span `processOrder` est un descendant du span `POST /orders`.

## Étape 6 — L'incident ambigu

```bash
bash scripts/incident.sh l3          # en parallèle : bash scripts/traffic.sh 2
```

Générez du trafic en continu. **D'abord sans le tracing** (rappelez-vous l'étape 8 du niveau 2) : que disent les dashboards ? p99 api en flèche, queue qui monte… Le CPU de l'api ? Regardez `process_cpu_usage` — normal. Le code ? Aucun déploiement récent. Impasse typique.

Puis avec le tracing :

1. Ouvrez Jaeger, trouvez une trace `POST /orders` récente, triez les spans par durée.
2. Quel span concentre le temps ? Son parent ? Que dit le span `redis.lpush` vs son enfant `LPUSH` ?
3. Formulez la cause racine en une phrase, avec la preuve tirée de la waterfall.
4. Comparez avec le diagnostic que les dashboards L2 permettaient seuls.

## Étape 7 — Le lien logs ↔ traces

Votre corrélation L1 repose sur `x-request-id`. OpenTelemetry propage aussi un **trace ID** standard. Piste (facultative, mais à discuter) : logger le trace ID courant dans chaque ligne de log (`trace.getActiveSpan()?.spanContext().traceId`) permet de naviguer d'une ligne de log à la trace complète dans Jaeger (champ de recherche « trace ID »). C'est le chaînon qui unifie les trois piliers.

## Étape 8 — Validation

```bash
./levels/level-3-tracing/validate.sh
```

## Livrable

- `tracing.js` (api + worker), span métier `processOrder`, propagation queue.
- Réponses écrites de l'étape 6 (diagnostic avant/après tracing, cause racine prouvée).

---

<details>
<summary>Bloqué ? Référence</summary>

La référence est appliquée par `bash scripts/apply-solutions.sh 3` : `tracing.js`, api et worker instrumentés avec propagation complète. Regardez surtout l'ordre `extract` → `context.with` → `startActiveSpan`.
</details>
