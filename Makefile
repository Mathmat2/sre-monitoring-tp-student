# Raccourcis du TP (voir README.md). Tout se lance depuis ce dossier.
COMPOSE_BASE = docker compose -f docker-compose.yml -f docker-compose.light.yml
L1 = $(COMPOSE_BASE) -f docker-compose.l1.yml
L2 = $(L1) -f docker-compose.l2.yml
L3 = $(L2) -f docker-compose.l3.yml
L5 = $(L3) -f docker-compose.l5.yml

.PHONY: restore-l2 stop-traffic need-l3 check prefetch up-l0 up-l1 up-l2 up-l3 up-l5 traffic down reset \
        incident-l0 incident-l1 incident-l2 incident-l3 incident-l4 incident-l5 surprise reveal \
        validate-l1 validate-l2 validate-l3 validate-l4 validate-l5 demo-circuit-breaker

check:      ## vérifie Docker / Compose / ports libres
	bash scripts/check-env.sh

prefetch:   ## UNE fois, avec réseau : télécharge les images et construit tout
	$(L5) pull --ignore-buildable
	$(L5) build

up-l0:
	$(COMPOSE_BASE) up -d --build
up-l1:
	$(L1) up -d --build
up-l2:
	$(L2) up -d --build
up-l3: need-l3
	$(L3) up -d --build
up-l5: need-l3
	$(L5) up -d --build

need-l3:
	@test -f app/api/tracing.js || { echo "L3 : appliquez d'abord la démo : bash scripts/apply-solutions.sh 3"; exit 1; }

traffic:
	bash scripts/traffic.sh 2
stop-traffic:  ## arrête un traffic.sh lancé en tâche de fond
	@pkill -f scripts/traffic.sh && echo "trafic arrêté" || echo "aucun trafic en cours"

restore-l2:  ## après la démo L3 : récupère VOTRE api/worker L2 sauvegardés par apply-solutions.sh 3
	@for d in $$(ls -d .student-backup/2* 2>/dev/null | sort -r); do \
	  if [ -f "$$d/app/api/server.js" ] && [ -f "$$d/app/worker/worker.js" ]; then \
	    cp "$$d/app/api/server.js" app/api/server.js; cp "$$d/app/worker/worker.js" app/worker/worker.js; \
	    echo "api/worker restaurés depuis $$d (le tracing de la démo L3 n'y est plus : relancez make up-l5)"; exit 0; \
	  fi; done; echo "aucune sauvegarde de vos fichiers L2 dans .student-backup/"; exit 1

# Pannes à déclencher soi-même (le contenu reste caché, cf. scripts/incident.sh)
incident-l0: ; bash scripts/incident.sh l0
incident-l1: ; bash scripts/incident.sh l1
incident-l2: ; bash scripts/incident.sh l2
incident-l3: ; bash scripts/incident.sh l3
incident-l4: ; bash scripts/incident.sh l4
incident-l5: ; bash scripts/incident.sh l5-silent
surprise:    ; bash scripts/incident.sh surprise
reveal:      ; bash scripts/incident.sh reveal

validate-l1: ; bash levels/level-1-logs/validate.sh
validate-l2: ; bash levels/level-2-metrics/validate.sh
validate-l3: ; bash levels/level-3-tracing/validate.sh
validate-l4: ; MODE=3h bash levels/level-4-slo/validate.sh
validate-l5: ; MODE=3h bash levels/level-5-automation/validate.sh

demo-circuit-breaker:  ## L5 : copie SEULEMENT db.js de référence (circuit breaker), pas rules.js
	@mkdir -p .student-backup/db-js && cp app/shared/db.js .student-backup/db-js/db.js
	cp .solutions/level-5-automation/app/shared/db.js app/shared/db.js
	@echo "db.js de référence copié (sauvegarde : .student-backup/db-js/). Relancez : make up-l5"

down:
	$(L5) down

reset:      ## repart de zéro (volumes inclus)
	$(L5) down -v
