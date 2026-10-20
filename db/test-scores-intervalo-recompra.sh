#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════════════════════════════════
# PROVA — intervalo de recompra MEDIDO (Venda por cliente, 1a)
# Migration: supabase/migrations/20261020151500_scores_intervalo_recompra.sql
# Roda:  bash db/test-scores-intervalo-recompra.sh > /tmp/t.log 2>&1; echo "exit=$?"
#        (NUNCA `| tail` — o pipe engole o exit code)
#        MIG=<cópia sabotada> bash db/test-scores-intervalo-recompra.sh  → falsificação (tem de dar vermelho)
#
# Parte dos predecessores VERBATIM da prod (db/fixtures/scores-intervalo-predecessores.sql), que é o
# que a PRE anti-deriva da migration exige, e EXECUTA as duas funções (PL/pgSQL é late-bound).
#
#   S1  6 colunas antigas de get_customer_sales_summary IDÊNTICAS antes × depois (EXCEPT nos 2 sentidos)
#   S2  mediana dos gaps entre dias DISTINTOS (vários itens no mesmo dia contam 1 dia)
#   S3  < 3 dias distintos → NULL (nunca 0)
#   S4  universo de pedidos: cancelado / apagado não entram no intervalo
#   S5  order_date_kpi NULL → data de SP de created_at (mesmo COALESCE das outras colunas)
#   S6  intervalo_mediano_dias é a ÚLTIMA coluna
#   A1  apply: chave com número grava
#   A2  apply: chave com null GRAVA NULL (sobrescreve o 30 legado)
#   A3  apply: chave AUSENTE preserva (edge anterior não apaga nada)
#   G1  ACL: anon/authenticated/PUBLIC sem EXECUTE; service_role com EXECUTE
#   D1  DEFAULT 0 removido: INSERT sem a chave → NULL
#   I1  idempotente: re-aplicar a mesma migration passa (PRE aceita "este")
#   N1  PRE anti-deriva: corpo vivo desconhecido → aborta com 'PRE FALHOU' e NADA muda
# ════════════════════════════════════════════════════════════════════════════════════════════════
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5493}"
SLUG="scores-intervalo-recompra"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
MIG="${MIG:-$REPO_ROOT/supabase/migrations/20261020151500_scores_intervalo_recompra.sql}"
export LC_ALL="${LC_ALL:-C}" LANG="${LANG:-C}"

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER}"; exit 1; }

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "/tmp/pg-${SLUG}.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
P()  { "$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }
Ps() { P -q "$@" >/dev/null; }

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  OK   $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

Ps -f "$REPO_ROOT/db/stubs-supabase.sql"

# ── Esquema mínimo, nas formas da PROD (information_schema, 2026-10-20) ──
Ps <<'SQL'
CREATE TABLE public.sync_state (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  entity_type text NOT NULL, account text NOT NULL DEFAULT 'vendas',
  status text DEFAULT 'idle', metadata jsonb DEFAULT '{}'::jsonb
);
CREATE TABLE public.sales_orders (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  customer_user_id uuid, status text NOT NULL, deleted_at timestamptz,
  order_date_kpi date, created_at timestamptz NOT NULL DEFAULT now(), total numeric
);
CREATE TABLE public.order_items (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  sales_order_id uuid NOT NULL REFERENCES public.sales_orders(id),
  customer_user_id uuid, product_id uuid, unit_price numeric, quantity numeric
);
CREATE TABLE public.farmer_client_scores (
  id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  customer_user_id uuid NOT NULL UNIQUE, farmer_id uuid NOT NULL,
  rf_score numeric DEFAULT 0, m_score numeric, g_score numeric DEFAULT 0,
  health_score numeric DEFAULT 0, health_class text DEFAULT 'critico', churn_risk numeric DEFAULT 0,
  priority_score numeric DEFAULT 0, days_since_last_purchase integer DEFAULT 0,
  avg_repurchase_interval numeric DEFAULT 0, avg_monthly_spend_180d numeric DEFAULT 0,
  gross_margin_pct numeric, category_count integer DEFAULT 0, sales_history_status text,
  itens_com_custo bigint, itens_sem_custo bigint,
  calculated_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
);
DO $$ BEGIN CREATE ROLE sandbox_exec_fzvklzpomgnyikkfkzai; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
SQL

Ps -f "$REPO_ROOT/db/fixtures/scores-intervalo-predecessores.sql"
# ACL da prod antes da migration.
Ps <<'SQL'
REVOKE ALL ON FUNCTION public.get_customer_sales_summary() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_customer_sales_summary() TO service_role, sandbox_exec_fzvklzpomgnyikkfkzai;
REVOKE ALL ON FUNCTION public.apply_score_updates(jsonb,text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_score_updates(jsonb,text) TO service_role, sandbox_exec_fzvklzpomgnyikkfkzai;
SQL

# ── Fixtures ──
#  A: dias 01, 11, 31 (gaps 10, 20) + 2º item no dia 11 + pedido CANCELADO no dia 05 + APAGADO no 06
#     → mediana(10,20) = 15. Se cancelado/apagado entrassem: dias 01,05,06,11,31 → gaps 4,1,5,20 → 4,5.
#  B: 2 dias → NULL.
#  C: dias 01, 11, 21, 61 (gaps 10, 10, 40) → 10.
#  D: order_date_kpi NULL; created_at 03:00Z = 00:00 SP do mesmo dia e 02:00Z = 23:00 SP do dia anterior
#     → dias SP 2026-01-01, 2026-01-10, 2026-01-30 → gaps 9, 20 → 14,5.
Ps <<'SQL'
CREATE TEMP TABLE pedido(cli text, dia date, status text, apagado boolean, criado timestamptz, itens int);
INSERT INTO pedido VALUES
 ('a','2026-01-01','faturado',false,NULL,1),
 ('a','2026-01-11','faturado',false,NULL,2),
 ('a','2026-01-31','faturado',false,NULL,1),
 ('a','2026-01-05','cancelado',false,NULL,1),
 ('a','2026-01-06','faturado',true,NULL,1),
 ('b','2026-01-01','faturado',false,NULL,1),
 ('b','2026-02-01','faturado',false,NULL,1),
 ('c','2026-01-01','faturado',false,NULL,1),
 ('c','2026-01-11','faturado',false,NULL,1),
 ('c','2026-01-21','faturado',false,NULL,1),
 ('c','2026-03-02','faturado',false,NULL,1),
 ('d',NULL,'faturado',false,'2026-01-01 03:00:00+00',1),
 ('d',NULL,'faturado',false,'2026-01-11 02:00:00+00',1),
 ('d',NULL,'faturado',false,'2026-01-30 12:00:00+00',1);
CREATE TABLE public.cli(nome text PRIMARY KEY, uid uuid);
INSERT INTO public.cli VALUES ('a','00000000-0000-0000-0000-00000000000a'),('b','00000000-0000-0000-0000-00000000000b'),
                              ('c','00000000-0000-0000-0000-00000000000c'),('d','00000000-0000-0000-0000-00000000000d');
WITH so AS (
  INSERT INTO public.sales_orders(customer_user_id, status, deleted_at, order_date_kpi, created_at)
  SELECT c.uid, p.status, CASE WHEN p.apagado THEN now() END, p.dia, COALESCE(p.criado, p.dia::timestamptz)
  FROM pedido p JOIN public.cli c ON c.nome = p.cli
  RETURNING id, customer_user_id, status, order_date_kpi, created_at
)
-- Os dados do pedido vêm do RETURNING: a linha recém-inserida pelo CTE NÃO é visível num scan de
-- sales_orders dentro da mesma instrução (foi o que deixou S1 vácuo na 1ª rodada).
INSERT INTO public.order_items(sales_order_id, customer_user_id, product_id, unit_price, quantity)
SELECT so.id, so.customer_user_id, gen_random_uuid(), 10, 1
FROM so
JOIN public.cli c ON c.uid = so.customer_user_id
JOIN pedido p ON p.cli = c.nome AND p.status = so.status
             AND COALESCE(p.dia::text, p.criado::text) = COALESCE(so.order_date_kpi::text, so.created_at::text)
CROSS JOIN LATERAL generate_series(1, p.itens);
INSERT INTO public.farmer_client_scores(customer_user_id, farmer_id, avg_repurchase_interval)
SELECT uid, gen_random_uuid(), 30 FROM public.cli;
CREATE TABLE public.antes AS SELECT * FROM public.get_customer_sales_summary();
SQL

echo "=== aplica a migration: $MIG ==="
if P -q -f "$MIG" >/tmp/pg-${SLUG}-mig.log 2>&1; then ok "migration aplicou (exit 0)"; else bad "migration FALHOU: $(tail -c 400 /tmp/pg-${SLUG}-mig.log)"; fi

intervalo() { Pq -c "SELECT COALESCE(s.intervalo_mediano_dias::text,'NULL') FROM public.get_customer_sales_summary() s JOIN public.cli c ON c.uid = s.customer_user_id WHERE c.nome = '$1'"; }

echo "=== S — get_customer_sales_summary ==="
eq "S1 antes−depois nas 6 colunas antigas" "$(Pq -c "SELECT count(*) FROM (SELECT * FROM public.antes EXCEPT SELECT customer_user_id,days_since_last_purchase,total_revenue,revenue_180d,item_count,category_count FROM public.get_customer_sales_summary()) x")" "0"
eq "S1 depois−antes nas 6 colunas antigas" "$(Pq -c "SELECT count(*) FROM (SELECT customer_user_id,days_since_last_purchase,total_revenue,revenue_180d,item_count,category_count FROM public.get_customer_sales_summary() EXCEPT SELECT * FROM public.antes) x")" "0"
eq "S1 sentinela: o fixture tem os 4 clientes (EXCEPT sobre vazio seria vácuo)" "$(Pq -c "SELECT count(*) FROM public.antes")" "4"
eq "S1 itens válidos de A (1+2+1; cancelado/apagado fora)" "$(Pq -c "SELECT a.item_count FROM public.antes a JOIN public.cli c ON c.uid=a.customer_user_id WHERE c.nome='a'")" "4"
eq "S1 mesmo número de linhas" "$(Pq -c "SELECT count(*) FROM public.get_customer_sales_summary()")" "$(Pq -c "SELECT count(*) FROM public.antes")"
eq "S2+S4 cliente A: mediana(10,20), sem cancelado/apagado" "$(intervalo a)" "15"
eq "S3 cliente B: 2 dias → NULL" "$(intervalo b)" "NULL"
eq "S2 cliente C: mediana(10,10,40)" "$(intervalo c)" "10"
eq "S5 cliente D: dia de SP do created_at" "$(intervalo d)" "14.5"
eq "S6 coluna nova é a última" "$(Pq -c "SELECT pg_get_function_result('public.get_customer_sales_summary()'::regprocedure)")" \
   "TABLE(customer_user_id uuid, days_since_last_purchase integer, total_revenue numeric, revenue_180d numeric, item_count bigint, category_count bigint, intervalo_mediano_dias numeric)"

echo "=== A — apply_score_updates ==="
payload() { # $1 = cliente, $2 = trecho extra do json (com vírgula inicial) ou vazio
  Pq -c "SELECT jsonb_build_array(jsonb_build_object('id', f.id, 'health_score', 1, 'health_class', 'critico',
    'churn_risk', 99, 'priority_score', 1, 'rf_score', 0, 'g_score', 0, 'days_since_last_purchase', 9,
    'avg_monthly_spend_180d', 0, 'category_count', 0, 'calculated_at', now(), 'updated_at', now()) || '{${2}}'::jsonb)
    FROM public.farmer_client_scores f JOIN public.cli c ON c.uid = f.customer_user_id WHERE c.nome = '$1'"
}
arv() { Pq -c "SELECT COALESCE(f.avg_repurchase_interval::text,'NULL') FROM public.farmer_client_scores f JOIN public.cli c ON c.uid = f.customer_user_id WHERE c.nome = '$1'"; }
Ps -c "SELECT public.apply_score_updates('$(payload a '"avg_repurchase_interval": 15')'::jsonb, NULL)"
eq "A1 chave com número grava" "$(arv a)" "15"
Ps -c "SELECT public.apply_score_updates('$(payload b '"avg_repurchase_interval": null')'::jsonb, NULL)"
eq "A2 chave com null grava NULL sobre o 30 legado" "$(arv b)" "NULL"
Ps -c "SELECT public.apply_score_updates('$(payload c '')'::jsonb, NULL)"
eq "A3 chave ausente preserva" "$(arv c)" "30"
eq "A3 e o resto da linha foi escrito" "$(Pq -c "SELECT f.churn_risk FROM public.farmer_client_scores f JOIN public.cli c ON c.uid=f.customer_user_id WHERE c.nome='c'")" "99"

echo "=== G — ACL ==="
eq "G1 anon sem EXECUTE" "$(Pq -c "SELECT has_function_privilege('anon','public.get_customer_sales_summary()','EXECUTE')")" "f"
eq "G1 authenticated sem EXECUTE" "$(Pq -c "SELECT has_function_privilege('authenticated','public.get_customer_sales_summary()','EXECUTE')")" "f"
eq "G1 PUBLIC fora do ACL" "$(Pq -c "SELECT count(*) FROM pg_proc p, aclexplode(p.proacl) a WHERE p.oid='public.get_customer_sales_summary()'::regprocedure AND a.grantee=0")" "0"
eq "G1 service_role com EXECUTE" "$(Pq -c "SELECT has_function_privilege('service_role','public.get_customer_sales_summary()','EXECUTE')")" "t"
eq "G1 sandbox_exec preservado" "$(Pq -c "SELECT has_function_privilege('sandbox_exec_fzvklzpomgnyikkfkzai','public.get_customer_sales_summary()','EXECUTE')")" "t"
eq "G1 apply_score_updates: authenticated segue barrado" "$(Pq -c "SELECT has_function_privilege('authenticated','public.apply_score_updates(jsonb,text)','EXECUTE')")" "f"

echo "=== D — DEFAULT ==="
Ps -c "INSERT INTO public.farmer_client_scores(customer_user_id, farmer_id) VALUES (gen_random_uuid(), gen_random_uuid())"
eq "D1 INSERT sem a chave → NULL (não 0)" "$(Pq -c "SELECT count(*) FROM public.farmer_client_scores WHERE avg_repurchase_interval IS NULL AND customer_user_id NOT IN (SELECT uid FROM public.cli)")" "1"

echo "=== I — idempotência ==="
if P -q -f "$MIG" >/tmp/pg-${SLUG}-mig2.log 2>&1; then ok "I1 re-aplicar passa"; else bad "I1 re-aplicar FALHOU: $(tail -c 300 /tmp/pg-${SLUG}-mig2.log)"; fi

echo "=== N — PRE anti-deriva ==="
Ps -c "CREATE OR REPLACE FUNCTION public.apply_score_updates(p_updates jsonb, p_run_id text DEFAULT NULL) RETURNS integer LANGUAGE plpgsql SET search_path TO 'public' AS \$f\$ BEGIN RETURN -1; END \$f\$"
ANTES_N1="$(Pq -c "SELECT md5(prosrc) FROM pg_proc WHERE oid='public.get_customer_sales_summary()'::regprocedure")"
if P -q -f "$MIG" >/tmp/pg-${SLUG}-mig3.log 2>&1; then
  bad "N1 migration passou com corpo vivo desconhecido"
else
  if grep -q 'PRE FALHOU: apply_score_updates' /tmp/pg-${SLUG}-mig3.log; then ok "N1 abortou pela PRE (ramo certo)"; else bad "N1 abortou por OUTRO motivo: $(tail -c 300 /tmp/pg-${SLUG}-mig3.log)"; fi
fi
eq "N1 nada mudou (apply sabotado intocado)" "$(Pq -c "SELECT prosrc LIKE '%RETURN -1%' FROM pg_proc WHERE oid='public.apply_score_updates(jsonb,text)'::regprocedure")" "t"
eq "N1 nada mudou (summary intocada)" "$(Pq -c "SELECT md5(prosrc) FROM pg_proc WHERE oid='public.get_customer_sales_summary()'::regprocedure")" "$ANTES_N1"

echo
echo "RESULTADO: $PASS OK, $FAIL FAIL"
[ "$FAIL" -eq 0 ] || exit 1
echo "TESTE_SCORES_INTERVALO_OK"
