#!/usr/bin/env bash
# PROVA PG17 — product_costs.cmc: ausente ≠ zero (DROP DEFAULT 0) + CHECK de faixa
# migration: supabase/migrations/20261009180000_product_costs_cmc_ausente_null.sql
# rodar: bash db/test-product-costs-cmc-faixa.sh > /tmp/t.log 2>&1; echo $?
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGBIN="/opt/homebrew/opt/postgresql@17/bin"
PORT="${PGPORT_TEST:-5475}"
DATA="$(mktemp -d "/tmp/pgtest-pccmc.XXXXXX")/data"
export LC_ALL="${LC_ALL:-C}" LANG="${LANG:-C}"
MIG="$REPO_ROOT/supabase/migrations/20261009180000_product_costs_cmc_ausente_null.sql"
BASELINE=17
TOTAL_ESPERADO=21

[ -x "$PGBIN/initdb" ] || { echo "postgresql@17 ausente"; exit 1; }
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT
LC_ALL=C "$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
LC_ALL=C "$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "/tmp/pg-pccmc.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
P()  { "$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tAq "$@"; }

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  OK   $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 -- esperado [$3], veio [$2]"; fi; }

sonda() {  # ACEITOU | REJEITOU_23514 | INESPERADO_<sqlstate>
  local out
  out=$(P -tA 2>&1 <<SQL || true
DO \$do\$
BEGIN
  $1
  RAISE NOTICE 'SONDA_ACEITOU';
EXCEPTION WHEN OTHERS THEN
  IF SQLSTATE = '23514' THEN RAISE NOTICE 'SONDA_REJEITOU_23514';
  ELSE RAISE NOTICE 'SONDA_INESPERADO_%', SQLSTATE; END IF;
END \$do\$;
SQL
)
  case "$out" in
    *SONDA_REJEITOU_23514*) echo REJEITOU_23514 ;;
    *SONDA_ACEITOU*)        echo ACEITOU ;;
    *SONDA_INESPERADO_*)    echo "INESPERADO_$(printf '%s' "$out" | sed -n 's/.*SONDA_INESPERADO_\([0-9A-Z]*\).*/\1/p' | head -1)" ;;
    *)                      echo INESPERADO_SEMSAIDA ;;
  esac
}
deve() { local v; v=$(sonda "$3"); eq "$1" "$v" "$2"; }
INS() { echo "INSERT INTO public.product_costs (product_id, cmc) VALUES (gen_random_uuid(), $1);"; }
# insert que OMITE cmc (o caso do DEFAULT): devolve o cmc gravado, ou NULO
omite() { Pq -c "INSERT INTO public.product_costs (product_id, cost_source) VALUES (gen_random_uuid(),'T') RETURNING coalesce(cmc::text,'NULO');" | tail -1; }

# estado de PROD hoje: colunas relevantes + DEFAULT 0 + dado real (zeros de proxy, máximo real)
estado_prod() {
P -q <<'SQL'
DROP TABLE IF EXISTS public.product_costs;
CREATE TABLE public.product_costs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), product_id uuid NOT NULL UNIQUE,
  cost_price numeric, updated_at timestamptz NOT NULL DEFAULT now(),
  cmc numeric DEFAULT 0, cost_source text DEFAULT 'UNKNOWN'::text,
  cost_confidence numeric DEFAULT 0, cost_final numeric DEFAULT 0);
INSERT INTO public.product_costs (product_id, cmc, cost_final, cost_source)
  SELECT gen_random_uuid(), 0, 10, 'FAMILY_MARGIN_PROXY' FROM generate_series(1,50);
INSERT INTO public.product_costs (product_id, cmc, cost_final, cost_source)
  SELECT gen_random_uuid(), g*1.1, g*1.1, 'CMC' FROM generate_series(1,80) g;
INSERT INTO public.product_costs (product_id, cmc, cost_final, cost_source) VALUES (gen_random_uuid(), 218715.88, 218715.88, 'CMC');
SQL
}

echo "=== PG17 :$PORT (LC_ALL=$LC_ALL) ==="
estado_prod
echo "-- caracterizacao (estado de prod) --"
eq   "C1 [defeito] insert sem cmc grava 0 (DEFAULT 0)" "$(omite)" 0
deve "C2 [defeito] sem CHECK, 1e100000 entra"          ACEITOU "$(INS "'1e100000'::numeric")"
P -q -c "DELETE FROM public.product_costs WHERE cmc > 10000000 OR cost_source='T';"

P -q -f "$MIG" >/dev/null 2>&1
echo "-- asserts --"
eq   "A1 default de cmc removido" "$(Pq -c "SELECT coalesce(column_default,'NENHUM') FROM information_schema.columns WHERE table_name='product_costs' AND column_name='cmc';")" NENHUM
eq   "A2 constraint existe e validada" "$(Pq -c "SELECT coalesce((SELECT convalidated::text FROM pg_constraint WHERE conname='product_costs_cmc_faixa'),'ausente');")" true
eq   "A3 insert sem cmc agora grava NULL (ausente)" "$(omite)" NULO
deve "A4 aceita NULL explicito"             ACEITOU        "$(INS NULL)"
deve "A5 aceita 0 (transicao do motor)"     ACEITOU        "$(INS 0)"
deve "A6 aceita o maximo real de prod"      ACEITOU        "$(INS 218715.88)"
deve "A7 aceita exatamente o teto"          ACEITOU        "$(INS 10000000)"
deve "A8 rejeita 1e100000"                  REJEITOU_23514 "$(INS "'1e100000'::numeric")"
deve "A9 rejeita teto+0.01"                 REJEITOU_23514 "$(INS 10000000.01)"
deve "A10 rejeita NaN"                      REJEITOU_23514 "$(INS "'NaN'::numeric")"
deve "A11 rejeita Infinity"                 REJEITOU_23514 "$(INS "'Infinity'::numeric")"
deve "A12 rejeita negativo"                 REJEITOU_23514 "$(INS -1)"
eq   "A13 linhas preexistentes intactas (zeros de proxy seguem 0, sem backfill)" "$(Pq -c "SELECT count(*) FROM public.product_costs WHERE cost_source='FAMILY_MARGIN_PROXY' AND cmc=0;")" 50
if P -q -f "$MIG" >/dev/null 2>&1; then ok "A14 re-aplicar passa"; else bad "A14 re-aplicar FALHOU"; fi
eq   "A15 re-aplicar nao duplica" "$(Pq -c "SELECT count(*) FROM pg_constraint WHERE conname='product_costs_cmc_faixa';")" 1

echo "-- falsificacao --"
if [ "$FAIL" != 0 ] || [ "$PASS" != "$BASELINE" ]; then echo "  ABORTA: baseline invalido ($PASS ok / $FAIL fail; esperado $BASELINE/0)"; exit 1; fi
echo "  baseline VERDE: $BASELINE/$BASELINE"
SAB="$(mktemp /tmp/mig-pc-sab.XXXXXX.sql)"
sabota() {
  sed "$1" "$MIG" > "$SAB"
  if cmp -s "$MIG" "$SAB"; then bad "sabotagem nao aplicou ($1)"; return 1; fi
  estado_prod; P -q -f "$SAB" >/dev/null 2>&1 || true
}
# F1 — sem o DROP DEFAULT: insert sem cmc volta a gravar 0, e a POSTCONDICAO tem de abortar
sabota '/ALTER COLUMN cmc DROP DEFAULT/d' && {
  eq "F1 sem DROP DEFAULT, a postcondicao aborta (nada aplicado)" "$(Pq -c "SELECT count(*) FROM pg_constraint WHERE conname='product_costs_cmc_faixa';")" 0
}
# F2 — sem o teto: 1e100000 entra (A8 tem dente)
sabota 's/ AND cmc <= 10000000//' && { v=$(sonda "$(INS "'1e100000'::numeric")"); eq "F2 sem teto, 1e100000 ENTRA" "$v" ACEITOU; }
# F3 — sonda distingue erro inesperado
v=$(sonda "INSERT INTO public.nao_existe VALUES (1);"); eq "F3 sonda triestado marca inesperado" "$v" INESPERADO_42P01
# F4 — controle: migration real restaurada barra de novo e grava NULL
estado_prod; P -q -f "$MIG" >/dev/null 2>&1
eq "F4 controle: migration real grava NULL ao omitir" "$(omite)" NULO
rm -f "$SAB"

echo "------------------------------"
echo "RESULTADO: $PASS ok / $FAIL fail (esperado $TOTAL_ESPERADO)"
[ "$FAIL" = 0 ] && [ "$PASS" = "$TOTAL_ESPERADO" ] || { echo "HARNESS VERMELHO"; exit 1; }
echo "HARNESS VERDE"
