#!/usr/bin/env bash
# Teste PG17 do cockpit de preço (Fase 2a). Money-path (RPC só-leitura + trigger de ledger).
# Caminho LEVE: stubs mínimos do Supabase (auth/app_role/has_role/pode_ver_carteira_completa
# + inventory_position/omie_products/tint_*) + as 3 migrations NOVAS
# (20260614170000 ledger, 20260614180000 markup_policy, 20260614190000 get_preco_cockpit)
# e EXECUTA os asserts:
#   A1  faixa account-aware (CMC em 'vendas', consultado 'oben'; piso/meta math)
#   A2  preço abaixo do custo → vermelho (mesmo com política)
#   A3  com custo, sem política → neutro/sem_politica (NUNCA verde) + 2ª ponte de conta (colacor)
#   A4  role-gate: gestor (master) vê cmc/markup
#   A5  role-gate: vendedora (employee) NÃO vê número (faixa presente) + FALSIFICAÇÃO do gate
#   A6  conta errada não casa → neutro/sem_custo
#   A7  tint ALL-OR-NOTHING (corante sem CMC → custo nulo; depois com CMC → base+corantes)
#   A8  trigger do ledger (UPDATE cmc → 1 linha; UPDATE não-cmc/cmc igual → 0)
#   A9  RLS markup_policy (SET ROLE: select staff ok, INSERT employee 42501, master ok)
#   A10 REVOKE: get_preco_cockpit não executável por anon; customer authenticated → forbidden
# ⚠️ RLS só é enforçada p/ roles NÃO-superuser. O psql roda como `postgres` (superuser, BYPASSA RLS)
# → asserts de RLS (A9) usam SET ROLE authenticated + SET LOCAL test.uid. A RPC é SECURITY DEFINER
# com gate INTERNO (has_role(auth.uid())) → asserts da RPC (A1-A8) só setam test.uid, sem SET ROLE.
# has_role/pode_ver_carteira_completa são SECURITY DEFINER → funcionam sob SET ROLE.
# Disciplina de assert negativo: captura a SQLSTATE esperada e RE-LANÇA o resto (sem WHEN OTHERS cego).
# Base: db/test-kb-0c-aprovacao.sh (bring-up PG17 keg-only). Pré-req: brew install postgresql@17.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT=5443   # porta dedicada (KB usa 5441; outros 5433/5436/5439)
DATA="$(mktemp -d /tmp/pgtest-cockpit.XXXXXX)/data"
export LC_ALL=C LANG=C

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER}"; exit 1; }

# Contorna o keg-only do brew (idempotente, no-clobber).
CELLAR="$(brew --prefix postgresql@${PGVER})"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l /tmp/pg-cockpit.log -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres cockpit_verify
P() { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d cockpit_verify "$@"; }

echo "→ stubs mínimos do Supabase (roles, auth, app_role, has_role, pode_ver_carteira_completa, tabelas)…"
P -v ON_ERROR_STOP=1 -q <<'SQL'
DO $$ BEGIN CREATE ROLE anon;          EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE service_role;  EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.uid', true), '')::uuid $f$;

DO $$ BEGIN CREATE TYPE public.app_role AS ENUM ('employee','customer','master'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE TABLE IF NOT EXISTS public.user_roles (
  user_id uuid NOT NULL,
  role    public.app_role NOT NULL,
  PRIMARY KEY (user_id, role)
);
CREATE OR REPLACE FUNCTION public.has_role(_uid uuid, _role public.app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $f$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _uid AND role = _role);
$f$;

-- Stub do gate de número: no teste, "vê número" = master (gestor). employee = vendedora (não vê).
-- SECURITY DEFINER p/ funcionar sob SET ROLE. A FALSIFICAÇÃO (A5) reescreve esta função.
CREATE OR REPLACE FUNCTION public.pode_ver_carteira_completa(_uid uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $f$
  SELECT public.has_role(_uid, 'master'::public.app_role);
$f$;

-- inventory_position (colunas que o trigger do ledger + a RPC leem).
CREATE TABLE IF NOT EXISTS public.inventory_position (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  omie_codigo_produto bigint NOT NULL,
  saldo numeric DEFAULT 0,
  cmc numeric DEFAULT 0,
  account text NOT NULL DEFAULT 'vendas',
  synced_at timestamptz DEFAULT now(),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- omie_products (a RPC lê familia/account/omie_codigo_produto/id; tint usa id).
CREATE TABLE IF NOT EXISTS public.omie_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  omie_codigo_produto bigint NOT NULL,
  account text NOT NULL DEFAULT 'oben',
  familia text
);

-- tint_* (mínimos p/ o caminho de custo all-or-nothing).
CREATE TABLE IF NOT EXISTS public.tint_skus (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account text NOT NULL DEFAULT 'oben',
  produto_id uuid, base_id uuid, embalagem_id uuid,
  omie_product_id uuid
);
CREATE TABLE IF NOT EXISTS public.tint_formulas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account text NOT NULL DEFAULT 'oben',
  sku_id uuid, produto_id uuid, base_id uuid, embalagem_id uuid
);
CREATE TABLE IF NOT EXISTS public.tint_corantes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  omie_product_id uuid,
  volume_total_ml numeric
);
CREATE TABLE IF NOT EXISTS public.tint_formula_itens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  formula_id uuid NOT NULL,
  corante_id uuid NOT NULL,
  qtd_ml numeric NOT NULL
);
SQL

echo "→ migration 20260614170000_cmc_ledger.sql…"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/migrations/20260614170000_cmc_ledger.sql" >/dev/null

echo "→ migration 20260614180000_markup_policy.sql…"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/migrations/20260614180000_markup_policy.sql" >/dev/null

echo "→ migration 20260614190000_get_preco_cockpit.sql…"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/migrations/20260614190000_get_preco_cockpit.sql" >/dev/null

echo "→ seed (roles + grants + produtos/CMC + política de conta + tint)…"
P -v ON_ERROR_STOP=1 -q <<'SQL'
-- a=master(gestor) b=employee(vendedora) c=customer
INSERT INTO public.user_roles (user_id, role) VALUES
  ('00000000-0000-0000-0000-00000000000a', 'master'::public.app_role),
  ('00000000-0000-0000-0000-00000000000b', 'employee'::public.app_role),
  ('00000000-0000-0000-0000-00000000000c', 'customer'::public.app_role)
ON CONFLICT DO NOTHING;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.markup_policy TO authenticated;

-- A1/A2/A4/A5: sku 1001 com CMC só em 'vendas' (ponte oben→vendas). familia 'vernizes'.
INSERT INTO public.inventory_position (omie_codigo_produto, account, cmc, saldo) VALUES (1001, 'vendas', 60, 10);
INSERT INTO public.omie_products (omie_codigo_produto, account, familia) VALUES (1001, 'oben', 'vernizes');

-- A3: sku 1003 colacor (CMC em 'colacor_vendas'), SEM política colacor → sem_politica.
INSERT INTO public.inventory_position (omie_codigo_produto, account, cmc, saldo) VALUES (1003, 'colacor_vendas', 100, 5);
INSERT INTO public.omie_products (omie_codigo_produto, account, familia) VALUES (1003, 'colacor', 'tintas');

-- A6: sku 1006 só em 'colacor_vendas'; consultado como oben → não casa.
INSERT INTO public.inventory_position (omie_codigo_produto, account, cmc, saldo) VALUES (1006, 'colacor_vendas', 70, 5);
INSERT INTO public.omie_products (omie_codigo_produto, account, familia) VALUES (1006, 'oben', 'abrasivos');

-- Política de CONTA oben: piso 30% / meta 50%.
INSERT INTO public.markup_policy (account, escopo, piso_markup, meta_markup) VALUES ('oben', 'conta', 30, 50);

-- A7 tint: base (op 7100, cmc 40 em vendas) + corante1 (op 7201, cmc 200, vol 1000) + corante2 (op 7202, vol 1000, CMC ausente no início).
INSERT INTO public.omie_products (id, omie_codigo_produto, account, familia) VALUES
  ('00000000-0000-0000-0000-0000000071b0', 7100, 'oben', 'bases'),
  ('00000000-0000-0000-0000-000000007201', 7201, 'oben', 'corantes'),
  ('00000000-0000-0000-0000-000000007202', 7202, 'oben', 'corantes');
INSERT INTO public.inventory_position (omie_codigo_produto, account, cmc, saldo) VALUES
  (7100, 'vendas', 40, 100),
  (7201, 'vendas', 200, 100);
-- (7202 SEM inventory_position no início = corante sem CMC)

INSERT INTO public.tint_skus (id, account, produto_id, base_id, embalagem_id, omie_product_id) VALUES
  ('00000000-0000-0000-0000-0000000005c0', 'oben', NULL, NULL, NULL,
   '00000000-0000-0000-0000-0000000071b0');
INSERT INTO public.tint_formulas (id, account, sku_id, produto_id, base_id, embalagem_id) VALUES
  ('00000000-0000-0000-0000-0000000f0001', 'oben', '00000000-0000-0000-0000-0000000005c0', NULL, NULL, NULL);
INSERT INTO public.tint_corantes (id, omie_product_id, volume_total_ml) VALUES
  ('00000000-0000-0000-0000-00000000c001', '00000000-0000-0000-0000-000000007201', 1000),
  ('00000000-0000-0000-0000-00000000c002', '00000000-0000-0000-0000-000000007202', 1000);
INSERT INTO public.tint_formula_itens (formula_id, corante_id, qtd_ml) VALUES
  ('00000000-0000-0000-0000-0000000f0001', '00000000-0000-0000-0000-00000000c001', 10),
  ('00000000-0000-0000-0000-0000000f0001', '00000000-0000-0000-0000-00000000c002', 5);
SQL

echo ""
echo "→ ASSERT A1 — faixa account-aware (CMC em 'vendas', consultado 'oben'; piso 78/meta 90):"
P -v ON_ERROR_STOP=1 <<'SQL'
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL test.uid = '00000000-0000-0000-0000-00000000000a';  -- master
  SELECT (public.get_preco_cockpit('[{"empresa":"oben","codigo":1001,"preco":85}]'::jsonb))->0 INTO r;
  IF r->>'faixa' <> 'verde' OR r->>'motivo' <> 'abaixo_da_meta' THEN
    RAISE EXCEPTION 'A1 FALHOU: faixa=% motivo=% (esperado verde/abaixo_da_meta)', r->>'faixa', r->>'motivo';
  END IF;
  IF (r->>'tem_custo')::boolean IS NOT TRUE OR r->>'proveniencia' NOT ILIKE '%vendas%' THEN
    RAISE EXCEPTION 'A1b FALHOU: tem_custo=% proveniencia=% (esperado true / inventory_position(vendas))', r->>'tem_custo', r->>'proveniencia';
  END IF;
  RAISE NOTICE 'OK A1 — account-aware: cmc 60 via vendas, preço 85 entre piso 78 e meta 90 → verde/abaixo_da_meta';
END $$;
SQL

echo ""
echo "→ ASSERT A2 — preço abaixo do custo → vermelho (mesmo com política de conta):"
P -v ON_ERROR_STOP=1 <<'SQL'
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL test.uid = '00000000-0000-0000-0000-00000000000a';
  SELECT (public.get_preco_cockpit('[{"empresa":"oben","codigo":1001,"preco":50}]'::jsonb))->0 INTO r;
  IF r->>'faixa' <> 'vermelho' OR r->>'motivo' <> 'abaixo_do_custo' THEN
    RAISE EXCEPTION 'A2 FALHOU: faixa=% motivo=% (esperado vermelho/abaixo_do_custo)', r->>'faixa', r->>'motivo';
  END IF;
  RAISE NOTICE 'OK A2 — preço 50 < cmc 60 → vermelho/abaixo_do_custo';
END $$;
SQL

echo ""
echo "→ ASSERT A3 — com custo, SEM política → neutro/sem_politica (NUNCA verde) + ponte colacor:"
P -v ON_ERROR_STOP=1 <<'SQL'
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL test.uid = '00000000-0000-0000-0000-00000000000a';  -- master (vê cmc)
  SELECT (public.get_preco_cockpit('[{"empresa":"colacor","codigo":1003,"preco":150}]'::jsonb))->0 INTO r;
  IF r->>'faixa' <> 'neutro' OR r->>'motivo' <> 'sem_politica' THEN
    RAISE EXCEPTION 'A3 FALHOU: faixa=% motivo=% (esperado neutro/sem_politica)', r->>'faixa', r->>'motivo';
  END IF;
  IF (r->>'tem_custo')::boolean IS NOT TRUE OR (r->>'tem_politica')::boolean IS NOT FALSE THEN
    RAISE EXCEPTION 'A3b FALHOU: tem_custo=% tem_politica=% (esperado true/false)', r->>'tem_custo', r->>'tem_politica';
  END IF;
  IF (r->>'cmc')::numeric <> 100 THEN
    RAISE EXCEPTION 'A3c FALHOU: cmc=% (esperado 100 via colacor_vendas)', r->>'cmc';
  END IF;
  RAISE NOTICE 'OK A3 — colacor cmc 100 (ponte), preço 150 sem política → neutro/sem_politica (NUNCA verde)';
END $$;
SQL

echo ""
echo "→ ASSERT A4 — role-gate: gestor (master) vê cmc/markup:"
P -v ON_ERROR_STOP=1 <<'SQL'
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL test.uid = '00000000-0000-0000-0000-00000000000a';  -- master
  SELECT (public.get_preco_cockpit('[{"empresa":"oben","codigo":1001,"preco":85}]'::jsonb))->0 INTO r;
  IF r->'cmc' = 'null'::jsonb OR (r->>'cmc')::numeric <> 60 THEN
    RAISE EXCEPTION 'A4 FALHOU: gestor não viu cmc (=%)', r->>'cmc';
  END IF;
  IF r->'markup_perc' = 'null'::jsonb OR r->'piso_markup' = 'null'::jsonb THEN
    RAISE EXCEPTION 'A4b FALHOU: gestor não viu markup_perc/piso_markup';
  END IF;
  RAISE NOTICE 'OK A4 — gestor vê cmc=60, markup e piso/meta';
END $$;
SQL

echo ""
echo "→ ASSERT A5 — role-gate: vendedora (employee) NÃO vê número (faixa presente) + FALSIFICAÇÃO:"
P -v ON_ERROR_STOP=1 <<'SQL'
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL test.uid = '00000000-0000-0000-0000-00000000000b';  -- employee
  SELECT (public.get_preco_cockpit('[{"empresa":"oben","codigo":1001,"preco":85}]'::jsonb))->0 INTO r;
  IF r->'cmc' <> 'null'::jsonb OR r->'markup_perc' <> 'null'::jsonb OR r->'folga_reais' <> 'null'::jsonb
     OR r->'piso_markup' <> 'null'::jsonb OR r->'proveniencia' <> 'null'::jsonb THEN
    RAISE EXCEPTION 'A5 FALHOU: vendedora viu número (cmc=% markup=% prov=%)', r->>'cmc', r->>'markup_perc', r->>'proveniencia';
  END IF;
  IF r->>'faixa' <> 'verde' OR r->>'motivo' <> 'abaixo_da_meta' THEN
    RAISE EXCEPTION 'A5b FALHOU: vendedora não viu a faixa (=%/%)', r->>'faixa', r->>'motivo';
  END IF;
  RAISE NOTICE 'OK A5 — vendedora vê faixa (verde/abaixo_da_meta) mas cmc/markup/prov = null';
END $$;
SQL
# FALSIFICAÇÃO: sabota pode_ver_carteira_completa → true; o número DEVE vazar p/ a vendedora (prova que o gate tem dente).
P -v ON_ERROR_STOP=1 -q <<'SQL'
CREATE OR REPLACE FUNCTION public.pode_ver_carteira_completa(_uid uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $f$ SELECT true $f$;
SQL
SAB=$(P -tA 2>&1 <<'SQL' || true
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL test.uid = '00000000-0000-0000-0000-00000000000b';  -- employee
  SELECT (public.get_preco_cockpit('[{"empresa":"oben","codigo":1001,"preco":85}]'::jsonb))->0 INTO r;
  IF r->'cmc' <> 'null'::jsonb AND (r->>'cmc')::numeric = 60 THEN RAISE NOTICE 'SABOTAGEM_PASSOU';
  ELSE RAISE NOTICE 'SABOTAGEM_NAO_PASSOU cmc=%', r->>'cmc'; END IF;
END $$;
SQL
)
if echo "$SAB" | grep -q 'SABOTAGEM_PASSOU'; then
  echo "  OK A5 (falsificação) — gate furado vazou o cmc p/ a vendedora → o assert A5 REALMENTE guarda (não é teatro)"
else
  echo "  A5 FALHOU (falsificação): mesmo com o gate furado o número NÃO vazou — A5 não testa o role-gate. saída: $SAB"
  exit 1
fi
# Restaura o gate correto (master-only).
P -v ON_ERROR_STOP=1 -q <<'SQL'
CREATE OR REPLACE FUNCTION public.pode_ver_carteira_completa(_uid uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $f$
  SELECT public.has_role(_uid, 'master'::public.app_role);
$f$;
SQL
echo "  OK A5 (restauração) — gate master-only de volta"

echo ""
echo "→ ASSERT A6 — conta errada não casa → neutro/sem_custo:"
P -v ON_ERROR_STOP=1 <<'SQL'
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL test.uid = '00000000-0000-0000-0000-00000000000a';
  SELECT (public.get_preco_cockpit('[{"empresa":"oben","codigo":1006,"preco":100}]'::jsonb))->0 INTO r;
  IF (r->>'tem_custo')::boolean IS NOT FALSE OR r->>'faixa' <> 'neutro' OR r->>'motivo' <> 'sem_custo' THEN
    RAISE EXCEPTION 'A6 FALHOU: tem_custo=% faixa=% motivo=% (esperado false/neutro/sem_custo)', r->>'tem_custo', r->>'faixa', r->>'motivo';
  END IF;
  RAISE NOTICE 'OK A6 — sku só em colacor_vendas, consultado oben → não casa → neutro/sem_custo';
END $$;
SQL

echo ""
echo "→ ASSERT A7 — tint ALL-OR-NOTHING (corante sem CMC → nulo; depois com CMC → base+corantes):"
P -v ON_ERROR_STOP=1 <<'SQL'
DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL test.uid = '00000000-0000-0000-0000-00000000000a';  -- master (vê cmc)
  -- parte 1: corante2 (7202) SEM CMC → custo incompleto → neutro/sem_custo (NÃO soma parcial)
  SELECT (public.get_preco_cockpit('[{"empresa":"oben","codigo":9999,"preco":100,"tint_formula_id":"00000000-0000-0000-0000-0000000f0001"}]'::jsonb))->0 INTO r;
  IF (r->>'tem_custo')::boolean IS NOT FALSE OR r->>'motivo' <> 'sem_custo' THEN
    RAISE EXCEPTION 'A7a FALHOU: corante faltando deu tem_custo=% motivo=% (esperado false/sem_custo — all-or-nothing)', r->>'tem_custo', r->>'motivo';
  END IF;
  RAISE NOTICE 'OK A7a — corante sem CMC → custo nulo (neutro), NÃO soma parcial';
END $$;

-- Agora dá CMC ao corante2 (7202): corantes = 10*(200/1000) + 5*(300/1000) = 2 + 1.5 = 3.5; custo = base 40 + 3.5 = 43.5
INSERT INTO public.inventory_position (omie_codigo_produto, account, cmc, saldo) VALUES (7202, 'vendas', 300, 50);

DO $$
DECLARE r jsonb;
BEGIN
  SET LOCAL test.uid = '00000000-0000-0000-0000-00000000000a';
  SELECT (public.get_preco_cockpit('[{"empresa":"oben","codigo":9999,"preco":100,"tint_formula_id":"00000000-0000-0000-0000-0000000f0001"}]'::jsonb))->0 INTO r;
  IF (r->>'tem_custo')::boolean IS NOT TRUE THEN
    RAISE EXCEPTION 'A7b FALHOU: com todos os CMC, tem_custo=% (esperado true)', r->>'tem_custo';
  END IF;
  IF abs((r->>'cmc')::numeric - 43.5) > 0.0001 THEN
    RAISE EXCEPTION 'A7c FALHOU: custo tint=% (esperado 43.5 = base 40 + corantes 3.5)', r->>'cmc';
  END IF;
  RAISE NOTICE 'OK A7b — custo tint = base 40 + corantes 3.5 = 43.5 (all-or-nothing satisfeito)';
END $$;
SQL

echo ""
echo "→ ASSERT A8 — trigger do ledger (UPDATE cmc → 1 linha; UPDATE não-cmc / cmc igual → 0):"
P -v ON_ERROR_STOP=1 <<'SQL'
DO $$
DECLARE n0 int; n1 int; n2 int; n3 int; v_ant numeric; v_novo numeric;
BEGIN
  SELECT count(*) INTO n0 FROM public.cmc_ledger WHERE omie_codigo_produto = 1001 AND account='vendas';
  -- o INSERT do seed (1001) já gerou 1 linha (cmc_anterior NULL). UPDATE do cmc → +1.
  UPDATE public.inventory_position SET cmc = 75 WHERE omie_codigo_produto = 1001 AND account='vendas';
  SELECT count(*) INTO n1 FROM public.cmc_ledger WHERE omie_codigo_produto = 1001 AND account='vendas';
  IF n1 <> n0 + 1 THEN RAISE EXCEPTION 'A8a FALHOU: UPDATE de cmc gerou % linha(s) (esperado +1)', n1 - n0; END IF;
  SELECT cmc_anterior, cmc_novo INTO v_ant, v_novo
    FROM public.cmc_ledger WHERE omie_codigo_produto=1001 AND account='vendas' ORDER BY observed_at DESC LIMIT 1;
  IF v_ant <> 60 OR v_novo <> 75 THEN
    RAISE EXCEPTION 'A8b FALHOU: ledger gravou anterior=% novo=% (esperado 60→75)', v_ant, v_novo;
  END IF;

  -- UPDATE de coluna NÃO-cmc (saldo) → trigger não dispara (AFTER UPDATE OF cmc) → 0 novas.
  UPDATE public.inventory_position SET saldo = 999 WHERE omie_codigo_produto = 1001 AND account='vendas';
  SELECT count(*) INTO n2 FROM public.cmc_ledger WHERE omie_codigo_produto = 1001 AND account='vendas';
  IF n2 <> n1 THEN RAISE EXCEPTION 'A8c FALHOU: UPDATE de saldo gerou % linha(s) (esperado 0)', n2 - n1; END IF;

  -- UPDATE de cmc p/ o MESMO valor → dispara mas guard IS DISTINCT FROM → 0 novas.
  UPDATE public.inventory_position SET cmc = 75 WHERE omie_codigo_produto = 1001 AND account='vendas';
  SELECT count(*) INTO n3 FROM public.cmc_ledger WHERE omie_codigo_produto = 1001 AND account='vendas';
  IF n3 <> n2 THEN RAISE EXCEPTION 'A8d FALHOU: UPDATE cmc p/ valor igual gerou % linha(s) (esperado 0)', n3 - n2; END IF;

  RAISE NOTICE 'OK A8 — ledger: UPDATE cmc=+1 (60→75); UPDATE saldo=0; UPDATE cmc igual=0';
END $$;
SQL

echo ""
echo "→ ASSERT A9 — RLS markup_policy (SET ROLE: select staff ok, INSERT employee 42501, master ok):"
# employee: SELECT ok (staff), INSERT negado (write master-only).
P -v ON_ERROR_STOP=1 <<'SQL'
DO $$
DECLARE c int;
BEGIN
  SET ROLE authenticated;
  SET LOCAL test.uid = '00000000-0000-0000-0000-00000000000b';  -- employee
  SELECT count(*) INTO c FROM public.markup_policy;   -- staff lê
  RESET ROLE;
  RAISE NOTICE 'OK A9a — employee LÊ markup_policy (% linha(s))', c;
END $$;
SQL
P -v ON_ERROR_STOP=1 <<'SQL'
DO $$
BEGIN
  SET ROLE authenticated;
  SET LOCAL test.uid = '00000000-0000-0000-0000-00000000000b';  -- employee
  BEGIN
    INSERT INTO public.markup_policy (account, escopo, piso_markup, meta_markup) VALUES ('oben','sku',20,40);
    RESET ROLE;
    RAISE EXCEPTION 'A9b FALHOU: employee inseriu em markup_policy (write master-only ausente)';
  EXCEPTION
    WHEN insufficient_privilege THEN
      RESET ROLE;
      IF SQLERRM NOT ILIKE '%row-level security%' THEN
        RAISE EXCEPTION 'A9b2 FALHOU: 42501 mas mensagem inesperada "%"', SQLERRM;
      END IF;
      RAISE NOTICE 'OK A9b — employee barrado no INSERT (42501): %', SQLERRM;
  END;
END $$;
SQL
# master: INSERT ok.
P -v ON_ERROR_STOP=1 <<'SQL'
DO $$
DECLARE c int;
BEGIN
  SET ROLE authenticated;
  SET LOCAL test.uid = '00000000-0000-0000-0000-00000000000a';  -- master
  INSERT INTO public.markup_policy (account, escopo, sku_codigo, piso_markup, meta_markup) VALUES ('oben','sku',1001,35,55);
  GET DIAGNOSTICS c = ROW_COUNT;
  RESET ROLE;
  IF c <> 1 THEN RAISE EXCEPTION 'A9c FALHOU: master INSERT afetou % (esperado 1)', c; END IF;
  RAISE NOTICE 'OK A9c — master insere em markup_policy';
END $$;
SQL

echo ""
echo "→ ASSERT A10 — REVOKE anon + customer authenticated → forbidden:"
# anon: REVOKE → permission denied for function (42501).
P -v ON_ERROR_STOP=1 <<'SQL'
DO $$
BEGIN
  SET ROLE anon;
  BEGIN
    PERFORM public.get_preco_cockpit('[]'::jsonb);
    RESET ROLE;
    RAISE EXCEPTION 'A10a FALHOU: anon executou get_preco_cockpit (REVOKE ausente)';
  EXCEPTION
    WHEN insufficient_privilege THEN
      RESET ROLE;
      IF SQLERRM NOT ILIKE '%permission denied for function%' THEN
        RAISE EXCEPTION 'A10a2 FALHOU: 42501 mas mensagem inesperada "%"', SQLERRM;
      END IF;
      RAISE NOTICE 'OK A10a — anon barrado (permission denied for function): %', SQLERRM;
  END;
END $$;
SQL
# customer authenticated: executa (grant) mas gate interno → RAISE forbidden.
P -v ON_ERROR_STOP=1 <<'SQL'
DO $$
BEGIN
  SET LOCAL test.uid = '00000000-0000-0000-0000-00000000000c';  -- customer
  BEGIN
    PERFORM public.get_preco_cockpit('[{"empresa":"oben","codigo":1001,"preco":85}]'::jsonb);
    RAISE EXCEPTION 'A10b FALHOU: customer passou no gate de staff';
  EXCEPTION
    WHEN insufficient_privilege THEN   -- a RPC faz RAISE 'forbidden' USING errcode='42501'
      IF SQLERRM NOT ILIKE '%forbidden%' THEN
        RAISE EXCEPTION 'A10b2 FALHOU: mensagem inesperada "%"', SQLERRM;
      END IF;
      RAISE NOTICE 'OK A10b — customer barrado no gate de staff: %', SQLERRM;
  END;
END $$;
SQL

echo ""
echo "✅ test-cockpit-preco: todos os asserts passaram (A1..A10)"
