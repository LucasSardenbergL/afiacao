#!/usr/bin/env bash
# Teste PG17 da defasagem por cliente (Fase 2b). Money-path (RPC só-leitura).
# Caminho LEVE: stubs mínimos do Supabase (auth/app_role/has_role/user_roles/
# pode_ver_carteira_completa + order_items/sales_orders/inventory_position) + as
# migrations NOVAS (20260627180000 cmc_snapshot, 20260627180100 get_defasagem_cliente)
# e EXECUTA os asserts:
#   D1  defasado básico (custo +20%, preço não acompanhou → defasado, p_req certo)
#   D2  snapshot FORA da janela ±7d → neutro (Codex #1, o FP crítico) — NÃO defasado
#   D3  desconto (order_items.discount>0) → neutro
#   D4  cent-rounding NÃO dispara (fronteira da tolerância)
#   D5  C_now stale (synced_at > 48h) → sem_custo_atual_fresco
#   D6  multi-pedido no MESMO dia → média ponderada por quantity
#   D7  status não-final (rascunho/cancelado/orcamento) EXCLUÍDO da âncora
#   D8  account-aware: mesmo código em 2 contas → âncora da conta certa + FALSIFICAÇÃO
#   D9  role-gate: gestor vê c_*, vendedora só p_req/status + FALSIFICAÇÃO
#   D10 REVOKE anon (permission denied for function)
#   D11 employee GERENCIAL é BARRADO pelo gate VIVO (private.cap_custo_ler, pós-E2) — o único
#       assert que o separa do gate anterior (X-D11 regride o gate da RPC, exige vermelho)
#   D12 contraprova: os 2 gates divergem SÓ no gerencial (X-D12 sabota o seed, exige vermelho)
#   D13 employee ESTRATÉGICO vê — impede D11 de passar por vacuidade (X-D13 exige vermelho)
# ⚠️ RLS só p/ não-superuser; psql roda como postgres (bypassa RLS) → A RPC é SECURITY
# DEFINER com gate INTERNO (has_role(auth.uid())) → asserts da RPC só setam test.uid;
# o REVOKE (D10) usa SET ROLE anon. Assert negativo: captura SQLSTATE esperada + re-lança.
# Base: db/test-cockpit-preco.sh. Pré-req: brew install postgresql@17.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT=5447   # porta dedicada (cockpit usa 5443; KB 5441; outros 5433/5436/5439)
DATA="$(mktemp -d /tmp/pgtest-defasagem.XXXXXX)/data"
export LC_ALL=C LANG=C

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER}"; exit 1; }

CELLAR="$(brew --prefix postgresql@${PGVER})"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l /tmp/pg-defasagem.log -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres defasagem_verify
P() { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d defasagem_verify "$@"; }

echo "→ stubs mínimos do Supabase (roles, auth, app_role, has_role, pode_ver_carteira_completa, tabelas)…"
P -v ON_ERROR_STOP=1 -q <<'SQL'
DO $$ BEGIN CREATE ROLE anon;          EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE service_role;  EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.uid', true), '')::uuid $f$;

DO $$ BEGIN CREATE TYPE public.app_role AS ENUM ('employee','customer','master'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE TABLE IF NOT EXISTS public.user_roles (
  user_id uuid NOT NULL, role public.app_role NOT NULL, PRIMARY KEY (user_id, role)
);
CREATE OR REPLACE FUNCTION public.has_role(_uid uuid, _role public.app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $f$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _uid AND role = _role);
$f$;
-- Gate de número, com o corpo FIEL da prod (medido via pg_get_functiondef, migration 20260526040000):
--   master OR (employee AND commercial_role IN ('gerencial','estrategico','super_admin'))
-- ⚠️ O stub ANTERIOR era `SELECT has_role(_uid,'master')` — master-only. Isso COLAPSAVA a política
-- real numa degenerada: as 3 personas semeadas (master / employee-sem-commercial_role / customer)
-- recebem o MESMO veredito das duas, então nenhum assert deste arquivo via a diferença. Medido:
-- trocar o gate por outra política que só divirja no employee GERENCIAL mantinha este harness
-- VERDE com exit 0. D11/D12 abaixo separam as duas; X-D11/X-D12 exigem o vermelho.
-- A FALSIFICAÇÃO (D9) reescreve esta função.
CREATE TYPE public.commercial_role AS ENUM ('vendedor','gerencial','estrategico','super_admin');
CREATE TABLE public.commercial_roles (user_id uuid NOT NULL, commercial_role public.commercial_role NOT NULL);
CREATE OR REPLACE FUNCTION public.get_commercial_role(_user_id uuid)
RETURNS public.commercial_role LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $f$
  SELECT commercial_role FROM public.commercial_roles WHERE user_id = _user_id LIMIT 1;
$f$;
CREATE OR REPLACE FUNCTION public.pode_ver_carteira_completa(_uid uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $f$
  SELECT public.has_role(_uid, 'master'::public.app_role)
      OR (public.has_role(_uid, 'employee'::public.app_role)
          AND public.get_commercial_role(_uid) IN ('gerencial'::public.commercial_role,
              'estrategico'::public.commercial_role, 'super_admin'::public.commercial_role));
$f$;

-- private.cap_custo_ler — o gate que a RPC usa EM PRODUÇÃO hoje (medido em pg_get_functiondef:
-- `v_pode_num := private.cap_custo_ler(auth.uid())`). Corpo fiel: master OR (employee AND
-- commercial_role IN ('estrategico','super_admin')) — ele EXCLUI o `gerencial`, que
-- `pode_ver_carteira_completa` INCLUI: a única persona em que os dois gates divergem.
CREATE SCHEMA IF NOT EXISTS private;
CREATE OR REPLACE FUNCTION private.cap_custo_ler(_uid uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $f$
  SELECT COALESCE(_uid IS NOT NULL AND (
    public.has_role(_uid, 'master'::public.app_role)
    OR (public.has_role(_uid, 'employee'::public.app_role)
        AND EXISTS (SELECT 1 FROM public.commercial_roles cr
                     WHERE cr.user_id = _uid
                       AND cr.commercial_role IN ('estrategico'::public.commercial_role,
                           'super_admin'::public.commercial_role)))), false);
$f$;

-- order_items (colunas que a RPC lê).
CREATE TABLE IF NOT EXISTS public.order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_user_id uuid NOT NULL,
  omie_codigo_produto bigint,
  product_id uuid,
  quantity numeric NOT NULL DEFAULT 1,
  unit_price numeric NOT NULL DEFAULT 0,
  discount numeric,
  sales_order_id uuid NOT NULL,
  created_at timestamptz DEFAULT now()
);
-- sales_orders (status/account/order_date_kpi/omie_pedido_id/omie_payload/discount/deleted_at).
CREATE TABLE IF NOT EXISTS public.sales_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account text NOT NULL DEFAULT 'vendas',
  status text NOT NULL DEFAULT 'faturado',
  order_date_kpi date,
  omie_pedido_id bigint,
  omie_payload jsonb,
  discount numeric NOT NULL DEFAULT 0,
  deleted_at timestamptz,
  customer_user_id uuid NOT NULL
);
-- inventory_position (C_now freshest por synced_at).
CREATE TABLE IF NOT EXISTS public.inventory_position (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  omie_codigo_produto bigint NOT NULL,
  cmc numeric DEFAULT 0,
  account text NOT NULL DEFAULT 'vendas',
  synced_at timestamptz DEFAULT now()
);
SQL

echo "→ migration 20260627180000_cmc_snapshot.sql…"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/migrations/20260627180000_cmc_snapshot.sql" >/dev/null
echo "→ migration 20260627180100_get_defasagem_cliente.sql…"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/migrations/20260627180100_get_defasagem_cliente.sql" >/dev/null

# ── FU4/E2: a RPC passa a usar private.cap_custo_ler ────────────────────────────────────────
# Em PRODUÇÃO get_defasagem_cliente NÃO usa mais `pode_ver_carteira_completa`: a migration
# 20260718190000_authz_capability_matrix_e2.sql reescreve a DEFINIÇÃO VIVA e troca só a
# atribuição do gate (medido hoje em prod: `v_pode_num := private.cap_custo_ler(auth.uid())`).
# Aplicar a E2 inteira aqui é inviável (64 policies sobre dezenas de tabelas que este harness leve
# não tem), então reproduzimos a MESMA transformação com o MESMO guard: se o padrão não casar,
# ABORTA em vez de deixar o harness provando um gate que não está no ar.
echo "→ FU4/E2: reescreve o gate de get_defasagem_cliente → private.cap_custo_ler…"
P -v ON_ERROR_STOP=1 -q <<'SQL'
DO $reescreve$
DECLARE
  v_oid  regprocedure := to_regprocedure('public.get_defasagem_cliente(jsonb,uuid)');
  v_def  text; v_novo text; v_ocorr int;
  c_re_antigo constant text := '(public\.)?pode_ver_carteira_completa\s*\(';
BEGIN
  IF v_oid IS NULL THEN
    RAISE EXCEPTION 'E2/harness: public.get_defasagem_cliente(jsonb,uuid) nao existe apos as migrations';
  END IF;
  v_def := pg_get_functiondef(v_oid);
  SELECT count(*) INTO v_ocorr FROM regexp_matches(v_def, c_re_antigo, 'g');
  IF v_ocorr <> 1 THEN
    RAISE EXCEPTION 'E2/harness: esperava 1 chamada do gate antigo, encontrei % — corpo divergente do medido', v_ocorr;
  END IF;
  v_novo := regexp_replace(
    v_def,
    'v_pode_num\s*:=\s*(public\.)?pode_ver_carteira_completa\s*\(\s*auth\.uid\(\)\s*\)',
    'v_pode_num := private.cap_custo_ler(auth.uid())', 'g');
  IF v_novo = v_def THEN
    RAISE EXCEPTION 'E2/harness: padrao do gate nao casou — nao aplicar no-op silencioso';
  END IF;
  IF v_novo ~ c_re_antigo THEN
    RAISE EXCEPTION 'E2/harness: sobrou chamada ao gate antigo apos a troca';
  END IF;
  EXECUTE v_novo;
END $reescreve$;
SQL
GATE_VIVO=$(P -tA -c "SELECT substring(pg_get_functiondef('public.get_defasagem_cliente(jsonb,uuid)'::regprocedure) from 'v_pode_num\s*:=[^;]*;');")
case "$GATE_VIVO" in
  *"private.cap_custo_ler(auth.uid())"*) echo "  OK gate vivo = private.cap_custo_ler (igual à prod)" ;;
  *) echo "  FALHOU: gate vivo inesperado após a reescrita: $GATE_VIVO"; exit 1 ;;
esac

echo "→ seed (roles + grants + âncoras + snapshots + C_now)…"
P -v ON_ERROR_STOP=1 -q <<'SQL'
-- a=master(gestor) b=employee(vendedora) c=customer
INSERT INTO public.user_roles (user_id, role) VALUES
  ('00000000-0000-0000-0000-00000000000a','master'::public.app_role),
  ('00000000-0000-0000-0000-00000000000b','employee'::public.app_role),
  ('00000000-0000-0000-0000-00000000000c','customer'::public.app_role),
  -- d=employee GERENCIAL: a ÚNICA persona em que a política real e a degenerada (master-only)
  -- discordam. Sem ela no seed, o bloco de authz não prova política — só "master vs resto".
  ('00000000-0000-0000-0000-00000000000d','employee'::public.app_role),
  -- e=employee ESTRATÉGICO: sem ele, "o gerencial não vê" passaria por VACUIDADE (ninguém vê).
  ('00000000-0000-0000-0000-00000000000e','employee'::public.app_role)
ON CONFLICT DO NOTHING;
INSERT INTO public.commercial_roles (user_id, commercial_role) VALUES
  ('00000000-0000-0000-0000-00000000000d','gerencial'::public.commercial_role),
  ('00000000-0000-0000-0000-00000000000e','estrategico'::public.commercial_role);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.cmc_snapshot, public.order_items, public.sales_orders, public.inventory_position TO authenticated, service_role;

-- cliente de teste
-- CL = 11111111-1111-1111-1111-111111111111
-- D1: oben, produto 1001. Âncora 20/03/2026 (dInc), pLast 100. C_last 60 (snapshot 20/03).
--     C_now 72 (+20%). preço carrinho 100 (não acompanhou) → defasado, p_req 120.
INSERT INTO public.sales_orders (id, account, status, order_date_kpi, omie_pedido_id, omie_payload, customer_user_id) VALUES
  ('a0000000-0000-0000-0000-000000000001','vendas','faturado','2026-03-20', 5001,
   '{"infoCadastro":{"dInc":"20/03/2026"}}'::jsonb, '11111111-1111-1111-1111-111111111111');
INSERT INTO public.order_items (customer_user_id, omie_codigo_produto, quantity, unit_price, sales_order_id) VALUES
  ('11111111-1111-1111-1111-111111111111', 1001, 4, 100, 'a0000000-0000-0000-0000-000000000001');
INSERT INTO public.cmc_snapshot (account, omie_codigo_produto, data_posicao, cmc) VALUES
  ('vendas', 1001, '2026-03-20', 60);
INSERT INTO public.inventory_position (omie_codigo_produto, account, cmc, synced_at) VALUES
  (1001, 'vendas', 72, now());

-- D2 (FP crítico): produto 1002, âncora 20/05/2026, MAS snapshot só em 30/04 (>±7d).
--     C_now 90 (alto). Sem snapshot na janela → neutro/sem_custo_historico (NÃO defasado).
INSERT INTO public.sales_orders (id, account, status, order_date_kpi, omie_pedido_id, omie_payload, customer_user_id) VALUES
  ('a0000000-0000-0000-0000-000000000002','vendas','faturado','2026-05-20', 5002,
   '{"infoCadastro":{"dInc":"20/05/2026"}}'::jsonb, '11111111-1111-1111-1111-111111111111');
INSERT INTO public.order_items (customer_user_id, omie_codigo_produto, quantity, unit_price, sales_order_id) VALUES
  ('11111111-1111-1111-1111-111111111111', 1002, 2, 100, 'a0000000-0000-0000-0000-000000000002');
INSERT INTO public.cmc_snapshot (account, omie_codigo_produto, data_posicao, cmc) VALUES
  ('vendas', 1002, '2026-04-30', 50);   -- 20 dias antes da âncora → fora da janela ±7d
INSERT INTO public.inventory_position (omie_codigo_produto, account, cmc, synced_at) VALUES
  (1002, 'vendas', 90, now());

-- D3 (desconto): produto 1003, âncora com discount no item → neutro/desconto_nao_provado.
INSERT INTO public.sales_orders (id, account, status, order_date_kpi, omie_pedido_id, omie_payload, customer_user_id) VALUES
  ('a0000000-0000-0000-0000-000000000003','vendas','faturado','2026-03-20', 5003,
   '{"infoCadastro":{"dInc":"20/03/2026"}}'::jsonb, '11111111-1111-1111-1111-111111111111');
INSERT INTO public.order_items (customer_user_id, omie_codigo_produto, quantity, unit_price, discount, sales_order_id) VALUES
  ('11111111-1111-1111-1111-111111111111', 1003, 1, 100, 5, 'a0000000-0000-0000-0000-000000000003');
INSERT INTO public.cmc_snapshot (account, omie_codigo_produto, data_posicao, cmc) VALUES ('vendas',1003,'2026-03-20',60);
INSERT INTO public.inventory_position (omie_codigo_produto, account, cmc, synced_at) VALUES (1003,'vendas',72,now());

-- D4 (fronteira): produto 1004. C_last 60, C_now 66 (+10%). pLast 100 (>C_last, markup positivo),
--     preço carrinho 109,96 (+9,96%) → gap de pontos 0,04pp < TOL 3pp → em_dia (cent não dispara).
INSERT INTO public.sales_orders (id, account, status, order_date_kpi, omie_pedido_id, omie_payload, customer_user_id) VALUES
  ('a0000000-0000-0000-0000-000000000004','vendas','faturado','2026-03-20', 5004,
   '{"infoCadastro":{"dInc":"20/03/2026"}}'::jsonb, '11111111-1111-1111-1111-111111111111');
INSERT INTO public.order_items (customer_user_id, omie_codigo_produto, quantity, unit_price, sales_order_id) VALUES
  ('11111111-1111-1111-1111-111111111111', 1004, 1, 100, 'a0000000-0000-0000-0000-000000000004');
INSERT INTO public.cmc_snapshot (account, omie_codigo_produto, data_posicao, cmc) VALUES ('vendas',1004,'2026-03-20',60);
INSERT INTO public.inventory_position (omie_codigo_produto, account, cmc, synced_at) VALUES (1004,'vendas',66,now());

-- D5 (C_now stale): produto 1005. C_now synced há 72h (>48h) → sem_custo_atual_fresco.
INSERT INTO public.sales_orders (id, account, status, order_date_kpi, omie_pedido_id, omie_payload, customer_user_id) VALUES
  ('a0000000-0000-0000-0000-000000000005','vendas','faturado','2026-03-20', 5005,
   '{"infoCadastro":{"dInc":"20/03/2026"}}'::jsonb, '11111111-1111-1111-1111-111111111111');
INSERT INTO public.order_items (customer_user_id, omie_codigo_produto, quantity, unit_price, sales_order_id) VALUES
  ('11111111-1111-1111-1111-111111111111', 1005, 1, 100, 'a0000000-0000-0000-0000-000000000005');
INSERT INTO public.cmc_snapshot (account, omie_codigo_produto, data_posicao, cmc) VALUES ('vendas',1005,'2026-03-20',60);
INSERT INTO public.inventory_position (omie_codigo_produto, account, cmc, synced_at) VALUES (1005,'vendas',72, now() - interval '72 hours');

-- D6 (multi-pedido mesmo dia): produto 1006. DOIS pedidos em 20/03: q2@100 e q8@90.
--     média ponderada = (2*100+8*90)/10 = 92. C_last 60, C_now 80 (+33%). pReq=92*(80/60)=122,67.
INSERT INTO public.sales_orders (id, account, status, order_date_kpi, omie_pedido_id, omie_payload, customer_user_id) VALUES
  ('a0000000-0000-0000-0000-000000000061','vendas','faturado','2026-03-20', 5061,'{"infoCadastro":{"dInc":"20/03/2026"}}'::jsonb,'11111111-1111-1111-1111-111111111111'),
  ('a0000000-0000-0000-0000-000000000062','vendas','faturado','2026-03-20', 5062,'{"infoCadastro":{"dInc":"20/03/2026"}}'::jsonb,'11111111-1111-1111-1111-111111111111');
INSERT INTO public.order_items (customer_user_id, omie_codigo_produto, quantity, unit_price, sales_order_id) VALUES
  ('11111111-1111-1111-1111-111111111111', 1006, 2, 100, 'a0000000-0000-0000-0000-000000000061'),
  ('11111111-1111-1111-1111-111111111111', 1006, 8,  90, 'a0000000-0000-0000-0000-000000000062');
INSERT INTO public.cmc_snapshot (account, omie_codigo_produto, data_posicao, cmc) VALUES ('vendas',1006,'2026-03-20',60);
INSERT INTO public.inventory_position (omie_codigo_produto, account, cmc, synced_at) VALUES (1006,'vendas',80,now());

-- D7 (status não-final): produto 1007. ÚNICO pedido é 'orcamento' → excluído → sem_historico.
INSERT INTO public.sales_orders (id, account, status, order_date_kpi, omie_pedido_id, omie_payload, customer_user_id) VALUES
  ('a0000000-0000-0000-0000-000000000007','vendas','orcamento','2026-03-20', 5007,'{"infoCadastro":{"dInc":"20/03/2026"}}'::jsonb,'11111111-1111-1111-1111-111111111111');
INSERT INTO public.order_items (customer_user_id, omie_codigo_produto, quantity, unit_price, sales_order_id) VALUES
  ('11111111-1111-1111-1111-111111111111', 1007, 1, 100, 'a0000000-0000-0000-0000-000000000007');
INSERT INTO public.cmc_snapshot (account, omie_codigo_produto, data_posicao, cmc) VALUES ('vendas',1007,'2026-03-20',60);
INSERT INTO public.inventory_position (omie_codigo_produto, account, cmc, synced_at) VALUES (1007,'vendas',72,now());

-- D8 (account-aware): produto 2080, MESMO código em 2 contas.
--   conta colacor_vendas: âncora pLast 200, snapshot 100, C_now 130 (+30%) → defasado (consultado como 'colacor').
--   conta vendas (oben):  âncora pLast 50,  snapshot 40,  C_now 44  → ruído. Se vazar p/ colacor, contamina.
INSERT INTO public.sales_orders (id, account, status, order_date_kpi, omie_pedido_id, omie_payload, customer_user_id) VALUES
  ('a0000000-0000-0000-0000-000000000081','colacor_vendas','faturado','2026-03-20', 5081,'{"infoCadastro":{"dInc":"20/03/2026"}}'::jsonb,'11111111-1111-1111-1111-111111111111'),
  ('a0000000-0000-0000-0000-000000000082','vendas','faturado','2026-03-21', 5082,'{"infoCadastro":{"dInc":"21/03/2026"}}'::jsonb,'11111111-1111-1111-1111-111111111111');  -- 21/03 = +recente → a falsificação account-blind (ORDER BY data DESC) escolhe ESTE (pLast 50) e vaza
INSERT INTO public.order_items (customer_user_id, omie_codigo_produto, quantity, unit_price, sales_order_id) VALUES
  ('11111111-1111-1111-1111-111111111111', 2080, 1, 200, 'a0000000-0000-0000-0000-000000000081'),
  ('11111111-1111-1111-1111-111111111111', 2080, 1,  50, 'a0000000-0000-0000-0000-000000000082');
INSERT INTO public.cmc_snapshot (account, omie_codigo_produto, data_posicao, cmc) VALUES
  ('colacor_vendas', 2080, '2026-03-20', 100),
  ('vendas',         2080, '2026-03-20', 40);
INSERT INTO public.inventory_position (omie_codigo_produto, account, cmc, synced_at) VALUES
  (2080, 'colacor_vendas', 130, now()),
  (2080, 'vendas',          44, now());
SQL
echo ""
echo "→ ASSERT D1 — defasado básico (custo +20%, preço não acompanhou → defasado, p_req 120):"
P -v ON_ERROR_STOP=1 <<'SQL'
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL test.uid = '00000000-0000-0000-0000-00000000000a';  -- master
  SELECT (public.get_defasagem_cliente('[{"empresa":"oben","codigo":1001,"preco":100}]'::jsonb,
          '11111111-1111-1111-1111-111111111111'::uuid))->0 INTO r;
  IF r->>'status_defasagem' <> 'defasado' THEN
    RAISE EXCEPTION 'D1 FALHOU: status=% motivo=% (esperado defasado)', r->>'status_defasagem', r->>'motivo';
  END IF;
  IF (r->>'p_req')::numeric <> 120 THEN
    RAISE EXCEPTION 'D1b FALHOU: p_req=% (esperado 120 = 100*72/60)', r->>'p_req';
  END IF;
  IF r->>'data_ancora' <> '03/2026' THEN
    RAISE EXCEPTION 'D1c FALHOU: data_ancora=% (esperado 03/2026 via dInc)', r->>'data_ancora';
  END IF;
  RAISE NOTICE 'OK D1 — defasado, p_req 120, âncora 03/2026';
END $$;
SQL

echo "→ ASSERT D2 — snapshot FORA da janela ±7d → neutro (Codex #1, FP crítico), NÃO defasado:"
P -v ON_ERROR_STOP=1 <<'SQL'
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL test.uid = '00000000-0000-0000-0000-00000000000a';
  SELECT (public.get_defasagem_cliente('[{"empresa":"oben","codigo":1002,"preco":100}]'::jsonb,
          '11111111-1111-1111-1111-111111111111'::uuid))->0 INTO r;
  IF r->>'status_defasagem' <> 'neutro' OR r->>'motivo' <> 'sem_custo_historico' THEN
    RAISE EXCEPTION 'D2 FALHOU: status=% motivo=% (esperado neutro/sem_custo_historico — snapshot a 20d da âncora)', r->>'status_defasagem', r->>'motivo';
  END IF;
  RAISE NOTICE 'OK D2 — snapshot fora de ±7d → neutro (não fabricou alta-fantasma)';
END $$;
SQL

echo "→ ASSERT D3 — desconto no item → neutro/desconto_nao_provado:"
P -v ON_ERROR_STOP=1 <<'SQL'
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL test.uid = '00000000-0000-0000-0000-00000000000a';
  SELECT (public.get_defasagem_cliente('[{"empresa":"oben","codigo":1003,"preco":100}]'::jsonb,
          '11111111-1111-1111-1111-111111111111'::uuid))->0 INTO r;
  IF r->>'status_defasagem' <> 'neutro' OR r->>'motivo' <> 'desconto_nao_provado' THEN
    RAISE EXCEPTION 'D3 FALHOU: status=% motivo=% (esperado neutro/desconto_nao_provado)', r->>'status_defasagem', r->>'motivo';
  END IF;
  RAISE NOTICE 'OK D3 — desconto → neutro/desconto_nao_provado';
END $$;
SQL

echo "→ ASSERT D4 — fronteira da tolerância (custo +10% / preço +9,96%) → em_dia (cent não dispara):"
P -v ON_ERROR_STOP=1 <<'SQL'
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL test.uid = '00000000-0000-0000-0000-00000000000a';
  SELECT (public.get_defasagem_cliente('[{"empresa":"oben","codigo":1004,"preco":109.96}]'::jsonb,
          '11111111-1111-1111-1111-111111111111'::uuid))->0 INTO r;
  IF r->>'status_defasagem' <> 'em_dia' THEN
    RAISE EXCEPTION 'D4 FALHOU: status=% (esperado em_dia — gap 0,04pp < TOL 3pp)', r->>'status_defasagem';
  END IF;
  RAISE NOTICE 'OK D4 — fronteira da tolerância → em_dia';
END $$;
SQL

echo "→ ASSERT D5 — C_now stale (synced há 72h) → sem_custo_atual_fresco:"
P -v ON_ERROR_STOP=1 <<'SQL'
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL test.uid = '00000000-0000-0000-0000-00000000000a';
  SELECT (public.get_defasagem_cliente('[{"empresa":"oben","codigo":1005,"preco":100}]'::jsonb,
          '11111111-1111-1111-1111-111111111111'::uuid))->0 INTO r;
  IF r->>'status_defasagem' <> 'sem_custo_atual_fresco' THEN
    RAISE EXCEPTION 'D5 FALHOU: status=% (esperado sem_custo_atual_fresco — synced há 72h > 48h)', r->>'status_defasagem';
  END IF;
  RAISE NOTICE 'OK D5 — C_now stale → sem_custo_atual_fresco';
END $$;
SQL

echo "→ ASSERT D6 — multi-pedido mesmo dia → média ponderada (pLast 92 → p_req 122,67):"
P -v ON_ERROR_STOP=1 <<'SQL'
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL test.uid = '00000000-0000-0000-0000-00000000000a';  -- master (vê p_last)
  SELECT (public.get_defasagem_cliente('[{"empresa":"oben","codigo":1006,"preco":92}]'::jsonb,
          '11111111-1111-1111-1111-111111111111'::uuid))->0 INTO r;
  IF (r->>'p_last')::numeric <> 92 THEN
    RAISE EXCEPTION 'D6 FALHOU: p_last=% (esperado 92 = (2*100+8*90)/10 — média ponderada)', r->>'p_last';
  END IF;
  -- p_req = 92 * (80/60) = 122,666… → 122,67
  IF (r->>'p_req')::numeric <> 122.67 THEN
    RAISE EXCEPTION 'D6b FALHOU: p_req=% (esperado 122.67)', r->>'p_req';
  END IF;
  RAISE NOTICE 'OK D6 — média ponderada por quantity (p_last 92, p_req 122,67)';
END $$;
SQL

echo "→ ASSERT D7 — status não-final (orcamento) EXCLUÍDO da âncora → sem_historico:"
P -v ON_ERROR_STOP=1 <<'SQL'
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL test.uid = '00000000-0000-0000-0000-00000000000a';
  SELECT (public.get_defasagem_cliente('[{"empresa":"oben","codigo":1007,"preco":100}]'::jsonb,
          '11111111-1111-1111-1111-111111111111'::uuid))->0 INTO r;
  IF r->>'status_defasagem' <> 'sem_historico' THEN
    RAISE EXCEPTION 'D7 FALHOU: status=% (esperado sem_historico — único pedido é orcamento)', r->>'status_defasagem';
  END IF;
  RAISE NOTICE 'OK D7 — orcamento excluído da âncora → sem_historico';
END $$;
SQL
echo "→ ASSERT D8 — account-aware: mesmo código 2080 em 2 contas → âncora da conta certa:"
P -v ON_ERROR_STOP=1 <<'SQL'
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL test.uid = '00000000-0000-0000-0000-00000000000a';  -- master (vê c_last)
  -- consultado como 'colacor' (ponte → colacor_vendas): deve ver pLast 200, c_last 100, defasado.
  SELECT (public.get_defasagem_cliente('[{"empresa":"colacor","codigo":2080,"preco":200}]'::jsonb,
          '11111111-1111-1111-1111-111111111111'::uuid))->0 INTO r;
  IF r->>'status_defasagem' <> 'defasado' THEN
    RAISE EXCEPTION 'D8 FALHOU: status=% (esperado defasado na conta colacor)', r->>'status_defasagem';
  END IF;
  IF (r->>'c_last')::numeric <> 100 OR (r->>'p_last')::numeric <> 200 THEN
    RAISE EXCEPTION 'D8b FALHOU: c_last=% p_last=% (esperado 100/200 — conta colacor; se 40/50 vazou de vendas)', r->>'c_last', r->>'p_last';
  END IF;
  RAISE NOTICE 'OK D8 — âncora da conta colacor (c_last 100, p_last 200), não vazou de vendas';
END $$;
SQL
# FALSIFICAÇÃO D8: sabota a RPC removendo o filtro de conta (account = ANY → TRUE) e exige
# que a âncora ERRADA vaze (a de 'vendas' pode ganhar/contaminar). Prova que o filtro tem dente.
echo "  → FALSIFICAÇÃO D8 (sabota o filtro de conta na âncora → exige vazamento):"
P -v ON_ERROR_STOP=1 -q <<'SQL'
-- versão sabotada: troca "so.account = ANY(v_accounts)" por "TRUE" na CTE ancora.
-- (recria a função inteira com a 1 linha sabotada; restaurada logo depois pela migration.)
CREATE OR REPLACE FUNCTION public.get_defasagem_cliente_SABOTADA(p_itens jsonb, p_customer_user_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $sab$
DECLARE
  v_item jsonb; v_codigo bigint; v_accounts text[]; v_empresa text;
  v_p_last numeric; v_c_last numeric; v_data date;
BEGIN
  v_item := p_itens->0;
  v_empresa := lower(v_item->>'empresa'); v_codigo := (v_item->>'codigo')::bigint;
  v_accounts := CASE v_empresa WHEN 'colacor' THEN ARRAY['colacor_vendas','colacor'] ELSE ARRAY[v_empresa] END;
  -- SABOTAGEM: account = ANY trocado por TRUE → âncora account-blind.
  SELECT oi.unit_price INTO v_p_last
  FROM order_items oi JOIN sales_orders so ON so.id = oi.sales_order_id
  WHERE oi.customer_user_id = p_customer_user_id AND oi.omie_codigo_produto = v_codigo
    AND TRUE  -- <<< era so.account = ANY(v_accounts)
    AND so.status IN ('faturado','importado','separacao','enviado')
    AND so.omie_pedido_id IS NOT NULL AND so.deleted_at IS NULL
  ORDER BY so.order_date_kpi DESC LIMIT 1;
  RETURN jsonb_build_array(jsonb_build_object('p_last_blind', to_jsonb(v_p_last)));
END $sab$;
SQL
SAB=$(P -tA 2>&1 <<'SQL' || true
DO $$
DECLARE r jsonb; v numeric;
BEGIN
  SET LOCAL test.uid = '00000000-0000-0000-0000-00000000000a';
  SELECT (public.get_defasagem_cliente_SABOTADA('[{"empresa":"colacor","codigo":2080,"preco":200}]'::jsonb,
          '11111111-1111-1111-1111-111111111111'::uuid))->0 INTO r;
  v := (r->>'p_last_blind')::numeric;
  -- account-blind: pode pegar o pedido de 'vendas' (pLast 50) em vez do de colacor (200).
  IF v = 50 THEN RAISE NOTICE 'SAB_VAZOU'; ELSE RAISE NOTICE 'SAB_NAO p_last=%', v; END IF;
END $$;
SQL
)
if echo "$SAB" | grep -q 'SAB_VAZOU'; then
  echo "  OK D8 (falsificação) — sem o filtro de conta a âncora de 'vendas' (50) vazou p/ colacor → D8 tem dente"
else
  echo "  D8 (falsificação) — account-blind não vazou neste seed (ambos os pedidos têm a MESMA data; o desempate não escolheu 'vendas')."
  echo "  Ajuste o seed pra a âncora de 'vendas' ser mais RECENTE (ex. dInc 21/03) e re-rode, garantindo que o account-blind a escolha."
  exit 1
fi
P -v ON_ERROR_STOP=1 -q -c 'DROP FUNCTION IF EXISTS public.get_defasagem_cliente_SABOTADA(jsonb, uuid);'
echo "  OK D8 (limpeza) — função sabotada removida"
echo ""
echo "→ ASSERT D9 — role-gate: gestor vê c_*, vendedora só p_req/status + FALSIFICAÇÃO:"
P -v ON_ERROR_STOP=1 <<'SQL'
DO $$
DECLARE r jsonb;
BEGIN
  -- gestor (master): vê c_last/c_now/p_last/markup_anterior
  SET LOCAL test.uid = '00000000-0000-0000-0000-00000000000a';
  SELECT (public.get_defasagem_cliente('[{"empresa":"oben","codigo":1001,"preco":100}]'::jsonb,
          '11111111-1111-1111-1111-111111111111'::uuid))->0 INTO r;
  IF r->'c_last' = 'null'::jsonb OR r->'c_now' = 'null'::jsonb OR r->'p_last' = 'null'::jsonb THEN
    RAISE EXCEPTION 'D9a FALHOU: gestor não viu c_last/c_now/p_last';
  END IF;

  -- vendedora (employee): c_* / p_last / markup_anterior = null, MAS p_req e status presentes.
  SET LOCAL test.uid = '00000000-0000-0000-0000-00000000000b';
  SELECT (public.get_defasagem_cliente('[{"empresa":"oben","codigo":1001,"preco":100}]'::jsonb,
          '11111111-1111-1111-1111-111111111111'::uuid))->0 INTO r;
  IF r->'c_last' <> 'null'::jsonb OR r->'c_now' <> 'null'::jsonb
     OR r->'p_last' <> 'null'::jsonb OR r->'markup_anterior' <> 'null'::jsonb THEN
    RAISE EXCEPTION 'D9b FALHOU: vendedora viu absoluto (c_last=% c_now=% p_last=%)', r->>'c_last', r->>'c_now', r->>'p_last';
  END IF;
  IF r->>'status_defasagem' <> 'defasado' OR (r->>'p_req')::numeric <> 120 THEN
    RAISE EXCEPTION 'D9c FALHOU: vendedora não viu status/p_req (=%/%)', r->>'status_defasagem', r->>'p_req';
  END IF;
  RAISE NOTICE 'OK D9 — gestor vê c_*; vendedora vê só status/p_req (120), absolutos null';
END $$;
SQL
# FALSIFICAÇÃO D9: sabota o gate QUE A RPC USA (private.cap_custo_ler, pós-E2) → true; o c_last
# DEVE vazar p/ a vendedora. ⚠️ Sabotar `pode_ver_carteira_completa` não morde mais desde a E2.
echo "  → FALSIFICAÇÃO D9 (sabota private.cap_custo_ler → true → exige vazamento):"
P -v ON_ERROR_STOP=1 -q <<'SQL'
CREATE OR REPLACE FUNCTION private.cap_custo_ler(_uid uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $f$ SELECT true $f$;
SQL
SAB=$(P -tA 2>&1 <<'SQL' || true
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL test.uid = '00000000-0000-0000-0000-00000000000b';  -- employee
  SELECT (public.get_defasagem_cliente('[{"empresa":"oben","codigo":1001,"preco":100}]'::jsonb,
          '11111111-1111-1111-1111-111111111111'::uuid))->0 INTO r;
  IF r->'c_last' <> 'null'::jsonb AND (r->>'c_last')::numeric = 60 THEN RAISE NOTICE 'SAB_VAZOU';
  ELSE RAISE NOTICE 'SAB_NAO c_last=%', r->>'c_last'; END IF;
END $$;
SQL
)
echo "$SAB" | grep -q 'SAB_VAZOU' && echo "  OK D9 (falsificação) — gate furado vazou c_last 60 p/ a vendedora → D9 tem dente" || { echo "  D9 FALHOU (falsificação): $SAB"; exit 1; }
# Restaura o gate correto (corpo FIEL de prod — NÃO o master-only degenerado).
P -v ON_ERROR_STOP=1 -q <<'SQL'
CREATE OR REPLACE FUNCTION private.cap_custo_ler(_uid uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $f$
  SELECT COALESCE(_uid IS NOT NULL AND (
    public.has_role(_uid, 'master'::public.app_role)
    OR (public.has_role(_uid, 'employee'::public.app_role)
        AND EXISTS (SELECT 1 FROM public.commercial_roles cr
                     WHERE cr.user_id = _uid
                       AND cr.commercial_role IN ('estrategico'::public.commercial_role,
                           'super_admin'::public.commercial_role)))), false);
$f$;
SQL
echo "  OK D9 (restauração) — gate fiel à prod de volta"

# ═══════════════════════════════════════════════════════════════════════════════════════
# D11/D12/D13 — OS ASSERTS QUE SEPARAM AS DUAS POLÍTICAS (molde D7/D8 do #1761)
# D9 prova que o gate tem DENTE (furá-lo vaza c_last), mas não prova QUAL política ele é.
# O gate VIVO da RPC é `private.cap_custo_ler` (master + estratégico/super_admin); o ANTERIOR
# era `pode_ver_carteira_completa` (que INCLUI o gerencial). Master, employee sem
# commercial_role e customer recebem o MESMO veredito dos dois — o GERENCIAL é o discriminante.
# ═══════════════════════════════════════════════════════════════════════════════════════
echo ""
echo "→ ASSERT D11 — employee GERENCIAL é BARRADO (cap_custo_ler exclui; o gate velho liberaria):"
P -v ON_ERROR_STOP=1 <<'SQL'
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL test.uid = '00000000-0000-0000-0000-00000000000d';  -- employee GERENCIAL
  SELECT (public.get_defasagem_cliente('[{"empresa":"oben","codigo":1001,"preco":100}]'::jsonb,
          '11111111-1111-1111-1111-111111111111'::uuid))->0 INTO r;
  IF r->'c_last' <> 'null'::jsonb OR r->'c_now' <> 'null'::jsonb
     OR r->'p_last' <> 'null'::jsonb OR r->'markup_anterior' <> 'null'::jsonb THEN
    RAISE EXCEPTION 'D11 FALHOU: gerencial VIU os absolutos (c_last=% c_now=% p_last=%) — o gate voltou ao anterior',
      r->>'c_last', r->>'c_now', r->>'p_last';
  END IF;
  IF r->>'status_defasagem' <> 'defasado' OR (r->>'p_req')::numeric <> 120 THEN
    RAISE EXCEPTION 'D11b FALHOU: gerencial perdeu status/p_req (=%/%) — o corte foi longe demais',
      r->>'status_defasagem', r->>'p_req';
  END IF;
  RAISE NOTICE 'OK D11 — gerencial ve status/p_req mas NAO os absolutos (cap_custo_ler barra; gate velho liberaria)';
END $$;
SQL

# D13 — sem ele, D11 passaria por VACUIDADE: um gate que barra TODO MUNDO também barra o gerencial.
echo "→ ASSERT D13 — employee ESTRATÉGICO vê os absolutos (D11 não é 'ninguém vê'):"
P -v ON_ERROR_STOP=1 <<'SQL'
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL test.uid = '00000000-0000-0000-0000-00000000000e';  -- employee ESTRATÉGICO
  SELECT (public.get_defasagem_cliente('[{"empresa":"oben","codigo":1001,"preco":100}]'::jsonb,
          '11111111-1111-1111-1111-111111111111'::uuid))->0 INTO r;
  IF r->'c_last' = 'null'::jsonb OR r->'c_now' = 'null'::jsonb OR r->'p_last' = 'null'::jsonb THEN
    RAISE EXCEPTION 'D13 FALHOU: estrategico NAO viu os absolutos — cap_custo_ler degenerou a master-only';
  END IF;
  RAISE NOTICE 'OK D13 — estrategico ve c_last/c_now/p_last (cap_custo_ler nao virou master-only)';
END $$;
SQL

# D12 — CONTRAPROVA de que os 2 gates divergem EXATAMENTE no gerencial.
echo "→ ASSERT D12 — contraprova: cap_custo_ler × pode_ver_carteira_completa divergem SÓ no gerencial:"
P -v ON_ERROR_STOP=1 <<'SQL'
DO $$
DECLARE u uuid; custo boolean; carteira boolean; divergiu int := 0;
BEGIN
  -- Compara o EFEITO (`IS TRUE`): pode_ver_carteira_completa não tem COALESCE e devolve NULL —
  -- não false — para employee sem commercial_role; quem consome trata NULL como negado.
  FOREACH u IN ARRAY ARRAY[
    '00000000-0000-0000-0000-00000000000a'::uuid,  -- master
    '00000000-0000-0000-0000-00000000000b'::uuid,  -- employee sem commercial_role (vendedora)
    '00000000-0000-0000-0000-00000000000c'::uuid,  -- customer
    '00000000-0000-0000-0000-00000000000d'::uuid,  -- employee GERENCIAL
    '00000000-0000-0000-0000-00000000000e'::uuid   -- employee ESTRATÉGICO
  ] LOOP
    custo    := private.cap_custo_ler(u) IS TRUE;               -- gate VIVO da RPC
    carteira := public.pode_ver_carteira_completa(u) IS TRUE;   -- gate ANTERIOR
    IF u = '00000000-0000-0000-0000-00000000000d'::uuid THEN
      IF custo IS NOT FALSE OR carteira IS NOT TRUE THEN
        RAISE EXCEPTION 'D12 FALHOU: gerencial nao discrimina (custo=% carteira=%) — seed furado, D11 seria vacuo', custo, carteira;
      END IF;
      divergiu := divergiu + 1;
    ELSE
      IF custo IS DISTINCT FROM carteira THEN
        RAISE EXCEPTION 'D12b FALHOU: persona % deveria dar o MESMO veredito nos 2 gates (custo=% carteira=%)', u, custo, carteira;
      END IF;
    END IF;
  END LOOP;
  IF divergiu <> 1 THEN
    RAISE EXCEPTION 'D12c FALHOU: nenhuma persona separou os 2 gates — o bloco de authz nao prova politica';
  END IF;
  RAISE NOTICE 'OK D12 — gerencial e o UNICO discriminante (custo=false, carteira=true); demais concordam';
END $$;
SQL

# FALSIFICAÇÃO X-D11: devolve o gate da RPC ao ANTERIOR — a regressão de autorização real.
echo "  → FALSIFICAÇÃO X-D11 (gate da RPC regride ao pode_ver_carteira_completa → exige D11 vermelho):"
P -v ON_ERROR_STOP=1 -q <<'SQL'
DO $regride$
DECLARE v_def text; v_novo text;
BEGIN
  v_def := pg_get_functiondef('public.get_defasagem_cliente(jsonb,uuid)'::regprocedure);
  v_novo := regexp_replace(v_def, 'v_pode_num\s*:=\s*private\.cap_custo_ler\s*\(\s*auth\.uid\(\)\s*\)',
                           'v_pode_num := public.pode_ver_carteira_completa(auth.uid())', 'g');
  IF v_novo = v_def THEN RAISE EXCEPTION 'X-D11: nao consegui regredir o gate (padrao nao casou)'; END IF;
  EXECUTE v_novo;
END $regride$;
SQL
SAB11=$(P -tA 2>&1 <<'SQL' || true
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL test.uid = '00000000-0000-0000-0000-00000000000d';
  SELECT (public.get_defasagem_cliente('[{"empresa":"oben","codigo":1001,"preco":100}]'::jsonb,
          '11111111-1111-1111-1111-111111111111'::uuid))->0 INTO r;
  IF r->'c_last' <> 'null'::jsonb THEN RAISE NOTICE 'D11_FICOU_VERMELHO c_last=%', r->>'c_last';
  ELSE RAISE NOTICE 'D11_SOBREVIVEU'; END IF;
END $$;
SQL
)
if echo "$SAB11" | grep -q 'D11_FICOU_VERMELHO'; then
  echo "  OK D11 (falsificação X-D11) — gate velho de volta ⇒ o gerencial VÊ os absolutos → D11 separa as 2 políticas"
else
  echo "  D11 FALHOU (falsificação X-D11): o gate velho não mudou o veredito do gerencial — D11 é teatro. saída: $SAB11"
  exit 1
fi
P -v ON_ERROR_STOP=1 -q <<'SQL'
DO $volta$
DECLARE v_def text; v_novo text;
BEGIN
  v_def := pg_get_functiondef('public.get_defasagem_cliente(jsonb,uuid)'::regprocedure);
  v_novo := regexp_replace(v_def, 'v_pode_num\s*:=\s*(public\.)?pode_ver_carteira_completa\s*\(\s*auth\.uid\(\)\s*\)',
                           'v_pode_num := private.cap_custo_ler(auth.uid())', 'g');
  IF v_novo = v_def THEN RAISE EXCEPTION 'X-D11: nao consegui restaurar o gate vivo'; END IF;
  EXECUTE v_novo;
END $volta$;
SQL
echo "  OK X-D11 (restauração) — gate vivo (cap_custo_ler) de volta"

# FALSIFICAÇÃO X-D13: degenera cap_custo_ler a master-only → D13 vermelho.
echo "  → FALSIFICAÇÃO X-D13 (cap_custo_ler := master-only → exige D13 vermelho):"
P -v ON_ERROR_STOP=1 -q <<'SQL'
CREATE OR REPLACE FUNCTION private.cap_custo_ler(_uid uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $f$
  SELECT COALESCE(public.has_role(_uid, 'master'::public.app_role), false);
$f$;
SQL
SAB13=$(P -tA 2>&1 <<'SQL' || true
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL test.uid = '00000000-0000-0000-0000-00000000000e';
  SELECT (public.get_defasagem_cliente('[{"empresa":"oben","codigo":1001,"preco":100}]'::jsonb,
          '11111111-1111-1111-1111-111111111111'::uuid))->0 INTO r;
  IF r->'c_last' = 'null'::jsonb THEN RAISE NOTICE 'D13_FICOU_VERMELHO';
  ELSE RAISE NOTICE 'D13_SOBREVIVEU c_last=%', r->>'c_last'; END IF;
END $$;
SQL
)
if echo "$SAB13" | grep -q 'D13_FICOU_VERMELHO'; then
  echo "  OK D13 (falsificação X-D13) — master-only barra o estratégico → D13 guarda contra a vacuidade de D11"
else
  echo "  D13 FALHOU (falsificação X-D13): master-only não mudou o veredito do estratégico. saída: $SAB13"
  exit 1
fi
P -v ON_ERROR_STOP=1 -q <<'SQL'
CREATE OR REPLACE FUNCTION private.cap_custo_ler(_uid uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $f$
  SELECT COALESCE(_uid IS NOT NULL AND (
    public.has_role(_uid, 'master'::public.app_role)
    OR (public.has_role(_uid, 'employee'::public.app_role)
        AND EXISTS (SELECT 1 FROM public.commercial_roles cr
                     WHERE cr.user_id = _uid
                       AND cr.commercial_role IN ('estrategico'::public.commercial_role,
                           'super_admin'::public.commercial_role)))), false);
$f$;
SQL
echo "  OK X-D13 (restauração) — cap_custo_ler fiel de volta"

# FALSIFICAÇÃO X-D12: sabota o SEED (tira o commercial_role do 'd') → D12 vermelho.
echo "  → FALSIFICAÇÃO X-D12 (seed sem o gerencial → exige D12 vermelho):"
P -v ON_ERROR_STOP=1 -q -c "DELETE FROM public.commercial_roles WHERE user_id='00000000-0000-0000-0000-00000000000d';"
SAB12=$(P -tA 2>&1 <<'SQL' || true
DO $$
DECLARE custo boolean; carteira boolean;
BEGIN
  custo    := private.cap_custo_ler('00000000-0000-0000-0000-00000000000d'::uuid) IS TRUE;
  carteira := public.pode_ver_carteira_completa('00000000-0000-0000-0000-00000000000d'::uuid) IS TRUE;
  IF custo IS NOT FALSE OR carteira IS NOT TRUE THEN RAISE NOTICE 'D12_FICOU_VERMELHO';
  ELSE RAISE NOTICE 'D12_SOBREVIVEU custo=% carteira=%', custo, carteira; END IF;
END $$;
SQL
)
if echo "$SAB12" | grep -q 'D12_FICOU_VERMELHO'; then
  echo "  OK D12 (falsificação X-D12) — sem o seed gerencial a contraprova cai → D12 guarda a EXISTÊNCIA da persona"
else
  echo "  D12 FALHOU (falsificação X-D12): seed sabotado e a contraprova sobreviveu — D12 é vácuo. saída: $SAB12"
  exit 1
fi
P -v ON_ERROR_STOP=1 -q -c "INSERT INTO public.commercial_roles (user_id, commercial_role) VALUES ('00000000-0000-0000-0000-00000000000d','gerencial'::public.commercial_role);"
echo "  OK X-D12 (restauração) — seed gerencial de volta"

echo ""
echo "→ ASSERT D10 — REVOKE anon (permission denied for function):"
P -v ON_ERROR_STOP=1 <<'SQL'
DO $$
BEGIN
  SET ROLE anon;
  BEGIN
    PERFORM public.get_defasagem_cliente('[]'::jsonb, '11111111-1111-1111-1111-111111111111'::uuid);
    RESET ROLE;
    RAISE EXCEPTION 'D10 FALHOU: anon executou get_defasagem_cliente (REVOKE ausente)';
  EXCEPTION
    WHEN insufficient_privilege THEN
      RESET ROLE;
      IF SQLERRM NOT ILIKE '%permission denied for function%' THEN
        RAISE EXCEPTION 'D10b FALHOU: 42501 mas mensagem inesperada "%"', SQLERRM;
      END IF;
      RAISE NOTICE 'OK D10 — anon barrado (permission denied for function): %', SQLERRM;
  END;
END $$;
SQL

echo ""
echo "✅ test-defasagem: todos os asserts passaram (D1..D13 + falsificações D8/D9 + X-D11/X-D12/X-D13)"
