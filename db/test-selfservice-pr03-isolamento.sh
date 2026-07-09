#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  HARNESS PG17 — PR0.3 SMOKE ADVERSARIAL DE ISOLAMENTO (teste-síntese Fase 0)    ║
# ║  Migrações reais: PR0.1 (gate selfservice_conta_atual) + PR0.2a (3 views-gate). ║
# ║  Rode:  bash db/test-selfservice-pr03-isolamento.sh > /tmp/t-pr03.log 2>&1; echo $?
# ║                                                                                ║
# ║  NÃO é migration nova — é a PROVA de que a fundação (PR0.0/0.1/0.2a + #1246)     ║
# ║  isola de fato. Semeadura única A(oben)/B(colacor)/C'(grupo de A, oben)/S(staff)║
# ║  e, sob o GUC do ATACANTE A, exige negado/0 em toda superfície de B/C'/cru.     ║
# ║                                                                                ║
# ║  Espelha a RLS REAL de prod (psql-ro 2026-07-08): omie_products staff-only      ║
# ║  (pós-PR0.0), sales_orders own+staff, inventory_position staff-only,            ║
# ║  get_regua_preco SECDEF gate staff. As views selfservice são invoker=off →      ║
# ║  leem a base como owner; o gate delas é o WHERE (habilitado ∧ account=ANY ∧ uid)║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5462}"
SLUG="pr03-isolamento"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente"; exit 1; }
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
GRANT USAGE ON SCHEMA auth TO authenticated, anon, service_role;
GRANT EXECUTE ON FUNCTION auth.uid(), auth.role() TO authenticated, anon, service_role;
SQL

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

echo "═══ setup pronto (PG17 :$PORT) ═══"

# ── ZONA 1 — deps do gate + tabelas-fonte + RLS REAL de prod ──
P -q <<'SQL'
CREATE TYPE public.app_role AS ENUM ('master','employee','customer');
CREATE TABLE public.user_roles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, role public.app_role NOT NULL);
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role app_role)
  RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $f$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id=_user_id AND role=_role) $f$;
CREATE TYPE public.commercial_role AS ENUM ('vendedor','gerencial','estrategico','super_admin');
CREATE TABLE public.commercial_roles_stub (user_id uuid PRIMARY KEY, role public.commercial_role);
CREATE OR REPLACE FUNCTION public.get_commercial_role(_uid uuid)
  RETURNS commercial_role LANGUAGE sql STABLE AS $f$ SELECT role FROM public.commercial_roles_stub WHERE user_id=_uid $f$;
CREATE OR REPLACE FUNCTION public.pode_ver_carteira_completa(_uid uuid)
  RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $f$ SELECT has_role(_uid,'master'::app_role) OR (has_role(_uid,'employee'::app_role) AND get_commercial_role(_uid) IN ('gerencial'::commercial_role)) $f$;
CREATE TABLE public.profiles (user_id uuid PRIMARY KEY, is_employee boolean, is_approved boolean);
CREATE TABLE public.company_config (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), key text UNIQUE NOT NULL, value text, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());

-- Tabelas-fonte (colunas reais relevantes + sensíveis p/ provar não-vazamento).
CREATE TABLE public.omie_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  omie_codigo_produto bigint NOT NULL, codigo text NOT NULL, descricao text NOT NULL,
  unidade text DEFAULT 'UN', valor_unitario numeric DEFAULT 0, estoque numeric DEFAULT 0,
  ativo boolean NOT NULL DEFAULT true, account text NOT NULL DEFAULT 'oben',
  familia text, subfamilia text, imagem_url text);
CREATE TABLE public.inventory_position (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  omie_codigo_produto bigint, product_id uuid, saldo numeric, cmc numeric, preco_medio numeric, account text);
CREATE TABLE public.sales_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_user_id uuid, total numeric, status text, omie_numero_pedido text,
  created_at timestamptz DEFAULT now(), account text, order_date_kpi date, omie_payload jsonb);

-- RLS REAL de prod nas bases cruas (o que barra o acesso DIRETO por PostgREST — as views
-- invoker=off leem como owner e não dependem disto; o acesso cru sim).
ALTER TABLE public.omie_products      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.inventory_position ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sales_orders       ENABLE ROW LEVEL SECURITY;
-- omie_products: pós-PR0.0 resta SÓ a policy staff ALL (a "Authenticated can view" USING(true) foi dropada).
CREATE POLICY "Staff can manage products" ON public.omie_products FOR ALL
  USING (has_role((SELECT auth.uid()),'master'::app_role) OR has_role((SELECT auth.uid()),'employee'::app_role));
-- inventory_position: staff-only (custo/cmc).
CREATE POLICY "staff_inventory_position_select" ON public.inventory_position FOR SELECT
  USING (has_role((SELECT auth.uid()),'master'::app_role) OR has_role((SELECT auth.uid()),'employee'::app_role));
-- sales_orders: customer vê os PRÓPRIOS + staff ALL.
CREATE POLICY "Customers can view their own sales orders" ON public.sales_orders FOR SELECT
  USING ((SELECT auth.uid()) = customer_user_id);
CREATE POLICY "Staff can manage sales orders" ON public.sales_orders FOR ALL
  USING (has_role((SELECT auth.uid()),'master'::app_role) OR has_role((SELECT auth.uid()),'employee'::app_role));

-- get_regua_preco: contrato REAL (psql-ro) — SECDEF, authenticated executa MAS gate interno staff
-- rejeita não-staff. Preço NÃO é superfície self-service (PR0.2b adiado); prova o staff-only preservado.
CREATE OR REPLACE FUNCTION public.get_regua_preco(p_customer uuid, p_product uuid, p_qty numeric)
  RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $f$
BEGIN
  IF NOT (has_role((SELECT auth.uid()),'employee'::app_role) OR has_role((SELECT auth.uid()),'master'::app_role)) THEN
    RAISE EXCEPTION 'regua de preco e staff-only' USING ERRCODE='42501';
  END IF;
  RETURN '{}'::jsonb;
END $f$;
REVOKE ALL ON FUNCTION public.get_regua_preco(uuid,uuid,numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_regua_preco(uuid,uuid,numeric) TO authenticated;
SQL

# ── ZONA 2 — aplicar migrations REAIS: PR0.1 (gate) + PR0.2a (views) ──
MIG_GATE="$REPO_ROOT/supabase/migrations/20260708202033_selfservice_pr01_allowlist_gate.sql"
MIG_VIEWS="$REPO_ROOT/supabase/migrations/20260708212123_selfservice_pr02a_views_customer.sql"
P -q -f "$MIG_GATE"
P -q -f "$MIG_VIEWS"
echo "migrations reais aplicadas: PR0.1 gate + PR0.2a views"

# ── ZONA 3 — seed. A=atacante (oben, habilitado); B=vítima (colacor); C'=irmão de grupo
#    de A (oben, MESMO 'grupo econômico', outro uid, NÃO habilitado); S=staff (oben). ──
P -q <<'SQL'
INSERT INTO auth.users(id) VALUES
  ('11111111-1111-1111-1111-111111111111'),  -- A: oben, habilitado (ATACANTE)
  ('22222222-2222-2222-2222-222222222222'),  -- B: colacor (VÍTIMA de outra conta)
  ('33333333-3333-3333-3333-333333333333'),  -- C': oben, irmão de grupo de A, NÃO habilitado
  ('44444444-4444-4444-4444-444444444444')   -- S: STAFF (pedido-fantasma sob seu uid)
  ON CONFLICT DO NOTHING;
INSERT INTO public.profiles(user_id, is_employee, is_approved) VALUES
  ('11111111-1111-1111-1111-111111111111', false, true),
  ('22222222-2222-2222-2222-222222222222', false, true),
  ('33333333-3333-3333-3333-333333333333', false, true),
  ('44444444-4444-4444-4444-444444444444', true,  true);
INSERT INTO public.user_roles(user_id, role) VALUES ('44444444-4444-4444-4444-444444444444','employee');
-- Allowlist: SÓ A(oben). B, C', S ficam de fora (só A é comprador self-service habilitado).
INSERT INTO public.selfservice_cliente_allowlist(customer_user_id, account, enabled) VALUES
  ('11111111-1111-1111-1111-111111111111','oben', true);
UPDATE public.company_config SET value='true' WHERE key='selfservice_produto_enabled';

INSERT INTO public.omie_products(omie_codigo_produto, codigo, descricao, valor_unitario, ativo, account) VALUES
  (1001,'OB-A','Tinta Oben A',    100, true,  'oben'),
  (1002,'OB-I','Tinta Oben Inat',  80, false, 'oben'),     -- inativo → fora do catálogo
  (2001,'CO-A','Lixa Colacor A',   30, true,  'colacor');  -- de B → invisível p/ A
INSERT INTO public.inventory_position(omie_codigo_produto, saldo, cmc, preco_medio, account) VALUES
  (1001, 50,  40, 45, 'oben'),
  (2001, 200, 12, 15, 'colacor');
INSERT INTO public.sales_orders(customer_user_id, total, status, omie_numero_pedido, account, omie_payload) VALUES
  ('11111111-1111-1111-1111-111111111111', 500, 'faturado', 'PV-A1', 'oben',    '{"cabecalho":{"nf":1}}'::jsonb),
  ('22222222-2222-2222-2222-222222222222', 300, 'faturado', 'PV-B1', 'colacor', '{"cabecalho":{"nf":2}}'::jsonb),
  ('33333333-3333-3333-3333-333333333333', 400, 'faturado', 'PV-C1', 'oben',    '{"cabecalho":{"nf":3}}'::jsonb), -- irmão de grupo, oben
  ('44444444-4444-4444-4444-444444444444', 999, 'faturado', 'PV-S1', 'oben',    '{"cabecalho":{"nf":4}}'::jsonb); -- staff
-- authenticated/anon TÊM grant nas bases (como prod); a RLS é o filtro real (não o grant).
GRANT SELECT ON public.omie_products, public.inventory_position, public.sales_orders TO authenticated, anon;
SQL

# ── ZONA 4 — asserts ──
A="SET test.uid='11111111-1111-1111-1111-111111111111'; SET ROLE authenticated;"
S="SET test.uid='44444444-4444-4444-4444-444444444444'; SET ROLE authenticated;"

echo "── Step 1 — matriz de isolamento (sob o GUC do ATACANTE A) ──"
eq "S1a catálogo de A → só oben ativo (1)"                 "$(Pq -c "$A SELECT count(*) FROM public.selfservice_catalogo;" | tail -1)" "1"
eq "S1b catálogo de A NÃO vê colacro de B (isolamento conta)" "$(Pq -c "$A SELECT count(*) FROM public.selfservice_catalogo WHERE account='colacor';" | tail -1)" "0"
eq "S1c disponibilidade de A NÃO vê colacor"               "$(Pq -c "$A SELECT count(*) FROM public.selfservice_disponibilidade WHERE account<>'oben';" | tail -1)" "0"
eq "S1d meus_pedidos de A → só o próprio de oben (1)"       "$(Pq -c "$A SELECT count(*) FROM public.selfservice_meus_pedidos;" | tail -1)" "1"
eq "S1e A NÃO vê o pedido de B (PV-B1) via meus_pedidos"    "$(Pq -c "$A SELECT count(*) FROM public.selfservice_meus_pedidos WHERE omie_numero_pedido='PV-B1';" | tail -1)" "0"
# Grupo econômico: C' é oben E 'mesmo grupo' de A, mas OUTRO uid → não há caminho auth.uid()→documento→grupo.
eq "S1f A NÃO vê o pedido do IRMÃO DE GRUPO C' (PV-C1, mesma conta oben)" "$(Pq -c "$A SELECT count(*) FROM public.selfservice_meus_pedidos WHERE omie_numero_pedido='PV-C1';" | tail -1)" "0"
eq "S1g A NÃO vê o pedido-fantasma do STAFF (PV-S1)"        "$(Pq -c "$A SELECT count(*) FROM public.selfservice_meus_pedidos WHERE omie_numero_pedido='PV-S1';" | tail -1)" "0"
# Acesso CRU às bases (a RLS real é o que barra — regressão do PR0.0 / seg-onda).
eq "S1h A lê omie_products CRU → 0 (RLS staff-only, pós-PR0.0)"      "$(Pq -c "$A SELECT count(*) FROM public.omie_products;" | tail -1)" "0"
eq "S1i A lê inventory_position CRU → 0 (RLS staff — custo/cmc fechado)" "$(Pq -c "$A SELECT count(*) FROM public.inventory_position;" | tail -1)" "0"
eq "S1j A lê sales_orders de B CRU → 0 (RLS own; payload de B inalcançável)" "$(Pq -c "$A SELECT count(*) FROM public.sales_orders WHERE omie_numero_pedido='PV-B1';" | tail -1)" "0"
# get_regua_preco: A rejeitada (preço é staff-only; não é superfície self-service — PR0.2b adiado).
# Padrão robusto (Lei #2/#3): bloco DO captura SÓ insufficient_privilege (42501), re-lança o resto;
# sentinelas SMK_* são do TESTE, não do código (que emite 'regua de preco e staff-only').
RP=$(P -tA -c "$A DO \$smk\$ BEGIN PERFORM public.get_regua_preco('22222222-2222-2222-2222-222222222222'::uuid,'11111111-1111-1111-1111-111111111111'::uuid,1); RAISE EXCEPTION 'SMK_ATACANTE_PASSOU'; EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'SMK_REJEITADO'; WHEN OTHERS THEN RAISE; END \$smk\$;" 2>&1 || true)
case "$RP" in
  *SMK_REJEITADO*)       ok "S1k A é REJEITADA no get_regua_preco (42501 — staff-only preservado)" ;;
  *SMK_ATACANTE_PASSOU*) bad "S1k A PASSOU no get_regua_preco (gate staff furado!)" ;;
  *)                     bad "S1k get_regua_preco erro inesperado p/ A: [$RP]" ;;
esac

echo "── Step 2 — contaminação staff (allowlistar S por engano NÃO habilita) ──"
# Allowlista S por engano E flag global ON → selfservice_conta_atual() de S DEVE dar habilitado=false
# (is_employee=true / has_role employee). Prova que staff nunca vira comprador self-service.
P -q <<'SQL'
INSERT INTO public.selfservice_cliente_allowlist(customer_user_id, account, enabled)
  VALUES ('44444444-4444-4444-4444-444444444444','oben', true)
  ON CONFLICT (customer_user_id, account) DO UPDATE SET enabled=true;
SQL
eq "S2a selfservice_conta_atual() de S (allowlistado+flag ON) → habilitado=false" \
   "$(Pq -c "$S SELECT habilitado FROM public.selfservice_conta_atual();" | tail -1)" "f"
eq "S2b S NÃO vê os pedidos-fantasma via selfservice_meus_pedidos (gate fecha)" \
   "$(Pq -c "$S SELECT count(*) FROM public.selfservice_meus_pedidos;" | tail -1)" "0"
eq "S2c S NÃO vê o catálogo self-service (gate fecha)" \
   "$(Pq -c "$S SELECT count(*) FROM public.selfservice_catalogo;" | tail -1)" "0"

echo "── Step 3 — anti-documento estrutural (nenhuma view selfservice_* expõe doc/grupo) ──"
for V in selfservice_catalogo selfservice_disponibilidade selfservice_meus_pedidos; do
  HIT=$(Pq -c "SELECT count(*) FROM (SELECT lower(pg_get_viewdef('public.$V'::regclass, true)) AS d) x WHERE x.d ~ '(document|cnpj|cliente_grupo|grupo_economico|razao_social)';")
  eq "S3 $V NÃO referencia document/cnpj/grupo/razao_social (defensa contra PR futuro)" "$HIT" "0"
done

echo "── Step 4 — default privileges (anon fechado por construção) ──"
eq "S4a anon NÃO executa selfservice_conta_atual()" \
   "$(Pq -c "SELECT has_function_privilege('anon','public.selfservice_conta_atual()','EXECUTE');" | tail -1)" "f"
for V in selfservice_catalogo selfservice_disponibilidade selfservice_meus_pedidos; do
  eq "S4b anon NÃO tem SELECT em $V" \
     "$(Pq -c "SELECT has_table_privilege('anon','public.$V','SELECT');" | tail -1)" "f"
done
# Preço adiado (PR0.2b): nenhuma view self-service pode projetar preço/custo/saldo.
LEAK=$(Pq -c "SELECT count(*) FROM information_schema.columns WHERE table_name LIKE 'selfservice_%' AND column_name IN ('valor_unitario','preco','preco_unitario','saldo','cmc','preco_medio','custo','omie_payload','omie_response');")
eq "S4c nenhuma view selfservice_* projeta preço/custo/saldo/payload (preço adiado)" "$LEAK" "0"

# ── ZONA 5 — falsificação global (sabota UMA barreira por vez → o assert-espelho fica VERMELHO) ──
echo "── Step 5 — falsificação (cada sabotagem tem de derrubar o assert correspondente) ──"

# F1 — afrouxar o gate: remover o veto a staff (is_employee / has_role employee) de selfservice_conta_atual
#      → S2a passaria a habilitado=true. (sentinela = 't', não contém texto do código.)
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.selfservice_conta_atual()
RETURNS TABLE(customer_user_id uuid, accounts text[], habilitado boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $f$
  SELECT (SELECT auth.uid()),
    COALESCE((SELECT array_agg(DISTINCT a.account) FROM public.selfservice_cliente_allowlist a
              WHERE a.customer_user_id=(SELECT auth.uid()) AND a.enabled IS TRUE), '{}'::text[]),
    ( COALESCE((SELECT (value)::boolean FROM public.company_config WHERE key='selfservice_produto_enabled'), false)
      AND COALESCE((SELECT p.is_approved FROM public.profiles p WHERE p.user_id=(SELECT auth.uid())), false)
      -- SABOTADO: removido o veto is_employee / has_role(employee|master)
      AND EXISTS (SELECT 1 FROM public.selfservice_cliente_allowlist a
                  WHERE a.customer_user_id=(SELECT auth.uid()) AND a.enabled IS TRUE) );
$f$;
SQL
F1=$(Pq -c "$S SELECT habilitado FROM public.selfservice_conta_atual();" | tail -1)
if [ "$F1" = "t" ]; then ok "F1 sem o veto a staff, S vira habilitado=true → S2a tem dente"; else bad "F1 sem efeito → S2a fraco (veio [$F1])"; fi
P -q -f "$MIG_GATE"  # restaura o gate real

# F2 — afrouxar o isolamento de conta: remover `account = ANY(accounts)` do catálogo → A vê colacor.
P -q <<'SQL'
CREATE OR REPLACE VIEW public.selfservice_catalogo WITH (security_invoker=off, security_barrier=true) AS
  SELECT op.omie_codigo_produto, op.codigo, op.descricao, op.unidade, op.familia, op.subfamilia, op.account, op.imagem_url
  FROM public.omie_products op
  CROSS JOIN LATERAL (SELECT accounts, habilitado FROM public.selfservice_conta_atual()) s
  WHERE s.habilitado IS TRUE AND op.ativo IS TRUE;  -- SABOTADO: sem `AND op.account = ANY(s.accounts)`
SQL
F2=$(Pq -c "$A SELECT count(*) FROM public.selfservice_catalogo WHERE account='colacor';" | tail -1)
if [ "$F2" != "0" ]; then ok "F2 sem account=ANY, A vê catálogo colacor ($F2) → S1b tem dente"; else bad "F2 sem efeito → S1b fraco"; fi
P -q -f "$MIG_VIEWS"  # restaura as views reais

# F3 — reabrir a base crua: re-adicionar a policy USING(true) em omie_products → A lê cru de novo.
P -q <<'SQL'
CREATE POLICY "sabotage_authenticated_view_all" ON public.omie_products FOR SELECT USING (true);
SQL
F3=$(Pq -c "$A SELECT count(*) FROM public.omie_products;" | tail -1)
if [ "$F3" != "0" ]; then ok "F3 com USING(true) reintroduzido, A lê omie_products cru ($F3) → S1h tem dente"; else bad "F3 sem efeito → S1h fraco"; fi
P -q -c "DROP POLICY \"sabotage_authenticated_view_all\" ON public.omie_products;"  # restaura

echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
