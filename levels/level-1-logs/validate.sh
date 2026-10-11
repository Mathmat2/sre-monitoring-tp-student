#!/usr/bin/env bash
# Validation boîte noire — Level 1 : logs structurés + corrélation.
# Prérequis : app + overlay L1 démarrés :
#   docker compose -f docker-compose.yml -f docker-compose.l1.yml up -d --build
# Vérifie le COMPORTEMENT via l'API de l'app et de Loki — ne lit jamais le code.
set -u

API_URL="${API_URL:-http://localhost:3001}"
LOKI_URL="${LOKI_URL:-http://localhost:3100}"

pass=0
fail=0
ok()  { printf '  \033[32mOK\033[0m     %s\n' "$1"; pass=$((pass+1)); }
bad() { printf '  \033[31mECHEC\033[0m %s\n' "$1"; fail=$((fail+1)); }

loki_query() { # $1 = requête LogQL -> lignes sur stdout
  curl -sG "$LOKI_URL/loki/api/v1/query_range" \
    --data-urlencode "query=$1" \
    --data-urlencode 'since=15m' \
    --data-urlencode 'limit=5000' \
    | jq -r '.data.result[]?.values[]?.[1]'
}

echo "== Level 1 : logs structurés & corrélation =="

# 0. App en vie
if ! curl -sf "$API_URL/health" >/dev/null; then
  bad "api injoignable ($API_URL) — démarrez app + overlay L1"
  exit 1
fi
ok "api joignable"

# 1. Créer une commande avec un request ID connu
REQ_ID="tp-l1-$(date +%s)-$RANDOM"
HEADERS_FILE=$(mktemp)
HTTP_CODE=$(curl -s -o /tmp/tp_l1_order.json -D "$HEADERS_FILE" -w '%{http_code}' \
  -X POST "$API_URL/orders" \
  -H 'Content-Type: application/json' -H "x-request-id: $REQ_ID" \
  -d '{"item":"sonde validation level 1","amount":42}')
if [ "$HTTP_CODE" = "202" ]; then
  ok "POST /orders => 202"
else
  bad "POST /orders => $HTTP_CODE (attendu 202)"
  exit 1
fi

ORDER_ID=$(jq -r '.id // empty' /tmp/tp_l1_order.json)
if [ -z "$ORDER_ID" ]; then
  bad "réponse POST /orders sans id — l'application tourne-t-elle ?"
  exit 1
fi

# 2. En-tête x-request-id renvoyé par l'api ? (propagation)
if grep -qi "x-request-id: $REQ_ID" "$HEADERS_FILE"; then
  ok "x-request-id renvoyé dans la réponse"
else
  bad "x-request-id absent des en-têtes de réponse"
fi

# 3. Log api : JSON structuré avec le requestId ?
API_LINE=""
for _ in $(seq 1 10); do
  API_LINE=$(loki_query '{container=~".*api.*"}' \
    | grep -F '"service":"api"' \
    | grep -F "\"requestId\":\"$REQ_ID\"" \
    | head -n1)
  [ -n "$API_LINE" ] && break
  sleep 2
done
if [ -n "$API_LINE" ]; then
  ok "api : log JSON corrélé au requestId $REQ_ID"
  if echo "$API_LINE" | jq -e 'has("level") and has("time") and (.service == "api")' >/dev/null 2>&1; then
    ok "champs structurés présents (level, time, service)"
  else
    bad "le log api n'est pas du JSON structuré attendu"
  fi
else
  bad "aucune ligne api corrélée au requestId $REQ_ID"
fi

# 4. Le worker parle-t-il de la même commande ?
WORKER_LINE=""
for _ in $(seq 1 15); do
  WORKER_LINE=$(loki_query '{container=~".*worker.*"}' | grep -F "\"orderId\":$ORDER_ID" | head -n1)
  [ -n "$WORKER_LINE" ] && break
  sleep 2
done
if [ -n "$WORKER_LINE" ]; then
  ok "worker : traitement corrélé au même flux (orderId=$ORDER_ID)"
else
  bad "worker : aucune ligne corrélée à l'orderId $ORDER_ID (ID propagé via le payload du job ?)"
fi

echo
echo "Récap : $pass OK / $fail échec(s)"
if [ "$fail" -eq 0 ]; then
  echo "LEVEL 1 : VALIDÉ"
  exit 0
else
  echo "LEVEL 1 : INCOMPLET — revoir TUTORIAL.md (étapes 2 à 5)."
  exit 1
fi
