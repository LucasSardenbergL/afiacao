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
CREATE TABLE public.sales_orders (id uuid PRIMARY KEY, deleted_at timestamptz,
  status text NOT NULL DEFAULT 'orcamento', omie_pedido_id bigint);
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
-- O que a PROD tem (20260724120000): RLS, DELETE de orçamento/rascunho sem PID para quem escreve
-- pedido, UPDATE só por coluna (deleted_at entre elas) — a coluna nova NÃO pode entrar.
CREATE SCHEMA IF NOT EXISTS private;
CREATE OR REPLACE FUNCTION private.cap_pedido_escrever(uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ SELECT true $$;
GRANT USAGE ON SCHEMA private TO authenticated;
ALTER TABLE public.sales_orders ENABLE ROW LEVEL SECURITY;
GRANT SELECT, DELETE ON public.sales_orders TO authenticated;
GRANT UPDATE (deleted_at, status) ON public.sales_orders TO authenticated;
CREATE POLICY sales_orders_select_t ON public.sales_orders FOR SELECT TO authenticated USING (true);
CREATE POLICY sales_orders_delete_staff ON public.sales_orders
  FOR DELETE TO authenticated
  USING (
    (SELECT private.cap_pedido_escrever((SELECT auth.uid())))
    AND omie_pedido_id IS NULL
    AND status IN ('orcamento', 'rascunho')
  );
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
  PGAPPNAME=s1 P -q -tA -c "BEGIN; $1; SELECT pg_sleep(3); COMMIT;" >/dev/null &
  local p1=$!
  for _ in $(seq 1 50); do
    [ "$(Pq -c "SELECT count(*) FROM pg_stat_activity WHERE application_name='s1' AND wait_event='PgSleep';")" = 1 ] && break; sleep 0.1
  done
  PGAPPNAME=s2 P -q -tA -c "$2" > "$out2" &
  local p2=$!
  local esperou=0
  # prova literal da disputa: a s2 está BLOQUEADA PELA s1 (não só "alguém esperando lock")
  for _ in $(seq 1 50); do
    [ "$(Pq -c "SELECT count(*) FROM pg_stat_activity b WHERE b.application_name='s2'
        AND (SELECT pid FROM pg_stat_activity WHERE application_name='s1') = ANY (pg_blocking_pids(b.pid));")" = 1 ] && { esperou=1; break; }; sleep 0.05
  done
  wait $p1; wait $p2
  echo "$esperou:$(tr -d '\n' < "$out2")"; rm -f "$out2"
}

FRONT_DELETE="SET ROLE authenticated; WITH d AS (DELETE FROM public.sales_orders WHERE id='$A' RETURNING 1) SELECT count(*) FROM d;"

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
  eq "C4 envio reivindica 1º → o DELETE do front (authenticated, RLS) que ESPEROU o lock não apaga o orçamento" \
    "$(corrida "SELECT public.sales_order_reivindicar_envio('$A')" "$FRONT_DELETE")" "1:0"
  eq "C4b orçamento fica" "$(existe)" "1"
  reset NULL "now() - interval '11 minutes'"
  eq "U8 DELETE do front NÃO apaga orçamento já reivindicado, mesmo velho (PV pode estar vivo — vai pela edge)" "$(Pq -q -c "$FRONT_DELETE")" "0"
  reset NULL NULL
  eq "U8b DELETE do front apaga orçamento nunca enviado" "$(Pq -q -c "$FRONT_DELETE")" "1"
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
P -q -c "DROP POLICY sales_orders_delete_staff ON public.sales_orders;
  CREATE POLICY sales_orders_delete_staff ON public.sales_orders FOR DELETE TO authenticated
  USING ((SELECT private.cap_pedido_escrever((SELECT auth.uid()))) AND omie_pedido_id IS NULL AND status IN ('orcamento','rascunho'));"
P -q -f "$MIG" >/dev/null   # repõe as RPCs; e a policy SEM a condição volta a ser recriada…
P -q -c "DROP POLICY sales_orders_delete_staff ON public.sales_orders;
  CREATE POLICY sales_orders_delete_staff ON public.sales_orders FOR DELETE TO authenticated
  USING ((SELECT private.cap_pedido_escrever((SELECT auth.uid()))) AND omie_pedido_id IS NULL AND status IN ('orcamento','rascunho'));"
reset NULL NULL   # …por isso a sabotagem da policy é aplicada DEPOIS da migration
eq "F4 policy sem a condição do claim deixa o front apagar durante o envio (o bug do Codex)" \
  "$(corrida "SELECT public.sales_order_reivindicar_envio('$A')" "$FRONT_DELETE")" "1:1"
P -q -c "DROP POLICY sales_orders_delete_staff ON public.sales_orders;
  CREATE POLICY sales_orders_delete_staff ON public.sales_orders FOR DELETE TO authenticated
  USING ((SELECT private.cap_pedido_escrever((SELECT auth.uid()))) AND omie_pedido_id IS NULL AND status IN ('orcamento','rascunho')
         AND (envio_omie_reivindicado_em IS NULL OR envio_omie_reivindicado_em < now() - interval '10 minutes'));"
reset NULL "now() - interval '11 minutes'"
eq "F6 policy com janela de 10 min apaga orçamento reivindicado e velho (PV órfão — o 2º bloqueante do Codex)" "$(Pq -q -c "$FRONT_DELETE")" "1"
if P -q -c "GRANT UPDATE (envio_omie_reivindicado_em) ON public.sales_orders TO authenticated;" >/dev/null 2>&1 \
   && ! P -q -f "$MIG" >/dev/null 2>&1; then ok "F5 postcondição A6 aborta a migration se o cliente puder reescrever o carimbo"
else bad "F5 postcondição A6 não abortou com UPDATE do carimbo concedido a authenticated"; fi
P -q -c "REVOKE UPDATE (envio_omie_reivindicado_em) ON public.sales_orders FROM authenticated;" >/dev/null
P -q -f "$MIG" >/dev/null
reset NULL NULL
eq "F3 migration reaplicada fecha de novo" \
  "$(corrida "SELECT public.sales_order_reivindicar_envio('$A')" "SELECT public.sales_order_excluir_sem_envio('$A')")" "1:envio_em_curso"
reset NULL NULL
eq "F3b policy reaplicada fecha o DELETE do front de novo" \
  "$(corrida "SELECT public.sales_order_reivindicar_envio('$A')" "$FRONT_DELETE")" "1:0"

echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE — fim"
