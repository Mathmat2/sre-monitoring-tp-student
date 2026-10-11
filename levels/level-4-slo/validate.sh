#!/usr/bin/env bash
# Validation boîte noire — Level 4 : SLI / SLO / error budget.
# Prérequis : app + overlays L1/L2 démarrés, règles SLO chargées par les étudiants.
# Vérifie via l'API Prometheus (règles chargées = parseées, expressions = références)
# — ne lit jamais le code des étudiants.
#
# MODE=3h : séance courte. Seul le SLI MÉTIER (commandes terminées en < 10 s) et
# son alerte de brûlure rapide sont exigés ; disponibilité HTTP, SLI latence et
# alertes lentes sont hors périmètre.
set -u
export LC_ALL=C   # awk : point décimal même en locale française

API_URL="${API_URL:-http://localhost:3001}"
PROM_URL="${PROM_URL:-http://localhost:9090}"
SHORT=0
[ "${MODE:-}" = "3h" ] && SHORT=1

pass=0
fail=0
ok()  { printf '  \033[32mOK\033[0m     %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  \033[31mECHEC\033[0m %s\n' "$1"; fail=$((fail+1)); }

echo "== Level 4 : SLI / SLO / error budget =="

if ! curl -sf "$PROM_URL/-/ready" >/dev/null; then
  bad "Prometheus injoignable ($PROM_URL)"
  exit 1
fi
ok "Prometheus prêt"

# --- 1. Trafic de sonde ---
for _ in $(seq 1 5); do
  curl -s -o /dev/null -m 5 -X POST "$API_URL/orders" \
    -H 'Content-Type: application/json' -d '{"item":"sonde L4","amount":1}' || true
  sleep 1
done
ok "trafic de sonde envoyé"

sleep 3
RULES_JSON=$(curl -sf "$PROM_URL/api/v1/rules")
expr_of() { # $1 = type (recording|alerting), $2 = nom
  echo "$RULES_JSON" | jq -r --arg t "$1" --arg n "$2" '[.data.groups[].rules[] | select(.type==$t and .name==$n) | .query] | first'
}

# --- 2. Recording rules SLI chargées (et donc parseées par Prometheus) ---
RULES_TO_CHECK="sli_orders_ratio_5m sli_orders_ratio_1h"
[ "$SHORT" = 0 ] && RULES_TO_CHECK="$RULES_TO_CHECK sli_availability_ratio_5m sli_availability_ratio_1h sli_latency_ok_ratio_5m"
for rule in $RULES_TO_CHECK; do
  echo "$RULES_JSON" | jq -e --arg r "$rule" '[.data.groups[].rules[] | select(.type=="recording" and .name==$r)] | length > 0' >/dev/null 2>&1 \
    && ok "recording rule $rule chargée" || bad "recording rule $rule absente — prometheus/rules/slo.yml"
done

# --- 3. Les expressions des SLI référencent les bonnes métriques sources ---
ORD_EXPR=$(expr_of recording sli_orders_ratio_5m)
if echo "$ORD_EXPR" | grep -q 'order_processing_seconds_bucket' && echo "$ORD_EXPR" | grep -q 'le="10"' && echo "$ORD_EXPR" | grep -q 'orders_total'; then
  ok "SLI commandes : numérateur = commandes terminées en < 10 s (order_processing_seconds_bucket{le=\"10\"})"
else
  bad "le SLI commandes doit rapporter order_processing_seconds_bucket{le=\"10\"} à orders_total ($ORD_EXPR)"
fi
if echo "$ORD_EXPR" | grep -q 'status="created"'; then
  ok "SLI commandes : dénominateur = commandes CRÉÉES (orders_total{status=\"created\"})"
else
  bad "dénominateur du SLI commandes : utilisez les commandes créées (status=\"created\"), pas completed/failed — un job perdu n'est ni l'un ni l'autre et disparaîtrait du ratio ($ORD_EXPR)"
fi

if [ "$SHORT" = 0 ]; then
  AVAIL_EXPR=$(expr_of recording sli_availability_ratio_5m)
  if echo "$AVAIL_EXPR" | grep -q 'http_requests_total' && echo "$AVAIL_EXPR" | grep -qE 'status[!]?~"5\.\."'; then
    ok "SLI disponibilité basé sur http_requests_total (5xx exclus du numérateur)"
  else
    bad "l'expression du SLI disponibilité ne référence pas http_requests_total / les 5xx ($AVAIL_EXPR)"
  fi
  LAT_EXPR=$(expr_of recording sli_latency_ok_ratio_5m)
  if echo "$LAT_EXPR" | grep -q 'http_request_duration_seconds_bucket' && echo "$LAT_EXPR" | grep -q 'le="0.3"'; then
    ok "SLI latence basé sur l'histogramme (bucket le=\"0.3\")"
  else
    bad "l'expression du SLI latence ne référence pas le bucket le=\"0.3\" ($LAT_EXPR)"
  fi
fi

# --- 4. Valeurs de SLI calculées (les recording rules s'évaluent toutes les 15 s) ---
check_value() { # $1 = nom de la série, $2 = libellé
  local v=""
  for _ in $(seq 1 8); do
    v=$(curl -sf -G "$PROM_URL/api/v1/query" --data-urlencode "query=$1" | jq -r '.data.result[0].value[1] // empty')
    [ -n "$v" ] && break
    sleep 5
  done
  if [ -n "$v" ] && [ "$v" != "NaN" ]; then
    ok "$2 calculé : $v"
    awk -v v="$v" 'BEGIN { if (v < 0 || v > 1) exit 1 }' \
      && ok "valeur de $1 dans [0,1]" || bad "valeur de $1 hors [0,1] ($v)"
  else
    bad "$1 jamais calculée (règle chargée mais série absente — trafic, métriques L2 ou expression ?)"
  fi
}
check_value sli_orders_ratio_5m "SLI commandes"
[ "$SHORT" = 0 ] && check_value sli_availability_ratio_5m "SLI disponibilité"

# --- 5. Alertes burn-rate présentes avec les deux fenêtres ---
ALERTS_TO_CHECK="SLOOrdersBurnFast"
[ "$SHORT" = 0 ] && ALERTS_TO_CHECK="SLOOrdersBurnFast SLOOrdersBurnSlow SLOAvailabilityBurnFast SLOAvailabilityBurnSlow"
for alert in $ALERTS_TO_CHECK; do
  E=$(expr_of alerting "$alert")
  if [ -n "$E" ] && [ "$E" != "null" ]; then
    ok "alerte $alert chargée"
    echo "$E" | grep -qE '0\.005|0\.072' && ok "$alert exprime le budget d'erreur du SLO 99.5 % (0.005, ou le seuil 14.4×0.005 = 0.072)" || bad "$alert sans budget 0.005 (ni seuil 0.072) dans l'expression"
    case "$alert" in
      *Fast) echo "$E" | grep -q '5m' && echo "$E" | grep -q '1h' && ok "$alert multi-fenêtres (5m ET 1h)" || bad "$alert n'utilise pas les deux fenêtres 5m + 1h" ;;
      *Slow) echo "$E" | grep -q '6h' && echo "$E" | grep -q '3d' && ok "$alert multi-fenêtres (6h ET 3d)" || bad "$alert n'utilise pas les fenêtres 6h + 3d" ;;
    esac
  else
    bad "alerte $alert absente — prometheus/rules/slo.yml"
  fi
done

echo
echo "Récap : $pass OK / $fail échec(s)"
if [ "$fail" -eq 0 ]; then
  echo "LEVEL 4 : VALIDÉ (le postmortem est gradé manuellement)"
  exit 0
else
  echo "LEVEL 4 : INCOMPLET — revoir TUTORIAL.md (étapes 1 à 3) et docs/MULTI_BURN_RATE_ALERTING.md."
  exit 1
fi
