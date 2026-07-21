#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════════════════════╗
# ║  FU4-F fase 2 — RÉGUA DE PREÇO decide no servidor e para de devolver custo                    ║
# ║  Prova de supabase/migrations/20260723150000_authz_custo_fu4f_fase2_regua.sql                 ║
# ║      bash db/test-authz-custo-fu4f-fase2-regua.sh > /tmp/t.log 2>&1; echo "exit=$?"           ║
# ║  (NÃO pipe pra tail — engole o exit≠0.)                                                       ║
# ║                                                                                                ║
# ║  O que esta prova existe para pegar, além do óbvio:                                            ║
# ║   · a assinatura de 3 args SOBREVIVENDO ao apply (viva, ela devolve `cmc` e o resto é teatro)  ║
# ║   · o piso do PRAZO ficando para trás (piso menor ⇒ "abaixo do piso" dispara MENOS ⇒ a         ║
# ║     vendedora fecha abaixo do piso real). A18 é o assert desenhado só para isso.               ║
# ║   · o writer aceitando salesperson_id do cliente (forjamento — §4.2 do spec do #1434)          ║
# ║   · o helper do piso ficando executável por `authenticated` (private NÃO é barreira: o schema  ║
# ║     tem USAGE para authenticated e não tem default ACL ⇒ função nova nasce aberta a PUBLIC)    ║
# ║                                                                                                ║
# ║  Valores esperados calculados FORA do SQL (node, ver PR) para o teste não ser circular:        ║
# ║      piso à vista        cmc/(1-aliq) = 12.40/0.922            = 13.4490                       ║
# ║      piso com prazo      [0,30,60] @ 20% a.a., S=0.9852001294  = 13.6684                       ║
# ╚══════════════════════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5462}"
SLUG="fu4f2regua"
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
-- No Supabase real `authenticated` tem USAGE em auth; sem isto, assert que chama auth.uid()
-- direto falha com "permission denied for schema auth" e SE LÊ COMO negação de gate.
GRANT USAGE ON SCHEMA auth TO authenticated, anon;
SQL

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

M='11111111-1111-1111-1111-111111111111'   # master
F='22222222-2222-2222-2222-222222222222'   # farmer      (employee + farmer)   ← as 2 vendedoras reais
E='33333333-3333-3333-3333-333333333333'   # estrategico (employee + estrategico)
C='44444444-4444-4444-4444-444444444444'   # customer
CLI='55555555-5555-5555-5555-555555555555' # cliente alvo da régua
OUT='66666666-6666-6666-6666-666666666666' # outro cliente (comparáveis)
PRD='77777777-7777-7777-7777-777777777777' # produto COM cmc
SEM='88888888-8888-8888-8888-888888888888' # produto SEM cmc
NAN='99999999-9999-9999-9999-999999999999' # produto com cmc = NaN   (numeric aceita!)
INF='aaaaaaaa-1111-1111-1111-111111111111' # produto com cmc = Infinity

as_user() { Pq -c "SET test.uid='$1'; SET ROLE authenticated; $2" | tail -1; }

echo "═══ setup pronto (PG17 :$PORT) ═══"

# guard: sem SET ROLE efetivo, TODA a zona de RLS é teatro e nada no exit code avisa.
CU=$(Pq -c "SET ROLE authenticated; SELECT current_user;" | tail -1)
[ "$CU" = "authenticated" ] || { echo "❌ SET ROLE não pegou (current_user=$CU) — zona de RLS seria teatro"; exit 1; }

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — PRÉ-REQUISITOS (stubs espelham a PROD, medida via psql-ro em 2026-07-20)
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
CREATE TYPE public.app_role AS ENUM ('customer','employee','master');
CREATE TYPE public.commercial_role AS ENUM ('gerencial','estrategico','super_admin','farmer','hunter','closer','master','operacional');
CREATE SCHEMA IF NOT EXISTS private;
-- espelha o nspacl medido em prod: authenticated ALCANÇA o schema private.
-- É por isso que o REVOKE do regua_piso_calc é carga viva, e não higiene.
GRANT USAGE ON SCHEMA private TO authenticated, anon;

CREATE TABLE public.user_roles (user_id uuid NOT NULL, role public.app_role NOT NULL);
CREATE TABLE public.commercial_roles (user_id uuid PRIMARY KEY, commercial_role public.commercial_role NOT NULL);

CREATE FUNCTION public.has_role(_uid uuid, _role public.app_role) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $f$
  SELECT EXISTS (SELECT 1 FROM public.user_roles ur WHERE ur.user_id=_uid AND ur.role=_role);
$f$;

-- #1434, já aplicado em prod (contrato v2 ativo) — corpo copiado de pg_get_functiondef.
CREATE FUNCTION private.cap_custo_ler(_uid uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $f$
  SELECT COALESCE(
    _uid IS NOT NULL AND (
      public.has_role(_uid,'master'::public.app_role)
      OR (public.has_role(_uid,'employee'::public.app_role)
          AND EXISTS (SELECT 1 FROM public.commercial_roles cr
                       WHERE cr.user_id=_uid AND cr.commercial_role IN ('estrategico','super_admin')))
    ), false);
$f$;

CREATE TABLE public.inventory_position (product_id uuid, account text, cmc numeric, saldo numeric);
CREATE TABLE public.company_config (key text PRIMARY KEY, value text);
CREATE TABLE public.empresa_configuracao_custos (
  empresa text, selic_anual numeric, spread_oportunidade numeric, armazenagem_fisica numeric);
CREATE TABLE public.sales_orders (
  id uuid PRIMARY KEY, account text, deleted_at timestamptz,
  order_date_kpi date, created_at timestamptz DEFAULT now());
CREATE TABLE public.order_items (
  id bigserial PRIMARY KEY, sales_order_id uuid, product_id uuid, customer_user_id uuid,
  unit_price numeric, quantity numeric, omie_codigo_produto bigint);

-- regua_preco_log: colunas EXATAS da prod (information_schema, 2026-07-20), com a policy ANTIGA
-- (FOR ALL employee OR master) — é ela que a migration substitui, e é o baseline.
CREATE TABLE public.regua_preco_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  account text NOT NULL, customer_user_id uuid NOT NULL, product_id uuid NOT NULL,
  salesperson_id uuid, sales_order_id uuid, quantity numeric, preco_atual numeric NOT NULL,
  sinal_exibido text NOT NULL, confianca text NOT NULL, preco_referencia numeric,
  observed_gap_pct numeric, suggested_gap_pct numeric, piso_mc numeric,
  cap_limitou boolean DEFAULT false, cmc_usado numeric, cmc_confianca text,
  aliquota_usada numeric, reason_codes text[], preco_final numeric, aplicou boolean,
  outcome_status text, outcome_at timestamptz, evidence_version text NOT NULL DEFAULT 'v1');
ALTER TABLE public.regua_preco_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY regua_preco_log_staff_all ON public.regua_preco_log
  FOR ALL TO authenticated
  USING  (public.has_role(auth.uid(), 'employee') OR public.has_role(auth.uid(), 'master'))
  WITH CHECK (public.has_role(auth.uid(), 'employee') OR public.has_role(auth.uid(), 'master'));

-- ACL da prod (relacl medido): authenticated=arwdDxtm. Reproduzida INTEIRA — a versão anterior
-- prometia arwdDxtm no comentário e concedia só `arwd`, então o TRUNCATE (o D) nunca era exercido
-- e o harness ficava verde sobre um privilégio que a migration não revogava (falso-verde apontado
-- pelo Codex). A negação tem de vir da RLS/REVOKE, nunca de grant que faltou no stub.
GRANT SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN
  ON public.regua_preco_log TO authenticated, anon;
GRANT SELECT ON public.inventory_position, public.company_config, public.user_roles,
                public.commercial_roles, public.order_items, public.sales_orders TO authenticated, anon;
SQL

# fin_regua_custo_capital: aplica a migration REAL (não stub) — é ela que a nova RPC reusa.
P -q -f "$REPO_ROOT/supabase/migrations/20260704190000_fin_regua_custo_capital.sql"

# get_regua_preco (3 args) + _customer360 — corpo VERBATIM de pg_get_functiondef da PROD
# (2026-07-20). Fiel de propósito: a precondição da migration exige reconhecer este corpo, e o
# baseline abaixo mede o furo REAL, não uma imitação.
P -q <<'SQL'
CREATE FUNCTION public.get_regua_preco(p_customer uuid, p_product uuid, p_qty numeric)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $f$
DECLARE
  v_account text := 'oben'; v_cmc numeric; v_aliquota numeric;
  v_precos_cli numeric[]; v_comparaveis jsonb;
  v_qty_lo numeric := COALESCE(p_qty, 0) * 0.5;
  v_qty_hi numeric := COALESCE(p_qty, 0) * 2;
BEGIN
  IF NOT (public.has_role(auth.uid(), 'employee') OR public.has_role(auth.uid(), 'master')) THEN
    RAISE EXCEPTION 'forbidden: regua_preco exige staff' USING ERRCODE = '42501';
  END IF;
  SELECT ip.cmc INTO v_cmc FROM public.inventory_position ip
   WHERE ip.product_id = p_product AND ip.account IN ('oben', 'vendas')
     AND ip.cmc IS NOT NULL AND ip.cmc > 0
   ORDER BY (ip.account = 'oben') DESC LIMIT 1;
  SELECT COALESCE(
           (SELECT cc.value::numeric FROM public.company_config cc
             WHERE cc.key = 'regua_preco_aliquota_venda_oben'), 0.15) INTO v_aliquota;
  SELECT array_agg(oi.unit_price ORDER BY so.order_date_kpi DESC) INTO v_precos_cli
    FROM public.order_items oi JOIN public.sales_orders so ON so.id = oi.sales_order_id
   WHERE so.account = v_account AND so.deleted_at IS NULL
     AND oi.product_id = p_product AND oi.customer_user_id = p_customer
     AND oi.unit_price > 0 AND so.order_date_kpi >= current_date - interval '180 days';
  WITH base AS (
    SELECT oi.unit_price, dense_rank() OVER (ORDER BY oi.customer_user_id) AS c_ord
      FROM public.order_items oi JOIN public.sales_orders so ON so.id = oi.sales_order_id
     WHERE so.account = v_account AND so.deleted_at IS NULL
       AND oi.product_id = p_product AND oi.customer_user_id <> p_customer
       AND oi.unit_price > 0 AND oi.quantity BETWEEN v_qty_lo AND v_qty_hi
       AND so.order_date_kpi >= current_date - interval '180 days'
  )
  SELECT jsonb_agg(jsonb_build_object('preco', unit_price, 'c', c_ord)) INTO v_comparaveis FROM base;
  RETURN jsonb_build_object(
    'cmc', v_cmc, 'cmc_confiavel', v_cmc IS NOT NULL, 'aliquota_venda', v_aliquota,
    'piso_mc', CASE WHEN v_cmc IS NOT NULL AND v_aliquota >= 0 AND v_aliquota < 1
                    THEN round(v_cmc / (1 - v_aliquota), 4) ELSE NULL END,
    'precos_cliente', COALESCE(to_jsonb(v_precos_cli), '[]'::jsonb),
    'comparaveis', COALESCE(v_comparaveis, '[]'::jsonb));
END;
$f$;

CREATE FUNCTION public.get_regua_preco_customer360(p_customer uuid, p_omie_codigos bigint[])
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $f$
DECLARE
  v_account text := 'oben'; v_codigos bigint[]; v_codigo bigint; v_product_id uuid;
  v_preco_atual numeric; v_preco_atual_at date; v_qty_preco numeric;
  v_pacote jsonb; v_out jsonb := '[]'::jsonb;
BEGIN
  IF NOT (public.has_role(auth.uid(), 'employee') OR public.has_role(auth.uid(), 'master')) THEN
    RAISE EXCEPTION 'forbidden: regua_preco exige staff' USING ERRCODE = '42501';
  END IF;
  SELECT array_agg(DISTINCT x) INTO v_codigos
    FROM unnest(COALESCE(p_omie_codigos, ARRAY[]::bigint[])) x WHERE x IS NOT NULL;
  IF v_codigos IS NULL THEN RETURN '[]'::jsonb; END IF;
  FOREACH v_codigo IN ARRAY v_codigos LOOP
    v_product_id := NULL; v_preco_atual := NULL; v_preco_atual_at := NULL;
    v_qty_preco := NULL; v_pacote := NULL;
    SELECT oi.product_id INTO v_product_id
      FROM public.order_items oi JOIN public.sales_orders so ON so.id = oi.sales_order_id
     WHERE so.account = v_account AND so.deleted_at IS NULL
       AND oi.customer_user_id = p_customer AND oi.omie_codigo_produto = v_codigo
       AND oi.product_id IS NOT NULL
     ORDER BY so.order_date_kpi DESC NULLS LAST, so.created_at DESC NULLS LAST, oi.id DESC LIMIT 1;
    IF v_product_id IS NULL THEN
      v_out := v_out || jsonb_build_array(jsonb_build_object(
        'omie_codigo', v_codigo, 'hide_reason', 'sem_produto')); CONTINUE;
    END IF;
    SELECT oi.unit_price, so.order_date_kpi, oi.quantity
      INTO v_preco_atual, v_preco_atual_at, v_qty_preco
      FROM public.order_items oi JOIN public.sales_orders so ON so.id = oi.sales_order_id
     WHERE so.account = v_account AND so.deleted_at IS NULL
       AND oi.customer_user_id = p_customer AND oi.product_id = v_product_id AND oi.unit_price > 0
     ORDER BY so.order_date_kpi DESC NULLS LAST, so.created_at DESC NULLS LAST, oi.id DESC LIMIT 1;
    IF v_preco_atual IS NULL THEN
      v_out := v_out || jsonb_build_array(jsonb_build_object(
        'omie_codigo', v_codigo, 'product_id', v_product_id, 'hide_reason', 'sem_preco')); CONTINUE;
    END IF;
    IF v_qty_preco IS NULL OR v_qty_preco <= 0 THEN
      v_out := v_out || jsonb_build_array(jsonb_build_object(
        'omie_codigo', v_codigo, 'product_id', v_product_id, 'preco_atual', v_preco_atual,
        'preco_atual_at', v_preco_atual_at, 'hide_reason', 'sem_quantidade')); CONTINUE;
    END IF;
    v_pacote := public.get_regua_preco(p_customer, v_product_id, v_qty_preco);
    v_out := v_out || jsonb_build_array(jsonb_build_object(
        'omie_codigo', v_codigo, 'product_id', v_product_id, 'preco_atual', v_preco_atual,
        'preco_atual_at', v_preco_atual_at, 'qty_ref', v_qty_preco,
        'qty_ref_source', 'ultima_venda', 'hide_reason', NULL) || COALESCE(v_pacote, '{}'::jsonb));
  END LOOP;
  RETURN v_out;
END;
$f$;

GRANT EXECUTE ON FUNCTION public.get_regua_preco(uuid,uuid,numeric),
                          public.get_regua_preco_customer360(uuid,bigint[]) TO authenticated;
SQL

# ── seeds ──
P -q <<SQL
INSERT INTO auth.users(id) VALUES ('$M'),('$F'),('$E'),('$C'),('$CLI'),('$OUT');
INSERT INTO public.user_roles(user_id,role) VALUES
  ('$M','master'),('$F','employee'),('$E','employee'),('$C','customer');
INSERT INTO public.commercial_roles(user_id,commercial_role) VALUES ('$F','farmer'),('$E','estrategico');

-- alíquota REAL da prod (não o seed 0.15 da migration original)
INSERT INTO public.company_config(key,value) VALUES ('regua_preco_aliquota_venda_oben','0.078');
-- taxa: (15+5)/100 = 0.20 a.a.
INSERT INTO public.empresa_configuracao_custos(empresa,selic_anual,spread_oportunidade,armazenagem_fisica)
  VALUES ('OBEN', 15, 5, 3);

INSERT INTO public.inventory_position(product_id,account,cmc,saldo) VALUES ('$PRD','oben',12.40,100);
-- produto SEM cmc: prova "ausente ≠ zero" (piso_disponivel=false, não piso=0)
INSERT INTO public.inventory_position(product_id,account,cmc,saldo) VALUES ('$SEM','oben',NULL,50);

INSERT INTO public.sales_orders(id,account,order_date_kpi) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001','oben',current_date - 10),
  ('aaaaaaaa-0000-0000-0000-000000000002','oben',current_date - 20);
INSERT INTO public.order_items(sales_order_id,product_id,customer_user_id,unit_price,quantity,omie_codigo_produto) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001','$PRD','$CLI',18.00,10,9001),
  ('aaaaaaaa-0000-0000-0000-000000000002','$PRD','$OUT',19.50,10,9001);
SQL

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1.5 — BASELINE PRÉ-MIGRATION
# Sem o "antes", os asserts provariam só "farmer não vê" — e ficariam verdes se a régua tivesse
# parado de devolver o número por QUALQUER motivo (RPC quebrada, produto sem cmc, seed errado).
# O baseline é o que separa "minha migration fechou" de "nunca esteve aberto".
# ══════════════════════════════════════════════════════════════════════════════
BASE_CMC=$(as_user "$F" "SELECT (public.get_regua_preco('$CLI','$PRD',10))->>'cmc';")
BASE_PISO=$(as_user "$F" "SELECT (public.get_regua_preco('$CLI','$PRD',10))->>'piso_mc';")
BASE_ALIQ=$(as_user "$F" "SELECT (public.get_regua_preco('$CLI','$PRD',10))->>'aliquota_venda';")
P -q -c "INSERT INTO public.regua_preco_log(account,customer_user_id,product_id,salesperson_id,preco_atual,sinal_exibido,confianca,piso_mc,cmc_usado)
         VALUES ('oben','$CLI','$PRD','$F',12.00,'piso','alta',13.4490,12.40);"
BASE_LOG=$(as_user "$F" "SELECT count(*) FROM public.regua_preco_log;")
echo "baseline pré-migration: farmer vê cmc=$BASE_CMC piso_mc=$BASE_PISO aliquota=$BASE_ALIQ · lê log=$BASE_LOG linha(s)"
[ "$BASE_CMC" = "12.40" ] || { echo "❌ baseline inválido: farmer devia ver cmc=12.40 ANTES (veio [$BASE_CMC])"; exit 1; }
[ "$BASE_PISO" = "13.4490" ] || { echo "❌ baseline inválido: piso_mc esperado 13.4490 (veio [$BASE_PISO])"; exit 1; }
[ "$BASE_LOG" = "1" ] || { echo "❌ baseline inválido: farmer devia LER o log ANTES (veio [$BASE_LOG])"; exit 1; }

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — APLICAR A MIGRATION REAL (Lei #1) + IDEMPOTÊNCIA
# ══════════════════════════════════════════════════════════════════════════════
MIG="$REPO_ROOT/supabase/migrations/20260723150000_authz_custo_fu4f_fase2_regua.sql"
P -q -f "$MIG"
echo "migration aplicada: $(basename "$MIG")"
# O dono cola à mão: reaplicar depois de um erro de rede é o caso de uso REAL.
if P -q -f "$MIG" >/dev/null 2>&1; then ok "A0 idempotente — 2ª aplicação passa"; else bad "A0 2ª aplicação FALHOU"; fi

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 3 — ASSERTS
# ══════════════════════════════════════════════════════════════════════════════
echo "── estrutura: a assinatura velha morreu ──"
eq "A1 get_regua_preco(uuid,uuid,numeric) NÃO existe mais" \
   "$(Pq -c "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='get_regua_preco' AND pg_get_function_identity_arguments(p.oid)='uuid, uuid, numeric';")" "0"
eq "A2 existe EXATAMENTE 1 get_regua_preco (sem overload)" \
   "$(Pq -c "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname='get_regua_preco';")" "1"

echo "── payload: o número de custo saiu para TODO MUNDO ──"
eq "A3 farmer: sem chave 'cmc' no payload" \
   "$(as_user "$F" "SELECT (public.get_regua_preco('$CLI','$PRD',10,12.00,NULL)) ? 'cmc';")" "f"
eq "A4 farmer: sem chave 'aliquota_venda'" \
   "$(as_user "$F" "SELECT (public.get_regua_preco('$CLI','$PRD',10,12.00,NULL)) ? 'aliquota_venda';")" "f"
eq "A5 master TAMBÉM não recebe 'cmc' (a RPC não é canal de custo)" \
   "$(as_user "$M" "SELECT (public.get_regua_preco('$CLI','$PRD',10,12.00,NULL)) ? 'cmc';")" "f"

echo "── o SINAL fica (o ponto da decisão de produto) ──"
eq "A6 farmer: abaixo_piso=true com preço 12.00 (piso 13.4490)" \
   "$(as_user "$F" "SELECT (public.get_regua_preco('$CLI','$PRD',10,12.00,NULL))->>'abaixo_piso';")" "true"
eq "A7 farmer: abaixo_piso=false com preço 20.00" \
   "$(as_user "$F" "SELECT (public.get_regua_preco('$CLI','$PRD',10,20.00,NULL))->>'abaixo_piso';")" "false"
eq "A8 master: MESMO sinal do farmer (mascarar não muda a decisão)" \
   "$(as_user "$M" "SELECT (public.get_regua_preco('$CLI','$PRD',10,12.00,NULL))->>'abaixo_piso';")" "true"
eq "A9 farmer: piso_disponivel=true (distingue 'acima' de 'sem dado')" \
   "$(as_user "$F" "SELECT (public.get_regua_preco('$CLI','$PRD',10,12.00,NULL))->>'piso_disponivel';")" "true"

echo "── o NÚMERO fecha ──"
eq "A10 farmer: piso_mc mascarado" \
   "$(as_user "$F" "SELECT coalesce((public.get_regua_preco('$CLI','$PRD',10,12.00,NULL))->>'piso_mc','NULL');")" "NULL"
eq "A11 farmer: piso_gap_pct mascarado (é invertível para o piso)" \
   "$(as_user "$F" "SELECT coalesce((public.get_regua_preco('$CLI','$PRD',10,12.00,NULL))->>'piso_gap_pct','NULL');")" "NULL"
eq "A12 master: piso_mc = 13.4491 (piso APLICÁVEL: cmc/(1-0,078) arredondado p/ cima)" \
   "$(as_user "$M" "SELECT (public.get_regua_preco('$CLI','$PRD',10,12.00,NULL))->>'piso_mc';")" "13.4491"
# 13.449023861…/12.00 − 1 = 0.120752 — o MESMO valor que o cálculo independente em node deu.
# (Antes da correção de arredondamento dava 0.120750, porque o gap saía do piso já truncado.)
eq "A13 master: piso_gap_pct = 0.120758 (do piso APLICÁVEL — gap×preço reconstrói o que o botão aplica)" \
   "$(as_user "$M" "SELECT (public.get_regua_preco('$CLI','$PRD',10,12.00,NULL))->>'piso_gap_pct';")" "0.120758"
eq "A14 estrategico: piso_mc = 13.4491 (a capability concede)" \
   "$(as_user "$E" "SELECT (public.get_regua_preco('$CLI','$PRD',10,12.00,NULL))->>'piso_mc';")" "13.4491"

echo "── ausente ≠ zero ──"
eq "A15 produto SEM cmc: piso_disponivel=false" \
   "$(as_user "$M" "SELECT (public.get_regua_preco('$CLI','$SEM',10,12.00,NULL))->>'piso_disponivel';")" "false"
eq "A16 produto SEM cmc: abaixo_piso=false (não fabrica sinal)" \
   "$(as_user "$M" "SELECT (public.get_regua_preco('$CLI','$SEM',10,12.00,NULL))->>'abaixo_piso';")" "false"
eq "A17 produto SEM cmc: piso_mc NULL mesmo p/ master (não vira 0)" \
   "$(as_user "$M" "SELECT coalesce((public.get_regua_preco('$CLI','$SEM',10,12.00,NULL))->>'piso_mc','NULL');")" "NULL"

echo "── custo do PRAZO (F2) veio junto — o furo silencioso ──"
eq "A18 master: piso com prazo [0,30,60] = 13.6685 (> à vista 13.4491)" \
   "$(as_user "$M" "SELECT (public.get_regua_preco('$CLI','$PRD',10,12.00,ARRAY[0,30,60]::numeric[]))->>'piso_mc';")" "13.6685"
eq "A19 prazo_aplicado=true" \
   "$(as_user "$M" "SELECT (public.get_regua_preco('$CLI','$PRD',10,12.00,ARRAY[0,30,60]::numeric[]))->>'prazo_aplicado';")" "true"
# ⚠️ O assert mais importante do prazo: 13.50 está ACIMA do piso à vista (13.4490) e ABAIXO do piso
# com prazo (13.6684). Se o ajuste de prazo ficasse no cliente sem cmc, o sinal viria `false` e a
# vendedora fecharia abaixo do piso real. Só este assert separa os dois mundos.
eq "A20 farmer: preço 13.50 é ABAIXO do piso porque o prazo entra" \
   "$(as_user "$F" "SELECT (public.get_regua_preco('$CLI','$PRD',10,13.50,ARRAY[0,30,60]::numeric[]))->>'abaixo_piso';")" "true"
eq "A21 farmer: o MESMO 13.50 é acima do piso À VISTA (prova que A20 não é trivial)" \
   "$(as_user "$F" "SELECT (public.get_regua_preco('$CLI','$PRD',10,13.50,NULL))->>'abaixo_piso';")" "false"
eq "A22 prazo com dia > 180 degrada para À VISTA (não NULL, não fabricado)" \
   "$(as_user "$M" "SELECT (public.get_regua_preco('$CLI','$PRD',10,12.00,ARRAY[0,400]::numeric[]))->>'piso_mc';")" "13.4491"
eq "A23 ... e sinaliza prazo_aplicado=false" \
   "$(as_user "$M" "SELECT (public.get_regua_preco('$CLI','$PRD',10,12.00,ARRAY[0,400]::numeric[]))->>'prazo_aplicado';")" "false"

echo "── regua_preco_log: leitura fecha (vs baseline: farmer LIA) ──"
# conta real no instante do assert (a tabela cresce ao longo do harness — expectativa fixa seria frágil)
NLOG=$(Pq -c "SELECT count(*) FROM public.regua_preco_log;" | tail -1)
eq "A24 farmer NÃO lê o log (lia $BASE_LOG antes)" "$(as_user "$F" 'SELECT count(*) FROM public.regua_preco_log;')" "0"
eq "A25 master LÊ o log"                            "$(as_user "$M" 'SELECT count(*) FROM public.regua_preco_log;')" "$NLOG"
eq "A26 estrategico LÊ o log"                       "$(as_user "$E" 'SELECT count(*) FROM public.regua_preco_log;')" "$NLOG"
# anon já não passa nem do GRANT (o REVOKE tirou tudo), então a negação é de PRIVILÉGIO, não de
# RLS — mais forte que o "0 linhas" de antes. Medir "0" aqui daria falso-verde por erro engolido.
eq "A27 anon NÃO lê o log (negado no privilégio, antes da RLS)" \
   "$(Pq -c "SELECT has_table_privilege('anon','public.regua_preco_log','SELECT');" | tail -1)" "f"

echo "── writer por RPC: salesperson_id fixado, custo apurado no servidor ──"
LOGID=$(as_user "$F" "SELECT public.registrar_exibicao_regua('oben','$CLI','$PRD',10,12.00,'piso','alta',NULL,NULL,NULL,false,ARRAY['x']::text[],NULL);")
eq "A28 RPC devolve um uuid (log gravado)" "$(Pq -c "SELECT ('$LOGID' ~ '^[0-9a-f-]{36}$');" | tail -1)" "t"
eq "A29 salesperson_id FIXADO em auth.uid() do farmer" \
   "$(Pq -c "SELECT salesperson_id FROM public.regua_preco_log WHERE id='$LOGID';" | tail -1)" "$F"
eq "A30 piso_mc gravado pelo SERVIDOR (cliente não o tem mais)" \
   "$(Pq -c "SELECT piso_mc FROM public.regua_preco_log WHERE id='$LOGID';" | tail -1)" "13.4491"
eq "A31 cmc_usado gravado pelo SERVIDOR" \
   "$(Pq -c "SELECT cmc_usado FROM public.regua_preco_log WHERE id='$LOGID';" | tail -1)" "12.40"
eq "A32 aliquota_usada gravada pelo SERVIDOR" \
   "$(Pq -c "SELECT aliquota_usada FROM public.regua_preco_log WHERE id='$LOGID';" | tail -1)" "0.078"
eq "A33 farmer NÃO consegue reler o que acabou de gravar (escreve mas não lê)" \
   "$(as_user "$F" "SELECT count(*) FROM public.regua_preco_log WHERE id='$LOGID';")" "0"

echo "── outcome: só o dono fecha o próprio loop ──"
eq "A34 dono fecha o loop → true" \
   "$(as_user "$F" "SELECT public.registrar_aplicacao_regua('$LOGID', 14.00);")" "t"
eq "A35 ... e o outcome ficou 'aplicado'" \
   "$(Pq -c "SELECT outcome_status FROM public.regua_preco_log WHERE id='$LOGID';" | tail -1)" "aplicado"
eq "A36 OUTRO staff NÃO fecha o loop alheio → false" \
   "$(as_user "$E" "SELECT public.registrar_aplicacao_regua('$LOGID', 99.00);")" "f"
eq "A37 ... e o preço final NÃO foi sobrescrito" \
   "$(Pq -c "SELECT preco_final FROM public.regua_preco_log WHERE id='$LOGID';" | tail -1)" "14.00"

echo "── customer 360 ──"
eq "A38 360 devolve abaixo_piso (decisão pronta do servidor)" \
   "$(as_user "$F" "SELECT (public.get_regua_preco_customer360('$CLI',ARRAY[9001]::bigint[])->0)->>'abaixo_piso';")" "false"
eq "A39 360 NÃO devolve cmc" \
   "$(as_user "$F" "SELECT (public.get_regua_preco_customer360('$CLI',ARRAY[9001]::bigint[])->0) ? 'cmc';")" "f"
eq "A40 360 mascara piso_mc p/ farmer" \
   "$(as_user "$F" "SELECT coalesce((public.get_regua_preco_customer360('$CLI',ARRAY[9001]::bigint[])->0)->>'piso_mc','NULL');")" "NULL"
eq "A41 360 dá piso_mc ao master (aplicável)" \
   "$(as_user "$M" "SELECT (public.get_regua_preco_customer360('$CLI',ARRAY[9001]::bigint[])->0)->>'piso_mc';")" "13.4491"

echo "── finitude: numeric aceita NaN/Infinity e as comparações MENTEM ──"
# `'NaN'::numeric > 0` é TRUE e `12 < 'NaN'` é TRUE (NaN ordena como o maior). Sem guard, um cmc
# NaN marcaria TODO preço como abaixo do piso — a régua gritando vermelho no catálogo inteiro.
P -q -c "INSERT INTO public.inventory_position(product_id,account,cmc,saldo)
         VALUES ('$NAN','oben','NaN'::numeric,10), ('$INF','oben','Infinity'::numeric,10);"
eq "A42 cmc NaN → piso_disponivel=false" \
   "$(as_user "$M" "SELECT (public.get_regua_preco('$CLI','$NAN',10,12.00,NULL))->>'piso_disponivel';")" "false"
eq "A43 cmc NaN → abaixo_piso=false (não marca todo preço como abaixo)" \
   "$(as_user "$F" "SELECT (public.get_regua_preco('$CLI','$NAN',10,12.00,NULL))->>'abaixo_piso';")" "false"
eq "A44 cmc Infinity → piso_disponivel=false" \
   "$(as_user "$M" "SELECT (public.get_regua_preco('$CLI','$INF',10,12.00,NULL))->>'piso_disponivel';")" "false"
eq "A45 preço NaN não vira sinal" \
   "$(as_user "$F" "SELECT (public.get_regua_preco('$CLI','$PRD',10,'NaN'::numeric,NULL))->>'abaixo_piso';")" "false"
eq "A46 mais de 12 parcelas degrada p/ à vista (array vem do CLIENTE, sem passar pelo parser)" \
   "$(as_user "$M" "SELECT (public.get_regua_preco('$CLI','$PRD',10,12.00,(SELECT array_agg(30::numeric) FROM generate_series(1,13))))->>'prazo_aplicado';")" "false"

echo "── arredondamento não move a fronteira da decisão ──"
# piso íntegro = 12.40/0.922 = 13.449023861…; a 4 casas seria 13.4490. Um preço ENTRE os dois
# separa os dois mundos: é abaixo do piso real, e "saudável" se a comparação usar o arredondado.
eq "A47 preço 13.44901 (entre o piso íntegro e o arredondado) é ABAIXO" \
   "$(as_user "$F" "SELECT (public.get_regua_preco('$CLI','$PRD',10,13.44901,NULL))->>'abaixo_piso';")" "true"
eq "A48 ... e o piso EXIBIDO fica em 4 casas, sem vazar escala de 16 dígitos" \
   "$(as_user "$M" "SELECT (public.get_regua_preco('$CLI','$PRD',10,13.44901,NULL))->>'piso_mc';")" "13.4491"

echo "── round-trip: o piso EXPOSTO, se aplicado, limpa o piso ──"
# Regressão da correção de arredondamento: com round(), o valor devolvido (13.4490) continuava
# ABAIXO do piso íntegro (13.449023861…), então "Aplicar piso" mantinha o vermelho — laço infinito
# para quem tem o botão. Com ceil na mesma escala, aplicar o valor devolvido SEMPRE limpa.
PISO_EXIB=$(as_user "$M" "SELECT (public.get_regua_preco('$CLI','$PRD',10,12.00,NULL))->>'piso_mc';")
eq "A52 piso exposto é arredondado p/ CIMA (aplicável), não p/ o mais próximo" "$PISO_EXIB" "13.4491"
eq "A53 aplicar o piso exposto → abaixo_piso=false (round-trip fecha)" \
   "$(as_user "$M" "SELECT (public.get_regua_preco('$CLI','$PRD',10,$PISO_EXIB,NULL))->>'abaixo_piso';")" "false"
eq "A54 ... e um tico abaixo dele ainda é vermelho (o assert não é trivial)" \
   "$(as_user "$M" "SELECT (public.get_regua_preco('$CLI','$PRD',10,13.4490,NULL))->>'abaixo_piso';")" "true"

echo "── array multidimensional não fura o cap de parcelas ──"
# array_length(a,1) só vê a 1ª dimensão: um 2x7 devolve 2, passa num cap de 12, e o unnest
# processa 14 assim mesmo. Medido no PG17; por isso o guard é ndims + cardinality.
eq "A55 array 2x7 (14 parcelas disfarçadas de 2) degrada p/ à vista" \
   "$(as_user "$M" "SELECT (public.get_regua_preco('$CLI','$PRD',10,12.00,ARRAY[[0,10,20,30,40,50,60],[70,80,90,100,110,120,130]]::numeric[]))->>'prazo_aplicado';")" "false"

echo "── privilégios de tabela: TRUNCATE não passa por RLS ──"
eq "A49 authenticated NÃO tem TRUNCATE no log" \
   "$(Pq -c "SELECT has_table_privilege('authenticated','public.regua_preco_log','TRUNCATE');" | tail -1)" "f"
eq "A50 authenticated NÃO tem DELETE no log" \
   "$(Pq -c "SELECT has_table_privilege('authenticated','public.regua_preco_log','DELETE');" | tail -1)" "f"
eq "A51 authenticated MANTÉM o SELECT (senão a policy de leitura fica inerte)" \
   "$(Pq -c "SELECT has_table_privilege('authenticated','public.regua_preco_log','SELECT');" | tail -1)" "t"

# ── negativos: SQLSTATE esperada + re-raise do resto (Lei #2) ──
echo "── negativos (SQLSTATE exata, WHEN OTHERS RE-LANÇA) ──"
neg() { # $1 nome — o SQL vem por stdin; sai 0 só se a exceção ESPERADA aconteceu
  if P -q -v cli="$CLI" -v prd="$PRD" -v uid="$2" -f /dev/stdin >/dev/null 2>&1
  then ok "$1"; else bad "$1 — não barrou com a SQLSTATE esperada"; fi; }

neg "N1 customer chamando get_regua_preco → 42501" "$C" <<'SQL'
-- :'var' NÃO é interpolado dentro de dollar-quote, então os uuids viajam por GUC.
SET test.uid = :'uid';
SET test.cli = :'cli';
SET test.prd = :'prd';
SET ROLE authenticated;
DO $$
BEGIN
  PERFORM public.get_regua_preco(current_setting('test.cli')::uuid, current_setting('test.prd')::uuid, 10, 12.00, NULL);
  RAISE EXCEPTION 'ASSERT_FALHOU_customer_passou';
EXCEPTION
  WHEN insufficient_privilege THEN NULL;
  WHEN OTHERS THEN RAISE;
END $$;
SQL

neg "N2 customer chamando registrar_exibicao_regua → 42501" "$C" <<'SQL'
-- :'var' NÃO é interpolado dentro de dollar-quote, então os uuids viajam por GUC.
SET test.uid = :'uid';
SET test.cli = :'cli';
SET test.prd = :'prd';
SET ROLE authenticated;
DO $$
BEGIN
  PERFORM public.registrar_exibicao_regua('oben', current_setting('test.cli')::uuid,
          current_setting('test.prd')::uuid, 10, 12.00, 'piso', 'alta');
  RAISE EXCEPTION 'ASSERT_FALHOU_customer_escreveu';
EXCEPTION
  WHEN insufficient_privilege THEN NULL;
  WHEN OTHERS THEN RAISE;
END $$;
SQL

# ⚠️ A migration REVOGOU o INSERT, então sem este GRANT temporário a negação viria do PRIVILÉGIO
# e o N3 passaria mesmo se uma policy permissiva de INSERT reaparecesse — falso-verde apontado na
# rodada 2. Concede o INSERT só para provar que a RLS (ausência de policy) é que barra, e revoga.
P -q -c "GRANT INSERT ON public.regua_preco_log TO authenticated;"
neg "N3 farmer INSERT DIRETO no log → 42501 (RLS barra, COM o privilégio concedido)" "$F" <<'SQL'
-- :'var' NÃO é interpolado dentro de dollar-quote, então os uuids viajam por GUC.
SET test.uid = :'uid';
SET test.cli = :'cli';
SET test.prd = :'prd';
SET ROLE authenticated;
DO $$
BEGIN
  INSERT INTO public.regua_preco_log(account,customer_user_id,product_id,preco_atual,sinal_exibido,confianca)
  VALUES ('oben', current_setting('test.cli')::uuid, current_setting('test.prd')::uuid, 1, 'piso', 'alta');
  RAISE EXCEPTION 'ASSERT_FALHOU_insert_direto_passou';
EXCEPTION
  WHEN insufficient_privilege THEN NULL;
  WHEN OTHERS THEN RAISE;
END $$;
SQL

P -q -c "REVOKE INSERT ON public.regua_preco_log FROM authenticated;"

neg "N4 authenticated NÃO executa private.regua_piso_calc → 42501" "$F" <<'SQL'
-- :'var' NÃO é interpolado dentro de dollar-quote, então os uuids viajam por GUC.
SET test.uid = :'uid';
SET test.cli = :'cli';
SET test.prd = :'prd';
SET ROLE authenticated;
DO $$
DECLARE v numeric;
BEGIN
  SELECT piso INTO v FROM private.regua_piso_calc(12.40, 0.078, NULL, NULL);
  RAISE EXCEPTION 'ASSERT_FALHOU_helper_executavel';
EXCEPTION
  WHEN insufficient_privilege THEN NULL;
  WHEN OTHERS THEN RAISE;
END $$;
SQL

neg "N5 farmer NÃO consegue TRUNCATE o log (REVOKE, não RLS) → 42501" "$F" <<'SQL'
SET test.uid = :'uid';
SET test.cli = :'cli';
SET test.prd = :'prd';
SET ROLE authenticated;
DO $$
BEGIN
  TRUNCATE public.regua_preco_log;
  RAISE EXCEPTION 'ASSERT_FALHOU_truncate_passou';
EXCEPTION
  WHEN insufficient_privilege THEN NULL;
  WHEN OTHERS THEN RAISE;
END $$;
SQL

neg "N6 writer REJEITA preco_atual NaN (fronteira de confiança) → 22023" "$F" <<'SQL'
SET test.uid = :'uid';
SET test.cli = :'cli';
SET test.prd = :'prd';
SET ROLE authenticated;
DO $$
BEGIN
  PERFORM public.registrar_exibicao_regua('oben', current_setting('test.cli')::uuid,
          current_setting('test.prd')::uuid, 10, 'NaN'::numeric, 'piso', 'alta');
  RAISE EXCEPTION 'ASSERT_FALHOU_nan_persistido';
EXCEPTION
  WHEN invalid_parameter_value THEN NULL;
  WHEN OTHERS THEN RAISE;
END $$;
SQL

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4 — FALSIFICAÇÃO
# Cada sabotagem exige o VALOR EXATO que ela produz. "Diferente do baseline" não serve: um erro
# de SQL também é diferente, e a falsificação ficaria vermelha pelo motivo errado.
# ══════════════════════════════════════════════════════════════════════════════
echo "── falsificação (cada sabotagem exige o valor EXATO que produziria) ──"
FALS_OK=0; FALS_BAD=0
fals() { if [ "$2" = "$3" ]; then FALS_OK=$((FALS_OK+1)); echo "  🔴 $1 — derrubou com o valor exato [$3]";
         else FALS_BAD=$((FALS_BAD+1)); echo "  ⚠️  $1 — esperava [$3], veio [$2]: sabotagem não reproduziu o furo"; fi; }

# F1 — a assinatura de 3 args RESSUSCITA: o furo original volta inteiro (farmer lê cmc=12.40).
P -q <<'SQL'
CREATE FUNCTION public.get_regua_preco(p_customer uuid, p_product uuid, p_qty numeric)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $f$
DECLARE v_cmc numeric;
BEGIN
  SELECT ip.cmc INTO v_cmc FROM public.inventory_position ip
   WHERE ip.product_id=p_product AND ip.cmc IS NOT NULL LIMIT 1;
  RETURN jsonb_build_object('cmc', v_cmc);
END $f$;
GRANT EXECUTE ON FUNCTION public.get_regua_preco(uuid,uuid,numeric) TO authenticated;
SQL
fals "F1 assinatura de 3 args ressuscitada (vs A1/A3)" \
     "$(as_user "$F" "SELECT (public.get_regua_preco('$CLI','$PRD',10))->>'cmc';")" "12.40"
P -q -c "DROP FUNCTION public.get_regua_preco(uuid,uuid,numeric);"

# F2 — piso_mc emitido SEM o gate v_pode_num: o farmer volta a ver EXATAMENTE 13.4490.
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.get_regua_preco(
  p_customer uuid, p_product uuid, p_qty numeric, p_preco_atual numeric, p_prazo_dias numeric[] DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $f$
DECLARE v_cmc numeric; v_aliq numeric; v_piso numeric;
BEGIN
  IF NOT (public.has_role((SELECT auth.uid()),'employee') OR public.has_role((SELECT auth.uid()),'master')) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE='42501';
  END IF;
  SELECT ip.cmc INTO v_cmc FROM public.inventory_position ip
   WHERE ip.product_id=p_product AND ip.cmc IS NOT NULL LIMIT 1;
  SELECT COALESCE((SELECT cc.value::numeric FROM public.company_config cc
                    WHERE cc.key='regua_preco_aliquota_venda_oben'),0.15) INTO v_aliq;
  SELECT piso INTO v_piso FROM private.regua_piso_calc(v_cmc, v_aliq, NULL, NULL);
  -- SABOTAGEM: emite piso_mc SEM o gate v_pode_num. Tudo o mais idêntico à real (inclusive o
  -- round de apresentação), para o vermelho vir do GATE ausente e não de outra diferença.
  RETURN jsonb_build_object('abaixo_piso', p_preco_atual < v_piso,
                            'piso_mc', round(ceil(v_piso * 10000) / 10000, 4));
END $f$;
SQL
fals "F2 piso_mc sem o gate v_pode_num (vs A10)" \
     "$(as_user "$F" "SELECT (public.get_regua_preco('$CLI','$PRD',10,12.00,NULL))->>'piso_mc';")" "13.4491"
P -q -f "$MIG" >/dev/null   # restaura a versão verdadeira

# F3 — policy do log volta a incluir `employee`: o farmer relê EXATAMENTE 1 linha.
P -q <<'SQL'
DROP POLICY regua_preco_log_select_custo ON public.regua_preco_log;
CREATE POLICY regua_preco_log_select_custo ON public.regua_preco_log FOR SELECT TO authenticated
  USING (private.cap_custo_ler(auth.uid()) OR public.has_role(auth.uid(),'employee'));
SQL
NLOG_F3=$(Pq -c "SELECT count(*) FROM public.regua_preco_log;" | tail -1)
fals "F3 policy do log com OR employee (vs A24)" \
     "$(as_user "$F" 'SELECT count(*) FROM public.regua_preco_log;')" "$NLOG_F3"
P -q -c "DROP POLICY regua_preco_log_select_custo ON public.regua_preco_log;
         CREATE POLICY regua_preco_log_select_custo ON public.regua_preco_log FOR SELECT TO authenticated
           USING ((SELECT private.cap_custo_ler((SELECT auth.uid()))));"

# F4 — o REVOKE do helper é esquecido: o farmer chama private.regua_piso_calc direto e lê 13.4490.
# concede os DOIS: regua_piso_calc chama regua_num_finito, e esquecer o segundo faria a
# sabotagem falhar por permissão no helper interno — vermelho pelo motivo errado.
P -q -c "GRANT EXECUTE ON FUNCTION private.regua_piso_calc(numeric,numeric,numeric[],numeric) TO authenticated;
         GRANT EXECUTE ON FUNCTION private.regua_num_finito(numeric) TO authenticated;"
fals "F4 REVOKE do helper esquecido (vs N4)" \
     "$(as_user "$F" "SELECT round(piso,4) FROM private.regua_piso_calc(12.40, 0.078, NULL, NULL);")" "13.4490"
P -q -c "REVOKE ALL ON FUNCTION private.regua_piso_calc(numeric,numeric,numeric[],numeric) FROM PUBLIC, anon, authenticated;
         REVOKE ALL ON FUNCTION private.regua_num_finito(numeric) FROM PUBLIC, anon, authenticated;"

# F5 — o writer volta a ACEITAR salesperson_id: o farmer grava em nome do estratégico.
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.registrar_exibicao_regua(
  p_account text, p_customer_user_id uuid, p_product_id uuid, p_quantity numeric,
  p_preco_atual numeric, p_sinal_exibido text, p_confianca text,
  p_preco_referencia numeric DEFAULT NULL, p_observed_gap_pct numeric DEFAULT NULL,
  p_suggested_gap_pct numeric DEFAULT NULL, p_cap_limitou boolean DEFAULT false,
  p_reason_codes text[] DEFAULT NULL, p_prazo_dias numeric[] DEFAULT NULL,
  p_salesperson_id uuid DEFAULT NULL)                                   -- SABOTAGEM: forjável
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $f$
DECLARE v_id uuid;
BEGIN
  INSERT INTO public.regua_preco_log(account,customer_user_id,product_id,salesperson_id,
                                     preco_atual,sinal_exibido,confianca)
  VALUES (p_account,p_customer_user_id,p_product_id,
          COALESCE(p_salesperson_id,(SELECT auth.uid())),p_preco_atual,p_sinal_exibido,p_confianca)
  RETURNING id INTO v_id;
  RETURN v_id;
END $f$;
GRANT EXECUTE ON FUNCTION public.registrar_exibicao_regua(text,uuid,uuid,numeric,numeric,text,text,numeric,numeric,numeric,boolean,text[],numeric[],uuid) TO authenticated;
SQL
FORJADO=$(as_user "$F" "SELECT public.registrar_exibicao_regua('oben','$CLI','$PRD',10,12.00,'piso','alta',NULL,NULL,NULL,false,NULL,NULL,'$E');")
fals "F5 writer aceita salesperson_id do cliente (vs A29)" \
     "$(Pq -c "SELECT salesperson_id FROM public.regua_preco_log WHERE id='$FORJADO';" | tail -1)" "$E"
P -q -c "DROP FUNCTION public.registrar_exibicao_regua(text,uuid,uuid,numeric,numeric,text,text,numeric,numeric,numeric,boolean,text[],numeric[],uuid);"
P -q -c "DELETE FROM public.regua_preco_log WHERE id='$FORJADO';"
P -q -f "$MIG" >/dev/null

# F6 — o ajuste de PRAZO é descartado (o furo silencioso): o piso cai para o à vista 13.4490 e o
#      13.50 que estava abaixo do piso real passa a parecer saudável.
P -q <<'SQL'
CREATE OR REPLACE FUNCTION private.regua_piso_calc(
  p_cmc numeric, p_aliquota numeric, p_dias numeric[], p_taxa numeric,
  OUT piso numeric, OUT prazo_aplicado boolean)
LANGUAGE plpgsql IMMUTABLE AS $f$
BEGIN
  piso := NULL; prazo_aplicado := false;
  IF p_cmc IS NULL OR p_cmc <= 0 THEN RETURN; END IF;
  IF p_aliquota IS NULL OR NOT (p_aliquota >= 0 AND p_aliquota < 1) THEN RETURN; END IF;
  piso := round(p_cmc / (1 - p_aliquota), 4);   -- SABOTAGEM: ignora o prazo
END $f$;
SQL
fals "F6a prazo descartado — piso volta ao à vista (vs A18)" \
     "$(as_user "$M" "SELECT (public.get_regua_preco('$CLI','$PRD',10,12.00,ARRAY[0,30,60]::numeric[]))->>'piso_mc';")" "13.4490"
fals "F6b ... e o 13.50 abaixo do piso real vira 'saudável' (vs A20)" \
     "$(as_user "$F" "SELECT (public.get_regua_preco('$CLI','$PRD',10,13.50,ARRAY[0,30,60]::numeric[]))->>'abaixo_piso';")" "false"
P -q -f "$MIG" >/dev/null

# F7 — registrar_aplicacao_regua sem o filtro de dono: o estratégico sobrescreve o outcome alheio.
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.registrar_aplicacao_regua(p_log_id uuid, p_preco_final numeric)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $f$
DECLARE v_n int;
BEGIN
  UPDATE public.regua_preco_log
     SET preco_final = p_preco_final, aplicou = true, outcome_status='aplicado', outcome_at=now()
   WHERE id = p_log_id;                                  -- SABOTAGEM: sem AND salesperson_id = uid
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RETURN v_n = 1;
END $f$;
SQL
as_user "$E" "SELECT public.registrar_aplicacao_regua('$LOGID', 99.00);" > /dev/null
# não basta o retorno `true`: o que importa é o dado ter sido SOBRESCRITO (A37 mede o valor).
fals "F7 outcome sem filtro de dono — preco_final alheio sobrescrito (vs A37)" \
     "$(Pq -c "SELECT preco_final FROM public.regua_preco_log WHERE id='$LOGID';" | tail -1)" "99.00"
P -q -f "$MIG" >/dev/null

echo "  falsificação: $FALS_OK derrubaram / $FALS_BAD não reproduziram"
[ "$FALS_BAD" = "0" ] || FAIL=$((FAIL+1))

# ── veredito ──
# ⚠️ Contagem EXATA, não só FAIL=0 (achado P3 do Codex): sem isto, apagar um assert ou uma
# sabotagem mantém o harness verde — o teste degradaria em silêncio, que é o modo de falha que
# este arquivo inteiro existe para impedir. Mudou o número de asserts? Atualize AQUI, conscientemente.
PASS_ESPERADO=62
FALS_ESPERADO=8
echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail · falsificações: $FALS_OK"
[ "$PASS" = "$PASS_ESPERADO" ] || { echo "❌ COBERTURA MUDOU: $PASS asserts, esperado $PASS_ESPERADO"; FAIL=$((FAIL+1)); }
[ "$FALS_OK" = "$FALS_ESPERADO" ] || { echo "❌ FALSIFICAÇÕES: $FALS_OK derrubaram, esperado $FALS_ESPERADO"; FAIL=$((FAIL+1)); }
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE ($PASS asserts, $FALS_OK falsificações)"
