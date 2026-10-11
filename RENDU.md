# Rendu

Tout se constate depuis ce dépôt : pensez à `git add -A && git commit` puis déposez le dépôt (ou une archive) à
l'endroit indiqué par votre enseignant. Aucun accès à votre machine n'est nécessaire pour corriger.

## À remettre

| Livrable | Contenu | Où |
|---|---|---|
| **L0** — chronologie | tableau « baseline » + 3 réponses de `levels/level-0-baseline/INSTRUCTIONS.md` | `rendu/l0-chronologie.md` |
| **L2** — code | `app/api/server.js`, `app/worker/worker.js`, `prometheus/prometheus.yml`, `prometheus/rules/alerts.yml` | l'arbre du dépôt |
| **L4** — code | `prometheus/rules/slo.yml` (SLI **commandes** + burn-rate) | l'arbre du dépôt |
| **L5** — code | `automation-controller/rules.js` (règle 1) | l'arbre du dépôt |
| **Validations** | sortie complète des validateurs (voir ci-dessous) | `rendu/validations.txt` |
| **Capstone** | quelle panne (`reveal`), détection, `/actions` du contrôleur, ce qui a/n'a pas marché | `rendu/capstone.md` |
| **Postmortem** | gabarit `docs/POSTMORTEM_TEMPLATE.md`, blameless, actions vérifiables | `rendu/postmortem.md` |
| **Plan B** | le fichier `.solutions-used.log` s'il existe (ne pas le supprimer) | racine |

## Produire la preuve de validation

```bash
mkdir -p rendu
{ date; echo "== L2"; make validate-l2; echo "== L4"; make validate-l4; echo "== L5"; make validate-l5; } 2>&1 | tee rendu/validations.txt
```

Les validateurs sont **boîte noire** : ils vérifient le comportement observé, pas le code. Il y a donc aussi une revue
de code : middleware de métriques en tête de pile, `route` = pattern (pas l'URL brute), dénominateur du SLI = commandes
**créées**, règle 1 avec escalade.
