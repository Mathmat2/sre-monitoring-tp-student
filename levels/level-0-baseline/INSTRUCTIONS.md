# Level 0 — Baseline : diagnostiquer à l'aveugle

> **Objectif** : vivre un incident réel dans un système distribué **sans aucune observabilité**, et mesurer ce que ça coûte. Cette souffrance est votre ligne de base : à chaque niveau suivant, vous comparerez votre temps de diagnostic à celui d'aujourd'hui.

## Prérequis

- Docker Desktop (ou Docker Engine + Compose v2) fonctionnel, ~4 Go de RAM alloués à Docker.
- Les outils système : `curl`, `docker logs`, `docker stats`. **C'est tout** — et c'est justement le problème.

## 1. Démarrer l'application

```bash
make up-l0        # = docker compose -f docker-compose.yml -f docker-compose.light.yml up -d --build
```

Vérifiez que l'application fonctionne :

```bash
curl http://localhost:3001/health
curl -X POST http://localhost:3001/orders \
  -H 'Content-Type: application/json' \
  -d '{"item": "clavier mécanique", "amount": 89.9}'
```

(Dans la suite, `docker compose …` doit porter les mêmes `-f` que le `Makefile` : utilisez les cibles `make` ou ajoutez `-f docker-compose.light.yml`.)

Vous pouvez aussi passer des commandes depuis l'interface : http://localhost:3000

L'application est composée de 4 services :
- `frontend` (port 3000) : page web qui crée des commandes et affiche leur statut.
- `api` (port 3001) : valide la commande, l'écrit dans Postgres, pousse un job dans Redis.
- `worker` : consomme les jobs Redis et fait passer la commande `pending → processing → completed`.
- `postgres`, `redis` : dépendances.
- `chaos-injector` (port 4000) : service qui déclenche les pannes — c'est **vous** qui le pilotez, via `scripts/incident.sh`.

## 2. Déclencher l'incident

Une panne est embarquée dans le chaos-injector. Son contenu est volontairement caché : **ne cherchez pas à le lire avant l'exercice** — en conditions réelles, vous ne sauriez pas quelle panne a été injectée.

```bash
bash scripts/incident.sh l0      # ou : make incident-l0
```

La panne se déroule en arrière-plan (≈ 2 min 30). Pour l'arrêter à tout moment : `bash scripts/incident.sh reset`.

## 3. Votre mission : diagnostiquer avec les moyens du bord

Pendant que le scénario tourne :

1. Générez du trafic (`make traffic` dans un second terminal, Ctrl-C pour l'arrêter ; ou `bash scripts/traffic.sh 2 &` puis `make stop-traffic`), passez des commandes via l'UI ou en boucle :
   ```bash
   while true; do
     curl -s -o /dev/null -w '%{http_code} %{time_total}s\n' -X POST http://localhost:3001/orders \
       -H 'Content-Type: application/json' -d '{"item": "test", "amount": 1}'
     sleep 1
   done
   ```
2. Observez avec **uniquement** :
   - `docker compose logs` / `docker logs <conteneur>`
   - `docker stats`
   - `curl http://localhost:3001/orders` (comportement visible de l'utilisateur)
   - vos propres hypothèses (`docker exec` dans les conteneurs est autorisé)
3. Essayez de répondre à ces questions **sans regarder le scénario** :
   - Quel service est en cause ?
   - La panne est-elle complète ou dégradée ? Certaines requêtes passent-elles ?
   - Est-ce un problème de code, de dépendance, de ressource ?
   - Que se passe-t-il si vous redémarrez un conteneur ?

## 4. Livrable : votre chronologie "baseline"

Recopiez et remplissez ce tableau — c'est l'artefact de référence de tout le TP :

| Événement | Horodatage (réel) | Comment vous l'avez su |
|---|---|---|
| Première anomalie **remarquée** | | |
| Cause probable **identifiée** | | |
| Confiance dans le diagnostic (0-5) | | |
| Ce que vous auriez voulu avoir sous la main | | |

Puis répondez en quelques lignes :

1. Combien de temps (réel) entre « quelque chose ne va pas » et « je sais à peu près pourquoi » ?
2. À quel moment avez-vous été **sûr** du diagnostic ? Qu'est-ce qui vous a donné l'assurance (ou pas) ?
3. Si cette panne durait 6 heures en production, quel serait le coût pour l'équipe ?

## 5. Débrief

Une fois votre livrable écrit, et seulement maintenant :

```bash
bash scripts/incident.sh reveal   # que s'est-il réellement passé ?
bash scripts/incident.sh status   # fautes encore actives
```

Laissez la stack tourner pour le niveau 1.

Gardez votre tableau : il resservira au Level 2 (comparaison avant/après dashboards) et au Level 4 (chiffrage du MTTR dans le postmortem).
