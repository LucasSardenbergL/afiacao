#!/usr/bin/env bash
# HARNESS PG17 — prova v_caca_compradores com custo efetivo tipo_produto-aware + status-aware.
# Migration: supabase/migrations/20260623120000_caca_custo_producao.sql
# Rode:  bash db/test-caca-custo-producao.sh > /tmp/t.log 2>&1; echo "exit=$?"
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5466}"
SLUG="caca-custo-producao"
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

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

echo "═══ setup PG17 :$PORT ═══"

# ── ZONA 1 — pré-requisitos: tabelas que a view LÊ + product_costs pré-ALTER (só product_id, cmc) ──
P -q <<'SQL'
CREATE TABLE public.profiles (
  user_id uuid PRIMARY KEY, name text, phone text, cnae text,
  document text, cnpj text, is_employee boolean
);
CREATE TABLE public.sales_orders (
  id uuid PRIMARY KEY, account text, total numeric,
  order_date_kpi date, created_at timestamptz, deleted_at timestamptz,
  status text, customer_user_id uuid
);
CREATE TABLE public.order_items (
  id uuid PRIMARY KEY, sales_order_id uuid, omie_codigo_produto text,
  product_id uuid, quantity numeric, unit_price numeric
);
CREATE TABLE public.omie_products (
  id uuid PRIMARY KEY, account text, familia text, tipo_produto text
);
CREATE TABLE public.product_costs (
  id uuid DEFAULT gen_random_uuid(), product_id uuid UNIQUE, cmc numeric DEFAULT 0
);
CREATE TABLE public.addresses (
  user_id uuid, city text, state text, is_default boolean, created_at timestamptz
);
SQL
echo "stubs criados"

# ── ZONA 2 — APLICAR A MIGRATION REAL (Lei #1) ──
MIG="$REPO_ROOT/supabase/migrations/20260623120000_caca_custo_producao.sql"
P -q -f "$MIG"
echo "migration aplicada: $(basename "$MIG")"

# ── ZONA 3 — SEED ──
# 1 cliente + 1 pedido colacor. 5 produtos:
#   A=fabricado(04) custo_producao=10 status=ok cmc=0           → custo_efetivo 10  (entra via custo_producao)
#   B=comprado(00)  cmc=5                                        → custo_efetivo 5   (entra via cmc)
#   C=comprado(00)  cmc=0                                        → custo_efetivo NULL (degrada)
#   D=fabricado(04) custo_producao=NULL status=missing cmc=0     → custo_efetivo NULL (degrada)
#   E=fabricado(04) custo_producao=NULL status=erro_api cmc=99   → custo_efetivo NULL (NÃO usa o cmc 99 espúrio!)
P -q <<'SQL'
INSERT INTO public.profiles(user_id, name, is_employee, document) VALUES
  ('11111111-1111-1111-1111-111111111111','Cliente Teste', false, '12345678000199');
INSERT INTO public.addresses(user_id, city, state, is_default, created_at) VALUES
  ('11111111-1111-1111-1111-111111111111','Curitiba','PR', true, now());
INSERT INTO public.sales_orders(id, account, total, order_date_kpi, created_at, deleted_at, status, customer_user_id) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001','colacor', 430, current_date, now(), NULL, 'faturado','11111111-1111-1111-1111-111111111111');
INSERT INTO public.omie_products(id, account, familia, tipo_produto) VALUES
  ('dddddddd-0000-0000-0000-000000000001','colacor','Cintas Estreitas','04'),
  ('dddddddd-0000-0000-0000-000000000002','colacor','Jumbo','00'),
  ('dddddddd-0000-0000-0000-000000000003','colacor','Jumbo','00'),
  ('dddddddd-0000-0000-0000-000000000004','colacor','Cintas Estreitas','04'),
  ('dddddddd-0000-0000-0000-000000000005','colacor','Cintas Estreitas','04');
INSERT INTO public.product_costs(product_id, cmc, custo_producao, custo_producao_status) VALUES
  ('dddddddd-0000-0000-0000-000000000001', 0,  10,   'ok'),
  ('dddddddd-0000-0000-0000-000000000002', 5,  NULL, NULL),
  ('dddddddd-0000-0000-0000-000000000003', 0,  NULL, NULL),
  ('dddddddd-0000-0000-0000-000000000004', 0,  NULL, 'missing_component_cost'),
  ('dddddddd-0000-0000-0000-000000000005', 99, NULL, 'erro_api');
INSERT INTO public.order_items(id, sales_order_id, omie_codigo_produto, product_id, quantity, unit_price) VALUES
  ('11111111-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001','A','dddddddd-0000-0000-0000-000000000001', 2, 30),
  ('11111111-0000-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000001','B','dddddddd-0000-0000-0000-000000000002', 1, 20),
  ('11111111-0000-0000-0000-000000000003','aaaaaaaa-0000-0000-0000-000000000001','C','dddddddd-0000-0000-0000-000000000003', 1, 100),
  ('11111111-0000-0000-0000-000000000004','aaaaaaaa-0000-0000-0000-000000000001','D','dddddddd-0000-0000-0000-000000000004', 1, 50),
  ('11111111-0000-0000-0000-000000000005','aaaaaaaa-0000-0000-0000-000000000001','E','dddddddd-0000-0000-0000-000000000005', 1, 200);
SQL
echo "seed pronto"

# ── ZONA 4 — ASSERTS ──
# Esperado: A entra (10 via custo_producao), B entra (5 via cmc), C/D/E degradam.
#   lucro_com_custo = (2*30-2*10) + (1*20-1*5) = 40 + 15 = 55
#   receita         = 60 + 20 + 100 + 50 + 200 = 430
#   receita_c_custo = 60 + 20 = 80  → cobertura = round(80/430,2) = 0.19
echo "── asserts ──"
LP=$(Pq -c "SELECT lucro_proxy FROM public.v_caca_compradores LIMIT 1;")
COBV=$(Pq -c "SELECT lucro_cobertura FROM public.v_caca_compradores LIMIT 1;")
echo "    lucro_proxy=$LP  lucro_cobertura=$COBV"

A1=$(Pq -c "SELECT (lucro_proxy = 55.00) FROM public.v_caca_compradores LIMIT 1;")
eq "P1+P2 fabricado(custo_producao,status=ok) + comprado(cmc) = 55" "$A1" "t"

A2=$(Pq -c "SELECT (lucro_cobertura = 0.19) FROM public.v_caca_compradores LIMIT 1;")
eq "N C/D/E degradam → cobertura 80/430 = 0.19" "$A2" "t"

# P1#2 (Codex): E é fabricado degradado COM cmc=99 espúrio. Se a view caísse para cmc, E entraria
# (lucro subiria p/ 156). lucro=55 prova que fabricado degradado NÃO usa o cmc.
A3=$(Pq -c "SELECT (lucro_proxy < 100) FROM public.v_caca_compradores LIMIT 1;")
eq "P1#2 fabricado degradado (cmc=99 espúrio) NÃO cai pra cmc (lucro<100)" "$A3" "t"

# Gate de status: muda A p/ status≠ok → A degrada → lucro cai p/ só B (15). Prova que custo_producao
# só conta quando status='ok' (cobre o caso erro_api/stale).
P -q -c "UPDATE public.product_costs SET custo_producao_status='suspeito_unidade' WHERE product_id='dddddddd-0000-0000-0000-000000000001';" >/dev/null
A4=$(Pq -c "SELECT (lucro_proxy = 15.00) FROM public.v_caca_compradores LIMIT 1;")
eq "P1#1 status≠ok degrada o fabricado (custo_producao válido mas status suspeito → fora; lucro 15)" "$A4" "t"
P -q -c "UPDATE public.product_costs SET custo_producao_status='ok' WHERE product_id='dddddddd-0000-0000-0000-000000000001';" >/dev/null

# Comprado NÃO regride: B sempre entra via cmc (independe de custo_producao/status).
REGB=$(Pq -c "SELECT (lucro_proxy = 55.00) FROM public.v_caca_compradores LIMIT 1;")
eq "P3 comprado intacto após restaurar A (lucro volta a 55)" "$REGB" "t"

# ── ZONA 5 — FALSIFICAÇÃO (Lei #3): a view GENÉRICA (sem tipo/status) deixa o cmc espúrio vazar ──
echo "── falsificação ──"
# sabota: custo_efetivo = COALESCE(custo_producao, NULLIF(cmc,0)) [genérico, sem CASE tipo/status].
# Com isso E (custo_producao NULL, cmc 99) → 99 entra → lucro sobe p/ 156. A1 (=55) DEVE ficar vermelho.
P -q <<'SQL'
CREATE OR REPLACE VIEW public.v_caca_compradores AS
 WITH cli AS (
         SELECT p.user_id, p.name, p.phone, p.cnae,
                CASE
                    WHEN length(regexp_replace(COALESCE(p.document, ''::text), '\D'::text, ''::text, 'g'::text)) = ANY (ARRAY[11, 14]) THEN regexp_replace(COALESCE(p.document, ''::text), '\D'::text, ''::text, 'g'::text)
                    WHEN length(regexp_replace(COALESCE(p.cnpj, ''::text), '\D'::text, ''::text, 'g'::text)) = ANY (ARRAY[11, 14]) THEN regexp_replace(COALESCE(p.cnpj, ''::text), '\D'::text, ''::text, 'g'::text)
                    ELSE NULL::text
                END AS documento
           FROM profiles p WHERE COALESCE(p.is_employee, false) = false
        ), cli_valid AS (
         SELECT DISTINCT ON (cli.user_id) cli.user_id, cli.documento, cli.name, cli.phone, cli.cnae
           FROM cli WHERE cli.documento IS NOT NULL ORDER BY cli.user_id, cli.documento
        ), cli_doc AS (
         SELECT DISTINCT ON (cli_valid.documento) cli_valid.documento, cli_valid.user_id, cli_valid.name, cli_valid.phone, cli_valid.cnae
           FROM cli_valid ORDER BY cli_valid.documento, cli_valid.user_id
        ), so_ok AS (
         SELECT so.id, so.account, so.total, COALESCE(so.order_date_kpi, so.created_at::date) AS dt, cv.documento
           FROM sales_orders so JOIN cli_valid cv ON cv.user_id = so.customer_user_id
          WHERE so.deleted_at IS NULL AND (so.status <> ALL (ARRAY['cancelado'::text, 'rascunho'::text])) AND (so.account = ANY (ARRAY['oben'::text, 'colacor'::text]))
        ), compras AS (
         SELECT so_ok.documento, so_ok.account, count(*) AS n_pedidos, sum(so_ok.total) AS volume, max(so_ok.dt) AS ultima
           FROM so_ok GROUP BY so_ok.documento, so_ok.account
        ), oi_dedup AS (
         SELECT DISTINCT ON (oi.sales_order_id, oi.omie_codigo_produto) oi.sales_order_id, oi.product_id, oi.quantity, oi.unit_price
           FROM order_items oi ORDER BY oi.sales_order_id, oi.omie_codigo_produto, oi.id
        ), itens AS (
         SELECT s.documento, s.account, d.quantity, d.unit_price, op.familia,
            COALESCE(pc.custo_producao, NULLIF(pc.cmc, 0::numeric)) AS custo_efetivo   -- GENÉRICO (bug): ignora tipo/status
           FROM so_ok s
             JOIN oi_dedup d ON d.sales_order_id = s.id
             JOIN omie_products op ON op.id = d.product_id AND op.account = s.account
             LEFT JOIN product_costs pc ON pc.product_id = op.id
        ), fam AS (
         SELECT itens.documento, itens.account, array_agg(DISTINCT itens.familia) FILTER (WHERE itens.familia IS NOT NULL AND itens.familia <> ''::text) AS familias
           FROM itens GROUP BY itens.documento, itens.account
        ), luc AS (
         SELECT itens.documento, itens.account,
            sum(itens.quantity * itens.unit_price - itens.quantity * itens.custo_efetivo) FILTER (WHERE itens.custo_efetivo > 0::numeric) AS lucro_com_custo,
            sum(itens.quantity * itens.unit_price) AS receita,
            sum(itens.quantity * itens.unit_price) FILTER (WHERE itens.custo_efetivo > 0::numeric) AS receita_com_custo
           FROM itens GROUP BY itens.documento, itens.account
        ), cid AS (
         SELECT DISTINCT ON (addresses.user_id) addresses.user_id, (addresses.city || '-'::text) || addresses.state AS cidade_uf
           FROM addresses WHERE COALESCE(addresses.city, ''::text) <> ''::text AND COALESCE(addresses.state, ''::text) <> ''::text
          ORDER BY addresses.user_id, addresses.is_default DESC NULLS LAST, addresses.created_at DESC NULLS LAST
        )
 SELECT c.documento, c.account AS empresa, cid.cidade_uf, cd.cnae AS ramo,
        CASE WHEN c.n_pedidos > 0 THEN round(c.volume / c.n_pedidos::numeric, 2) ELSE NULL::numeric END AS ticket_faixa,
    COALESCE(f.familias, ARRAY[]::text[]) AS familias, c.volume, c.n_pedidos, now()::date - c.ultima AS recencia_dias,
        CASE WHEN l.lucro_com_custo IS NOT NULL THEN round(l.lucro_com_custo, 2) ELSE NULL::numeric END AS lucro_proxy,
        CASE WHEN COALESCE(l.receita, 0::numeric) > 0::numeric THEN round(COALESCE(l.receita_com_custo, 0::numeric) / l.receita, 2) ELSE 0::numeric END AS lucro_cobertura
   FROM compras c
     JOIN cli_doc cd ON cd.documento = c.documento
     LEFT JOIN fam f ON f.documento = c.documento AND f.account = c.account
     LEFT JOIN luc l ON l.documento = c.documento AND l.account = c.account
     LEFT JOIN cid ON cid.user_id = cd.user_id;
SQL
FBUGVAL=$(Pq -c "SELECT lucro_proxy FROM public.v_caca_compradores LIMIT 1;")
FBUG=$(Pq -c "SELECT (lucro_proxy = 55.00) FROM public.v_caca_compradores LIMIT 1;")
case "$FBUG" in
  f) ok "F1 view genérica deixa cmc=99 espúrio do fabricado E vazar → lucro $FBUGVAL≠55 (tipo/status tem dente)" ;;
  *) bad "F1 sabotei p/ genérico e A1 NÃO mudou (veio $FBUGVAL) → assert fraco" ;;
esac

P -q -f "$MIG" >/dev/null
FRES=$(Pq -c "SELECT (lucro_proxy = 55.00) FROM public.v_caca_compradores LIMIT 1;")
eq "F1b view correta restaurada volta a 55" "$FRES" "t"

# ── veredito ──
echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
