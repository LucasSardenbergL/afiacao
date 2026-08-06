#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  HARNESS PG17 — PROVA: PR0.0 fecha a base crua omie_products (RLS staff-only)  ║
# ║  Migração: supabase/migrations/20260708164211_selfservice_pr00_fechar_base_crua.sql
# ║  Rode:  bash db/test-selfservice-pr00-base-crua.sh > /tmp/t-pr00.log 2>&1; echo "exit=$?"
# ║                                                                                ║
# ║  Invariante money-path/auth: cliente comum (authenticated sem role) e anon NÃO ║
# ║  leem o catálogo cru (valor_unitario/estoque das 3 contas) — nem por SELECT     ║
# ║  direto NEM por embed/join (order_items→omie_products); staff continua lendo    ║
# ║  (preflight de vendabilidade não regride). Falsificação prova o dente.         ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

# ── arranque PG17 descartável (contorna keg-only do brew) ──
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5459}"     # dedicado (evita colisão com outros harnesses em worktrees paralelas)
SLUG="pr00-base-crua"
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

# ── base mínima do Supabase: roles, schema auth, auth.uid()/role() via GUC ──
P -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -q <<'SQL'
CREATE OR REPLACE FUNCTION auth.uid()  RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.uid',  true), '')::uuid $f$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.role', true), '') $f$;
ALTER ROLE service_role BYPASSRLS;
SQL

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

echo "═══ setup pronto (PG17 :$PORT) ═══"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — PRÉ-REQUISITOS: estado de PROD ANTES da migração (defs reais via psql-ro)
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
-- app_role + user_roles + has_role: cópia FIEL de prod (pg_get_functiondef).
CREATE TYPE public.app_role AS ENUM ('master','employee','customer');
CREATE TABLE public.user_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  role public.app_role NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role app_role)
  RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $function$;

-- omie_products: colunas reais relevantes.
CREATE TABLE public.omie_products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  omie_codigo_produto bigint NOT NULL,
  codigo text NOT NULL,
  descricao text NOT NULL,
  unidade text NOT NULL DEFAULT 'UN',
  valor_unitario numeric NOT NULL DEFAULT 0,
  estoque numeric DEFAULT 0,
  ativo boolean NOT NULL DEFAULT true,
  account text NOT NULL DEFAULT 'oben',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE public.omie_products ENABLE ROW LEVEL SECURITY;

-- Estado PRÉ-migração: as DUAS policies que hoje existem em prod (psql-ro confirmou).
-- A "USING(true)" é o vazamento que a migração REMOVE; a "Staff…ALL" permanece.
CREATE POLICY "Authenticated users can view products" ON public.omie_products
  FOR SELECT TO authenticated USING (true);
CREATE POLICY "Staff can manage products" ON public.omie_products
  FOR ALL TO authenticated
  USING ((SELECT (has_role((SELECT auth.uid()),'master'::app_role) OR has_role((SELECT auth.uid()),'employee'::app_role))));

-- order_items: usado para provar que o EMBED PostgREST (select=*,omie_products(...)) — que é
-- um join lateral — respeita a RLS da tabela embedded. Policy "own" (espelha prod).
CREATE TABLE public.order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_user_id uuid,
  product_id uuid REFERENCES public.omie_products(id)
);
ALTER TABLE public.order_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY "order_items own" ON public.order_items
  FOR SELECT TO authenticated USING (customer_user_id = (SELECT auth.uid()));
SQL

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — APLICAR A MIGRATION REAL (Lei #1)
# ══════════════════════════════════════════════════════════════════════════════
MIG="$REPO_ROOT/supabase/migrations/20260708164211_selfservice_pr00_fechar_base_crua.sql"
P -q -f "$MIG"
echo "migration aplicada: $(basename "$MIG")"

# Sanidade estrutural: a policy furada sumiu; resta só a staff (ALL).
LEAK=$(Pq -c "SELECT count(*) FROM pg_policies WHERE tablename='omie_products' AND policyname='Authenticated users can view products';")
REST=$(Pq -c "SELECT count(*) FROM pg_policies WHERE tablename='omie_products';")
eq "E1 policy USING(true) removida"               "$LEAK" "0"
eq "E2 resta só a policy staff (ALL cobre SELECT)" "$REST" "1"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 3 — SEED + GRANTS (semear como postgres; has_role é SECDEF → não precisa GRANT em user_roles)
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
INSERT INTO auth.users(id) VALUES
  ('11111111-1111-1111-1111-111111111111'),   -- cliente comum (sem role)
  ('33333333-3333-3333-3333-333333333333')    -- staff (employee)
  ON CONFLICT DO NOTHING;
INSERT INTO public.user_roles(user_id, role) VALUES
  ('33333333-3333-3333-3333-333333333333','employee') ON CONFLICT DO NOTHING;
INSERT INTO public.omie_products(omie_codigo_produto, codigo, descricao, valor_unitario, estoque, ativo, account) VALUES
  (1001,'OB-A','Tinta Oben A',        100, 50,  true,  'oben'),
  (1002,'OB-I','Tinta Oben Inativa',   80, 0,   false, 'oben'),
  (2001,'CO-A','Lixa Colacor A',       30, 200, true,  'colacor'),
  (2002,'CO-I','Lixa Colacor Inativa', 25, 0,   false, 'colacor');
-- pedido do cliente comum apontando para um produto (para o teste de embed/join).
INSERT INTO public.order_items(customer_user_id, product_id)
  SELECT '11111111-1111-1111-1111-111111111111', id FROM public.omie_products WHERE codigo='OB-A';
-- migração do repo é --no-privileges (Supabase concede em runtime) → conceda p/ os asserts de RLS.
GRANT SELECT ON public.omie_products TO authenticated, anon;
GRANT SELECT ON public.order_items  TO authenticated;
SQL

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4 — ASSERTS (RLS: staff vê / cliente barrado / anon barrado / embed barrado)
# ══════════════════════════════════════════════════════════════════════════════
echo "── asserts ──"
STAFF=$(Pq -c "SET test.uid='33333333-3333-3333-3333-333333333333'; SET ROLE authenticated; SELECT count(*) FROM public.omie_products;" | tail -1)
eq "A1 staff (employee) vê o catálogo cru (preflight vendabilidade não regride)" "$STAFF" "4"

CLI=$(Pq -c "SET test.uid='11111111-1111-1111-1111-111111111111'; SET ROLE authenticated; SELECT count(*) FROM public.omie_products;" | tail -1)
eq "A2 cliente comum NÃO vê a base crua" "$CLI" "0"

CLIV=$(Pq -c "SET test.uid='11111111-1111-1111-1111-111111111111'; SET ROLE authenticated; SELECT count(*) FROM (SELECT valor_unitario, estoque FROM public.omie_products) t;" | tail -1)
eq "A3 cliente NÃO lê valor_unitario/estoque (vazamento cross-empresa fechado)" "$CLIV" "0"

ANON=$(Pq -c "SET ROLE anon; SELECT count(*) FROM public.omie_products;" | tail -1)
eq "A4 anon não vê nada" "$ANON" "0"

OI=$(Pq -c "SET test.uid='11111111-1111-1111-1111-111111111111'; SET ROLE authenticated; SELECT count(*) FROM public.order_items;" | tail -1)
eq "A5 cliente vê o próprio pedido (order_items own — controle)" "$OI" "1"

EMBED=$(Pq -c "SET test.uid='11111111-1111-1111-1111-111111111111'; SET ROLE authenticated; SELECT count(*) FROM public.order_items oi JOIN public.omie_products p ON p.id=oi.product_id;" | tail -1)
eq "A6 embed order_items→omie_products NÃO expõe o produto (RLS filtra no join)" "$EMBED" "0"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICAÇÃO (sabota → exige VERMELHO → restaura cirurgicamente)
# ══════════════════════════════════════════════════════════════════════════════
echo "── falsificação ──"

# F1 — reabre o vazamento (policy USING(true)) e EXIGE que cliente + embed voltem a ver → dente de A2/A3/A6.
P -q -c "CREATE POLICY \"Authenticated users can view products\" ON public.omie_products FOR SELECT TO authenticated USING (true);"
CLI_SAB=$(Pq -c "SET test.uid='11111111-1111-1111-1111-111111111111'; SET ROLE authenticated; SELECT count(*) FROM public.omie_products;" | tail -1)
if [ "$CLI_SAB" != "0" ]; then ok "F1 policy USING(true) reabriu o vazamento (cliente vê $CLI_SAB) → A2/A3 têm dente"; else bad "F1 sabotei e cliente ainda vê 0 → A2 é fraco"; fi
EMBED_SAB=$(Pq -c "SET test.uid='11111111-1111-1111-1111-111111111111'; SET ROLE authenticated; SELECT count(*) FROM public.order_items oi JOIN public.omie_products p ON p.id=oi.product_id;" | tail -1)
if [ "$EMBED_SAB" != "0" ]; then ok "F1b embed também vaza com USING(true) (=$EMBED_SAB) → A6 tem dente"; else bad "F1b embed seguiu 0 com o vazamento aberto → A6 é fraco"; fi
P -q -c "DROP POLICY \"Authenticated users can view products\" ON public.omie_products;"
CLI_RE=$(Pq -c "SET test.uid='11111111-1111-1111-1111-111111111111'; SET ROLE authenticated; SELECT count(*) FROM public.omie_products;" | tail -1)
eq "F1-restore cliente volta a 0" "$CLI_RE" "0"

# F2 — remove a policy staff (ALL, a única que resta) e EXIGE que o staff caia a 0 → prova
#      que A1 depende de policy (não é bypass) e que a ALL é o que sustenta o SELECT do staff.
P -q -c "DROP POLICY \"Staff can manage products\" ON public.omie_products;"
STAFF_SAB=$(Pq -c "SET test.uid='33333333-3333-3333-3333-333333333333'; SET ROLE authenticated; SELECT count(*) FROM public.omie_products;" | tail -1)
if [ "$STAFF_SAB" = "0" ]; then ok "F2 sem a policy staff, staff vê 0 → A1 tem dente (staff lê via a policy ALL)"; else bad "F2 removi a policy staff e staff ainda vê $STAFF_SAB → A1 é teatro (bypass)"; fi
# restaura cirurgicamente (recria a policy staff ALL na versão verdadeira)
P -q -c "CREATE POLICY \"Staff can manage products\" ON public.omie_products FOR ALL TO authenticated USING ((SELECT (has_role((SELECT auth.uid()),'master'::app_role) OR has_role((SELECT auth.uid()),'employee'::app_role))));"
STAFF_RE=$(Pq -c "SET test.uid='33333333-3333-3333-3333-333333333333'; SET ROLE authenticated; SELECT count(*) FROM public.omie_products;" | tail -1)
eq "F2-restore staff volta a ver 4" "$STAFF_RE" "4"

# ── veredito ──
echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
