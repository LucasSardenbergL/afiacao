#!/usr/bin/env bash
# test-lovable-recibos.sh — TDD do scripts/lovable-recibos.sh (repo git descartável + psql-ro FALSO).
#
# O psql falso responde às 3 consultas do script a partir de $F: `ledger` (linhas "<sha> <estados>"),
# `adiadas` (SHAs adiados não revogados), `sem_tabela` (db_migracoes_adiadas ainda não existe) e
# `cai` (o psql falha). Falsificação com CONTROLE verde na mesma invocação: a cópia que trata
# `tentativa` como sem recibo tem de reprovar o cenário desconhecido.
# Uso: bash scripts/test-lovable-recibos.sh   (exit 0 = tudo verde)
set -u
here="$(cd "$(dirname "$0")" && pwd)"
ALVO="$here/lovable-recibos.sh"
base="$(mktemp -d)"; trap 'rm -rf "$base"' EXIT
F="$base/f"; mkdir -p "$F"; fail=0

cat > "$base/psql" <<'FAKE'
#!/usr/bin/env bash
F="$LR_FAKE"; q=""
while [ $# -gt 0 ]; do case "$1" in -c) q="$2"; shift ;; esac; shift; done
[ -f "$F/cai" ] && { echo "psql: conexão recusada" >&2; exit 2; }
case "$q" in
  *unnest*) for s in $(printf '%s' "$q" | grep -oE "'[0-9a-f]{64}'" | tr -d "'"); do
              e=$(awk -v s="$s" '$1 == s { print $2 }' "$F/ledger" 2>/dev/null); echo "$s ${e:--}"; done ;;
  *to_regclass*) if [ -f "$F/sem_tabela" ]; then echo f; else echo t; fi ;;
  *db_migracoes_adiadas*) cat "$F/adiadas" 2>/dev/null; true ;;
  *) exit 3 ;;
esac
FAKE
chmod +x "$base/psql"

cd "$base" && git init -q -b main r && cd r || exit 1
git config user.email t@t && git config user.name t
c() { mkdir -p "$(dirname "$1")"; echo "$RANDOM$2" >> "$1"; git add -A; git commit -qm "$2"; git rev-parse HEAD; }
A=$(c src/a.ts a); M1=$(c supabase/migrations/1_a.sql m1); M2=$(c supabase/migrations/2_b.sql m2)
S1=$(git show "$M2:supabase/migrations/1_a.sql" | shasum -a 256 | cut -c1-64)
S2=$(git show "$M2:supabase/migrations/2_b.sql" | shasum -a 256 | cut -c1-64)
git rm -q supabase/migrations/1_a.sql; D=$(git commit -qm rm && git rev-parse HEAD)

# roda <rc> <regex da saída inteira> <ar> <head> [alvo]
roda() { local esp="$1" re="$2" out rc; : ; out=$(LP_PSQL_RO="$base/psql" LR_FAKE="$F" bash "${5:-$ALVO}" "$3" "$4" 2>&1); rc=$?
  if [ "$rc" = "$esp" ] && [ "$(printf '%s\n' "$out" | head -1)" = "$esp" ] && printf '%s' "$out" | grep -qE "$re"; then return 0; fi
  echo "FALHOU [$CEN]: esperado rc=$esp /$re/, veio rc=$rc"; printf '%s\n' "$out" | sed 's/^/    /'; fail=1; return 1; }
limpa() { rm -f "$F"/*; }

CEN=nenhuma;      limpa; roda 0 '^0$' "$M2" "$M2"
CEN=todas;        limpa; printf '%s aplicada\n%s falhou,aplicada\n' "$S1" "$S2" > "$F/ledger"; roda 0 "aplicada supabase/migrations/2_b.sql ${S2:0:12}" "$A" "$M2"
CEN=sem_recibo;   limpa; printf '%s aplicada\n' "$S1" > "$F/ledger"; roda 1 "sem_recibo supabase/migrations/2_b.sql" "$A" "$M2"
CEN=so_falhou;    limpa; printf '%s aplicada\n%s falhou\n' "$S1" "$S2" > "$F/ledger"; roda 1 "sem_recibo supabase/migrations/2_b.sql" "$A" "$M2"
CEN=desconhecido; limpa; printf '%s aplicada\n%s falhou,tentativa\n' "$S1" "$S2" > "$F/ledger"; roda 2 "desconhecido supabase/migrations/2_b.sql" "$A" "$M2"
CEN=adiada;       limpa; printf '%s aplicada\n' "$S1" > "$F/ledger"; echo "$S2" > "$F/adiadas"; roda 0 "adiada supabase/migrations/2_b.sql" "$A" "$M2"
CEN=sem_tabela;   limpa; printf '%s aplicada\n' "$S1" > "$F/ledger"; echo "$S2" > "$F/adiadas"; touch "$F/sem_tabela"
                  roda 1 "sem_recibo supabase/migrations/2_b.sql" "$A" "$M2"
CEN=removida;     limpa; printf '%s aplicada\n' "$S2" > "$F/ledger"; roda 1 "removida supabase/migrations/1_a.sql" "$M2" "$D"
CEN=psql_cai;     limpa; touch "$F/cai"; roda 2 "mecanica psql-ro" "$A" "$M2"
CEN=psql_ausente; limpa; out=$(LP_PSQL_RO="$base/nao-existe" bash "$ALVO" "$A" "$M2" 2>&1); rc=$?
                  [ "$rc" = 2 ] || { echo "FALHOU [$CEN]: rc=$rc"; fail=1; }

# falsificação: tentativa tratada como sem recibo → o cenário desconhecido tem de reprovar
sed 's/\*,tentativa,\*|\*,desconhecido,\*) e=desconhecido ;;/*,nunca,*) e=desconhecido ;;/' "$ALVO" > "$base/sab.sh"
if cmp -s "$ALVO" "$base/sab.sh"; then echo "FALHOU [sab]: a sabotagem não casou"; fail=1
else
  CEN=controle_desconhecido; limpa; printf '%s aplicada\n%s tentativa\n' "$S1" "$S2" > "$F/ledger"
  if roda 2 "desconhecido" "$A" "$M2"; then
    if ( roda 2 "desconhecido" "$A" "$M2" "$base/sab.sh" ) >/dev/null 2>&1; then echo "FALHOU [sab]: cópia sabotada passou"; fail=1; fi
  fi
fi

[ "$fail" = 0 ] && echo "test-lovable-recibos: OK"
exit "$fail"
