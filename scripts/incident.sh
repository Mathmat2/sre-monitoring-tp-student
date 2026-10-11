#!/usr/bin/env bash
# incident.sh — déclenche vous-même une panne scénarisée.
#   bash scripts/incident.sh l0|l1|l2|l3|l4|l4-burst|l4-long|l5-crash|l5-silent
#   bash scripts/incident.sh surprise      # capstone : panne aléatoire, différée, non nommée
#   bash scripts/incident.sh reveal        # APRÈS le diagnostic : quelle panne était-ce ?
#   bash scripts/incident.sh status        # fautes actuellement actives
#   bash scripts/incident.sh reset         # supprime toutes les fautes injectées
#
# Les scénarios sont embarqués dans l'image du chaos-injector (pas dans ce dépôt) :
# vous ne voyez le contenu d'une panne que si vous le décidez (`reveal`).
# Le scénario tourne dans le conteneur : fermer votre terminal ne l'interrompt pas.
set -euo pipefail
cd "$(dirname "$0")/.."
DC="docker compose -f docker-compose.yml"
EXEC="$DC exec -T chaos-injector"
CHAOS_URL=${CHAOS_URL:-http://localhost:4000}

running() { $DC ps --status running --services 2>/dev/null | grep -qx chaos-injector; }
need_stack() { running || { echo "chaos-injector arrêté : lancez d'abord la stack (make up-l0, up-l1…)." >&2; exit 1; }; }

case "${1:-}" in
  l0)       f=3h/l0-db-pool-exhaustion.yaml ;;
  l1)       f=l1-intermittent-errors.yaml ;;
  l2)       f=3h/l2-latency-spike.yaml ;;
  l3)       f=l3-cascading-redis-slowdown.yaml ;;
  l4)       f=3h/l4-orders-lost.yaml ;;
  l4-burst) f=3h/l4-error-burst.yaml ;;
  l4-long)  f=l4-mixed-30min.yaml ;;
  l5-crash) f=l5-unannounced/crash-loop-api.yaml ;;
  l5-pool)  f=l5-unannounced/db-pool-squeeze.yaml ;;
  l5-silent) f=3h/l5-silent-job-loss.yaml ;;
  surprise)
    need_stack
    # tirage + délai (60-180 s) décidés DANS le conteneur : le nom n'apparaît nulle part à l'écran
    $EXEC sh -c '
      set -e
      cd /injector
      set -- scenarios/l5-unannounced/*.yaml
      n=$(( $(od -An -N2 -tu2 /dev/urandom) % $# + 1 ))
      eval "pick=\${$n}"
      echo "$pick" > /tmp/last-incident
      rm -f /tmp/last-incident.log
      delay=$(( 60 + $(od -An -N2 -tu2 /dev/urandom) % 121 ))
      (sleep "$delay"; node run_scenario.js "$pick" > /tmp/last-incident.log 2>&1) >/dev/null 2>&1 &
    '
    echo "Une panne va se déclencher d'ici 1 à 3 minutes. Continuez à travailler normalement :"
    echo "générez du trafic (bash scripts/traffic.sh 2), surveillez Grafana / Prometheus / alertes."
    echo "Quand l'incident est terminé : bash scripts/incident.sh reveal"
    exit 0 ;;
  reveal)
    need_stack
    $EXEC sh -c 'if [ ! -s /tmp/last-incident.log ]; then echo "L incident n a pas (encore) démarré : patientez, diagnostiquez d abord."; elif [ -f /tmp/last-incident ]; then echo "Scénario joué : $(cat /tmp/last-incident)"; echo; cat /injector/$(cat /tmp/last-incident); echo; echo "--- journal ---"; cat /tmp/last-incident.log 2>/dev/null || true; else echo "Aucune panne surprise lancée."; fi'
    exit 0 ;;
  status) curl -s -m 5 "$CHAOS_URL/chaos/status"; echo; exit 0 ;;
  reset)  curl -s -m 5 -X POST "$CHAOS_URL/chaos/reset"; echo; exit 0 ;;
  *) sed -n '2,10p' "$0"; exit 1 ;;
esac

need_stack
echo "Déclenchement de la panne « $1 » (elle se déroule en arrière-plan, quelques minutes)."
$EXEC sh -c "cd /injector && echo scenarios/$f > /tmp/last-incident && (node run_scenario.js scenarios/$f > /tmp/last-incident.log 2>&1 &)"
echo "Panne lancée. Générez du trafic : bash scripts/traffic.sh 2"
echo "Fin du scénario, ou à tout moment : bash scripts/incident.sh reset"
