#!/usr/bin/env bash
# check-env.sh — vérifie que la machine peut faire tourner le TP.
ok=1
chk() { if eval "$2" >/dev/null 2>&1; then echo "  OK     $1"; else echo "  ÉCHEC  $1 — $3"; ok=0; fi; }
chk "docker installé et démarré" "docker info" "lancez Docker Desktop / le démon Docker"
chk "docker compose v2" "docker compose version" "installez le plugin Compose v2"
chk "curl" "command -v curl" "installez curl"
chk "jq (validateurs)" "command -v jq" "brew install jq / apt install jq"
chk "bash 3.2+" "bash --version" "bash requis"
for p in 3000 3001 3002 4000 5001 5002 9090 9093 3100 16686; do
  if (command -v lsof >/dev/null && lsof -iTCP:$p -sTCP:LISTEN >/dev/null 2>&1); then
    echo "  ATTENTION port $p déjà utilisé (sauf si c'est ce TP déjà lancé)"
  fi
done
[ "$ok" = 1 ] && echo "Environnement prêt." || { echo "Corrigez les ÉCHEC ci-dessus."; exit 1; }
