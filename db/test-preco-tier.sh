#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA PG17 — Preço por tier (migration 20260704120000_preco_por_tier.sql)    ║
# ║  Spec: docs/superpowers/specs/preco-por-tier.md (v2.1 APROVADA)               ║
# ║  bash db/test-preco-tier.sh > /tmp/t.log 2>&1; echo "exit=$?"                  ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5471}"
SLUG="preco-tier"
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
-- Prod: authenticated/anon acessam auth.uid()/auth.role() (o trigger anti-forje, não-SECDEF,
-- roda como o caller e os invoca). No PG puro é preciso conceder USAGE/EXECUTE explícito.
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.uid(), auth.role() TO anon, authenticated, service_role;
SQL

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

echo "═══ setup pronto (PG17 :$PORT) ═══"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — PRÉ-REQUISITOS (o que a migração lê/altera mas não cria) — fiel a prod
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
-- Espelha o Supabase: toda função nova em public nasce com EXECUTE p/ anon/authenticated/
-- service_role (grant EXPLÍCITO via default privileges). Sem isto, o REVOKE ... FROM PUBLIC da
-- migration derrubaria authenticated no PG puro — divergindo de prod, onde authenticated tem
-- grant próprio que o REVOKE PUBLIC não toca (database.md §7).
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;

-- roles / gate infra
CREATE TYPE public.app_role AS ENUM ('employee','master','customer');
CREATE TABLE public.user_roles (user_id uuid, role public.app_role);
CREATE TABLE public.gestores   (user_id uuid);  -- stub: marca quem tem carteira completa
CREATE FUNCTION public.has_role(p_uid uuid, p_role public.app_role) RETURNS boolean
  LANGUAGE sql STABLE AS $$ SELECT EXISTS(SELECT 1 FROM public.user_roles WHERE user_id=p_uid AND role=p_role) $$;
CREATE FUNCTION public.pode_ver_carteira_completa(p_uid uuid) RETURNS boolean
  LANGUAGE sql STABLE AS $$
    SELECT public.has_role(p_uid,'master') OR EXISTS(SELECT 1 FROM public.gestores WHERE user_id=p_uid) $$;

-- markup_policy VIGENTE (fiel ao pré-flight psql-ro: colunas + CHECKs + RLS staff-wide + 1 linha)
CREATE TABLE public.markup_policy (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account text NOT NULL,
  escopo text NOT NULL,
  familia text,
  sku_codigo bigint,
  piso_markup numeric NOT NULL,
  meta_markup numeric NOT NULL,
  updated_by uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT markup_policy_check CHECK (meta_markup >= piso_markup),
  CONSTRAINT markup_policy_check1 CHECK (
    ((escopo='conta'   AND familia IS NULL     AND sku_codigo IS NULL) OR
     (escopo='familia' AND familia IS NOT NULL AND sku_codigo IS NULL) OR
     (escopo='sku'     AND sku_codigo IS NOT NULL))),
  CONSTRAINT markup_policy_escopo_check CHECK (escopo = ANY(ARRAY['conta','familia','sku'])),
  CONSTRAINT markup_policy_finite CHECK (piso_markup <> 'NaN'::numeric AND meta_markup <> 'NaN'::numeric
    AND piso_markup < 'Infinity'::numeric AND meta_markup < 'Infinity'::numeric),
  CONSTRAINT markup_policy_meta_markup_check CHECK (meta_markup >= 0),
  CONSTRAINT markup_policy_piso_markup_check CHECK (piso_markup >= 0)
);
ALTER TABLE public.markup_policy ENABLE ROW LEVEL SECURITY;
CREATE POLICY "markup_policy_select_staff" ON public.markup_policy FOR SELECT
  USING (public.has_role(auth.uid(),'employee') OR public.has_role(auth.uid(),'master'));
CREATE POLICY "markup_policy_write_master" ON public.markup_policy FOR ALL
  USING (public.has_role(auth.uid(),'master'));
-- Índices únicos parciais VIGENTES em prod (por escopo, SEM tier) — fielmente reproduzidos:
-- sem o DROP na migration, o seed (conta,tier) colide com a linha-base (23505). A prova exige isso.
CREATE UNIQUE INDEX uq_markup_policy_conta ON public.markup_policy (account) WHERE escopo='conta';
CREATE UNIQUE INDEX uq_markup_policy_fam ON public.markup_policy (account, familia) WHERE escopo='familia';
CREATE UNIQUE INDEX uq_markup_policy_sku ON public.markup_policy (account, sku_codigo) WHERE escopo='sku';
INSERT INTO public.markup_policy(account,escopo,piso_markup,meta_markup) VALUES ('oben','conta',30,50);
-- SKU commodity de piso BAIXO (sem tier): prova P1-5 (não pode derrubar o piso do tier).
INSERT INTO public.markup_policy(account,escopo,sku_codigo,piso_markup,meta_markup) VALUES ('oben','sku',777,20,50);

-- resolve_markup_policy VIGENTE (3 args) — a migration a DROPa (anti-overload)
CREATE FUNCTION public.resolve_markup_policy(p_empresa text, p_codigo bigint, p_familia text)
RETURNS TABLE(piso_markup numeric, meta_markup numeric) LANGUAGE sql STABLE SET search_path TO 'public' AS $$
  SELECT piso_markup, meta_markup FROM public.markup_policy
  WHERE account=lower(p_empresa)
    AND ((escopo='sku' AND sku_codigo=p_codigo) OR (escopo='familia' AND p_familia IS NOT NULL AND familia=p_familia) OR (escopo='conta'))
  ORDER BY CASE escopo WHEN 'sku' THEN 1 WHEN 'familia' THEN 2 ELSE 3 END LIMIT 1;
$$;

-- tabelas de dado que as RPCs cruzam
CREATE TABLE public.omie_products (id uuid DEFAULT gen_random_uuid(), omie_codigo_produto bigint, account text, familia text);
CREATE TABLE public.inventory_position (omie_codigo_produto bigint, account text, cmc numeric, synced_at timestamptz DEFAULT now());
CREATE TABLE public.sales_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account text, customer_user_id uuid,
  status text, order_date_kpi date, created_at timestamptz DEFAULT now(), deleted_at timestamptz,
  omie_numero_pedido text);
CREATE TABLE public.order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), sales_order_id uuid, product_id uuid,
  omie_codigo_produto bigint, customer_user_id uuid, unit_price numeric, quantity numeric,
  created_at timestamptz DEFAULT now());

-- stubs vazios das tint_* (o cockpit as referencia no ramo tint; testamos produto comum,
-- mas as tabelas precisam EXISTIR p/ o ramo não dar undefined_table se um dia executado)
CREATE TABLE public.tint_formulas (id uuid, sku_id uuid, account text, produto_id uuid, base_id uuid, embalagem_id uuid);
CREATE TABLE public.tint_skus (id uuid, account text, produto_id uuid, base_id uuid, embalagem_id uuid, omie_product_id uuid);
CREATE TABLE public.tint_formula_itens (formula_id uuid, corante_id uuid, qtd_ml numeric);
CREATE TABLE public.tint_corantes (id uuid, volume_total_ml numeric, omie_product_id uuid);
SQL

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — APLICAR A MIGRATION REAL
# ══════════════════════════════════════════════════════════════════════════════
MIG="$REPO_ROOT/supabase/migrations/20260704120000_preco_por_tier.sql"
P -q -f "$MIG"
echo "migration aplicada: $(basename "$MIG")"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 3 — SEED + GRANTS
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
-- personas
INSERT INTO auth.users(id) VALUES
  ('11111111-1111-1111-1111-111111111111'),  -- V  vendedor (employee, SEM carteira)
  ('22222222-2222-2222-2222-222222222222'),  -- G  gestor  (employee + carteira)
  ('33333333-3333-3333-3333-333333333333'),  -- M  master
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),  -- Cli1 tier C
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'),  -- Cli2 tier A
  ('cccccccc-cccc-cccc-cccc-cccccccccccc')   -- CliST sem tier
  ON CONFLICT DO NOTHING;
INSERT INTO public.user_roles(user_id,role) VALUES
  ('11111111-1111-1111-1111-111111111111','employee'),
  ('22222222-2222-2222-2222-222222222222','employee'),
  ('33333333-3333-3333-3333-333333333333','master');
INSERT INTO public.gestores(user_id) VALUES ('22222222-2222-2222-2222-222222222222');

-- tier dos clientes (semeado como postgres; o trigger anti-forje força definido_por=auth.uid()
-- MAS auth.uid() é NULL aqui → mantém o payload; usamos o próprio G como autor)
INSERT INTO public.cliente_tier_preco(company,customer_user_id,tier,definido_por) VALUES
  ('oben','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','C','22222222-2222-2222-2222-222222222222'),
  ('oben','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','A','22222222-2222-2222-2222-222222222222');

-- produto comum 555 (fam1), cmc=100; produto commodity 777 (fam2), cmc=100
INSERT INTO public.omie_products(omie_codigo_produto,account,familia) VALUES (555,'oben','fam1'),(777,'oben','fam2');
INSERT INTO public.inventory_position(omie_codigo_produto,account,cmc) VALUES (555,'oben',100),(777,'oben',100);

-- pedido EFETIVADO do Cli1 (tier C) — tem PV no Omie → entra na medição A5
INSERT INTO public.sales_orders(id,account,customer_user_id,status,order_date_kpi,omie_numero_pedido) VALUES
  ('50000000-0000-0000-0000-000000000001','oben','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','faturado','2026-06-15','PV-1');
INSERT INTO public.order_items(sales_order_id,product_id,omie_codigo_produto,customer_user_id,unit_price,quantity) VALUES
  ('50000000-0000-0000-0000-000000000001','55555555-5555-5555-5555-555555555555',555,'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',132,1),  -- abaixo do piso tier C (135)
  ('50000000-0000-0000-0000-000000000001','55555555-5555-5555-5555-555555555555',555,'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',200,1);  -- saudável
-- pedido SEM PV no Omie (bloqueado/erro) com item abaixo do piso → NÃO deve contar (P2-D Codex).
-- Data ANTERIOR ao pedido efetivado p/ não virar o "último praticado" do produto em get_ultimos.
INSERT INTO public.sales_orders(id,account,customer_user_id,status,order_date_kpi,omie_numero_pedido) VALUES
  ('50000000-0000-0000-0000-000000000002','oben','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','separacao','2026-06-10',NULL);
INSERT INTO public.order_items(sales_order_id,product_id,omie_codigo_produto,customer_user_id,unit_price,quantity) VALUES
  ('50000000-0000-0000-0000-000000000002','55555555-5555-5555-5555-555555555555',555,'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',120,1);  -- abaixo, mas SEM PV

-- grants p/ os asserts de RLS (a migração é --no-privileges; RLS filtra por cima)
GRANT SELECT ON public.user_roles, public.gestores TO authenticated, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.markup_policy, public.tier_preco_config,
  public.cliente_tier_preco, public.cliente_tier_preco_log TO authenticated;
GRANT SELECT ON public.markup_policy, public.tier_preco_config,
  public.cliente_tier_preco, public.cliente_tier_preco_log TO anon;
SQL

echo "── asserts ──"

# ── Positivos: resolve_markup_policy (GREATEST das 2 cascatas) ──
V=$(Pq -c "SELECT piso_markup FROM public.resolve_markup_policy('oben',555,'fam1',NULL);")
eq "P1 tier=NULL replica vigente (conta 30)" "$V" "30"
V=$(Pq -c "SELECT piso_markup FROM public.resolve_markup_policy('oben',555,'fam1','C');")
eq "P2 tier C eleva piso p/ 35 (GREATEST 30,35)" "$V" "35"
V=$(Pq -c "SELECT piso_markup FROM public.resolve_markup_policy('oben',777,'fam2','C');")
eq "P3 SKU commodity piso 20 NAO derruba tier C 35 (P1-5)" "$V" "35"
V=$(Pq -c "SELECT piso_markup FROM public.resolve_markup_policy('oben',555,'fam1','A');")
eq "P4 tier A: GREATEST(conta 30, tierA 25)=30" "$V" "30"
V=$(Pq -c "SELECT count(*) FROM public.resolve_markup_policy('zzz',1,'x',NULL);")
eq "P5 empresa sem politica -> 0 linhas (sem_politica)" "$V" "0"
# invariante meta>=piso sob GREATEST, em todos os pares (empresa,tier) semeados
V=$(Pq -c "SELECT count(*) FROM (SELECT (public.resolve_markup_policy('oben',777,'fam2',t)).* FROM unnest(ARRAY['A','B','C',NULL]) t) x WHERE meta_markup < piso_markup;")
eq "P6 meta>=piso preservado sob GREATEST" "$V" "0"

# ── Cockpit tier-aware (A3): server-side, do customer, jamais do payload ──
FX=$(Pq -c "SET test.uid='11111111-1111-1111-1111-111111111111'; SET ROLE authenticated;
  SELECT public.get_preco_cockpit('[{\"empresa\":\"oben\",\"codigo\":555,\"preco\":132}]'::jsonb) -> 0 ->> 'faixa';" | tail -1)
eq "P7 cockpit SEM customer: preco 132 = verde (piso conta 30)" "$FX" "verde"
FX=$(Pq -c "SET test.uid='11111111-1111-1111-1111-111111111111'; SET ROLE authenticated;
  SELECT public.get_preco_cockpit('[{\"empresa\":\"oben\",\"codigo\":555,\"preco\":132,\"customer_user_id\":\"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa\"}]'::jsonb) -> 0 ->> 'faixa';" | tail -1)
eq "P8 cockpit COM Cli1(tier C): 132 = amarelo (piso tier 35, server-side)" "$FX" "amarelo"
# payload tenta forjar tier A; a função ignora e usa o customer (tier C) → segue amarelo
FX=$(Pq -c "SET test.uid='11111111-1111-1111-1111-111111111111'; SET ROLE authenticated;
  SELECT public.get_preco_cockpit('[{\"empresa\":\"oben\",\"codigo\":555,\"preco\":132,\"tier\":\"A\",\"customer_user_id\":\"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa\"}]'::jsonb) -> 0 ->> 'faixa';" | tail -1)
eq "P9 payload tier=A ignorado; usa customer(C) server-side (P1-8)" "$FX" "amarelo"
TR=$(Pq -c "SET test.uid='11111111-1111-1111-1111-111111111111'; SET ROLE authenticated;
  SELECT public.get_preco_cockpit('[{\"empresa\":\"oben\",\"codigo\":555,\"preco\":132,\"customer_user_id\":\"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa\"}]'::jsonb) -> 0 ->> 'tier';" | tail -1)
eq "P10 cockpit devolve o tier resolvido (badge)" "$TR" "C"

# ── get_ultimos_precos_cliente: expõe a DATA do último praticado ──
D=$(Pq -c "SET test.uid='22222222-2222-2222-2222-222222222222'; SET ROLE authenticated;
  SELECT ultimo_praticado_em FROM public.get_ultimos_precos_cliente('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa') LIMIT 1;" | tail -1)
eq "P11 get_ultimos expõe a data (order_date_kpi mais recente)" "$D" "2026-06-15"

# ── medir_abaixo_piso_tier (A5): usa a MESMA resolve_markup_policy; só conta PV efetivado ──
AB=$(Pq -c "SET test.uid='22222222-2222-2222-2222-222222222222'; SET ROLE authenticated;
  SELECT itens_abaixo FROM public.medir_abaixo_piso_tier(90) WHERE company='oben' AND tier='C';" | tail -1)
eq "P12 medicao: 1 item abaixo (SO2 sem PV excluído — P2-D)" "$AB" "1"
FL=$(Pq -c "SET test.uid='22222222-2222-2222-2222-222222222222'; SET ROLE authenticated;
  SELECT (folga_negativa_reais = 3) FROM public.medir_abaixo_piso_tier(90) WHERE company='oben' AND tier='C';" | tail -1)
eq "P13 medicao: folga negativa = (135-132)*1 = 3" "$FL" "t"

# ── Negativos: constraints ──
echo "── negativos (constraints) ──"
R=$(P -tA 2>&1 <<'SQL'
DO $$ BEGIN
  INSERT INTO public.markup_policy(account,escopo,piso_markup,meta_markup,tier) VALUES ('oben','conta',35,50,'C');
  RAISE EXCEPTION 'UNIQUE_NAO_BARROU';
EXCEPTION WHEN unique_violation THEN RAISE NOTICE 'UQ_OK';
  WHEN OTHERS THEN RAISE; END $$;
SQL
)
case "$R" in *UQ_OK*) ok "N1 UNIQUE anti-empate barra (conta,C) duplicado" ;; *) bad "N1 UNIQUE — veio: $R" ;; esac

R=$(P -tA 2>&1 <<'SQL'
DO $$ BEGIN
  INSERT INTO public.markup_policy(account,escopo,piso_markup,meta_markup,tier) VALUES ('oben','conta',30,50,'D');
  RAISE EXCEPTION 'TIERCHECK_NAO_BARROU';
EXCEPTION WHEN check_violation THEN RAISE NOTICE 'TIERCK_OK';
  WHEN OTHERS THEN RAISE; END $$;
SQL
)
case "$R" in *TIERCK_OK*) ok "N2 CHECK tier barra 'D'" ;; *) bad "N2 CHECK tier — veio: $R" ;; esac

R=$(P -tA 2>&1 <<'SQL'
DO $$ BEGIN
  INSERT INTO public.tier_preco_config(company,tier,mult_partida) VALUES ('oben','A',1.60);
  RAISE EXCEPTION 'MULTCHECK_NAO_BARROU';
EXCEPTION WHEN check_violation THEN RAISE NOTICE 'MULTCK_OK';
  WHEN OTHERS THEN RAISE; END $$;
SQL
)
case "$R" in *MULTCK_OK*) ok "N3 CHECK mult_partida barra 1.60 (fora 0.5-1.5)" ;; *) bad "N3 CHECK mult — veio: $R" ;; esac

# ── Anti-forje do autor (trigger BEFORE) ──
echo "── anti-forje + auditoria ──"
Pq -c "SET test.uid='22222222-2222-2222-2222-222222222222'; SET ROLE authenticated;
  INSERT INTO public.cliente_tier_preco(company,customer_user_id,tier,definido_por)
  VALUES ('oben','cccccccc-cccc-cccc-cccc-cccccccccccc','B','11111111-1111-1111-1111-111111111111');" >/dev/null
AUT=$(Pq -c "SELECT definido_por FROM public.cliente_tier_preco WHERE customer_user_id='cccccccc-cccc-cccc-cccc-cccccccccccc';")
eq "N4 anti-forje: definido_por = autor real (G), nao o forjado (V)" "$AUT" "22222222-2222-2222-2222-222222222222"
# auditoria: o INSERT gerou linha no log
LG=$(Pq -c "SELECT tier_para FROM public.cliente_tier_preco_log WHERE customer_user_id='cccccccc-cccc-cccc-cccc-cccccccccccc' ORDER BY mudado_em DESC LIMIT 1;")
eq "N5 auditoria: log registrou tier_para=B" "$LG" "B"
# UPDATE B->C gera log de->para
Pq -c "SET test.uid='22222222-2222-2222-2222-222222222222'; SET ROLE authenticated;
  UPDATE public.cliente_tier_preco SET tier='C' WHERE customer_user_id='cccccccc-cccc-cccc-cccc-cccccccccccc';" >/dev/null
LG=$(Pq -c "SELECT tier_de||'->'||tier_para FROM public.cliente_tier_preco_log WHERE customer_user_id='cccccccc-cccc-cccc-cccc-cccccccccccc' ORDER BY mudado_em DESC LIMIT 1;")
eq "N6 auditoria: UPDATE grava de->para (B->C)" "$LG" "B->C"

# ── RLS: cliente_tier_preco escrita gated ──
echo "── RLS ──"
R=$(P -tA 2>&1 <<'SQL'
SET test.uid='11111111-1111-1111-1111-111111111111'; SET ROLE authenticated;  -- V, sem carteira
DO $$ BEGIN
  INSERT INTO public.cliente_tier_preco(company,customer_user_id,tier,definido_por)
  VALUES ('oben','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','C','11111111-1111-1111-1111-111111111111');
  RAISE EXCEPTION 'RLS_INSERT_NAO_BARROU';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'RLSINS_OK';
  WHEN OTHERS THEN RAISE; END $$;
SQL
)
case "$R" in *RLSINS_OK*) ok "N7 vendedor sem carteira NAO define tier (RLS INSERT)" ;; *) bad "N7 RLS insert — veio: $R" ;; esac

# gestor COM carteira consegue inserir (own path positivo)
Pq -c "SET test.uid='22222222-2222-2222-2222-222222222222'; SET ROLE authenticated;
  INSERT INTO public.cliente_tier_preco(company,customer_user_id,tier,definido_por)
  VALUES ('oben','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','C','22222222-2222-2222-2222-222222222222')
  ON CONFLICT (company,customer_user_id) DO UPDATE SET tier='C';" >/dev/null
GC=$(Pq -c "SELECT tier FROM public.cliente_tier_preco WHERE company='oben' AND customer_user_id='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';")
eq "N8 gestor com carteira DEFINE tier" "$GC" "C"

# RLS markup_policy APERTADA (P1-12): vendedor sem carteira NAO lê a política crua
VEND=$(Pq -c "SET test.uid='11111111-1111-1111-1111-111111111111'; SET ROLE authenticated; SELECT count(*) FROM public.markup_policy;" | tail -1)
GEST=$(Pq -c "SET test.uid='22222222-2222-2222-2222-222222222222'; SET ROLE authenticated; SELECT count(*) FROM public.markup_policy;" | tail -1)
eq "N9 markup_policy: vendedor sem carteira le 0 (RLS apertada P1-12)" "$VEND" "0"
if [ "$GEST" -gt 0 ]; then ok "N10 markup_policy: gestor com carteira le a politica ($GEST linhas)"; else bad "N10 gestor devia ler markup_policy"; fi

# tier_preco_config: staff LÊ (a partida no browser precisa do mult); anon não
TCV=$(Pq -c "SET test.uid='11111111-1111-1111-1111-111111111111'; SET ROLE authenticated; SELECT count(*) FROM public.tier_preco_config;" | tail -1)
eq "N11 tier_preco_config: vendedor (staff) LÊ o mult (partida no browser)" "$TCV" "6"
TCA=$(Pq -c "SET ROLE anon; SELECT count(*) FROM public.tier_preco_config;" | tail -1)
eq "N11b tier_preco_config: anon nao le" "$TCA" "0"

# log inescrevível direto (REVOKE + sem policy de INSERT)
R=$(P -tA 2>&1 <<'SQL'
SET test.uid='33333333-3333-3333-3333-333333333333'; SET ROLE authenticated;  -- ate master
DO $$ BEGIN
  INSERT INTO public.cliente_tier_preco_log(company,customer_user_id,tier_para) VALUES ('oben','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','Z');
  RAISE EXCEPTION 'LOG_INSERT_NAO_BARROU';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'LOGINS_OK';
  WHEN OTHERS THEN RAISE; END $$;
SQL
)
case "$R" in *LOGINS_OK*) ok "N12 log inescrevivel direto (REVOKE IUD)" ;; *) bad "N12 log revoke — veio: $R" ;; esac

# gates 42501
R=$(P -tA 2>&1 <<'SQL'
SET test.uid='11111111-1111-1111-1111-111111111111'; SET ROLE authenticated;  -- V sem carteira
DO $$ BEGIN
  PERFORM * FROM public.medir_abaixo_piso_tier(90);
  RAISE EXCEPTION 'MEDIR_NAO_BARROU';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'MEDIR_OK';
  WHEN OTHERS THEN RAISE; END $$;
SQL
)
case "$R" in *MEDIR_OK*) ok "N13 medir_abaixo_piso_tier: sem carteira -> forbidden 42501" ;; *) bad "N13 medir gate — veio: $R" ;; esac

# gate INTERNO: customer (authenticated, TEM execute) mas não é staff → RAISE forbidden
R=$(P -tA 2>&1 <<'SQL'
SET test.uid='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'; SET ROLE authenticated;  -- Cli1: sem role staff
DO $$ BEGIN
  PERFORM * FROM public.get_ultimos_precos_cliente('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
  RAISE EXCEPTION 'ULT_NAO_BARROU';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'ULT_OK';
  WHEN OTHERS THEN RAISE; END $$;
SQL
)
case "$R" in *ULT_OK*) ok "N14 get_ultimos: gate barra não-staff (customer) -> forbidden 42501" ;; *) bad "N14 ultimos gate — veio: $R" ;; esac
# REVOKE anon/PUBLIC: anon não tem sequer EXECUTE (barrado antes do gate)
R=$(P -tA 2>&1 <<'SQL'
SET ROLE anon;
DO $$ BEGIN
  PERFORM * FROM public.get_ultimos_precos_cliente('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
  RAISE EXCEPTION 'ANON_NAO_BARROU';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'ANONULT_OK';
  WHEN OTHERS THEN RAISE; END $$;
SQL
)
case "$R" in *ANONULT_OK*) ok "N14b get_ultimos: anon sem EXECUTE (REVOKE anon/PUBLIC)" ;; *) bad "N14b anon revoke — veio: $R" ;; esac

# anti-overload: a assinatura de 3 args foi REMOVIDA (só a de 4 existe)
NARGS=$(Pq -c "SELECT count(*) FROM pg_proc WHERE proname='resolve_markup_policy';")
eq "N15 anti-overload: só 1 assinatura de resolve_markup_policy (a de 4 args)" "$NARGS" "1"

# P1-B (review Codex): linha escopo='sku' NÃO pode ter familia → fecha o empate (sku,tier)
R=$(P -tA 2>&1 <<'SQL'
DO $$ BEGIN
  INSERT INTO public.markup_policy(account,escopo,sku_codigo,familia,piso_markup,meta_markup,tier)
  VALUES ('oben','sku',888,'fam_qualquer',40,50,'C');
  RAISE EXCEPTION 'SKU_FAMILIA_NAO_BARROU';
EXCEPTION WHEN check_violation THEN RAISE NOTICE 'SKUFAM_OK';
  WHEN OTHERS THEN RAISE; END $$;
SQL
)
case "$R" in *SKUFAM_OK*) ok "N16 CHECK barra linha sku com familia (anti-empate não-determinístico)" ;; *) bad "N16 sku/familia — veio: $R" ;; esac
# e com familia NULL a UNIQUE barra o empate real (2ª linha sku mesmo sku/tier)
Pq -c "INSERT INTO public.markup_policy(account,escopo,sku_codigo,piso_markup,meta_markup,tier) VALUES ('oben','sku',889,40,50,'C');" >/dev/null
R=$(P -tA 2>&1 <<'SQL'
DO $$ BEGIN
  INSERT INTO public.markup_policy(account,escopo,sku_codigo,piso_markup,meta_markup,tier) VALUES ('oben','sku',889,45,55,'C');
  RAISE EXCEPTION 'UQ_SKU_NAO_BARROU';
EXCEPTION WHEN unique_violation THEN RAISE NOTICE 'UQSKU_OK';
  WHEN OTHERS THEN RAISE; END $$;
SQL
)
case "$R" in *UQSKU_OK*) ok "N17 UNIQUE barra 2ª linha (sku,tier) de mesmo sku (determinismo)" ;; *) bad "N17 uq sku — veio: $R" ;; esac
Pq -c "DELETE FROM public.markup_policy WHERE sku_codigo=889;" >/dev/null

# os 3 índices parciais VIGENTES (sem tier) foram DROPADOS — senão os seeds (conta,tier) colidiriam
IDX=$(Pq -c "SELECT count(*) FROM pg_indexes WHERE schemaname='public' AND tablename='markup_policy' AND indexname IN ('uq_markup_policy_conta','uq_markup_policy_fam','uq_markup_policy_sku');")
eq "N18 índices parciais antigos (sem tier) dropados" "$IDX" "0"
# e o seed de tier de fato entrou (6 linhas conta,tier) — prova que o DROP destravou o INSERT
SEED=$(Pq -c "SELECT count(*) FROM public.markup_policy WHERE tier IS NOT NULL;")
eq "N19 seed de pisos por tier entrou (6 linhas)" "$SEED" "6"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICAÇÃO (sabota → exija VERMELHO → restaura)
# ══════════════════════════════════════════════════════════════════════════════
echo "── falsificação ──"

# F1: fura o GREATEST (só cascata-produto) → P2/P3 devem cair (piso volta a 30/20, não 35)
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.resolve_markup_policy(p_empresa text,p_codigo bigint,p_familia text,p_tier text DEFAULT NULL)
RETURNS TABLE(piso_markup numeric, meta_markup numeric) LANGUAGE sql STABLE SET search_path TO 'public' AS $$
  SELECT piso_markup, meta_markup FROM public.markup_policy
  WHERE account=lower(p_empresa) AND tier IS NULL
    AND ((escopo='sku' AND sku_codigo=p_codigo) OR (escopo='familia' AND p_familia IS NOT NULL AND familia=p_familia) OR (escopo='conta'))
  ORDER BY CASE escopo WHEN 'sku' THEN 1 WHEN 'familia' THEN 2 ELSE 3 END LIMIT 1;
$$;
SQL
V=$(Pq -c "SELECT piso_markup FROM public.resolve_markup_policy('oben',555,'fam1','C');")
if [ "$V" != "35" ]; then ok "F1 GREATEST furado derruba P2 (veio $V, nao 35) → P2 tem dente"; else bad "F1 sabotei o GREATEST e P2 seguiu 35 → assert fraco"; fi
P -q -f "$MIG" >/dev/null  # restaura

# F2: reabre a RLS da markup_policy p/ staff-wide → N9 deve cair (vendedor passa a ler)
P -q <<'SQL'
DROP POLICY IF EXISTS "markup_policy_select_carteira" ON public.markup_policy;
CREATE POLICY "markup_policy_select_carteira" ON public.markup_policy FOR SELECT
  USING (public.has_role(auth.uid(),'employee') OR public.has_role(auth.uid(),'master'));
SQL
VEND2=$(Pq -c "SET test.uid='11111111-1111-1111-1111-111111111111'; SET ROLE authenticated; SELECT count(*) FROM public.markup_policy;" | tail -1)
if [ "$VEND2" -gt 0 ]; then ok "F2 RLS reaberta: vendedor lê $VEND2 → N9 tem dente (P1-12)"; else bad "F2 reabri a RLS e vendedor seguiu vendo 0 → N9 fraco"; fi
P -q -f "$MIG" >/dev/null  # restaura (re-DROP + policy carteira)

# F3: dropa o trigger anti-forje → N4 deve cair (definido_por forjado PERSISTE)
P -q -c "DROP TRIGGER IF EXISTS trg_cliente_tier_forca_autor ON public.cliente_tier_preco;"
Pq -c "SET test.uid='22222222-2222-2222-2222-222222222222'; SET ROLE authenticated;
  INSERT INTO public.cliente_tier_preco(company,customer_user_id,tier,definido_por)
  VALUES ('oben','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','A','11111111-1111-1111-1111-111111111111')
  ON CONFLICT (company,customer_user_id) DO UPDATE SET tier='A', definido_por='11111111-1111-1111-1111-111111111111';" >/dev/null
AUT2=$(Pq -c "SELECT definido_por FROM public.cliente_tier_preco WHERE customer_user_id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';")
if [ "$AUT2" = "11111111-1111-1111-1111-111111111111" ]; then ok "F3 sem trigger: forja PERSISTE ($AUT2) → N4 tem dente"; else bad "F3 droppei o trigger e a forja nao passou → N4 fraco"; fi
P -q -f "$MIG" >/dev/null
Pq -c "UPDATE public.cliente_tier_preco SET tier='C', definido_por='22222222-2222-2222-2222-222222222222' WHERE customer_user_id='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';" >/dev/null

# F4: zera o tier server-side no cockpit → P8 deve cair (volta a verde, ignora tier C)
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.get_preco_cockpit(p_itens jsonb) RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $fn$
DECLARE v_out jsonb:='[]'::jsonb; v_item jsonb; v_empresa text; v_codigo bigint; v_preco numeric;
  v_cmc numeric; v_familia text; v_piso numeric; v_meta numeric; v_faixa text; v_accounts text[];
BEGIN
  IF NOT (auth.uid() IS NOT NULL AND (has_role(auth.uid(),'employee') OR has_role(auth.uid(),'master'))) THEN
    RAISE EXCEPTION 'forbidden' USING errcode='42501'; END IF;
  FOR v_item IN SELECT * FROM jsonb_array_elements(p_itens) LOOP
    v_empresa:=lower(v_item->>'empresa'); v_codigo:=(v_item->>'codigo')::bigint; v_preco:=(v_item->>'preco')::numeric;
    v_accounts := CASE v_empresa WHEN 'oben' THEN ARRAY['vendas','oben'] WHEN 'colacor' THEN ARRAY['colacor_vendas','colacor'] ELSE ARRAY[v_empresa] END;
    SELECT ip.cmc INTO v_cmc FROM inventory_position ip WHERE ip.omie_codigo_produto=v_codigo AND ip.cmc>0 AND ip.account=ANY(v_accounts) ORDER BY ip.synced_at DESC LIMIT 1;
    SELECT op.familia INTO v_familia FROM omie_products op WHERE op.omie_codigo_produto=v_codigo AND op.account=v_empresa LIMIT 1;
    -- SABOTADO: tier sempre NULL (ignora o customer)
    SELECT rp.piso_markup, rp.meta_markup INTO v_piso, v_meta FROM resolve_markup_policy(v_empresa,v_codigo,v_familia,NULL) rp;
    IF v_cmc IS NULL OR v_preco IS NULL THEN v_faixa:='neutro';
    ELSIF v_preco < v_cmc THEN v_faixa:='vermelho';
    ELSIF v_piso IS NULL THEN v_faixa:='neutro';
    ELSIF v_preco < v_cmc*(1+v_piso/100) THEN v_faixa:='amarelo';
    ELSE v_faixa:='verde'; END IF;
    v_out := v_out || jsonb_build_array(jsonb_build_object('codigo',v_codigo,'faixa',v_faixa));
  END LOOP; RETURN v_out;
END $fn$;
SQL
FXS=$(Pq -c "SET test.uid='11111111-1111-1111-1111-111111111111'; SET ROLE authenticated;
  SELECT public.get_preco_cockpit('[{\"empresa\":\"oben\",\"codigo\":555,\"preco\":132,\"customer_user_id\":\"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa\"}]'::jsonb) -> 0 ->> 'faixa';" | tail -1)
if [ "$FXS" != "amarelo" ]; then ok "F4 cockpit sem tier server-side: 132 volta a $FXS (nao amarelo) → P8 tem dente"; else bad "F4 zerei o tier e seguiu amarelo → P8 fraco"; fi
P -q -f "$MIG" >/dev/null  # restaura o cockpit real

# F5: sem o CHECK sku_sem_familia, a linha sku COM familia entra (empate não-determinístico volta)
P -q -c "ALTER TABLE public.markup_policy DROP CONSTRAINT markup_policy_sku_sem_familia;"
if P -q -c "INSERT INTO public.markup_policy(account,escopo,sku_codigo,familia,piso_markup,meta_markup,tier) VALUES ('oben','sku',890,'x',40,50,'C');" >/dev/null 2>&1; then
  ok "F5 sem o CHECK a linha sku+familia entra → N16 tem dente"
else
  bad "F5 droppei o CHECK e a linha AINDA foi barrada → N16 fraco"
fi
P -q -c "DELETE FROM public.markup_policy WHERE sku_codigo=890;" >/dev/null 2>&1 || true
P -q -f "$MIG" >/dev/null  # restaura o CHECK

# F6: se o SO2 (excluído por não ter PV) GANHASSE um PV, passaria a contar (=2) → prova que
# o filtro omie_numero_pedido é o que exclui o pedido não-efetivado, não outra coisa.
P -q -c "UPDATE public.sales_orders SET omie_numero_pedido='PV-2' WHERE id='50000000-0000-0000-0000-000000000002';" >/dev/null
AB2=$(Pq -c "SET test.uid='22222222-2222-2222-2222-222222222222'; SET ROLE authenticated;
  SELECT itens_abaixo FROM public.medir_abaixo_piso_tier(90) WHERE company='oben' AND tier='C';" | tail -1)
if [ "$AB2" = "2" ]; then ok "F6 com PV o pedido antes-excluído passa a contar (=2) → filtro PV tem dente"; else bad "F6 dei PV e a contagem não mudou ($AB2) → P12 fraco"; fi
P -q -c "UPDATE public.sales_orders SET omie_numero_pedido=NULL WHERE id='50000000-0000-0000-0000-000000000002';" >/dev/null

# F7: o índice antigo (sem tier) é INCOMPATÍVEL com as linhas (conta,tier) já semeadas —
# recriá-lo FALHA (as 4 linhas oben/conta o violam). Prova que o DROP era necessário, não cosmético.
if P -q -c "CREATE UNIQUE INDEX uq_markup_policy_conta ON public.markup_policy (account) WHERE escopo='conta';" >/dev/null 2>&1; then
  bad "F7 recriei o índice antigo e passou → ele não bloqueava o design de tier (DROP dispensável?)"
  P -q -c "DROP INDEX IF EXISTS public.uq_markup_policy_conta;" >/dev/null 2>&1 || true
else
  ok "F7 índice antigo (sem tier) não coexiste com linhas (conta,tier) → o DROP era necessário"
fi

echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
