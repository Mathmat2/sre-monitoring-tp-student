#!/usr/bin/env bash
# Validation boîte noire — Level 2 : métriques Prometheus + règles d'alerte.
# Prérequis : app + overlays L1 et L2 démarrés :
#   docker compose -f docker-compose.yml -f docker-compose.l1.yml -f docker-compose.l2.yml up -d --build
# Vérifie le COMPORTEMENT via l'API HTTP de Prometheus — ne lit jamais le code.
set -u
export LC_ALL=C   # awk : point décimal même en locale française

API_URL="${API_URL:-http://localhost:3001}"
PROM_URL="${PROM_URL:-http://localhost:9090}"
CHAOS_URL="${CHAOS_URL:-http://localhost:4000}"

pass=0
fail=0
ok()  { printf '  \033[32mOK\033[0m     %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  \033[31mECHEC\033[0m %s\n' "$1"; fail=$((fail+1)); }

# fsum <sélecteur> : somme des séries dont le DERNIER échantillon a moins de 30 s.
# Prometheus renvoie sinon une série « périmée » pendant 5 min (processus remplacé,
# bug corrigé depuis) : sans ce filtre, un ancien run ferait mentir la validation.
fsum() {
  curl -sG "$PROM_URL/api/v1/query" \
    --data-urlencode "query=sum($1 and on() (time() - max(timestamp($1)) < 30)) or vector(0)" \
    | jq -r '.data.result[0].value[1] // "0"'
}

echo "== Level 2 : métriques & alerting =="

# --- 0. Pré-requis ---
if ! curl -sf "$PROM_URL/-/ready" >/dev/null; then
  bad "Prometheus injoignable ($PROM_URL) — overlays L1+L2 démarrés ?"
  echo "Démarrez : docker compose -f docker-compose.yml -f docker-compose.l1.yml -f docker-compose.l2.yml up -d --build"
  exit 1
fi
ok "Prometheus prêt"

# --- 1. Générer du trafic pour alimenter les métriques ---
for _ in $(seq 1 5); do
  curl -s -m 5 -o /tmp/tp_l2_order.json -X POST "$API_URL/orders" \
    -H 'Content-Type: application/json' -d '{"item":"sonde L2","amount":1}' || true
  ORDER_ID=$(jq -r '.id // empty' /tmp/tp_l2_order.json 2>/dev/null || true)
  if [ -n "$ORDER_ID" ]; then
    curl -s -o /dev/null -m 5 "$API_URL/orders/$ORDER_ID" || true
  fi
  curl -s -o /dev/null -m 5 "$API_URL/orders" || true
  sleep 1
done
ok "trafic de sonde envoyé (POST /orders + GET /orders/:id)"

# --- 2. Targets UP (api + worker) ---
TARGETS=$(curl -sf "$PROM_URL/api/v1/targets" | jq -r '
  [.data.activeTargets[] | select(.health=="up") | .labels.job] | unique | join(" ")')
echo "$TARGETS" | grep -qw api && ok "target api UP" || bad "target api absente ou DOWN ($TARGETS)"
echo "$TARGETS" | grep -qw worker && ok "target worker UP" || bad "target worker absente ou DOWN — /metrics exposé sur :3002 et job décommenté ?"

# --- 3. Métriques attendues présentes ---
sleep 3
NAMES=$(curl -sf "$PROM_URL/api/v1/label/__name__/values" | jq -r '.data | join(" ")')
# NB : les histograms n'exposent que les séries suffixées (_bucket/_sum/_count) —
# on vérifie donc les noms réellement stockés par Prometheus.
for metric in http_requests_total http_request_duration_seconds_bucket db_pool_active db_pool_idle db_pool_waiting redis_queue_depth orders_total order_processing_seconds_bucket orders_in_flight orders_oldest_pending_seconds; do
  echo "$NAMES" | grep -qw "$metric" && ok "métrique $metric présente" || bad "métrique $metric absente de Prometheus"
done

# --- 3b. Métriques MÉTIER : les commandes sont créées ET terminées ---
CREATED=$(fsum 'orders_total{status="created",service="api"}')
COMPLETED=$(fsum 'orders_total{status="completed",service="worker"}')
awk -v v="$CREATED" 'BEGIN { exit !(v >= 1) }' && ok "orders_total{status=\"created\"} incrémenté par l'api ($(printf '%.0f' "$CREATED"))" || bad "orders_total{status=\"created\",service=\"api\"} reste à 0 — « created » se compte dans POST /orders (api), pas dans le worker (étape 4b)"
awk -v v="$COMPLETED" 'BEGIN { exit !(v >= 1) }' && ok "orders_total{status=\"completed\"} incrémenté par le worker ($(printf '%.0f' "$COMPLETED"))" || bad "orders_total{status=\"completed\"} reste à 0 — incrémenter dans le worker (étape 4b)"

# --- 4. Les métriques portent les labels attendus (route pattern, pas URL brute) ---
SAMPLE=$(fsum 'http_requests_total{route="/orders/:id"}')
awk -v v="$SAMPLE" 'BEGIN { exit !(v > 0) }' && ok "label route au format pattern (/orders/:id)" || bad "aucune série avec route=\"/orders/:id\" — cardinalité des labels à vérifier (URLs brutes ?)"
CARD=$(curl -sfG "$PROM_URL/api/v1/series" --data-urlencode 'match[]={__name__="http_requests_total"}' --data-urlencode "start=$(( $(date +%s) - 120 ))" | jq -r '.data | length')
[ "$CARD" -lt 100 ] && ok "cardinalité raisonnable ($CARD séries)" || bad "cardinalité élevée ($CARD séries) — probablement des IDs dans les labels"

# --- 4b. Chemin d'échec : un job en erreur est compté « failed », jamais « completed » ---
if curl -sf -m 5 "$CHAOS_URL/chaos/status" >/dev/null; then
  sleep 6   # laisse finir les commandes de sonde précédentes
  C0=$(fsum 'orders_total{status="completed"}'); F0=$(fsum 'orders_total{status="failed"}')
  curl -s -m 5 -X POST "$CHAOS_URL/chaos/error-rate" -H 'Content-Type: application/json' -d '{"target":"worker","rate":1}' >/dev/null
  for _ in 1 2 3; do curl -s -m 5 -o /dev/null -X POST "$API_URL/orders" -H 'Content-Type: application/json' -d '{"item":"sonde échec","amount":1}'; done
  # On attend (30 s max) que Prometheus ait scrapé les échecs, au lieu d'un sleep fixe :
  # juste après un redémarrage, le premier scrape peut tarder.
  F1="$F0"
  for _ in $(seq 1 15); do
    sleep 2
    F1=$(fsum 'orders_total{status="failed"}')
    awk -v a="$F0" -v b="$F1" 'BEGIN { exit !(b - a >= 3) }' && break
  done
  curl -s -m 5 -X POST "$CHAOS_URL/chaos/reset" >/dev/null
  sleep 6
  C1=$(fsum 'orders_total{status="completed"}'); F1=$(fsum 'orders_total{status="failed"}')
  awk -v a="$F0" -v b="$F1" 'BEGIN { exit !(b - a >= 1) }' && ok "jobs en erreur comptés orders_total{status=\"failed\"} (+$(awk -v a="$F0" -v b="$F1" 'BEGIN{print b-a}'))" || bad "des jobs en erreur injectée ne sont pas comptés « failed » (étape 4b : incrémenter dans le catch)"
  awk -v a="$C0" -v b="$C1" 'BEGIN { exit !(b - a < 1) }' && ok "aucun job en erreur n'est compté « completed »" || bad "des jobs en ERREUR sont comptés « completed » (+$(awk -v a="$C0" -v b="$C1" 'BEGIN{print b-a}')) : incrémentez après le traitement réussi, pas avant"
else
  bad "chaos-injector injoignable ($CHAOS_URL) : impossible de tester le chemin d'échec"
fi

# --- 5. Règles d'alerte chargées ---
RULES=$(curl -sf "$PROM_URL/api/v1/rules" | jq -r '[.data.groups[].rules[] | select(.type=="alerting") | .name] | join(" ")')
echo "$RULES" | grep -qw ErrorRateTooHigh && ok "alerte ErrorRateTooHigh chargée" || bad "alerte ErrorRateTooHigh absente (prometheus/rules/)"
echo "$RULES" | grep -qw P99LatencyTooHigh && ok "alerte P99LatencyTooHigh chargée" || bad "alerte P99LatencyTooHigh absente (prometheus/rules/)"

# --- 6. Alertmanager câblé dans Prometheus ---
AM=$(curl -sf "$PROM_URL/api/v1/alertmanagers" | jq -r '[.data.activeAlertmanagers[].url] | join(" ")')
echo "$AM" | grep -q alertmanager && ok "Alertmanager découvert par Prometheus" || bad "Alertmanager non découvert ($AM)"

echo
echo "Récap : $pass OK / $fail échec(s)"
if [ "$fail" -eq 0 ]; then
  echo "LEVEL 2 : VALIDÉ"
  exit 0
else
  echo "LEVEL 2 : INCOMPLET — revoir TUTORIAL.md (étapes 2 à 7)."
  exit 1
fi
