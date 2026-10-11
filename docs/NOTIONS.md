# Notions du TP — aide-mémoire

Les concepts mobilisés par le TP, niveau par niveau. Le TP est autonome : lisez la section du niveau **avant** de l'attaquer (5 à 8 minutes), puis le tutoriel du niveau.

## Socle — à lire avant le Level 0

- **Observabilité vs monitoring** : le monitoring répond à des questions connues à l'avance (dashboards, seuils) ; l'observabilité permet de répondre à des questions qu'on ne s'était pas posées à l'avance, en explorant l'état interne du système à partir de ses sorties.
- **Les trois piliers de l'observabilité** : logs, métriques, traces — ce qu'ils capturent, leurs forces/limites respectives, pourquoi aucun des trois seul ne suffit.
- **Toil** (définition SRE de Google) : travail opérationnel manuel, répétitif, automatisable, sans valeur durable — moteur de toute la progression du TP (L0 = tout le toil possible, L5 = toil éliminé).
- **MTTR / MTTD / MTBF** : temps de détection, temps de diagnostic, temps de résolution, temps moyen entre pannes — les métriques qui serviront à comparer les niveaux entre eux.
- **Architecture distribuée minimale** : pourquoi une panne dans un système à plusieurs services est plus difficile à diagnostiquer qu'un monolithe (propagation, dépendances cachées, défaillances en cascade).

## Level 0 — Baseline

- Notion de **panne silencieuse / diagnostic à l'aveugle** : ce que coûte réellement l'absence d'observabilité (temps, stress, incertitude).
- **Debugging par corrélation manuelle** (logs bruts, `docker stats`) et ses limites intrinsèques à l'échelle.

## Level 1 — Logs

- **Logging structuré (JSON) vs logging texte libre** : pourquoi la structure permet l'agrégation et la requête, pas seulement la lecture humaine.
- **Niveaux de log** (debug/info/warn/error/fatal) et discipline d'usage.
- **Corrélation de requêtes** : request ID / trace ID propagé à travers les services, pourquoi c'est le chaînon qui relie logs, métriques et traces entre eux.
- **Agrégation centralisée de logs** : pattern (agent de collecte type Promtail, stockage type Loki, interrogation type LogQL) — le *pourquoi* architectural, pas seulement l'outil.
- **Limites des logs** : volumétrie, coût de stockage, impossibilité de voir des tendances agrégées sans métriques dédiées, risque de "log-and-forget".

## Level 2 — Métriques

- **Golden signals** (Google SRE) : latence, trafic, erreurs, saturation.
- **RED method** (Rate, Errors, Duration) — pour les services orientés requêtes.
- **USE method** (Utilization, Saturation, Errors) — pour les ressources (CPU, connexions DB, mémoire).
- **Types de métriques Prometheus** : counter, gauge, histogram, summary — quand utiliser lequel, notamment pour la latence (histogram + quantiles).
- **Percentiles vs moyenne** : pourquoi p95/p99 racontent une histoire que la moyenne cache (impact utilisateur réel vs comportement moyen).
- **Pull vs push model** pour la collecte de métriques (Prometheus scrape vs agents qui poussent) — trade-offs.
- **Cardinalité des métriques** : pourquoi trop de labels (ex. un label par user ID) explose le coût et dégrade Prometheus — notion souvent sous-estimée par les étudiants.
- **Dashboards utiles vs dashboards décoratifs** : principes de construction (contexte, comparaison, actionnabilité) plutôt qu'empiler des graphes.
- **Monitoring applicatif vs monitoring d'infrastructure** : l'infrastructure (CPU, RAM, conteneurs « up ») dit que la machine va bien ; l'application dit si le produit rend le service. Une panne peut laisser l'une verte et l'autre rouge.
- **Métriques métier** : compter ce que l'utilisateur attend (commandes créées / terminées / bloquées, délai de bout en bout) et non seulement ce que fait la machine. Gauges lues dans l'état réel (base) plutôt que déduites des appels HTTP.
- **Panne silencieuse** : un composant échoue sans erreur ni lenteur visible (job acquitté sans traitement). Se détecte par un SLI de bout en bout.
- **Alerting sur symptômes vs sur causes** : pourquoi alerter sur le taux d'erreur perçu par l'utilisateur est préférable à alerter sur le CPU d'une machine.
- **Fatigue d'alerte (alert fatigue)** et ses conséquences (désensibilisation, alertes ignorées).

## Level 3 — Tracing distribué

- **Trace, span, contexte de propagation** : vocabulaire et mécanique (parent/enfant, baggage, propagation via headers).
- **OpenTelemetry** comme standard d'instrumentation vendor-neutral (SDK, auto-instrumentation vs instrumentation manuelle).
- **Pourquoi le tracing révèle ce que les métriques agrégées cachent** : localisation précise de la latence dans une chaîne d'appels, défaillances en cascade.
- **Sampling de traces** : pourquoi on ne trace pas 100% du trafic en production (coût, volumétrie) et les stratégies de sampling (head-based, tail-based) — au moins en survol.
- **Propagation de contexte across boundaries asynchrones** (queue, worker) : cas plus difficile que le HTTP synchrone, qu'auto-instrumentation ne couvre pas toujours.

## Level 4 — SLI / SLO / Error Budget

- **SLI (Service Level Indicator)** : définition rigoureuse d'une métrique qui représente l'expérience utilisateur. Préférer un SLI **métier** (« commande terminée en < 10 s ») à un SLI purement technique (« HTTP sans 5xx ») : le second peut rester vert alors que le produit est cassé.
- **SLO (Service Level Objective)** : objectif interne, cible d'engagement, distinct du SLA (contractuel, souvent avec pénalités).
- **Error budget** : ce qu'il reste de marge d'échec avant de violer le SLO, et comment il sert d'outil de décision produit/ingénierie (ralentir les déploiements vs accélérer les features).
- **Fenêtres de mesure** (rolling window 28-30 jours typiquement) et pourquoi elles importent.
- **Alerting multi-fenêtres / multi-burn-rate** (pattern du Google SRE Workbook) : détecter à la fois les brûlures rapides et lentes du budget d'erreur sans fausses alertes.
- **Blameless postmortem** : principes (pas de recherche de coupable, focus sur les facteurs contributifs systémiques), structure type (timeline, impact, root cause(s), action items).
- **Culture SRE vs culture Ops traditionnelle** : accountability partagée entre dev et ops, le SLO comme contrat entre les deux.

## Level 5 — Automatisation / auto-remédiation

- **Runbook vs runbook-as-code** : passage d'une procédure documentée suivie manuellement à un code exécuté automatiquement.
- **Auto-scaling réactif** (basé sur métriques de charge) vs **prédictif** — au moins mentionner la distinction.
- **Circuit breaker pattern** : éviter qu'une dépendance lente ne fasse s'effondrer tout le système en cascade (lien direct avec le scénario du Level 3).
- **Auto-remédiation et ses risques** : actions automatiques mal bornées peuvent aggraver un incident (ex. redémarrages en boucle, scaling incontrôlé) — nécessité de garde-fous (rate limiting des actions, escalade humaine après N tentatives).
- **Observabilité des systèmes d'automatisation eux-mêmes** : toute action automatique doit être loguée/mesurée — sinon on recrée un nouveau système opaque.
- **Escalade humaine (paging)** : quand et comment une automatisation doit "rendre la main" à un humain plutôt que persister. Cas d'école : des commandes perdues en silence ne se réparent ni par restart ni par scale.
- **Chaos engineering** : principe (injecter délibérément des pannes pour valider la résilience), lien avec le chaos-injector utilisé dans tout le TP, mention de Netflix/Chaos Monkey comme origine historique.

## Notions transverses à rappeler à chaque niveau

- **Coût de l'observabilité** : stockage, performance, complexité opérationnelle ajoutée — l'observabilité n'est pas gratuite, c'est un arbitrage.
- **Lien logs ↔ métriques ↔ traces** : comment un identifiant commun (trace ID) permet de naviguer de l'un à l'autre dans un incident réel (le TP est conçu pour le démontrer concrètement au Level 3).
- **MTTR comme fil conducteur** : à chaque niveau, comparer le temps de diagnostic au niveau précédent pour rendre tangible la valeur ajoutée de chaque brique.

## Références

- *Site Reliability Engineering* et *The Site Reliability Workbook*, Google (chapitres SLI/SLO/error budget, alerting multi-burn-rate, postmortems blameless).
- Spécification **OpenTelemetry** (vocabulaire traces/spans/contexte).
- Documentation **Prometheus** (types de métriques, cardinalité).
- *Chaos Engineering* (Netflix, principes originaux de Chaos Monkey).
