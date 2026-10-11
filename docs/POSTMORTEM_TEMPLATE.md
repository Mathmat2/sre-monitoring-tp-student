# Postmortem — [Titre court de l'incident]

> **Règle d'or (blameless)** : ce document décrit un **système qui a failli**, pas des personnes. Aucune phrase ne commence par « X aurait dû ». Si une action humaine apparaît, demandez : *quel facteur système a rendu cette erreur possible ?* Les postmortems blâmables ne sont plus honnêtes — tout le monde arrête de dire ce qu'il sait.

| | |
|---|---|
| **Date** | YYYY-MM-DD |
| **Durée d'impact** | de HH:MM à HH:MM (X min) |
| **Services impactés** | |
| **Sévérité** | SEV-1 / SEV-2 / SEV-3 (critère : impact utilisateur) |
| **Auteur·rice** | |
| **Statut** | brouillon / finalisé |

## 1. Résumé (3 lignes max)

En une phrase : ce qui s'est passé, quel impact pour l'utilisateur, quel facteur racine.

## 2. Impact

- Utilisateurs : (requêtes échouées, latence perçue, commandes perdues...)
- SLI/SLO : budget d'erreur consommé pendant l'incident = ___ % (sur le mois en cours : ___ %)
- Chiffres : (nombre de 5xx, p99 max observé, durée d'alerte)

## 3. Chronologie (UTC ou heure locale, cohérente)

| Heure | Événement | Source (alerte, dashboard, log, trace, humain) |
|---|---|---|
| HH:MM | Faute injectée / déclencheur | |
| HH:MM | Première alerte déclenchée | |
| HH:MM | Impact utilisateur max | |
| HH:MM | Détection de la cause | |
| HH:MM | Remédiation | |
| HH:MM | Retour à la normale | |

*(TTD = temps de détection, TTR = temps de résolution — comparez-les aux niveaux précédents du TP.)*

## 4. Cause(s) racine(s)

Décrivez le mécanisme technique **complet** : déclencheur → propagation → symptôme. Une cause racine est rarement unique ; listez les facteurs contributifs.

## 5. Facteurs contributifs (systémiques)

- (ex. : absence de métrique de saturation X, seuil d'alerte trop bas, runbook inexistant, dépendance sans timeout...)
- Pour chaque facteur : pourquoi le système a-t-il *permis* ça ?

## 6. Ce qui a bien fonctionné

(Alertes utiles, dashboards qui ont aidé, propagation efficace... — la partie blameless sert aussi à ça.)

## 7. Action items

| Action | Type (prévention / détection / atténuation) | Propriétaire | Échéance | Priorité |
|---|---|---|---|---|
| | | | | |

*(Chaque action doit être vérifiable : « ajouter un timeout de 2 s sur l'appel redis », pas « améliorer la résilience ».)*

## 8. Leçons

- Ce que nous savions déjà et n'avons pas appliqué :
- Ce que nous avons appris de nouveau :

## 9. Chat gris (facultatif)

Ce qui n'a PAS de solution évidente aujourd'hui — à garder sous les yeux plutôt que prétendre trancher.
