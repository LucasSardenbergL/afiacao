#!/usr/bin/env bash
# PROVA PG17 — disputa atômica envio × exclusão (migration 20261120210002_sales_orders_claim_envio_omie).
# Executa as RPCs (PL/pgSQL é late-bound), prova os grants com o DEFAULT PRIVILEGE do Supabase
# replicado, prova a CONCORRÊNCIA com duas sessões reais (a 2ª espera o lock da 1ª — conferido em
# pg_stat_activity, não por sleep) e FALSIFICA: as versões sem a condição reprovam o mesmo assert.
# bash db/test-claim-envio-exclusao.sh > /tmp/t.log 2>&1; echo "exit=$?"
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5471}"
SLUG="claim-envio-exclusao"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER}"; exit 1; }
CELLAR="$(brew --prefix "postgresql@${PGVER}")"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "/tmp/pg-${SLUG}.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
P()  { "$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }

P -q -f "$REPO_ROOT/db/stubs-supabase.sql"

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

MIG="$REPO_ROOT/supabase/migrations/20261120210002_sales_orders_claim_envio_omie.sql"
A='00000000-0000-0000-0000-00000000000a'

P -q <<'SQL'
CREATE TABLE public.sales_orders (id uuid PRIMARY KEY, deleted_at timestamptz);
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
SQL
P -q -f "$MIG" >/dev/null
P -q -f "$MIG" >/dev/null   # idempotente: a 2ª colada não pode falhar
ok "migration aplicada 2× (idempotente, postcondição passou)"

reset() { Pq -c "TRUNCATE public.sales_orders; INSERT INTO public.sales_orders(id, deleted_at, envio_omie_reivindicado_em) VALUES ('$A', $1, $2);" >/dev/null; }
claim()   { Pq -c "SELECT public.sales_order_reivindicar_envio('$A');"; }
excluir() { Pq -c "SELECT public.sales_order_excluir_sem_envio('$A');"; }
existe()  { Pq -c "SELECT count(*) FROM public.sales_orders WHERE id='$A';"; }

# Sessão 1 segura o lock (stmt + pg_sleep na MESMA transação); a sessão 2 roda em background e o
# teste espera ela ENTRAR em espera de lock antes de soltar a 1ª — a corrida acontece de verdade.
corrida() { # $1 = SQL da sessão 1 (segura) · $2 = SQL da sessão 2 (espera) · imprime o resultado da 2
  local out2; out2="$(mktemp)"
  P -q -tA -c "BEGIN; $1; SELECT pg_sleep(3); COMMIT;" >/dev/null &
  local p1=$!
  for _ in $(seq 1 50); do
    [ "$(Pq -c "SELECT count(*) FROM pg_stat_activity WHERE query LIKE 'BEGIN;%pg_sleep(3)%' AND wait_event='PgSleep';")" = 1 ] && break; sleep 0.1
  done
  P -q -tA -c "$2" > "$out2" &
  local p2=$!
  local esperou=0
  for _ in $(seq 1 50); do
    [ "$(Pq -c "SELECT count(*) FROM pg_stat_activity WHERE wait_event_type='Lock';")" = 1 ] && { esperou=1; break; }; sleep 0.05
  done
  wait $p1; wait $p2
  echo "$esperou:$(tr -d '\n' < "$out2")"; rm -f "$out2"
}

suite() {
  echo "── unitário ──"
  reset NULL NULL;  eq "U1 claim em pedido vivo"                 "$(claim)" "t"
  eq "U1b carimbo gravado" "$(Pq -c "SELECT envio_omie_reivindicado_em IS NOT NULL FROM public.sales_orders WHERE id='$A';")" "t"
  reset "now()" NULL; eq "U2 claim em pedido marcado p/ exclusão RECUSA" "$(claim)" "f"
  Pq -c "TRUNCATE public.sales_orders;" >/dev/null; eq "U3 claim em pedido inexistente RECUSA" "$(claim)" "f"
  reset NULL NULL;  eq "U4 exclusão sem claim apaga"             "$(excluir)" "excluido"
  eq "U4b linha some" "$(existe)" "0"
  reset NULL "now() - interval '9 minutes'";  eq "U5 claim de 9 min BARRA a exclusão" "$(excluir)" "envio_em_curso"
  eq "U5b linha fica" "$(existe)" "1"
  reset NULL "now() - interval '11 minutes'"; eq "U6 claim de 11 min não barra"       "$(excluir)" "excluido"
  Pq -c "TRUNCATE public.sales_orders;" >/dev/null; eq "U7 exclusão de inexistente = ausente (idempotente)" "$(excluir)" "ausente"

  echo "── concorrência (2 sessões, lock de linha) ──"
  reset NULL NULL
  eq "C1 envio reivindica 1º → a exclusão que ESPEROU o lock vê o carimbo e recusa" \
    "$(corrida "SELECT public.sales_order_reivindicar_envio('$A')" "SELECT public.sales_order_excluir_sem_envio('$A')")" "1:envio_em_curso"
  eq "C1b linha fica" "$(existe)" "1"
  reset NULL NULL   # caminho que não marca deleted_at antes (o envio disputa o lock de verdade)
  eq "C2 exclusão apaga 1º → o envio que ESPEROU o lock não reivindica" \
    "$(corrida "SELECT public.sales_order_excluir_sem_envio('$A')" "SELECT public.sales_order_reivindicar_envio('$A')")" "1:f"
  reset NULL NULL
  eq "C3 front marca deleted_at 1º → o envio que ESPEROU o lock não reivindica" \
    "$(corrida "UPDATE public.sales_orders SET deleted_at=now() WHERE id='$A'" "SELECT public.sales_order_reivindicar_envio('$A')")" "1:f"
}

haspriv() { Pq -c "SELECT has_function_privilege('$1','public.$2(uuid)','EXECUTE');"; }
echo "── grants ──"
for fn in sales_order_reivindicar_envio sales_order_excluir_sem_envio; do
  eq "G $fn: service_role EXECUTE" "$(haspriv service_role $fn)" "t"
  eq "G $fn: authenticated SEM"    "$(haspriv authenticated $fn)" "f"
  eq "G $fn: anon SEM"             "$(haspriv anon $fn)" "f"
done

suite

echo "── falsificação (versões sem a condição; cada uma tem de reprovar o assert que a mira) ──"
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.sales_order_excluir_sem_envio(p_sales_order_id uuid) RETURNS text
LANGUAGE plpgsql SET search_path = public AS $$
DECLARE v_n integer;
BEGIN
  DELETE FROM public.sales_orders WHERE id = p_sales_order_id;  -- SABOTADA: ignora o claim
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN CASE WHEN v_n = 1 THEN 'excluido' ELSE 'ausente' END;
END $$;
CREATE OR REPLACE FUNCTION public.sales_order_reivindicar_envio(p_sales_order_id uuid) RETURNS boolean
LANGUAGE sql SET search_path = public AS $$
  WITH r AS (UPDATE public.sales_orders SET envio_omie_reivindicado_em = now()
              WHERE id = p_sales_order_id RETURNING 1)  -- SABOTADA: ignora deleted_at
  SELECT EXISTS (SELECT 1 FROM r);
$$;
SQL
reset NULL NULL
eq "F1 exclusão sem condição APAGA apesar do envio em curso (o bug)" \
  "$(corrida "SELECT public.sales_order_reivindicar_envio('$A')" "SELECT public.sales_order_excluir_sem_envio('$A')")" "1:excluido"
reset "now()" NULL; eq "F2 claim sem condição reivindica pedido em exclusão (o bug)" "$(claim)" "t"
P -q -f "$MIG" >/dev/null
reset NULL NULL
eq "F3 migration reaplicada fecha de novo" \
  "$(corrida "SELECT public.sales_order_reivindicar_envio('$A')" "SELECT public.sales_order_excluir_sem_envio('$A')")" "1:envio_em_curso"

echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE — fim"
