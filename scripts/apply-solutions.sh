#!/usr/bin/env bash
# apply-solutions.sh — plan B : copie la solution de référence d'un niveau dans l'arbre.
# Usage : bash scripts/apply-solutions.sh <2|3|4|5>
#   - L3 : prévue pour être appliquée telle quelle (démo du tracing), sans confirmation.
#   - L2/L4/L5 : solution complète. À réserver au plan B (temps dépassé) ; la demande
#     est tracée dans .solutions-used.log et un niveau « rattrapé » perd ses points de code.
# Vos fichiers écrasés sont sauvegardés dans .student-backup/<horodatage>/.
# NB : la solution L3 est cumulative (elle contient les métriques L2) : l'appliquer
# remplace votre travail L2 sur ces fichiers. Validez L2 AVANT.
set -euo pipefail
cd "$(dirname "$0")/.."

[ "$#" -eq 1 ] || { echo "usage: $0 <niveau 2|3|4|5>" >&2; exit 1; }
n=$1
dir=$(ls -d .solutions/level-"$n"-* 2>/dev/null | head -1 || true)
[ -n "$dir" ] || { echo "pas de solution pour le niveau $n (L1 est déjà fourni)" >&2; exit 1; }

if [ "$n" != "3" ]; then
  echo "Vous allez appliquer la SOLUTION COMPLÈTE du niveau $n (plan B)."
  echo "Un niveau rattrapé perd ses points de code. Essayez d'abord les indices du TUTORIAL."
  if [ "${FORCE:-}" != "1" ]; then
    printf "Tapez « oui » pour continuer : "; read -r a
    [ "$a" = "oui" ] || { echo "abandon."; exit 1; }
  fi
  echo "$(date -u +%FT%TZ) niveau $n" >> .solutions-used.log
fi

STAMP=$(date +%Y%m%d-%H%M%S)
BACKUP=".student-backup/$STAMP"
echo "── niveau $n ← $dir"
while IFS= read -r -d '' src; do
  rel=${src#"$dir"/}
  if [ -f "$rel" ] && ! cmp -s "$src" "$rel"; then
    mkdir -p "$BACKUP/$(dirname "$rel")"; cp "$rel" "$BACKUP/$rel"; echo "   sauvegardé : $rel"
  fi
  mkdir -p "$(dirname "$rel")"; cp "$src" "$rel"; echo "   copié      : $rel"
done < <(find "$dir" -type f -print0)
[ -d "$BACKUP" ] && echo "Sauvegarde de vos fichiers : $BACKUP"
echo "Relancez les services concernés : make up-l<N> (reconstruit les images)."
