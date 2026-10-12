#!/usr/bin/env bash
# validate.sh — niveau 5 : auto-remédiation
# Prérequis : niveaux L1 et L2 APPLIQUÉS (le contrôleur lit redis_queue_depth
# depuis Prometheus — sans les métriques worker, la règle 2 ne peut pas fire).
# Usage : bash levels/level-5-automation/validate.sh
set -uo pipefail
cd "$(dirname "$0")/../.."

PASS=0; FAIL=0
ok()   { echo -e "  \033[32mOK\033[0m     $1"; PASS=$((PASS+1)); }
fail() { echo -e "  \033[31mÉCHEC\033[0m $1"; FAIL=$((FAIL+1)); }

CTRL=http://localhost:5002
CHAOS=http://localhost:4000

echo "── 1. Prérequis ─────────────────────────────────────────────"
curl -s -m 5 "$CTRL/health" | jq -e '.ok == true' >/dev/null 2>&1 \
  && ok "contrôleur d'automation en ligne (:5002)" \
  || fail "contrôleur injoignable — stack l5 lancée ? (docker compose -f ... -f docker-compose.l5.yml up -d --build)"
curl -s -m 5 "$CHAOS/chaos/status" | jq -e 'has("faults")' >/dev/null 2>&1 \
  && ok "chaos-injector en ligne" \
  || fail "chaos-injector injoignable"
curl -s -m 5 "http://localhost:9090/api/v1/query?query=up" | jq -e '.status=="success"' >/dev/null 2>&1 \
  && ok "Prometheus API en ligne" \
  || fail "Prometheus injoignable"
curl -s -m 5 "http://localhost:9090/api/v1/query?query=redis_queue_depth" \
  | jq -e '.data.result | length > 0' >/dev/null 2>&1 \
  && ok "métrique redis_queue_depth présente (L2)" \
  || fail "redis_queue_depth absente — appliquez la solution L2 (worker /metrics) avant de valider le L5"

echo "── 2. Règle 1 : api crashée → restart + escalade ────────────"
BEFORE=$(curl -s -m 5 "$CTRL/actions" | jq '.actions | length')
curl -s -m 8 -X POST "$CHAOS/chaos/kill" -H 'Content-Type: application/json' \
  -d '{"target":"api"}' >/dev/null 2>&1
echo "     api tuée — observation du contrôleur (45 s max)..."
STARTED=0
for _ in $(seq 1 15); do
  if curl -s -m 5 "$CTRL/actions" | jq -e --argjson b "$BEFORE" \
    '[.actions[$b:][] | select((.action.type=="start" or .action.type=="restart") and .action.service=="api" and .result.ok==true)] | length > 0' \
    >/dev/null 2>&1; then STARTED=1; break; fi
  sleep 3
done
[ "$STARTED" = 1 ] && ok "redémarrage automatique de l'api (action 'start' ou 'restart' auditée)" \
  || fail "aucun 'start'/'restart' sur l'api en 45 s — règle 1 non implémentée dans rules.js"
API_UP=0
for _ in $(seq 1 10); do
  curl -s -m 5 http://localhost:3001/health | jq -e '.ok' >/dev/null 2>&1 && { API_UP=1; break; }
  sleep 3
done
[ "$API_UP" = 1 ] && ok "l'api répond à nouveau" \
  || fail "l'api ne répond pas après redémarrage"
sleep 6   # laisse le contrôleur re-poller une fois l'état 'running'
curl -s -m 8 -X POST "$CHAOS/chaos/kill" -H 'Content-Type: application/json' \
  -d '{"target":"api"}' >/dev/null 2>&1
echo "     api re-tuée (crash-loop) — attente de l'escalade (45 s max)..."
PAGED=0
for _ in $(seq 1 15); do
  if curl -s -m 5 "$CTRL/actions" | jq -e --argjson b "$BEFORE" \
    '[.actions[$b:][] | select(.action.type=="page" and .result.ok==true)] | length > 0' \
    >/dev/null 2>&1; then PAGED=1; break; fi
  sleep 3
done
[ "$PAGED" = 1 ] && ok "crash-loop détecté → escalade humaine (action 'page')" \
  || fail "pas de 'page' au 2e crash — logique CRASH_ESCALATION_MS absente"
for _ in $(seq 1 15); do
  curl -s -m 5 http://localhost:3001/health | jq -e '.ok' >/dev/null 2>&1 && break
  sleep 3
done

if [ "${MODE:-}" = "3h" ]; then
  echo "── 3. Règle 2 : ignorée (MODE=3h, règle fournie) ────────────"
else
echo "── 3. Règle 2 : queue saturée → scale workers ───────────────"
BEFORE=$(curl -s -m 5 "$CTRL/actions" | jq '.actions | length')
# Sans fault, le worker traite ~2,7 cmd/s : une salve courte se vide trop vite pour
# dépasser le seuil de façon soutenue — comme en production, la saturation
# vient d'une dépendance ralentie. On injecte donc une latence SQL.
curl -s -m 5 -X POST "$CHAOS/chaos/dep-slow" -H 'Content-Type: application/json' \
  -d '{"dependency":"postgres","ms":400}' >/dev/null 2>&1
echo "     latence SQL 400 ms injectée + salve de 60 commandes..."
for i in $(seq 1 60); do
  curl -s -m 5 -o /dev/null -X POST http://localhost:3001/orders \
    -H 'Content-Type: application/json' -d '{"item":"l5 validate","amount":1}' &
done
wait 2>/dev/null
echo "     observation (120 s max)..."
SCALED=0
for _ in $(seq 1 40); do
  if curl -s -m 5 "$CTRL/actions" | jq -e --argjson b "$BEFORE" \
    '[.actions[$b:][] | select(.action.type=="scale" and .action.replicas>=3)] | length > 0' \
    >/dev/null 2>&1; then SCALED=1; break; fi
  sleep 3
done
curl -s -m 5 -X POST "$CHAOS/chaos/reset" >/dev/null 2>&1
[ "$SCALED" = 1 ] && ok "scale déclenché par la profondeur de queue (action 'scale')" \
  || fail "pas de 'scale' en 120 s — règle 2 non implémentée (ou seuil non atteint)"
WORKERS=$(docker ps --filter 'label=com.docker.compose.service=worker' \
  --filter 'status=running' -q 2>/dev/null | wc -l | tr -d ' ')
if [ "${WORKERS:-0}" -ge 3 ]; then
  ok "3 workers en circulation (réplicas clonés)"
else
  fail "seulement $WORKERS worker(s) actif(s) — le clonage a échoué (voir logs automation-controller)"
fi

fi

if [ "${MODE:-}" != "3h" ]; then
echo "── 3a. Lenteur ≠ perte : aucune fausse alerte « commandes bloquées » ─"
# Une file qui grossit parce que Postgres est lent n'est PAS une perte de jobs :
# les commandes attendent depuis longtemps, mais la queue est pleine. La règle 3
# ne doit paginer que si la queue est vide (jobs perdus), jamais ici.
BEFORE=$(curl -s -m 5 "$CTRL/actions" | jq '.actions | length')
curl -s -m 5 -X POST "$CHAOS/chaos/dep-slow" -H 'Content-Type: application/json' \
  -d '{"dependency":"postgres","ms":2000}' >/dev/null 2>&1
seq 1 150 | xargs -P 10 -I{} curl -s -m 20 -o /dev/null -X POST http://localhost:3001/orders \
  -H 'Content-Type: application/json' -d '{"item":"l5 lenteur","amount":1}'
echo "     Postgres ralenti (2 s) + 150 commandes — observation (120 s) : la règle 3 doit rester silencieuse..."
FALSEPAGE=0
for _ in $(seq 1 40); do
  if curl -s -m 5 "$CTRL/actions" | jq -e --argjson b "$BEFORE" \
    '[.actions[$b:][] | select(.action.type=="page" and .result.ok==true and (.action.message | test("commandes")))] | length > 0' \
    >/dev/null 2>&1; then FALSEPAGE=1; break; fi
  sleep 3
done
curl -s -m 5 -X POST "$CHAOS/chaos/reset" >/dev/null 2>&1
[ "$FALSEPAGE" = 0 ] && ok "lenteur sans perte : pas de fausse page « commandes bloquées » (file non vide)" \
  || fail "fausse page « commandes bloquées » pendant une simple lenteur : la règle 3 doit exiger une queue VIDE (QUEUE_IDLE_DEPTH)"
echo "     attente du retour à la normale (queue vidée, 150 s max)..."
for _ in $(seq 1 50); do
  D=$(curl -s -m 5 -G "http://localhost:9090/api/v1/query" --data-urlencode 'query=max(redis_queue_depth)' | jq -r '.data.result[0].value[1] // "0"')
  awk -v d="$D" 'BEGIN { exit !(d <= 1) }' && break
  sleep 3
done
sleep 45   # laisse retomber orders_oldest_pending_seconds avant le test de perte
fi

# --- Hygiène : le test de la règle 3 ne doit dépendre ni des niveaux précédents ni d'un essai raté ---
# Commandes laissées « pending » (perte L4, validate précédent...) : marquées « abandoned »,
# sans toucher aux autres données.
abandon_pending() {
  local pg
  pg=$(docker ps -q --filter 'label=com.docker.compose.service=postgres' | head -1)
  [ -n "$pg" ] && docker exec "$pg" psql -U app orders_db -qc \
    "UPDATE orders SET status='abandoned', error='validate-l5: nettoyage', updated_at=now() WHERE status IN ('pending','processing')" \
    >/dev/null 2>&1
}
echo "── 3b. Règle 3 : commandes bloquées (signal applicatif) ─────"
# Panne invisible pour l'infra : le worker acquitte les jobs sans les traiter.
# HTTP reste en 202, la queue reste vide, les conteneurs sont « running » :
# seule la métrique MÉTIER orders_oldest_pending_seconds le montre.
# Chaque règle est jugée indépendamment : si la règle 1 est absente ou cassée,
# l'api tuée plus haut est restée à l'arrêt — on la relance ici pour ne pas
# faire échouer la règle 3 à cause de la règle 1.
if ! curl -s -m 5 http://localhost:3001/health | jq -e '.ok' >/dev/null 2>&1; then
  echo "     api toujours arrêtée : relancée par le validateur (règle 1 non validée plus haut)"
  docker ps -a -q --filter 'label=com.docker.compose.service=api' | xargs docker start >/dev/null 2>&1
  for _ in $(seq 1 15); do
    curl -s -m 5 http://localhost:3001/health | jq -e '.ok' >/dev/null 2>&1 && break
    sleep 3
  done
fi
abandon_pending
# La règle 3 ne repagine pas pendant ORDERS_PAGE_DEDUP_MS (5 min) : si une page « commandes bloquées »
# est récente (niveau précédent, essai précédent), la page du test serait masquée -> on attend.
LAST_AGE=$(curl -s -m 5 "$CTRL/actions" | jq -r '
  [.actions[] | select(.action.type=="page" and ((.action.message // "") | startswith("commandes bloqu")))
   | (.at | sub("\\.[0-9]+Z$";"Z") | fromdateiso8601)] | max // 0 | (now - .) | floor')
if [ "${LAST_AGE:-9999}" -lt 305 ] 2>/dev/null; then
  WAIT=$((305 - LAST_AGE))
  echo "     page « commandes bloquées » émise il y a ${LAST_AGE} s : attente de ${WAIT} s (dédup de 5 min du contrôleur)..."
  sleep "$WAIT"
fi
sleep 8   # laisse les gauges (rafraîchies toutes les 2 s) et Prometheus refléter le nettoyage
BEFORE=$(curl -s -m 5 "$CTRL/actions" | jq '.actions | length')
curl -s -m 5 -X POST "$CHAOS/chaos/job-drop" -H 'Content-Type: application/json' \
  -d '{"target":"worker","rate":1}' >/dev/null 2>&1
for _ in $(seq 1 6); do
  curl -s -m 5 -o /dev/null -X POST http://localhost:3001/orders \
    -H 'Content-Type: application/json' -d '{"item":"l5 jobs perdus","amount":1}'
done
echo "     jobs perdus en silence + 6 commandes — observation (150 s max)..."
BLOCKED=0
for _ in $(seq 1 50); do
  if curl -s -m 5 "$CTRL/actions" | jq -e --argjson b "$BEFORE" \
    '[.actions[$b:][] | select(.action.type=="page" and .result.ok==true and (.action.message | test("commandes")))] | length > 0' \
    >/dev/null 2>&1; then BLOCKED=1; break; fi
  sleep 3
done
curl -s -m 5 -X POST "$CHAOS/chaos/reset" >/dev/null 2>&1
# nettoyage : ne pas laisser nos commandes perdues fausser la suite (capstone : make surprise)
abandon_pending
[ "$BLOCKED" = 1 ] && ok "commandes bloquées détectées → escalade humaine (action 'page')" \
  || fail "pas de 'page' sur commandes bloquées en 150 s — règle 3 absente ou modifiée (orders_oldest_pending_seconds + queue vide) ; vérifiez aussi /actions : une page « commandes bloquées » de moins de 5 min masque la suivante"

echo "── 4. Piste d'audit ─────────────────────────────────────────"
curl -s -m 5 "$CTRL/actions" | jq -e \
  '[.actions[] | select(.result != null)] | length >= 3' >/dev/null 2>&1 \
  && ok "/actions expose une piste d'audit complète" \
  || fail "piste d'audit trop maigre"

echo ""
echo "Récap : $PASS OK / $FAIL échec(s)"
if [ "$FAIL" = 0 ]; then
  echo "LEVEL 5 : VALIDÉ (le circuit breaker est vérifié par revue de code — étape 3 du TUTORIAL)"
else
  echo "LEVEL 5 : à corriger"
fi
exit "$FAIL"
