# TP Monitoring & SRE — de l'aveugle à l'auto-remédiation

Une petite application e-commerce (frontend → api → Postgres + file Redis → worker) que vous équipez, niveau après
niveau, d'une plateforme d'observabilité — puis qu'on fait tomber en panne, volontairement, pour mesurer ce que chaque
brique apporte.

**Ce dépôt est autonome** : tout tourne sur votre machine (Docker), sans serveur partagé, sans compte externe et sans
personne pour lancer les pannes à votre place. Vous déclenchez vous-même les incidents (`scripts/incident.sh`) et vous
vérifiez votre travail vous-même (`validate.sh`).

## Avant de commencer (≈ 20 min, réseau requis — à faire AVANT la séance)

Prérequis : Docker (Desktop ou Engine) + Compose v2, `curl`, `jq`, bash, ~4 Go de RAM pour Docker.

```bash
make check       # vérifie Docker, jq, ports, mémoire
make prefetch    # télécharge les images et construit tout : évite 15-20 min en séance
```

Pas de `make` ? Chaque cible est une commande Docker Compose lisible dans le `Makefile`.

## Le parcours (édition 3 h)

Détail minuté, ce que vous codez et plan B : **`docs/TP_3H.md`**. Résumé :

| Niveau | Thème | Mode | Vous lancez |
|---|---|---|---|
| 0 | Incident à l'aveugle | vécu | `make up-l0`, `make traffic`, `make incident-l0` |
| 1 | Logs structurés (Loki / Grafana) | déjà fourni, exploré | `make up-l1`, `make incident-l1` |
| 2 | Métriques RED + métier, alertes | **vous codez** | `make up-l2`, `make incident-l2`, `make validate-l2` |
| 3 | Traces (OpenTelemetry / Jaeger) | démo | `bash scripts/apply-solutions.sh 3`, `make up-l3`, `make incident-l3` |
| 4 | SLI métier, burn-rate, postmortem | **vous codez** | `make incident-l4`, `make validate-l4` |
| 5 | Auto-remédiation + capstone | **vous codez** | `make up-l5`, `make validate-l5`, `make surprise` |

Chaque niveau a son tutoriel : `levels/level-N-*/TUTORIAL.md` (le niveau 0 : `INSTRUCTIONS.md`).
Les notions théoriques sont dans `docs/NOTIONS.md` ; le format du postmortem dans `docs/POSTMORTEM_TEMPLATE.md`.

## Les pannes sont à vous

```bash
bash scripts/incident.sh <l0|l1|l2|l3|l4|l4-long|l5-crash|l5-pool|l5-silent>   # lance une panne scénarisée
bash scripts/incident.sh surprise   # capstone : panne aléatoire, différée de 1 à 3 min, non nommée
bash scripts/incident.sh reveal     # APRÈS votre diagnostic : quelle panne c'était
bash scripts/incident.sh status     # fautes actives
bash scripts/incident.sh reset      # tout arrêter / nettoyer
```

Le contenu des scénarios est embarqué dans l'image du `chaos-injector` et pas affiché : ne le lisez pas avant d'avoir
diagnostiqué, c'est le principe de l'exercice. Une UI manuelle est disponible sur http://localhost:4000.

## Où est mon travail ?

Marqueurs `TODO(student, L<n>)` dans :

- `app/api/server.js`, `app/worker/worker.js` — métriques RED et métier (L2)
- `prometheus/prometheus.yml` — scraping (L2) ; `prometheus/rules/alerts.yml` (L2) et `prometheus/rules/slo.yml` (L4) à créer
- `automation-controller/rules.js` — règle 1 de remédiation (L5)

## Ports

| Service | Port | Service | Port |
|---|---|---|---|
| frontend | 3000 | Grafana (L1+) | 3002 (admin / sre-tp) |
| api | 3001 | Prometheus (L2+) | 9090 |
| chaos-injector | 4000 | Alertmanager (L2+) | 9093 |
| contrôleur (L5) | 5002 | Jaeger (L3+) | 16686 |
| webhook-receiver (L2+) | 5001 | Loki (L1+) | 3100 |

## Plan B et honnêteté

`bash scripts/apply-solutions.sh <2|4|5>` applique la solution complète d'un niveau si vous êtes bloqué : vos fichiers
sont sauvegardés dans `.student-backup/`, et l'usage est tracé dans `.solutions-used.log` (à joindre à votre rendu).
Un niveau rattrapé perd ses points de code. La démo L3 est, elle, prévue pour être appliquée sans pénalité.

## Rendu

Voir **`RENDU.md`** : ce qu'il faut remettre, sans qu'aucune interaction avec votre machine ne soit nécessaire.

## Aide IA

`AI_MENTOR_PROMPT.md` contient un prompt à coller dans votre assistant IA pour qu'il vous guide par indices plutôt que
de produire le code.

## Dépannage

| Symptôme | Remède |
|---|---|
| Commandes `docker compose` sans réponse (Docker Desktop figé après une veille) | quittez et relancez Docker Desktop |
| Une alerte / une métrique n'apparaît pas | attendez 40 s après un redémarrage ; `docker compose restart prometheus` après avoir modifié sa config |
| Conteneurs à l'état « Created » | `make down` puis relancez |
| `awk`/`sleep` en erreur dans `traffic.sh` | déjà géré (`LC_ALL=C`) ; sinon exportez `LC_ALL=C` |
| Repartir de zéro | `make reset` |
