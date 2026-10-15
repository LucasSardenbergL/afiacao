#!/usr/bin/env bash
# Gera fatos.json (psql-ro, read-only) e retrato.json (node). Saída em $RAIOX_OUT.
set -euo pipefail
DIR="$(cd "$(dirname "$0")" && pwd)"
OUT="${RAIOX_OUT:?defina RAIOX_OUT (diretório fora do repo ou ignorado)}"
mkdir -p "$OUT"
RAW="$OUT/fatos.raw.txt"
~/.config/afiacao/psql-ro -At -F'|' -v ON_ERROR_STOP=1 -f "$DIR/fatos.sql" > "$RAW" 2>&1 || { echo "psql falhou:"; head -c 2000 "$RAW"; exit 1; }
grep -q '^fim|ok$' "$RAW" || { echo "sem marcador fim|ok:"; head -c 2000 "$RAW"; exit 1; }
grep '^json|' "$RAW" | sed 's/^json|//' > "$OUT/fatos.json"
[ -s "$OUT/fatos.json" ] || { echo "fatos.json vazio"; exit 1; }
node "$DIR/gerar.mjs" "$OUT/fatos.json" "$OUT/retrato.json" "$@"
