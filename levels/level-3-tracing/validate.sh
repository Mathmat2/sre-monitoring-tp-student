#!/usr/bin/env bash
# Validation boîte noire — Level 3 : tracing distribué.
# Prérequis : app + overlays L1, L2 et L3 démarrés :
#   docker compose -f docker-compose.yml -f docker-compose.l1.yml -f docker-compose.l2.yml -f docker-compose.l3.yml up -d --build
# Vérifie via l'API HTTP de Jaeger — ne lit jamais le code des étudiants.
set -u

API_URL="${API_URL:-http://localhost:3001}"
JAEGER_URL="${JAEGER_URL:-http://localhost:16686}"

pass=0
fail=0
ok()  { printf '  \033[32mOK\033[0m     %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  \033[31mECHEC\033[0m %s\n' "$1"; fail=$((fail+1)); }

echo "== Level 3 : tracing distribué =="

# Horodatage de début de validation : seules les traces postérieures comptent
# (sinon d'anciennes traces masqueraient l'état réel).
START_US=$(( $(date +%s) * 1000000 ))

# --- 0. Pré-requis ---
if ! curl -sf "$JAEGER_URL/api/services" >/dev/null; then
  bad "Jaeger injoignable ($JAEGER_URL) — overlay L3 démarré ?"
  exit 1
fi
ok "Jaeger joignable"

# --- 1. Générer du trafic tracé ---
for _ in $(seq 1 5); do
  curl -s -o /dev/null -m 5 -X POST "$API_URL/orders" \
    -H 'Content-Type: application/json' -d '{"item":"sonde L3","amount":1}' || true
  sleep 1
done
ok "trafic de sonde envoyé"

# --- 2. Services tracés (traces postérieures au lancement du script) ---
sleep 3
SERVICES=$(curl -sf "$JAEGER_URL/api/services" | jq -r '.data | join(" ")')
NEW_TRACES_COUNT=$(curl -sf "$JAEGER_URL/api/traces?service=api&start=$START_US&limit=50" | jq '.data | length')
[ "$NEW_TRACES_COUNT" -ge 1 ] && ok "nouvelles traces api créées pendant la validation ($NEW_TRACES_COUNT)" || bad "aucune nouvelle trace api — SDK OpenTelemetry initialisé ? export OTLP ?"
echo "$SERVICES" | grep -qw api && ok "service api tracé" || bad "aucune trace du service api (tracing.js chargé ? export OTLP ?)"
echo "$SERVICES" | grep -qw worker && ok "service worker tracé" || bad "aucune trace du service worker"

# --- 3. Propagation : une même trace contient api ET worker ---
# Le côté worker est asynchrone (queue) : sous charge ou pendant un incident Redis il peut
# arriver plusieurs dizaines de secondes plus tard -> on attend jusqu'à 60 s.
FOUND_PROPAGATION=""
for _ in $(seq 1 30); do
  TRACES=$(curl -sf "$JAEGER_URL/api/traces?service=api&start=$START_US&limit=100" | jq -c '.data[]? | . as $t | {traceID, services: ([.spans[] | .processID as $p | $t.processes[$p].serviceName] | unique), spanCount: (.spans | length)}')
  for trace in $TRACES; do
    if echo "$trace" | jq -e '.services | index("api") and index("worker")' >/dev/null 2>&1; then
      FOUND_PROPAGATION="$trace"
      break
    fi
  done
  [ -n "$FOUND_PROPAGATION" ] && break
  sleep 2
done
if [ -n "$FOUND_PROPAGATION" ]; then
  ok "propagation api→worker : trace commune ($(echo "$FOUND_PROPAGATION" | jq -r '.spanCount') spans)"
else
  bad "aucune trace commune api+worker en 60 s — contexte propagé via le payload du job ? (étape 5). Si un incident ou trafic.sh tourne encore : bash scripts/incident.sh reset"
fi

# --- 4. Span métier manuel processOrder ---
if [ -n "$FOUND_PROPAGATION" ]; then
  TID=$(echo "$FOUND_PROPAGATION" | jq -r '.traceID')
  OPS=$(curl -sf "$JAEGER_URL/api/traces/$TID" | jq -r '[.data[0].spans[].operationName] | join(" ")')
  echo "$OPS" | grep -qw processOrder && ok "span métier 'processOrder' présent" || bad "span manuel 'processOrder' absent — étape 4"
  echo "$OPS" | grep -qE 'LPUSH|redis' && ok "spans redis capturés" || bad "aucun span redis dans la trace"
  echo "$OPS" | grep -qE 'INSERT|UPDATE|postgres' && ok "spans postgres capturés" || bad "aucun span postgres dans la trace"
else
  bad "span métier 'processOrder' non vérifiable (propagation manquante)"
fi

echo
echo "Récap : $pass OK / $fail échec(s)"
if [ "$fail" -eq 0 ]; then
  echo "LEVEL 3 : VALIDÉ"
  exit 0
else
  echo "LEVEL 3 : INCOMPLET — revoir TUTORIAL.md (étapes 2, 4 et 5)."
  exit 1
fi
