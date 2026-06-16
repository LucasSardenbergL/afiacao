#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  HARNESS PG17 — PROVA da migration 20260616120000_regua_preco (money-path)    ║
# ║      bash db/test-regua-preco.sh > /tmp/t.log 2>&1; echo "exit=$?"             ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5461}"
SLUG="regua-preco"
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
Pq() { P -qtA "$@"; }   # -q suprime a tag "SET" do output (senão polui o valor capturado)

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

# ════════ ZONA 1 — pré-requisitos (o que a RPC LÊ) ════════
P -q <<'SQL'
CREATE TYPE public.app_role AS ENUM ('master','employee','customer');
CREATE TABLE public.user_roles (user_id uuid, role public.app_role);
CREATE FUNCTION public.has_role(_user_id uuid, _role public.app_role) RETURNS boolean
  LANGUAGE sql STABLE AS $f$ SELECT EXISTS(SELECT 1 FROM public.user_roles WHERE user_id=_user_id AND role=_role) $f$;
CREATE TABLE public.inventory_position (product_id uuid, account text, cmc numeric);
CREATE TABLE public.company_config (id uuid DEFAULT gen_random_uuid(), key text UNIQUE, value text,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
CREATE TABLE public.sales_orders (id uuid PRIMARY KEY, account text, order_date_kpi date,
  deleted_at timestamptz, customer_user_id uuid);
CREATE TABLE public.order_items (id uuid DEFAULT gen_random_uuid(), customer_user_id uuid,
  product_id uuid, quantity numeric, unit_price numeric, sales_order_id uuid);
SQL

# ════════ ZONA 2 — aplicar a migration REAL ════════
MIG="$REPO_ROOT/supabase/migrations/20260616120000_regua_preco.sql"
P -q -f "$MIG"
echo "migration aplicada: $(basename "$MIG")"

# ════════ ZONA 3 — seeds + grants ════════
P -q <<'SQL'
INSERT INTO public.user_roles VALUES
  ('33333333-3333-3333-3333-333333333333','employee'),
  ('44444444-4444-4444-4444-444444444444','customer');
UPDATE public.company_config SET value='0.20' WHERE key='regua_preco_aliquota_venda_oben';  -- piso = cmc/0.8
INSERT INTO public.inventory_position VALUES ('22222222-2222-2222-2222-222222222222','oben',100);
INSERT INTO public.sales_orders (id, account, order_date_kpi, deleted_at, customer_user_id) VALUES
  ('a0000000-0000-0000-0000-000000000001','oben',  current_date-10, NULL,  '11111111-1111-1111-1111-111111111111'),
  ('a0000000-0000-0000-0000-000000000002','oben',  current_date-40, NULL,  '11111111-1111-1111-1111-111111111111'),
  ('c0000000-0000-0000-0000-000000000001','oben',  current_date-10, NULL,  '55555555-5555-5555-5555-555555550001'),
  ('c0000000-0000-0000-0000-000000000002','oben',  current_date-10, NULL,  '55555555-5555-5555-5555-555555550002'),
  ('c0000000-0000-0000-0000-000000000003','oben',  current_date-10, NULL,  '55555555-5555-5555-5555-555555550003'),
  ('c0000000-0000-0000-0000-000000000004','oben',  current_date-10, NULL,  '55555555-5555-5555-5555-555555550004'),
  ('c0000000-0000-0000-0000-000000000005','oben',  current_date-400,NULL,  '55555555-5555-5555-5555-555555550005'),
  ('c0000000-0000-0000-0000-000000000006','colacor',current_date-10,NULL,  '55555555-5555-5555-5555-555555550006'),
  ('c0000000-0000-0000-0000-000000000007','oben',  current_date-10, now(), '55555555-5555-5555-5555-555555550007');
-- produto P=222... em todos. CA paga 130/128; C1..C3 válidos (120/122/124); armadilhas 888/777/666/555.
INSERT INTO public.order_items (customer_user_id, product_id, quantity, unit_price, sales_order_id) VALUES
  ('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222', 10,130,'a0000000-0000-0000-0000-000000000001'),
  ('11111111-1111-1111-1111-111111111111','22222222-2222-2222-2222-222222222222', 10,128,'a0000000-0000-0000-0000-000000000002'),
  ('55555555-5555-5555-5555-555555550001','22222222-2222-2222-2222-222222222222', 10,120,'c0000000-0000-0000-0000-000000000001'),
  ('55555555-5555-5555-5555-555555550002','22222222-2222-2222-2222-222222222222', 10,122,'c0000000-0000-0000-0000-000000000002'),
  ('55555555-5555-5555-5555-555555550003','22222222-2222-2222-2222-222222222222', 12,124,'c0000000-0000-0000-0000-000000000003'),
  ('55555555-5555-5555-5555-555555550004','22222222-2222-2222-2222-222222222222',100,888,'c0000000-0000-0000-0000-000000000004'),
  ('55555555-5555-5555-5555-555555550005','22222222-2222-2222-2222-222222222222', 10,777,'c0000000-0000-0000-0000-000000000005'),
  ('55555555-5555-5555-5555-555555550006','22222222-2222-2222-2222-222222222222', 10,666,'c0000000-0000-0000-0000-000000000006'),
  ('55555555-5555-5555-5555-555555550007','22222222-2222-2222-2222-222222222222', 10,555,'c0000000-0000-0000-0000-000000000007');
GRANT SELECT, INSERT ON public.regua_preco_log TO authenticated, anon;
GRANT SELECT ON public.user_roles TO authenticated, anon;
SQL

# ════════ ZONA 4 — asserts ════════
echo "── asserts ──"
S="33333333-3333-3333-3333-333333333333"  # staff uid
CA="11111111-1111-1111-1111-111111111111"; PR="22222222-2222-2222-2222-222222222222"
# helper: preço $1 está em comparaveis? (chamada como staff)
has_price() { Pq -c "SET test.uid='$S'; SELECT EXISTS(SELECT 1 FROM jsonb_array_elements((public.get_regua_preco('$CA'::uuid,'$PR'::uuid,10))->'comparaveis') e WHERE (e->>'preco')::numeric=$1);"; }

eq "P1 piso_mc = cmc/(1-0.20) = 125" "$(Pq -c "SET test.uid='$S'; SELECT ((public.get_regua_preco('$CA'::uuid,'$PR'::uuid,10))->>'piso_mc')::numeric = 125;")" "t"
eq "P2 cmc = 100, confiavel"          "$(Pq -c "SET test.uid='$S'; SELECT ((public.get_regua_preco('$CA'::uuid,'$PR'::uuid,10))->>'cmc')::numeric=100 AND ((public.get_regua_preco('$CA'::uuid,'$PR'::uuid,10))->>'cmc_confiavel')::boolean;")" "t"
eq "P3a comparáveis tem 120"  "$(has_price 120)" "t"
eq "P3b comparáveis tem 122"  "$(has_price 122)" "t"
eq "P3c comparáveis tem 124 (qty 12 dentro da banda)" "$(has_price 124)" "t"
eq "P4 leave-one-out: preço do CA (130) NÃO entra" "$(has_price 130)" "f"
eq "P5 banda qty: 888 (qty 100) fora"              "$(has_price 888)" "f"
eq "P6 janela 180d: 777 (pedido antigo) fora"      "$(has_price 777)" "f"
eq "P7 account: 666 (colacor) fora"                "$(has_price 666)" "f"
eq "P8 deletado: 555 fora"                         "$(has_price 555)" "f"
eq "P9 precos_cliente tem 130 (do próprio CA)" "$(Pq -c "SET test.uid='$S'; SELECT EXISTS(SELECT 1 FROM jsonb_array_elements((public.get_regua_preco('$CA'::uuid,'$PR'::uuid,10))->'precos_cliente') e WHERE e::numeric=130);")" "t"

# N1 — gate barra não-staff (customer) com 42501 (sentinela anti-teatro 'GATEBARROU' ≠ texto do código)
R=$(P -tA 2>&1 <<'SQL' || true
SET test.uid='44444444-4444-4444-4444-444444444444';
DO $$
BEGIN
  PERFORM public.get_regua_preco('11111111-1111-1111-1111-111111111111'::uuid,'22222222-2222-2222-2222-222222222222'::uuid,10);
  RAISE EXCEPTION 'XGATEFUROUX';
EXCEPTION
  WHEN insufficient_privilege THEN RAISE NOTICE 'GATEBARROU';
  WHEN OTHERS THEN RAISE;
END $$;
SQL
)
case "$R" in *GATEBARROU*) ok "N1 gate barra customer (42501)";; *) bad "N1 gate furado — [$R]";; esac

# RLS do log: staff insere e lê; customer não lê
P -q -c "SET test.uid='$S'; SET ROLE authenticated; INSERT INTO public.regua_preco_log (account,customer_user_id,product_id,preco_atual,sinal_exibido,confianca) VALUES ('oben','$CA','$PR',106,'piso','alta');"
eq "L1 staff lê o próprio log"  "$(Pq -c "SET test.uid='$S'; SET ROLE authenticated; SELECT count(*) FROM public.regua_preco_log;" | tail -1)" "1"
eq "L2 customer NÃO lê o log"   "$(Pq -c "SET test.uid='44444444-4444-4444-4444-444444444444'; SET ROLE authenticated; SELECT count(*) FROM public.regua_preco_log;" | tail -1)" "0"

# ════════ ZONA 5 — falsificação (sabota → exige vermelho → restaura) ════════
echo "── falsificação ──"
# F1 — sabota o leave-one-out (remove o filtro <> p_customer): CA (130) DEVE passar a aparecer
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.get_regua_preco(p_customer uuid, p_product uuid, p_qty numeric)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_comparaveis jsonb; v_lo numeric := COALESCE(p_qty,0)*0.5; v_hi numeric := COALESCE(p_qty,0)*2;
BEGIN
  IF NOT (public.has_role(auth.uid(),'employee') OR public.has_role(auth.uid(),'master')) THEN
    RAISE EXCEPTION 'forbidden' USING ERRCODE='42501'; END IF;
  WITH base AS (
    SELECT oi.unit_price, dense_rank() OVER (ORDER BY oi.customer_user_id) c_ord
      FROM public.order_items oi JOIN public.sales_orders so ON so.id=oi.sales_order_id
     WHERE so.account='oben' AND so.deleted_at IS NULL AND oi.product_id=p_product
       AND oi.unit_price>0 AND oi.quantity BETWEEN v_lo AND v_hi
       AND so.order_date_kpi >= current_date - interval '180 days')  -- SABOTADO: sem "<> p_customer"
  SELECT jsonb_agg(jsonb_build_object('preco',unit_price,'c',c_ord)) INTO v_comparaveis FROM base;
  RETURN jsonb_build_object('comparaveis', COALESCE(v_comparaveis,'[]'::jsonb));
END $$;
SQL
if [ "$(has_price 130)" = "t" ]; then ok "F1 leave-one-out sabotado → CA 130 aparece (assert P4 tem dente)"; else bad "F1 sabotagem não detectada → P4 é teatro"; fi
P -q -f "$MIG"  # restaura a versão verdadeira
eq "F1b restaurado → CA 130 some de novo" "$(has_price 130)" "f"

# F2 — sabota a RLS (policy USING(true)): customer passa a ler
P -q <<'SQL'
DROP POLICY regua_preco_log_staff_all ON public.regua_preco_log;
CREATE POLICY p_furada ON public.regua_preco_log FOR ALL TO authenticated USING (true) WITH CHECK (true);
SQL
CL=$(Pq -c "SET test.uid='44444444-4444-4444-4444-444444444444'; SET ROLE authenticated; SELECT count(*) FROM public.regua_preco_log;" | tail -1)
if [ "$CL" = "1" ]; then ok "F2 RLS furada → customer lê (assert L2 tem dente)"; else bad "F2 sabotagem RLS não detectada → L2 é teatro"; fi
P -q <<'SQL'
DROP POLICY p_furada ON public.regua_preco_log;
SQL
P -q -f "$MIG"  # restaura a policy verdadeira
eq "F2b restaurado → customer não lê de novo" "$(Pq -c "SET test.uid='44444444-4444-4444-4444-444444444444'; SET ROLE authenticated; SELECT count(*) FROM public.regua_preco_log;" | tail -1)" "0"

# ── veredito ──
echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
