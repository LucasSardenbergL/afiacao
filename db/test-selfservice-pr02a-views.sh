#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  HARNESS PG17 — PROVA: PR0.2a views-gate customer-facing (catálogo/disp/pedidos)║
# ║  Migrações: PR0.1 (gate) + 20260708212123_selfservice_pr02a_views_customer.sql ║
# ║  Rode:  bash db/test-selfservice-pr02a-views.sh > /tmp/t-pr02a.log 2>&1; echo $?║
# ║                                                                                ║
# ║  Invariantes: isolamento A(oben)×B(colacor); projeção segura (sem valor_unit/  ║
# ║  saldo/cmc/omie_payload); gate fecha não-habilitado; account=ANY sem COALESCE. ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5461}"
SLUG="pr02a-views"
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

# ── ZONA 1 — pré-requisitos: gate deps + tabelas-fonte ──
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

-- Tabelas-fonte das views (colunas reais relevantes + as sensíveis p/ provar que não vazam).
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
SQL

# ── ZONA 2 — aplicar migrations REAIS: PR0.1 (gate) + PR0.2a (views) ──
MIG_GATE="$REPO_ROOT/supabase/migrations/20260708202033_selfservice_pr01_allowlist_gate.sql"
MIG="$REPO_ROOT/supabase/migrations/20260708212123_selfservice_pr02a_views_customer.sql"
P -q -f "$MIG_GATE"
P -q -f "$MIG"
echo "migrations aplicadas: PR0.1 gate + $(basename "$MIG")"

# ── ZONA 3 — seed (postgres) ──
P -q <<'SQL'
INSERT INTO auth.users(id) VALUES
  ('11111111-1111-1111-1111-111111111111'),  -- A: oben, habilitado
  ('22222222-2222-2222-2222-222222222222'),  -- B: colacor, habilitado
  ('33333333-3333-3333-3333-333333333333'),  -- C: NÃO habilitado (sem allowlist)
  ('44444444-4444-4444-4444-444444444444')   -- S: STAFF (pedido contaminado)
  ON CONFLICT DO NOTHING;
INSERT INTO public.profiles(user_id, is_employee, is_approved) VALUES
  ('11111111-1111-1111-1111-111111111111', false, true),
  ('22222222-2222-2222-2222-222222222222', false, true),
  ('33333333-3333-3333-3333-333333333333', false, true),
  ('44444444-4444-4444-4444-444444444444', true,  true);
INSERT INTO public.user_roles(user_id, role) VALUES ('44444444-4444-4444-4444-444444444444','employee');
INSERT INTO public.selfservice_cliente_allowlist(customer_user_id, account, enabled) VALUES
  ('11111111-1111-1111-1111-111111111111','oben',    true),
  ('22222222-2222-2222-2222-222222222222','colacor', true);
UPDATE public.company_config SET value='true' WHERE key='selfservice_produto_enabled';

INSERT INTO public.omie_products(omie_codigo_produto, codigo, descricao, valor_unitario, ativo, account) VALUES
  (1001,'OB-A','Tinta Oben A',    100, true,  'oben'),
  (1002,'OB-I','Tinta Oben Inat',  80, false, 'oben'),    -- inativo → fora do catálogo
  (2001,'CO-A','Lixa Colacor A',   30, true,  'colacor'); -- de B → invisível p/ A
INSERT INTO public.inventory_position(omie_codigo_produto, saldo, cmc, preco_medio, account) VALUES
  (1001, 50,  40, 45, 'oben'),
  (2001, 200, 12, 15, 'colacor'),
  (2002, NULL, 12, 15, 'colacor');   -- saldo NULL (poisoned-ish) de outra conta
INSERT INTO public.sales_orders(customer_user_id, total, status, omie_numero_pedido, account, omie_payload) VALUES
  ('11111111-1111-1111-1111-111111111111', 500, 'faturado', 'PV-A1', 'oben',    '{"cabecalho":{}}'::jsonb),
  ('22222222-2222-2222-2222-222222222222', 300, 'faturado', 'PV-B1', 'colacor', '{"cabecalho":{}}'::jsonb),
  ('44444444-4444-4444-4444-444444444444', 999, 'faturado', 'PV-S1', 'oben',    '{"cabecalho":{}}'::jsonb), -- contaminado (staff)
  ('11111111-1111-1111-1111-111111111111', 700, 'faturado', 'PV-A2c','colacor', '{"cabecalho":{}}'::jsonb); -- A mas em colacor (conta NÃO habilitada p/ A) — Codex #5
GRANT SELECT ON public.omie_products, public.inventory_position, public.sales_orders TO authenticated, anon;
SQL

# ── ZONA 4 — asserts ──
echo "── asserts ──"
A="SET test.uid='11111111-1111-1111-1111-111111111111'; SET ROLE authenticated;"

CAT=$(Pq -c "$A SELECT count(*) FROM public.selfservice_catalogo;" | tail -1)
eq "A1 catálogo de A → só oben ativo (1 de 3 produtos)" "$CAT" "1"
CATCOL=$(Pq -c "$A SELECT count(*) FROM public.selfservice_catalogo WHERE account='colacor';" | tail -1)
eq "A2 catálogo de A NÃO tem produto de colacor (isolamento A×B)" "$CATCOL" "0"

DISP=$(Pq -c "$A SELECT count(*) FROM public.selfservice_disponibilidade;" | tail -1)
eq "A3 disponibilidade de A → só oben (1)" "$DISP" "1"
DCOL=$(Pq -c "$A SELECT count(*) FROM public.selfservice_disponibilidade WHERE account='colacor';" | tail -1)
eq "A4 disponibilidade de A NÃO tem colacor (nem a linha saldo NULL)" "$DCOL" "0"

PED=$(Pq -c "$A SELECT count(*) FROM public.selfservice_meus_pedidos;" | tail -1)
eq "A5 meus_pedidos de A → só o próprio de oben (1; exclui B, staff e o próprio de colacor)" "$PED" "1"
PEDCOL=$(Pq -c "$A SELECT count(*) FROM public.selfservice_meus_pedidos WHERE account='colacor';" | tail -1)
eq "A5b pedido do PRÓPRIO A em conta NÃO habilitada (colacor) NÃO aparece (Codex #5)" "$PEDCOL" "0"

# C não-habilitado → tudo fechado pelo gate
C="SET test.uid='33333333-3333-3333-3333-333333333333'; SET ROLE authenticated;"
CC=$(Pq -c "$C SELECT count(*) FROM public.selfservice_catalogo;" | tail -1)
CD=$(Pq -c "$C SELECT count(*) FROM public.selfservice_disponibilidade;" | tail -1)
CP=$(Pq -c "$C SELECT count(*) FROM public.selfservice_meus_pedidos;" | tail -1)
eq "A6 catálogo do não-habilitado → 0" "$CC" "0"
eq "A7 disponibilidade do não-habilitado → 0" "$CD" "0"
eq "A8 pedidos do não-habilitado → 0" "$CP" "0"

# Projeção segura: colunas sensíveis NÃO existem nas views
VU=$(Pq -c "SELECT count(*) FROM information_schema.columns WHERE table_name='selfservice_catalogo' AND column_name IN ('valor_unitario','estoque');")
eq "A9 catálogo NÃO projeta valor_unitario/estoque" "$VU" "0"
SC=$(Pq -c "SELECT count(*) FROM information_schema.columns WHERE table_name='selfservice_disponibilidade' AND column_name IN ('saldo','cmc','preco_medio');")
eq "A10 disponibilidade NÃO projeta saldo/cmc/preco_medio (só booleano)" "$SC" "0"
OP=$(Pq -c "SELECT count(*) FROM information_schema.columns WHERE table_name='selfservice_meus_pedidos' AND column_name IN ('omie_payload','omie_response');")
eq "A11 meus_pedidos NÃO projeta omie_payload/omie_response" "$OP" "0"

# anon barrado (REVOKE anon) — o comando deve FALHAR; || true p/ não abortar sob set -e+pipefail
AN=$(P -tA -c "SET ROLE anon; SELECT count(*) FROM public.selfservice_catalogo;" 2>&1 | tail -1 || true)
case "$AN" in *denied*|*permission*) ok "A12 anon não lê o catálogo (permission denied — REVOKE anon)" ;; 0) ok "A12 anon vê 0 no catálogo" ;; *) bad "A12 anon leu: $AN" ;; esac

# ── ZONA 5 — falsificação ──
echo "── falsificação ──"
# F1 — remover o filtro `account = ANY(accounts)` → A passa a ver colacor (prova o dente do isolamento).
#   (Codex P2#9: COALESCE(account=ANY,true) NÃO abriria — p/ dado não-nulo o ANY dá false, não NULL.
#    O vetor real é ALGUÉM REMOVER/afrouxar o filtro; é isso que a sabotagem simula.)
P -q <<'SQL'
CREATE OR REPLACE VIEW public.selfservice_catalogo WITH (security_invoker=off, security_barrier=true) AS
  SELECT op.omie_codigo_produto, op.codigo, op.descricao, op.unidade, op.familia, op.subfamilia, op.account, op.imagem_url
  FROM public.omie_products op
  CROSS JOIN LATERAL (SELECT accounts, habilitado FROM public.selfservice_conta_atual()) s
  WHERE s.habilitado IS TRUE AND op.ativo IS TRUE;  -- SABOTADO: sem o `AND op.account = ANY(s.accounts)`
SQL
CATSAB=$(Pq -c "$A SELECT count(*) FROM public.selfservice_catalogo WHERE account='colacor';" | tail -1)
if [ "$CATSAB" != "0" ]; then ok "F1 sem o filtro de account A vê colacor ($CATSAB) → A2 tem dente"; else bad "F1 sem efeito → A2 fraco"; fi
P -q -f "$MIG"  # restaura

# F2 — poisoned-row / cross-account não deve causar ERRO: A consulta disponibilidade com a linha saldo NULL de colacor presente → 0 linhas, sem erro
DERR=$(P -tA -c "$A SELECT count(*) FROM public.selfservice_disponibilidade;" 2>&1 | tail -1 || true)
case "$DERR" in *ERROR*|*error*) bad "F2 disponibilidade de A ERROU com linha NULL de outra conta: $DERR" ;; *) ok "F2 linha saldo NULL de colacor não quebra a view de A (=$DERR, sem erro)" ;; esac

# F3 — remover `account = ANY(accounts)` de meus_pedidos → A vê o PRÓPRIO pedido de colacor (dente de A5b/Codex#5)
P -q <<'SQL'
CREATE OR REPLACE VIEW public.selfservice_meus_pedidos WITH (security_invoker=off, security_barrier=true) AS
  SELECT so.id, so.omie_numero_pedido, so.account, so.status, so.created_at, so.order_date_kpi, so.total
  FROM public.sales_orders so
  CROSS JOIN LATERAL (SELECT accounts, habilitado FROM public.selfservice_conta_atual()) s
  WHERE s.habilitado IS TRUE AND so.customer_user_id = (SELECT auth.uid())
    AND NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.user_id = so.customer_user_id AND p.is_employee IS TRUE);  -- SABOTADO: sem account = ANY
SQL
PEDSAB=$(Pq -c "$A SELECT count(*) FROM public.selfservice_meus_pedidos WHERE account='colacor';" | tail -1)
if [ "$PEDSAB" != "0" ]; then ok "F3 sem account=ANY A vê o próprio pedido de colacor ($PEDSAB) → A5b tem dente"; else bad "F3 sem efeito → A5b fraco"; fi
P -q -f "$MIG"  # restaura

echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
