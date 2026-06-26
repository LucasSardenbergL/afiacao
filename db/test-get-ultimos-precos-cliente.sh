#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA PG17 — get_ultimos_precos_cliente (money-path: preço-cliente na tela)   ║
# ║  Migration: supabase/migrations/20260625120000_get_ultimos_precos_cliente.sql ║
# ║  Rode: bash db/test-get-ultimos-precos-cliente.sh > /tmp/t.log 2>&1; echo $?   ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5462}"
SLUG="ultimos-precos"
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

P -q <<'SQL'
CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.uid', true), '')::uuid $f$;
CREATE TABLE IF NOT EXISTS auth.users (id uuid PRIMARY KEY);
DO $$ BEGIN CREATE ROLE anon; EXCEPTION WHEN duplicate_object THEN END $$;
DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN END $$;
SQL

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

echo "═══ setup pronto (PG17 :$PORT) ═══"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — PRÉ-REQUISITOS (app_role, user_roles, has_role, sales_orders, order_items)
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
CREATE TYPE public.app_role AS ENUM ('master','employee','customer');

CREATE TABLE public.user_roles (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id uuid NOT NULL,
  role public.app_role NOT NULL DEFAULT 'customer'
);

-- has_role REAL (snapshot): SQL STABLE SECURITY DEFINER lendo user_roles
CREATE FUNCTION public.has_role(_user_id uuid, _role public.app_role) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
  AS $$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $$;

-- sales_orders: só as colunas que a RPC lê
CREATE TABLE public.sales_orders (
  id uuid PRIMARY KEY,
  customer_user_id uuid,
  status text,
  order_date_kpi date,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

-- order_items: product_id NULLABLE (espelha prod), customer_user_id NOT NULL
CREATE TABLE public.order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sales_order_id uuid NOT NULL,
  product_id uuid,
  customer_user_id uuid NOT NULL,
  unit_price numeric NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
SQL

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — APLICAR A MIGRATION REAL
# ══════════════════════════════════════════════════════════════════════════════
MIG="$REPO_ROOT/supabase/migrations/20260625120000_get_ultimos_precos_cliente.sql"
P -q -f "$MIG"
echo "migration aplicada: $(basename "$MIG")"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 3 — SEED
#   STAFF=33 (employee, o caller) · A=11 (customer) · B=22 (outro cliente)
#   prod1..8 = 0000…0001..0008 ; pedidos a0…0011.. ; datas: passado < hoje < futuro 2027
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
INSERT INTO auth.users(id) VALUES
  ('11111111-1111-1111-1111-111111111111'),
  ('22222222-2222-2222-2222-222222222222'),
  ('33333333-3333-3333-3333-333333333333');
INSERT INTO public.user_roles(user_id, role) VALUES
  ('33333333-3333-3333-3333-333333333333','employee'),
  ('11111111-1111-1111-1111-111111111111','customer');

INSERT INTO public.sales_orders(id, customer_user_id, status, order_date_kpi, created_at, deleted_at) VALUES
  ('a0000000-0000-0000-0000-000000000011','11111111-1111-1111-1111-111111111111','faturado','2026-01-01','2026-06-20T12:00:00Z',NULL), -- prod1 antigo p/ data, created_at NOVO (trocado), price 10
  ('a0000000-0000-0000-0000-000000000012','11111111-1111-1111-1111-111111111111','faturado','2026-05-01','2026-01-15T12:00:00Z',NULL), -- prod1 RECENTE p/ data, created_at velho, price 12 ← correto
  ('a0000000-0000-0000-0000-000000000020','11111111-1111-1111-1111-111111111111','faturado','2026-04-01','2026-04-01T12:00:00Z',NULL), -- prod2 price 50
  ('a0000000-0000-0000-0000-000000000031','11111111-1111-1111-1111-111111111111','cancelado','2026-05-10','2026-05-10T12:00:00Z',NULL), -- prod3 CANCELADO recente price 99
  ('a0000000-0000-0000-0000-000000000032','11111111-1111-1111-1111-111111111111','faturado','2026-03-10','2026-03-10T12:00:00Z',NULL), -- prod3 faturado price 30 ← correto
  ('a0000000-0000-0000-0000-000000000041','11111111-1111-1111-1111-111111111111','faturado','2027-01-01','2026-06-24T12:00:00Z',NULL), -- prod4 FUTURO price 88
  ('a0000000-0000-0000-0000-000000000042','11111111-1111-1111-1111-111111111111','faturado','2026-03-01','2026-03-01T12:00:00Z',NULL), -- prod4 válido price 40 ← correto
  ('a0000000-0000-0000-0000-000000000051','11111111-1111-1111-1111-111111111111','faturado','2026-05-20','2026-05-20T12:00:00Z','2026-05-21T00:00:00Z'), -- prod5 DELETED price 77
  ('a0000000-0000-0000-0000-000000000052','11111111-1111-1111-1111-111111111111','faturado','2026-02-20','2026-02-20T12:00:00Z',NULL), -- prod5 vivo price 25 ← correto
  ('a0000000-0000-0000-0000-000000000061','11111111-1111-1111-1111-111111111111','faturado','2026-05-05','2026-05-05T12:00:00Z',NULL), -- prod6 price 0 (recente)
  ('a0000000-0000-0000-0000-000000000062','11111111-1111-1111-1111-111111111111','faturado','2026-04-05','2026-04-05T12:00:00Z',NULL), -- prod6 price 15 ← correto
  ('a0000000-0000-0000-0000-000000000070','11111111-1111-1111-1111-111111111111','faturado','2026-04-01','2026-04-01T12:00:00Z',NULL), -- prod7 (product_id NULL)
  ('a0000000-0000-0000-0000-000000000080','22222222-2222-2222-2222-222222222222','faturado','2026-06-01','2026-06-01T12:00:00Z',NULL); -- prod8: PAI é cliente B

INSERT INTO public.order_items(sales_order_id, product_id, customer_user_id, unit_price, created_at) VALUES
  ('a0000000-0000-0000-0000-000000000011','00000000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111',10,'2026-06-20T12:00:00Z'),
  ('a0000000-0000-0000-0000-000000000012','00000000-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111',12,'2026-01-15T12:00:00Z'),
  ('a0000000-0000-0000-0000-000000000020','00000000-0000-0000-0000-000000000002','11111111-1111-1111-1111-111111111111',50,'2026-04-01T12:00:00Z'),
  ('a0000000-0000-0000-0000-000000000031','00000000-0000-0000-0000-000000000003','11111111-1111-1111-1111-111111111111',99,'2026-05-10T12:00:00Z'),
  ('a0000000-0000-0000-0000-000000000032','00000000-0000-0000-0000-000000000003','11111111-1111-1111-1111-111111111111',30,'2026-03-10T12:00:00Z'),
  ('a0000000-0000-0000-0000-000000000041','00000000-0000-0000-0000-000000000004','11111111-1111-1111-1111-111111111111',88,'2026-06-24T12:00:00Z'),
  ('a0000000-0000-0000-0000-000000000042','00000000-0000-0000-0000-000000000004','11111111-1111-1111-1111-111111111111',40,'2026-03-01T12:00:00Z'),
  ('a0000000-0000-0000-0000-000000000051','00000000-0000-0000-0000-000000000005','11111111-1111-1111-1111-111111111111',77,'2026-05-20T12:00:00Z'),
  ('a0000000-0000-0000-0000-000000000052','00000000-0000-0000-0000-000000000005','11111111-1111-1111-1111-111111111111',25,'2026-02-20T12:00:00Z'),
  ('a0000000-0000-0000-0000-000000000061','00000000-0000-0000-0000-000000000006','11111111-1111-1111-1111-111111111111',0, '2026-05-05T12:00:00Z'),
  ('a0000000-0000-0000-0000-000000000062','00000000-0000-0000-0000-000000000006','11111111-1111-1111-1111-111111111111',15,'2026-04-05T12:00:00Z'),
  ('a0000000-0000-0000-0000-000000000070',NULL,                                  '11111111-1111-1111-1111-111111111111',5, '2026-04-01T12:00:00Z'),
  ('a0000000-0000-0000-0000-000000000080','00000000-0000-0000-0000-000000000008','11111111-1111-1111-1111-111111111111',200,'2026-06-01T12:00:00Z'); -- oi.customer=A mas pai(so)=B
SQL

# helpers: chamam a RPC como STAFF (auth.uid()=employee 33) p/ cliente A (11)
# -q SUPRIME os command tags ('SET') — senão, quando o SELECT volta 0 linhas (produto ausente,
# o caso CORRETO em M5/M6), o tail -1 pegaria o 'SET' do SET ROLE em vez de string vazia.
preco()  { Pq -q -c "SET test.uid='33333333-3333-3333-3333-333333333333'; SET ROLE authenticated; SELECT unit_price FROM public.get_ultimos_precos_cliente('11111111-1111-1111-1111-111111111111') WHERE product_id='$1';" | tail -1; }
ntotal() { Pq -q -c "SET test.uid='33333333-3333-3333-3333-333333333333'; SET ROLE authenticated; SELECT count(*) FROM public.get_ultimos_precos_cliente('11111111-1111-1111-1111-111111111111');" | tail -1; }

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4 — ASSERTS
# ══════════════════════════════════════════════════════════════════════════════
echo "── asserts positivos / money-path ──"
eq "P1 prod1 usa order_date_kpi (12, não created_at→10)" "$(preco 00000000-0000-0000-0000-000000000001)" "12"
eq "P2 prod2 preço simples"                              "$(preco 00000000-0000-0000-0000-000000000002)" "50"
eq "P3 DISTINCT ON: 1 linha/produto, total=6"            "$(ntotal)" "6"
eq "M1 status: ignora cancelado (30, não 99)"            "$(preco 00000000-0000-0000-0000-000000000003)" "30"
eq "M2 anti-futuro: ignora 2027 (40, não 88)"            "$(preco 00000000-0000-0000-0000-000000000004)" "40"
eq "M3 deleted_at: ignora deletado (25, não 77)"         "$(preco 00000000-0000-0000-0000-000000000005)" "25"
eq "M4 unit_price>0: ignora preço 0 (15)"                "$(preco 00000000-0000-0000-0000-000000000006)" "15"
eq "M5 product_id NULL: prod7 não aparece"               "$(preco 00000000-0000-0000-0000-000000000007)" ""
eq "M6 defesa oi=so: prod8 (pai=B) não vaza p/ A"        "$(preco 00000000-0000-0000-0000-000000000008)" ""

echo "── asserts negativos (gate) — SQLSTATE + re-raise, sentinela própria ──"
# N1: customer (A) chamando → RAISE forbidden (42501)
R=$(P -tA 2>&1 <<'SQL'
SET test.uid='11111111-1111-1111-1111-111111111111';  -- customer, NÃO staff
SET ROLE authenticated;
DO $$
BEGIN
  PERFORM * FROM public.get_ultimos_precos_cliente('11111111-1111-1111-1111-111111111111');
  RAISE EXCEPTION 'GATE_NAO_BARROU';
EXCEPTION
  WHEN insufficient_privilege THEN RAISE NOTICE 'GATE_OK';   -- 42501 = esperado
  WHEN OTHERS THEN RAISE;
END $$;
SQL
)
case "$R" in *GATE_OK*) ok "N1 gate nega customer (42501)" ;; *) bad "N1 gate — veio: $R" ;; esac

# N2: anon não tem EXECUTE (REVOKE) → insufficient_privilege
R=$(P -tA 2>&1 <<'SQL'
SET ROLE anon;
DO $$
BEGIN
  PERFORM * FROM public.get_ultimos_precos_cliente('11111111-1111-1111-1111-111111111111');
  RAISE EXCEPTION 'ANON_EXECUTOU';
EXCEPTION
  WHEN insufficient_privilege THEN RAISE NOTICE 'ANON_BLOQ';
  WHEN OTHERS THEN RAISE;
END $$;
SQL
)
case "$R" in *ANON_BLOQ*) ok "N2 anon sem EXECUTE (REVOKE)" ;; *) bad "N2 anon — veio: $R" ;; esac

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICAÇÃO (sabota → exige VERMELHO → restaura reaplicando a migration)
# ══════════════════════════════════════════════════════════════════════════════
echo "── falsificação ──"
restaura() { P -q -f "$MIG"; }

# F1 — sabota o GATE (remove o IF NOT staff): N1 deve deixar de barrar
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.get_ultimos_precos_cliente(p_customer uuid)
RETURNS TABLE(product_id uuid, unit_price numeric) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $fn$
BEGIN
  RETURN QUERY SELECT DISTINCT ON (oi.product_id) oi.product_id, oi.unit_price
  FROM public.order_items oi JOIN public.sales_orders so ON so.id=oi.sales_order_id
  WHERE oi.customer_user_id=p_customer ORDER BY oi.product_id, oi.id;  -- GATE REMOVIDO
END $fn$;
SQL
R=$(P -tA 2>&1 <<'SQL'
SET test.uid='11111111-1111-1111-1111-111111111111'; SET ROLE authenticated;
DO $$ BEGIN
  PERFORM * FROM public.get_ultimos_precos_cliente('11111111-1111-1111-1111-111111111111');
  RAISE NOTICE 'SABOTAGEM_PASSOU';
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'AINDA_BARRA'; END $$;
SQL
)
case "$R" in *SABOTAGEM_PASSOU*) ok "F1 gate furado deixou customer passar → N1 tem dente" ;; *) bad "F1 sabotei o gate e N1 não mudou → fraco" ;; esac
restaura

# F2 — sabota a ORDENAÇÃO (created_at no lugar de order_date_kpi): prod1 deve virar 10
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.get_ultimos_precos_cliente(p_customer uuid)
RETURNS TABLE(product_id uuid, unit_price numeric) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $fn$
BEGIN
  IF NOT (public.has_role(auth.uid(),'employee'::public.app_role) OR public.has_role(auth.uid(),'master'::public.app_role)) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
  RETURN QUERY SELECT DISTINCT ON (oi.product_id) oi.product_id, oi.unit_price
  FROM public.order_items oi JOIN public.sales_orders so ON so.id=oi.sales_order_id
  WHERE oi.customer_user_id=p_customer AND oi.customer_user_id=so.customer_user_id AND so.deleted_at IS NULL
    AND COALESCE(so.status,'') NOT IN ('cancelado','orcamento') AND oi.unit_price>0 AND oi.product_id IS NOT NULL
  ORDER BY oi.product_id, oi.created_at DESC, oi.id DESC;  -- SABOTADO: created_at em vez de order_date_kpi
END $fn$;
SQL
eq "F2 ordenação furada (created_at) → prod1 vira 10" "$(preco 00000000-0000-0000-0000-000000000001)" "10"
restaura

# F3 — sabota o filtro de STATUS (remove): prod3 deve virar 99 (cancelado vence)
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.get_ultimos_precos_cliente(p_customer uuid)
RETURNS TABLE(product_id uuid, unit_price numeric) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $fn$
BEGIN
  IF NOT (public.has_role(auth.uid(),'employee'::public.app_role) OR public.has_role(auth.uid(),'master'::public.app_role)) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
  RETURN QUERY SELECT DISTINCT ON (oi.product_id) oi.product_id, oi.unit_price
  FROM public.order_items oi JOIN public.sales_orders so ON so.id=oi.sales_order_id
  WHERE oi.customer_user_id=p_customer AND oi.customer_user_id=so.customer_user_id AND so.deleted_at IS NULL
    AND oi.unit_price>0 AND oi.product_id IS NOT NULL                        -- SABOTADO: sem filtro de status
    AND COALESCE(so.order_date_kpi,(so.created_at AT TIME ZONE 'America/Sao_Paulo')::date) <= current_date
  ORDER BY oi.product_id, COALESCE(so.order_date_kpi,(so.created_at AT TIME ZONE 'America/Sao_Paulo')::date) DESC, so.created_at DESC, oi.created_at DESC, oi.id DESC;
END $fn$;
SQL
eq "F3 sem filtro status → prod3 vira 99 (cancelado)" "$(preco 00000000-0000-0000-0000-000000000003)" "99"
restaura

# F4 — sabota o ANTI-FUTURO (remove <= current_date): prod4 deve virar 88 (futuro vence)
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.get_ultimos_precos_cliente(p_customer uuid)
RETURNS TABLE(product_id uuid, unit_price numeric) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $fn$
BEGIN
  IF NOT (public.has_role(auth.uid(),'employee'::public.app_role) OR public.has_role(auth.uid(),'master'::public.app_role)) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
  RETURN QUERY SELECT DISTINCT ON (oi.product_id) oi.product_id, oi.unit_price
  FROM public.order_items oi JOIN public.sales_orders so ON so.id=oi.sales_order_id
  WHERE oi.customer_user_id=p_customer AND oi.customer_user_id=so.customer_user_id AND so.deleted_at IS NULL
    AND COALESCE(so.status,'') NOT IN ('cancelado','orcamento') AND oi.unit_price>0 AND oi.product_id IS NOT NULL
  ORDER BY oi.product_id, COALESCE(so.order_date_kpi,(so.created_at AT TIME ZONE 'America/Sao_Paulo')::date) DESC, so.created_at DESC, oi.created_at DESC, oi.id DESC;  -- SABOTADO: sem anti-futuro
END $fn$;
SQL
eq "F4 sem anti-futuro → prod4 vira 88 (2027)" "$(preco 00000000-0000-0000-0000-000000000004)" "88"
restaura

# F5 — sabota a DEFESA oi=so (remove): prod8 (pai=B) deve VAZAR p/ A
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.get_ultimos_precos_cliente(p_customer uuid)
RETURNS TABLE(product_id uuid, unit_price numeric) LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path='' AS $fn$
BEGIN
  IF NOT (public.has_role(auth.uid(),'employee'::public.app_role) OR public.has_role(auth.uid(),'master'::public.app_role)) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
  RETURN QUERY SELECT DISTINCT ON (oi.product_id) oi.product_id, oi.unit_price
  FROM public.order_items oi JOIN public.sales_orders so ON so.id=oi.sales_order_id
  WHERE oi.customer_user_id=p_customer AND so.deleted_at IS NULL                 -- SABOTADO: sem oi=so
    AND COALESCE(so.status,'') NOT IN ('cancelado','orcamento') AND oi.unit_price>0 AND oi.product_id IS NOT NULL
    AND COALESCE(so.order_date_kpi,(so.created_at AT TIME ZONE 'America/Sao_Paulo')::date) <= current_date
  ORDER BY oi.product_id, COALESCE(so.order_date_kpi,(so.created_at AT TIME ZONE 'America/Sao_Paulo')::date) DESC, so.created_at DESC, oi.created_at DESC, oi.id DESC;
END $fn$;
SQL
eq "F5 sem defesa oi=so → prod8 vaza (200)" "$(preco 00000000-0000-0000-0000-000000000008)" "200"
restaura

# sanidade pós-restauração: o estado verdadeiro voltou
eq "POS-restauração prod1 voltou a 12" "$(preco 00000000-0000-0000-0000-000000000001)" "12"

echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
