#!/usr/bin/env bash
# TEMPORÁRIO — sai do branch antes do PR.
# Custo de UMA execução de tint_watchdog_fase5_check() em função de:
#   N   = chaves BULK do seed (a prova usa 1000; o universo é 4 + N)
#   idx = sem | com os índices que a PROD tem e o fixture NÃO:
#         UNIQUE (formula_id, corante_id) em tint_formula_itens e
#         idx_tint_formulas_busca_cor (account, sku_id, cor_id) em tint_formulas
#   stats = sem ANALYZE (como a prova, com autovacuum desligado aqui para não sortear) | com ANALYZE
# O fixture (ZONA 1, seed da ZONA 3) é EXTRAÍDO da própria prova, a view da última migration
# que a define e a função da migration real — nada reescrito à mão.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export PGVER=17
# shellcheck disable=SC1091
. "$REPO_ROOT/db/lib/pg-harness.sh"
PORT="${PGPORT_TEST:-5471}"
TMP="$(mktemp -d "/tmp/pgbench-f5wd.XXXXXX")"; DATA="$TMP/data"
export LC_ALL=C LANG=C
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMP"; }
trap cleanup EXIT
"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k $TMP -c autovacuum=off" -l "$TMP/log" -w start >/dev/null

PROVA="$REPO_ROOT/db/test-tint-fase5-watchdog.sh"
MIG="$REPO_ROOT/supabase/migrations/20260730120000_tint_watchdog_fase5_chave.sql"
python3 - "$PROVA" "$REPO_ROOT" "$MIG" "$TMP" <<'PY'
import sys, os, re, glob
prova, repo, mig, tmp = sys.argv[1:5]
s = open(prova).read()
# heredocs <<'SQL' da prova, na ordem: [0] ZONA 1, [1] ZONA 3 (seeds)
docs = re.findall(r"<<'SQL'\n(.*?)\nSQL\n", s, re.S)
assert len(docs) >= 2, "heredocs SQL da prova nao encontrados"
open(os.path.join(tmp, "zona1.sql"), "w").write(docs[0])
seed = docs[1]
assert seed.count("FOR g IN 1001..2000 LOOP") == 1, "laco BULK do seed mudou"
open(os.path.join(tmp, "zona3.tpl"), "w").write(seed)
ANCORA = "CREATE OR REPLACE VIEW public.v_tint_formula_canonica"
cands = sorted(f for f in glob.glob(os.path.join(repo, "supabase/migrations/*.sql")) if ANCORA in open(f).read())
v = open(cands[-1]).read(); i = v.index(ANCORA); seg = v[i:]; j = seg.index("SELECT")
m = re.search(r";\s*\n", seg[j:]); open(os.path.join(tmp, "view.sql"), "w").write(seg[: j + m.end()])
# a varredura da função, sem o INTO — para o EXPLAIN
f = open(mig).read()
a = f.index("  SELECT count(*) FILTER (WHERE k.tem_ativa AND v.account IS NULL),")
b = f.index("AND v.cor_id = k.cor_id;", a) + len("AND v.cor_id = k.cor_id;")
q = f[a:b].replace("    INTO v_s1, v_s2, v_universo\n", "")
open(os.path.join(tmp, "varredura.sql"), "w").write(q)
PY

agora() { if [ -n "${EPOCHREALTIME:-}" ]; then printf '%s' "$EPOCHREALTIME"; else perl -MTime::HiRes=time -e 'printf "%.6f", time'; fi; }

IDX_SQL="CREATE UNIQUE INDEX ON public.tint_formula_itens (formula_id, corante_id);
CREATE INDEX ON public.tint_formulas (account, sku_id, cor_id);"

mede() {  # mede <db> <rotulo> <n_execucoes> <timeout_ms> — numa sessão só; mediana das execuções
  local db="$1" rot="$2" n="$3" to="$4" tempos med i sql
  sql="SET statement_timeout = $to;
\\timing on
\\o /dev/null"
  for i in $(seq 1 "$n"); do sql="$sql
SELECT public.tint_watchdog_fase5_check();"; done
  tempos="$(printf '%s\n' "$sql" | "$PGBIN/psql" -X -h "$TMP" -p "$PORT" -U postgres -d "$db" -v ON_ERROR_STOP=1 -q 2>&1 \
            | grep -oE '^Time: [0-9.]+|statement timeout' | sed 's/^Time: //; s/statement timeout/TIMEOUT/' | tr '\n' ' ')" || true
  med="$(printf '%s' "$tempos" | tr ' ' '\n' | grep -v '^$' | grep -vx TIMEOUT | sort -n | awk '{a[NR]=$1} END {if (NR) print a[int((NR+1)/2)]; else print "NA"}')" || med="NA"
  echo "MEDIDA_ESCALA|$rot|mediana_ms=$med|execucoes_ms=$tempos"
}

for N in ${NS:-0 100 250 500 1000 2000}; do
  for idx in sem com; do
    db="b_${N}_${idx}"
    "$PGBIN/createdb" -h "$TMP" -p "$PORT" -U postgres "$db"
    Pb() { "$PGBIN/psql" -X -h "$TMP" -p "$PORT" -U postgres -d "$db" -v ON_ERROR_STOP=1 -q "$@"; }
    Pb -f "$TMP/zona1.sql" >/dev/null
    [ "$idx" = com ] && Pb -c "$IDX_SQL" >/dev/null
    Pb -f "$TMP/view.sql" >/dev/null
    Pb -f "$MIG" >/dev/null
    sed "s/FOR g IN 1001..2000 LOOP/FOR g IN 1001..$((1000 + N)) LOOP/" "$TMP/zona3.tpl" > "$TMP/zona3_$N.sql"
    s0="$(agora)"
    Pb -f "$TMP/zona3_$N.sql" >/dev/null
    s1="$(agora)"
    uni="$(Pb -tA -c "SELECT count(DISTINCT (account,sku_id,cor_id)) FROM public.tint_formulas WHERE desativada_motivo='fase5_geracao_legada'")"
    echo "MEDIDA_SEED|N=$N|idx=$idx|universo=$uni|seed_s=$(awk -v a="$s0" -v b="$s1" 'BEGIN{printf "%.2f", b-a}')"
    if [ "$N" -le 250 ]; then n_sem=3; else n_sem=1; fi
    mede "$db" "N=$N|idx=$idx|stats=sem" "$n_sem" 180000
    Pb -c "ANALYZE" >/dev/null
    mede "$db" "N=$N|idx=$idx|stats=com" 3 180000
    if [ "$N" = 1000 ]; then
      echo "── EXPLAIN da varredura, N=1000 idx=$idx (stats=com) ──"
      Pb -c "EXPLAIN (ANALYZE, TIMING OFF, COSTS OFF) $(cat "$TMP/varredura.sql")" \
        | grep -E 'Execution Time|loops=[0-9]{3,}' | cut -c1-150 | head -20 || true
    fi
  done
done
echo "ESCALA_OK"
