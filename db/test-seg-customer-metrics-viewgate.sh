#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  HARNESS PG17 — view-gate da customer_metrics_mv (fecha "Materialized View in   ║
# ║  API"). Prova: MV vai p/ private, view public de mesmo nome lê como owner;      ║
# ║  authenticated lê via view, anon não; get_customer_metrics e refresh seguem;    ║
# ║  nenhuma matview em public exposta na API. + FALSIFICAÇÃO.                      ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5463}"
SLUG="seg-cmv-viewgate"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER} pgvector"; exit 1; }
CELLAR="$(brew --prefix "postgresql@${PGVER}")"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "/tmp/pg-${SLUG}.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
P()  { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }

P -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -q <<'SQL'
CREATE OR REPLACE FUNCTION auth.uid()  RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.uid',  true), '')::uuid $f$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.role', true), '') $f$;
ALTER ROLE service_role BYPASSRLS;
GRANT USAGE ON SCHEMA auth TO anon, authenticated;
SQL

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }
deny() { local out; if out=$(P -q -c "$1" 2>&1); then bad "$2 — devia NEGAR e passou"; \
         elif echo "$out" | grep -qiE "permission denied|does not exist"; then ok "$2 (negado)"; \
         else bad "$2 — erro inesperado: $(echo "$out" | tail -1)"; fi; }

echo "═══ setup PG17 :$PORT ═══"

# ══ ZONA 1 — estado de PROD antes da migração ════════════════════════════════
P -q <<'SQL'
CREATE SCHEMA IF NOT EXISTS private;
CREATE TYPE public.app_role AS ENUM ('employee','master','customer');
CREATE FUNCTION public.has_role(_uid uuid, _role public.app_role) RETURNS boolean
  LANGUAGE sql STABLE AS $$ SELECT current_setting('test.is_staff', true) = 'on' $$;

-- fonte + MV em public (como em prod, com índice único p/ CONCURRENTLY).
-- #1380: as 13 colunas REAIS (medidas no psql-ro) — antes eram 2 fake (user_id,
-- metric). O view-gate da 20260717120000 as lista explicitamente, então um schema
-- fake fazia a migration real falhar aqui (42703) e o harness não podia aplicá-la.
CREATE TABLE public.clientes_src (
  customer_user_id uuid, razao_social text, document text, ultima_compra_data timestamptz,
  dias_desde_ultima_compra int, pedidos_90d bigint, faturamento_90d numeric,
  ticket_medio_90d numeric, faturamento_prev_90d numeric, intervalo_medio_dias numeric,
  atraso_relativo numeric, is_cold_start boolean, calculated_at timestamptz
);
INSERT INTO public.clientes_src VALUES
  ('11111111-1111-1111-1111-111111111111','ACME MARCENARIA LTDA','11111111000191', now(), 10, 4, 40000, 10000, 30000, 25, 0.4, false, now()),
  ('22222222-2222-2222-2222-222222222222','BETA MOVEIS LTDA','22222222000172', now(), 5, 9, 90000, 10000, 70000, 12, 0.4, false, now());
CREATE MATERIALIZED VIEW public.customer_metrics_mv AS
  SELECT customer_user_id, razao_social, document, ultima_compra_data,
         dias_desde_ultima_compra, pedidos_90d, faturamento_90d, ticket_medio_90d,
         faturamento_prev_90d, intervalo_medio_dias, atraso_relativo, is_cold_start,
         calculated_at
    FROM public.clientes_src;
CREATE UNIQUE INDEX idx_customer_metrics_mv_uid ON public.customer_metrics_mv(customer_user_id);
GRANT SELECT ON public.customer_metrics_mv TO authenticated, service_role;  -- estado pós-Onda1 (anon já revogado)

-- RPC que lê a MV (deve seguir funcionando após virar view)
CREATE FUNCTION public.get_customer_metrics() RETURNS SETOF public.customer_metrics_mv
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$ SELECT * FROM public.customer_metrics_mv $$;

-- refresh (versão ANTIGA: aponta p/ public) — a migração deve recriar p/ private
CREATE FUNCTION public.refresh_customer_metrics() RETURNS void
  LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT (public.has_role(auth.uid(),'employee'::app_role) OR public.has_role(auth.uid(),'master'::app_role)) THEN
    RAISE EXCEPTION 'Acesso negado: requer perfil staff' USING ERRCODE='42501';
  END IF;
  REFRESH MATERIALIZED VIEW CONCURRENTLY public.customer_metrics_mv;
END $$;
SQL

# ══ ZONA 2 — aplicar as migrações REAIS, NA ORDEM ════════════════════════════
P -q -f "$REPO_ROOT/supabase/migrations/20260629120000_seg_customer_metrics_viewgate.sql"
# ⚠️ #1380: a 20260629120000 sozinha DEIXA O VAZAMENTO ABERTO — ela fechava o lint
# "Materialized View in API", não a autorização (o cabeçalho dela diz "SEM mudar
# comportamento"). Este harness parava aqui e, com M3/M6 exigindo `2`, CONSAGRAVA
# o vazamento como esperado (achado do Codex challenge no #1382). Aplicamos também
# o fix, e os asserts abaixo passam a descrever o estado FINAL: staff lê, customer
# NÃO. Ver db/test-customer-metrics-viewgate.sh p/ a prova dedicada do gate.
P -q -f "$REPO_ROOT/supabase/migrations/20260717120000_seg_customer_metrics_gate_staff.sql"
P -q -f "$REPO_ROOT/supabase/migrations/20260717130000_seg_customer_metrics_acl_least_privilege.sql"
echo "migrações aplicadas (lint + view-gate + ACL)"

# ══ ZONA 4 — ASSERTS ═════════════════════════════════════════════════════════
echo "── asserts ──"
# M1/M2: public virou VIEW; private é MATVIEW
V=$(Pq -c "SELECT c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname='customer_metrics_mv';")
eq "M1 public.customer_metrics_mv e VIEW" "$V" "v"
V=$(Pq -c "SELECT c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='private' AND c.relname='customer_metrics_mv';")
eq "M2 private.customer_metrics_mv e MATVIEW" "$V" "m"
# M3: authenticated SEM staff (= customer) NÃO lê — o gate filtra (0 ≠ 42501).
# Era `eq ... "2"`, que EXIGIA o vazamento; corrigido no #1380 (o assert estava
# travando o bug como comportamento esperado — falso-verde estrutural).
V=$(Pq -c "SET ROLE authenticated; SELECT count(*) FROM public.customer_metrics_mv;" | tail -1)
eq "M3 authenticated SEM staff NAO le (gate filtra)" "$V" "0"
# M3b: authenticated COM staff segue lendo — o gate não quebra as telas.
V=$(Pq -c "SET test.is_staff='on'; SET ROLE authenticated; SELECT count(*) FROM public.customer_metrics_mv;" | tail -1)
eq "M3b authenticated COM staff le via view" "$V" "2"
# M4: anon NÃO lê a view (sem grant)
deny "SET ROLE anon; SELECT 1 FROM public.customer_metrics_mv;" "M4 anon NAO le a view"
# M5: authenticated NÃO lê a MV em private (trancada)
deny "SET ROLE authenticated; SELECT 1 FROM private.customer_metrics_mv;" "M5 authenticated NAO le a MV private"
# M6: get_customer_metrics (RPC SECDEF) segue funcionando p/ staff — o SECDEF
# troca o ROLE, não o JWT, então o gate da view vale dentro dela.
V=$(Pq -c "SET test.is_staff='on'; SELECT count(*) FROM public.get_customer_metrics();" | tail -1)
eq "M6 get_customer_metrics segue funcionando p/ staff" "$V" "2"
# M6b: e NÃO vaza p/ quem não é staff (era `eq ... "2"`, que exigia o vazamento).
V=$(Pq -c "SELECT count(*) FROM public.get_customer_metrics();" | tail -1)
eq "M6b get_customer_metrics NAO vaza p/ nao-staff" "$V" "0"
# M7: refresh_customer_metrics agora aponta p/ private
V=$(Pq -c "SELECT pg_get_functiondef('public.refresh_customer_metrics'::regproc) LIKE '%private.customer_metrics_mv%';")
eq "M7 refresh aponta p/ private" "$V" "t"
# M8: refresh roda como staff (REFRESH CONCURRENTLY private ok)
P -q -c "SET test.uid='11111111-1111-1111-1111-111111111111'; SET test.is_staff='on'; SELECT public.refresh_customer_metrics();"
ok "M8 refresh_customer_metrics roda como staff (CONCURRENTLY private)"
# M9 (lint-proxy): NENHUMA matview em public com grant a anon/authenticated
V=$(Pq -c "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='m' AND (has_table_privilege('anon',c.oid,'SELECT') OR has_table_privilege('authenticated',c.oid,'SELECT'));")
eq "M9 zero matview exposta na API (public)" "$V" "0"

# ══ ZONA 5 — FALSIFICAÇÃO ════════════════════════════════════════════════════
echo "── falsificacao ──"
# FM1: recria uma matview exposta em public → o lint-proxy M9 deve passar a contar >0
P -q -c "CREATE MATERIALIZED VIEW public.cmv_sabotage AS SELECT 1 AS x; GRANT SELECT ON public.cmv_sabotage TO authenticated;"
V=$(Pq -c "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relkind='m' AND (has_table_privilege('anon',c.oid,'SELECT') OR has_table_privilege('authenticated',c.oid,'SELECT'));")
if [ "$V" -gt 0 ]; then ok "FM1 sabotado (matview exposta) M9 conta $V -> M9 tem dente"; else bad "FM1 M9 nao detectou matview exposta -> SEM dente"; fi
P -q -c "DROP MATERIALIZED VIEW public.cmv_sabotage;"
# FM2: se a view fosse security_invoker=on, authenticated (sem grant na MV private) NÃO leria → prova que invoker=off é o que faz funcionar
P -q -c "ALTER VIEW public.customer_metrics_mv SET (security_invoker = on);"
R=$(P -q -c "SET ROLE authenticated; SELECT count(*) FROM public.customer_metrics_mv;" 2>&1 || true)
if echo "$R" | grep -qi "permission denied"; then ok "FM2 sabotado (invoker=on) authenticated perde acesso -> invoker=off tem dente"; else bad "FM2 leu mesmo com invoker=on ($R) -> sem dente"; fi
P -q -c "ALTER VIEW public.customer_metrics_mv SET (security_invoker = off);"

echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
