# TUTORIAL — Level 4 : SLI, SLO, error budget & postmortem

> **Objectif** : transformer vos métriques du niveau 2 en **engagements mesurables** (SLI/SLO), implémenter l'alerting **multi-fenêtres multi-burn-rate** du Google SRE Workbook, consommer visiblement le budget pendant un incident long, puis écrire un **postmortem blameless**.
>
> **Le SLI porte sur le produit, pas sur la machine ni sur le HTTP.** Le SLI principal de ce niveau est métier : *« la commande a-t-elle été terminée en moins de 10 s ? »*. Le SLI de disponibilité HTTP existe aussi : vous verrez qu'une panne peut laisser l'un vert pendant que l'autre s'effondre.
>
> Changement de posture : aux niveaux précédents on diagnostiquait ; ici on **décide** (ralentir les features ? investir en fiabilité ?) à partir d'un chiffre partagé.

## Prérequis

Stack L1+L2 actives (aucun nouveau conteneur). La doc de référence `docs/MULTI_BURN_RATE_ALERTING.md` résume le pattern Google SRE — lisez-la AVANT d'écrire vos règles, elle contient la table des fenêtres et le piège des divisions par zéro.

## Étape 1 — Définir 2 SLI (recording rules)

**Pourquoi** : un SLI est une **définition rigoureuse** de l'expérience utilisateur, pas un graphe. On l'écrit une fois, comme du code, pour que tout le monde mesure la même chose.

Créez `prometheus/rules/slo.yml` avec deux recording rules (noms imposés) :

| Nom | Définition |
|---|---|
| `sli_availability_ratio_5m` / `_1h` / `_6h` / `_3d` | fraction des réponses de l'api **sans 5xx** sur la fenêtre |
| `sli_latency_ok_ratio_5m` | fraction des réponses de l'api **sous 300 ms** (bucket `le="0.3"`) |
| `sli_orders_ratio_5m` / `_1h` / `_6h` / `_3d` | **SLI métier** : commandes terminées en moins de 10 s (`order_processing_seconds_bucket{le="10"}`) ÷ commandes **créées** (`orders_total{status="created"}`) |

Base : vos métriques L2 (`http_requests_total`, `http_request_duration_seconds_bucket`, `orders_total`, `order_processing_seconds_bucket`).

⚠️ **Piège du SLI métier** : le dénominateur est le nombre de commandes **créées**, pas `completed + failed`. Un job perdu en silence n'est ni `completed` ni `failed` : avec le mauvais dénominateur, il disparaîtrait du ratio. Encadrez le ratio avec `clamp_max(..., 1)` (il peut dépasser 1 quand les terminaisons rattrapent un retard).

⚠️ **Deux pièges qui ont piégé la conception même du TP** :

1. Comptez les **succès** au numérateur (`status!~"5.."`), pas les échecs : la série `status="5.."` n'existe pas tant qu'aucun 5xx n'a eu lieu, et `1 − vide/total` ne produit aucune série.
2. Ne filtrez **pas** par route : les erreurs qui partent avant le matching Express portent `route="unmatched"` — un SLI filtré sur `/orders` serait aveugle à ces échecs, précisément ceux que l'utilisateur subit. Le SLI mesure le **service**.

Vérifiez la série avec `sli_availability_ratio_5m` dans l'onglet Graph de Prometheus — entre 0 et 1, à 1 quand tout va bien. Un `docker compose restart prometheus` recharge les règles après création du fichier.

### Checkpoint

```bash
curl -s http://localhost:9090/api/v1/query --data-urlencode 'query=sli_availability_ratio_5m' | jq -r '.data.result[0].value[1]'
```
Attendu : `1` (ou proche de 1) tant que tout va bien. Générez du trafic si la série n'existe pas.

## Étape 2 — Fixer le SLO et son budget

**Pourquoi** : le SLO transforme une intuition (« ça doit marcher ») en contrat chiffré et en marge de décision.

1. SLO de disponibilité : **99.5 % sur 30 jours glissants**.
2. Calculez : budget d'erreur = 0.5 % des requêtes. Sur 1000 requêtes/heure, combien de 5xx le budget autorise-t-il **par jour** ? (Réponse attendue dans votre livrable.)
3. Notez la différence SLA/SLO/SLI : le SLA est contractuel (avec pénalités), le SLO interne est l'engagement d'ingénierie, le SLI est la mesure.

## Étape 3 — Alertes multi-fenêtres multi-burn-rate

**Pourquoi** : alerter sur « erreurs > 5 % » (L2) déclenche trop tôt ou trop tard. Le burn rate mesure la **vitesse de consommation du budget** et hiérarchise : brûlure rapide = pager, brûlure lente = ticket.

Écrivez les alertes suivantes (noms imposés) en suivant `docs/MULTI_BURN_RATE_ALERTING.md`. Les deux premières portent sur le SLI métier (même SLO 99.5 %, même budget 0.005) ; les deux suivantes, sur la disponibilité HTTP :

1. `SLOOrdersBurnFast` : burn > **14.4** sur 5 min **ET** 1 h, `for: 2m` (sur `sli_orders_ratio_*`).
2. `SLOOrdersBurnSlow` : burn > 1 sur 6 h **ET** 3 j.
3. `SLOAvailabilityBurnFast` : même logique sur `sli_availability_ratio_*`.
4. `SLOAvailabilityBurnSlow`.

⚠️ Les fenêtres 6 h/3 j ne s'allumeront pas pendant la séance (il faudrait des heures de données) : c'est normal — ce qui se vérifie, c'est que la règle **charge** et que son expression est correcte. La brûlure rapide, elle, doit réellement partir pendant le scénario.

<details>
<summary>Indice</summary>

Le taux de succès sur 5 min = `1 - (5xx/total sur 5m)`. Le burn rate = `(1 - sli) / 0.005`. Utilisez `and` entre les deux fenêtres (PromQL : les deux côtés doivent être vrais sur les mêmes labels). Voir la doc de référence, section 3.
</details>

### Checkpoint

```bash
curl -s http://localhost:9090/api/v1/rules | jq -r '.data.groups[].rules[] | "\(.type) \(.name)"'
curl -s -G http://localhost:9090/api/v1/query --data-urlencode 'query=(1 - sli_availability_ratio_5m) / 0.005' | jq -r '.data.result[0].value[1]'
```
Le burn rate actuel doit être ~0 quand tout va bien.

## Étape 4a — Une panne que seul le SLI métier voit

Avant l'incident long, rejouez le contraste. Pendant 5 min, le worker acquitte 70 % des jobs **sans les traiter** :

```bash
bash scripts/traffic.sh 2          # en continu, depuis plusieurs minutes
bash scripts/incident.sh l4
```

Comparez dans l'onglet Graph de Prometheus :

```
sli_orders_ratio_5m                              # chute
sum(rate(http_requests_total{status!~"5.."}[5m])) / sum(rate(http_requests_total[5m]))   # reste à 1
sum(redis_queue_depth), up, container_cpu...     # rien ne bouge côté infra
```

Questions : quelle alerte part ? Laquelle reste muette, et pourquoi ? Qu'aurait montré un monitoring purement infrastructure ?

## Étape 4 — L'incident long (30 min)

```bash
bash scripts/incident.sh l4-long
```

Générez du trafic en continu pendant toute la durée. Pendant l'incident :

1. Observez la **brûlure** : `query=(1 - sli_availability_ratio_5m) / 0.005` — notez les paliers à chaque phase du scénario.
2. Quelle alerte part ? Avec quelle latence par rapport au début de la phase d'erreurs ? Et la brûlure lente, pourquoi reste-t-elle silencieuse ?
3. À la fin : calculez le budget consommé pendant la séance : fraction de 5xx sur la fenêtre totale ÷ 0.5 % de budget mensuel. (Discussion : un incident de 25 min consomme combien du mois ?)

## Étape 5 — Postmortem blameless

Complétez `docs/POSTMORTEM_TEMPLATE.md` (copiez-le, ne le modifiez pas) avec l'incident que vous venez de vivre :

- chronologie horodatée à partir des **sources** (alertes, dashboard, traces) ;
- budget consommé chiffré depuis Prometheus ;
- cause racine + facteurs contributifs **systémiques** (pas de coupable) ;
- action items vérifiables.

Relecture croisée : échangez votre postmortem avec un autre binôme — cherchez du langage blâmable dans le leur (et inversement).

## Étape 6 — Validation

```bash
./levels/level-4-slo/validate.sh
```

Le postmortem est **gradé manuellement** (rubrique : chronologie sourcée, impact chiffré, causes systémiques, actions vérifiables, absence de langage de blâme).

## Livrable

- `prometheus/rules/slo.yml` (recording rules + alertes burn-rate, SLI **métier** compris).
- Réponses à l'étape 4a : le HTTP aurait-il suffi ?
- Le postmortem complété.
- Réponses écrites de l'étape 4 (budget consommé, décision que vous prendriez : geler les déploiements ou non, et pourquoi).

---

<details>
<summary>Bloqué ? Référence</summary>

Une référence existe (`slo.yml` complet : recording rules + burn-rate fast/slow) : plan B, `bash scripts/apply-solutions.sh 4` (confirmation, usage tracé ; un niveau rattrapé perd ses points de code). Il n'y a pas de postmortem d'exemple : c'est votre livrable.
</details>
