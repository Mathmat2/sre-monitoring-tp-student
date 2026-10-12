# TUTORIAL — Level 1 : Logs structurés & corrélation

> **Dans ce dépôt, le niveau 1 est déjà appliqué** (logger JSON, `x-request-id`, logs de l'api et du worker). Lisez ce tutoriel comme une visite guidée : les étapes 1 à 4 expliquent *pourquoi* le code fourni est fait ainsi — ne les refaites pas. Votre travail commence à l'étape 5 (retrouver une requête dans Loki) et à l'étape 6 (incident).

> **Objectif** : transformer les `console.log` textuels en logs **structurés (JSON)**, relier chaque requête utilisateur à travers les 3 services via un **ID de corrélation**, puis utiliser cette structure dans Loki/Grafana pour diagnostiquer un incident intermittent.
>
> À la fin, rejouez le scénario du Level 0 : ce qui prenait 20 minutes de fouille aveugle doit prendre 2 minutes de requête LogQL.

## Ce qui existe déjà (infra, à ne pas réinventer)

- `docker-compose.l1.yml` ajoute **Loki** (stockage), **Promtail** (collecte des logs Docker) et **Grafana** (UI) — déjà configurés : Promtail scrappe les logs de tous les conteneurs et Grafana a la datasource Loki provisionnée.
- `app/shared/logger.js` (pino, JSON, niveaux **textuels** `"level":"error"`) et la corrélation `x-request-id` sont déjà en place : les étapes 1 à 5 se lisent, ne les refaites pas.

```bash
make up-l1
```

Grafana : http://localhost:3002 (admin / sre-tp, ou anonymous). Explore → Loki.

---

## Étape 1 — Installer pino

**Pourquoi** : un log texte libre (`commande 12 créée (écran 27 pouces)`) est lisible par un humain mais inexploitable par une machine : pas de champ, pas de type, pas de requête possible. Un log JSON (une ligne = un objet) se filtre, s'agrège et se joint à d'autres sources.

1. Ajoutez `pino` aux dépendances de `app/package.json` .
2. Reconstruisez : `docker compose build api worker frontend`.
3. Lancez un test rapide en local si vous voulez sentir la différence : `node -e "const p=require('pino')(); p.info({a:1},'test')"`.

> **Note** : en production on garde du JSON brut (compact, parsable) ; la lisibilité humaine se règle dans l'outil d'agrégation, pas dans le log.

## Étape 2 — Implémenter `app/shared/logger.js`

**Pourquoi** : un module unique évite N implémentations divergentes et garantit que chaque ligne porte les mêmes champs de base.

Contrat attendu :

```js
const log = require('../shared/logger');        // logger par défaut
const child = log.child({ requestId: 'abc' });  // sous-logger avec contexte
log.info('msg');      // niveau info
log.error(err, 'msg'); // 1er argument peut être une Error
```

Chaque ligne doit contenir au minimum : `level`, `time` (timestamp), `service` (nom du service — indice : `process.env.SERVICE_NAME` est déjà défini dans les Dockerfiles), et le message.

<details>
<summary>Indice (cliquez seulement si bloqué)</summary>

`pino` accepte des champs de base à la création : `pino({ base: { service: ... } })`. La méthode `.child(obj)` renvoie un logger pré-rempli — c'est elle qui portera l'ID de corrélation.
</details>

## Étape 3 — L'ID de corrélation (middleware api)

**Pourquoi** : c'est le chaînon manquant. Une requête utilisateur traverse frontend → api → worker ; sans identifiant commun, ses logs sont trois îlots. L'en-tête HTTP standard est ici `x-request-id`.

1. Dans `app/api/server.js`, ajoutez un **middleware Express** qui :
   - lit `x-request-id` de la requête entrante (envoyé par le frontend) ;
   - le génère (`crypto.randomUUID()`) s'il est absent ;
   - le remet dans la réponse (`x-request-id`) pour le client ;
   - crée un logger enfant et le rend accessible (ex. `res.locals.log` ou via `req`).
2. Utilisez ce logger enfant dans les handlers au lieu du logger global.

<details>
<summary>Indice</summary>

L'ordre des middlewares compte : celui-ci doit être enregistré **avant** les routes. `crypto` est un module natif de Node.
</details>

## Étape 4 — Propager l'ID à travers la queue

**Pourquoi** : la queue Redis est une frontière asynchrone : rien ne propage le contexte HTTP automatiquement. C'est à vous de le sérialiser.

1. Dans `app/api/server.js`, ajoutez `requestId` au payload poussé dans la queue (`pushJob`).
2. Dans `app/worker/worker.js`, lisez-le au dépilement et loggez chaque étape du traitement avec l'ID.

**Point d'attention** (à discuter en séance) : si le job est retraité ou si plusieurs workers tournent, l'ID reste-il fiable ? Que manque-t-il pour en faire un vrai trace ID (niveau 3) ?

## Étape 5 — Remplacer tous les appels

Chaque appel de log (déjà converti dans l'arbre livré) utilise le logger structuré (avec ID de corrélation quand il y en a un). Le frontend enverra l'en-tête :

```js
headers: { 'Content-Type': 'application/json', 'x-request-id': crypto.randomUUID() }
```

*(Dans le navigateur : `crypto.randomUUID()` est disponible.)*

### Checkpoint

```bash
docker compose build api worker frontend && docker compose up -d
curl -si -X POST http://localhost:3001/orders -H 'Content-Type: application/json' \
  -H 'x-request-id: test-abc-123' -d '{"item": "souris", "amount": 29.9}'
docker compose logs api --tail 5
```

Attendu : des lignes JSON avec `service:"api"`, un `requestId`, et un niveau `info`. L'en-tête de réponse contient `x-request-id: test-abc-123`.

Puis Grafana (http://localhost:3002) → **Explore** → Loki :

```
{container=~".*api.*"} |= "test-abc-123"
```

Vous devez retrouver **toute la vie de la requête** avec une seule requête.

## Étape 6 — Incident intermittent

Lancez la panne vous-même :

```bash
bash scripts/incident.sh l1
```

Générez du trafic en parallèle (UI ou boucle `curl` de l'étape Level 0). Avec **uniquement** Loki, répondez :

1. Quel est le taux d'échec observé sur `POST /orders` (approximatif) ?
2. Les échecs sont-ils aléatoires ou corrélés à quelque chose (route, payload, service) ?
3. Montrez votre requête LogQL et la requête qui isole les lignes d'erreur d'un seul service.

Les erreurs injectées sont loggées en JSON (`level="error"`, `injected=true`). Rappels LogQL utiles :
```
{container=~".*api.*"}                              # tout l'api
{container=~".*api.*"} |= "error"                   # filtre par contenu
{container=~".*api.*"} | json | level="error"       # filtre par champ structuré
{container=~".*api.*"} | json | level="error" | injected="true"   # seulement les erreurs injectées
```

## Étape 7 — Validation

```bash
./levels/level-1-logs/validate.sh
```

Le script est boîte noire : il crée une commande avec un ID connu et vérifie dans Loki que api **et** worker en parlent, en JSON structuré. Il ne lit jamais votre code.

## Livrable

- Vos fichiers `logger.js`, `server.js`, `worker.js` instrumentés.
- Réponses écrites de l'étape 6 (3 questions).
- Votre chronologie Level 0 complétée, mise à jour : « avec Loki, j'aurais trouvé en X minutes ».

---

> Le code de ce niveau est déjà dans `app/shared/logger.js`, `app/api/server.js` et `app/worker/worker.js` : relisez-le après l'étape 5.
