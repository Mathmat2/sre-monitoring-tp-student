#!/usr/bin/env bash
# traffic.sh — trafic synthétique continu vers l'api (Ctrl-C pour arrêter).
# Usage : bash scripts/traffic.sh [itérations_par_seconde=2]
# Chaque itération = 1 POST /orders + 1 GET /orders. Le worker traite ~2.7 commandes/s :
# au-delà, la file grossit et le SLI « commandes < 10 s » chute sans aucune panne.
export LC_ALL=C   # awk et sleep exigent un point décimal (pas « 0,200 » en locale fr)
RATE=${1:-2}
API_URL=${API_URL:-http://localhost:3001}
DELAY=$(awk -v r="$RATE" 'BEGIN { printf "%.3f", 1 / r }')
echo "trafic : ~$RATE commandes/s vers $API_URL (Ctrl-C pour arrêter)"
while true; do
  curl -s -m 5 -o /dev/null -X POST "$API_URL/orders" \
    -H 'Content-Type: application/json' -d '{"item":"trafic 3h","amount":10}' &
  curl -s -m 5 -o /dev/null "$API_URL/orders" &
  sleep "$DELAY"
done
