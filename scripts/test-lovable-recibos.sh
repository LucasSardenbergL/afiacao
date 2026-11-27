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

# ── db-adiar.sh: grava/revoga por SHA dos bytes commitados, com releitura (psql-rw FALSO) ───────
cat > "$base/rw" <<'FAKE'
#!/usr/bin/env bash
F="$LR_FAKE"; q=""
while [ $# -gt 0 ]; do case "$1" in -c) q="$2"; shift ;; esac; shift; done
[ -f "$F/rw_cai" ] && exit 2
s=$(printf '%s' "$q" | grep -oE "'[0-9a-f]{64}'" | head -1 | tr -d "'")
case "$q" in
  insert*) [ -f "$F/rw_mente" ] && exit 0; echo "$s adiada" > "$F/rw_$s" ;;
  update*) [ -f "$F/rw_$s" ] && echo "$s revogada" > "$F/rw_$s" ;;
  select*) [ -f "$F/rw_$s" ] && cut -d' ' -f2 "$F/rw_$s" ;;
esac
exit 0
FAKE
chmod +x "$base/rw"
ADIAR="$here/db-adiar.sh"
adiar() { local esp="$1" rc; shift; AD_OUT=$(AFIACAO_PSQL_RW="$base/rw" LR_FAKE="$F" bash "$ADIAR" "$@" 2>&1); rc=$?
  [ "$rc" = "$esp" ] || { echo "FALHOU [$CEN]: db-adiar rc=$rc (esperado $esp): $AD_OUT"; fail=1; return 1; }; }
git checkout -q "$M2"
CEN=adiar_ok;        limpa; adiar 0 supabase/migrations/2_b.sql "fatia futura sem front" && [ "$(cut -d' ' -f2 "$F/rw_$S2")" = adiada ] \
                       || { echo "FALHOU [$CEN]: não gravou o SHA dos bytes do commit"; fail=1; }
CEN=adiar_revoga;    adiar 0 --revogar supabase/migrations/2_b.sql && [ "$(cut -d' ' -f2 "$F/rw_$S2")" = revogada ] || { echo "FALHOU [$CEN]"; fail=1; }
CEN=adiar_sem_motivo; limpa; adiar 2 supabase/migrations/2_b.sql "curto"
CEN=adiar_caminho;   limpa; adiar 2 src/a.ts "motivo comprido o bastante"
CEN=adiar_sujo;      limpa; echo x >> supabase/migrations/2_b.sql; adiar 2 supabase/migrations/2_b.sql "motivo comprido o bastante"
                     git checkout -q -- supabase/migrations/2_b.sql
CEN=adiar_mente;     limpa; touch "$F/rw_mente"; adiar 6 supabase/migrations/2_b.sql "motivo comprido o bastante"   # INSERT "ok" sem linha
CEN=adiar_cai;       limpa; touch "$F/rw_cai"; adiar 6 supabase/migrations/2_b.sql "motivo comprido o bastante"
git checkout -q main
# falsificação com controle (adiar_mente acima, verde): sem a releitura, o INSERT mentiroso passa
sed 's/^\[ "\$EST" = "\$ESPERADO" \] || morre 6/true || morre 6/' "$ADIAR" > "$base/adiar-sab.sh"
if cmp -s "$ADIAR" "$base/adiar-sab.sh"; then echo "FALHOU [sab-adiar]: a sabotagem não casou"; fail=1
else limpa; touch "$F/rw_mente"; git checkout -q "$M2"
  if AFIACAO_PSQL_RW="$base/rw" LR_FAKE="$F" bash "$base/adiar-sab.sh" supabase/migrations/2_b.sql "motivo comprido o bastante" >/dev/null 2>&1
  then :; else echo "FALHOU [sab-adiar]: a cópia sem releitura deveria ACEITAR o INSERT mentiroso (sabotagem inerte)"; fail=1; fi
  git checkout -q main
fi

[ "$fail" = 0 ] && echo "test-lovable-recibos: OK"
exit "$fail"
