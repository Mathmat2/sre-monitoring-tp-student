# Référence — Alerting multi-fenêtres multi-burn-rate (pattern Google SRE Workbook)

> Objectif : détecter une brûlure anormale du budget d'erreur **assez vite pour pager**, **sans fausses alertes**. Une seule fenêtre ne suffit pas : elle crie soit trop tard (fenêtre longue), soit trop souvent sur du bruit (fenêtre courte).

## 1. Vocabulaire

- **SLI** : métrique qui mesure l'expérience utilisateur. Ici : `sli_orders_ratio_Xm` = fraction des commandes créées qui sont **terminées en moins de 10 s** (SLI métier), et `sli_availability_ratio_Xm` = fraction des réponses de l'api **sans** 5xx, **toutes routes confondues** (y compris `route="unmatched"`) (SLI HTTP). Le premier voit les jobs perdus, pas le second.
- **SLO** : objectif. `99.5 %` de disponibilité sur 30 jours glissants.
- **Error budget** : la marge d'échec autorisée. SLO 99.5 % → **budget = 0.5 %** des requêtes.
- **Burn rate** : vitesse de consommation du budget, sans unité de temps :
  ```
  burn_rate = (1 - SLI) / budget
  ```
  `burn_rate = 1` signifie « on consomme le budget au rythme exact prévu par le SLO » (à ce rythme, le budget de 30 jours est épuisé en 30 jours).
  `burn_rate = 14.4` → à ce rythme, **tout le budget part en 2 % du mois ≈ 14.4 h** : c'est une urgence.

## 2. La table de référence (Google SRE Workbook, chap. 5)

| Fenêtre longue | Fenêtre courte | Burn rate | Budget brûlé | Comportement |
|---|---|---|---|---|
| 1 h | 5 min | 14.4 | 2 % | Pager (brûlure rapide) |
| 6 h | 30 min | 6 | 5 % | Pager |
| 3 j | 6 h | 1 | 10 % | Ticket |
| 30 j | 2 h | 0.5 | 50 % | Ticket (revue) |

Pourquoi **deux fenêtres** : la fenêtre courte détecte vite, la fenêtre longue élimine les micro-pics (une salve de 2 minutes ne tient pas 1 h à burn 14.4). L'alerte ne part que si **les deux** conditions sont vraies simultanément.

## 3. La règle (à adapter à votre SLI)

```yaml
- alert: SLOAvailabilityBurnFast
  expr: |
    ((1 - sli_availability_ratio_5m) / 0.005 > 14.4)
    and
    ((1 - sli_availability_ratio_1h) / 0.005 > 14.4)
  for: 2m
```

- `sli_availability_ratio_5m` : recording rule (fraction de succès sur 5 min).
- `0.005` : le budget (1 - 0.995).
- `and` : PromQL « les deux séries vraies sur la même période ».
- `for: 2m` : anti-rebond supplémentaire.

La brûlure lente est identique avec les fenêtres 6 h / 3 j et un seuil de 1.

## 4. Pièges classiques

1. **Alerter sur la cause** (CPU > 80 %) au lieu du symptôme (burn rate) : le CPU peut monter sans impact utilisateur, et l'impact peut arriver sans CPU haut (latence dépendance).
2. **Oublier le trafic nul** : sans requêtes, `rate()` vaut 0 et le ratio peut être aberrant (0/0). Gardez une garde (`and sum(rate(...)) > 0`) ou acceptez que l'alerte ne dorme que quand il n'y a rien à protéger.
3. **Une seule fenêtre** : soit trop bruyante (5 min seule), soit trop lente (1 h seule).
4. **SLO à 100 %** : aucun budget → aucune feature ne se déploie plus. Le budget est fait pour être dépensé, pas sanctuarisé.

## 5. Ce que le budget décide (culture SRE)

- Budget sain (> 50 % restant) : on peut pousser des features, prendre des risques.
- Budget entamé (< 50 %) : on gèle les déploiements risqués, on investit en fiabilité.
- C'est un **contrat dev ↔ ops** : les deux camps décident avec le même chiffre, pas avec des opinions.
