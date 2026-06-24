#!/usr/bin/env bash
# HARNESS PG17 — v_caca_compradores: custo efetivo = COALESCE(custo_producao quando status='ok', NULLIF(cmc,0)).
# Migrations: 20260623120000 (coluna+view inicial) → 20260624010000 (fallback pro cmc legítimo).
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
CREATE TABLE public.profiles (user_id uuid PRIMARY KEY, name text, phone text, cnae text, document text, cnpj text, is_employee boolean);
CREATE TABLE public.sales_orders (id uuid PRIMARY KEY, account text, total numeric, order_date_kpi date, created_at timestamptz, deleted_at timestamptz, status text, customer_user_id uuid);
CREATE TABLE public.order_items (id uuid PRIMARY KEY, sales_order_id uuid, omie_codigo_produto text, product_id uuid, quantity numeric, unit_price numeric);
CREATE TABLE public.omie_products (id uuid PRIMARY KEY, account text, familia text, tipo_produto text);
CREATE TABLE public.product_costs (id uuid DEFAULT gen_random_uuid(), product_id uuid UNIQUE, cmc numeric DEFAULT 0);
CREATE TABLE public.addresses (user_id uuid, city text, state text, is_default boolean, created_at timestamptz);
SQL
echo "stubs criados"

# ── ZONA 2 — APLICAR AS MIGRATIONS REAIS, na ordem de prod (Lei #1) ──
MIG1="$REPO_ROOT/supabase/migrations/20260623120000_caca_custo_producao.sql"
MIG2="$REPO_ROOT/supabase/migrations/20260624010000_caca_custo_efetivo_fallback.sql"
P -q -f "$MIG1"
P -q -f "$MIG2"
echo "migrations aplicadas: $(basename "$MIG1") + $(basename "$MIG2")"

# ── ZONA 3 — SEED ──
# custo efetivo = COALESCE(custo_producao se status='ok', NULLIF(cmc,0)). 6 produtos:
#   A=fabricado(04) custo_producao=10 status=ok cmc=0      → 10  (recomposto vence)
#   B=comprado(00)  cmc=5                                   → 5   (comprado via cmc)
#   C=comprado(00)  cmc=0                                   → NULL (degrada: sem custo)
#   D=fabricado(04) status=missing custo_producao=NULL cmc=0 → NULL (degrada: sem recomp E sem cmc)
#   E=fabricado(04) status=erro_api custo_producao=NULL cmc=8 → 8 (FALLBACK pro cmc legítimo da OP!)
#   F=fabricado(04) status=suspeito custo_producao=999 cmc=7 → 7 (GATE: ignora o 999 stale, cai pro cmc)
P -q <<'SQL'
INSERT INTO public.profiles(user_id, name, is_employee, document) VALUES
  ('11111111-1111-1111-1111-111111111111','Cliente Teste', false, '12345678000199');
INSERT INTO public.addresses(user_id, city, state, is_default, created_at) VALUES
  ('11111111-1111-1111-1111-111111111111','Curitiba','PR', true, now());
INSERT INTO public.sales_orders(id, account, total, order_date_kpi, created_at, deleted_at, status, customer_user_id) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001','colacor', 440, current_date, now(), NULL, 'faturado','11111111-1111-1111-1111-111111111111');
INSERT INTO public.omie_products(id, account, familia, tipo_produto) VALUES
  ('dddddddd-0000-0000-0000-000000000001','colacor','Cintas Estreitas','04'),
  ('dddddddd-0000-0000-0000-000000000002','colacor','Jumbo','00'),
  ('dddddddd-0000-0000-0000-000000000003','colacor','Jumbo','00'),
  ('dddddddd-0000-0000-0000-000000000004','colacor','Cintas Estreitas','04'),
  ('dddddddd-0000-0000-0000-000000000005','colacor','Cintas Estreitas','04'),
  ('dddddddd-0000-0000-0000-000000000006','colacor','Cintas Estreitas','04');
INSERT INTO public.product_costs(product_id, cmc, custo_producao, custo_producao_status) VALUES
  ('dddddddd-0000-0000-0000-000000000001', 0, 10,  'ok'),
  ('dddddddd-0000-0000-0000-000000000002', 5, NULL, NULL),
  ('dddddddd-0000-0000-0000-000000000003', 0, NULL, NULL),
  ('dddddddd-0000-0000-0000-000000000004', 0, NULL, 'missing_component_cost'),
  ('dddddddd-0000-0000-0000-000000000005', 8, NULL, 'erro_api'),
  ('dddddddd-0000-0000-0000-000000000006', 7, 999, 'suspeito_unidade');
INSERT INTO public.order_items(id, sales_order_id, omie_codigo_produto, product_id, quantity, unit_price) VALUES
  ('11111111-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001','A','dddddddd-0000-0000-0000-000000000001', 2, 30),
  ('11111111-0000-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000001','B','dddddddd-0000-0000-0000-000000000002', 1, 20),
  ('11111111-0000-0000-0000-000000000003','aaaaaaaa-0000-0000-0000-000000000001','C','dddddddd-0000-0000-0000-000000000003', 1, 100),
  ('11111111-0000-0000-0000-000000000004','aaaaaaaa-0000-0000-0000-000000000001','D','dddddddd-0000-0000-0000-000000000004', 1, 50),
  ('11111111-0000-0000-0000-000000000005','aaaaaaaa-0000-0000-0000-000000000001','E','dddddddd-0000-0000-0000-000000000005', 1, 200),
  ('11111111-0000-0000-0000-000000000006','aaaaaaaa-0000-0000-0000-000000000001','F','dddddddd-0000-0000-0000-000000000006', 1, 10);
SQL
echo "seed pronto"

# ── ZONA 4 — ASSERTS ──
# A=10(recomp) B=5(cmc) E=8(fallback cmc) F=7(gate→cmc); C,D degradam.
#   lucro = (2*30-2*10)+(1*20-1*5)+(1*200-1*8)+(1*10-1*7) = 40+15+192+3 = 250
#   receita = 60+20+100+50+200+10 = 440 ; receita_c_custo = 60+20+200+10 = 290 → cobertura 0.66
echo "── asserts ──"
LP=$(Pq -c "SELECT lucro_proxy FROM public.v_caca_compradores LIMIT 1;")
COBV=$(Pq -c "SELECT lucro_cobertura FROM public.v_caca_compradores LIMIT 1;")
echo "    lucro_proxy=$LP  lucro_cobertura=$COBV"

A1=$(Pq -c "SELECT (lucro_proxy = 250.00) FROM public.v_caca_compradores LIMIT 1;")
eq "P1 recomposto(A=10)+comprado(B=5)+fallback(E=8)+gate(F=7) = 250" "$A1" "t"

A2=$(Pq -c "SELECT (lucro_cobertura = 0.66) FROM public.v_caca_compradores LIMIT 1;")
eq "cobertura 290/440 = 0.66 (C/D degradam; E/F recuperados via cmc)" "$A2" "t"

# Fallback (corrige a regressão do #1014): E é fabricado erro_api com cmc=8 legítimo → entra via cmc.
# Se E degradasse (view #1014), lucro cairia p/ 58. lucro=250 prova que E (e F) entraram.
A3=$(Pq -c "SELECT (lucro_proxy > 60) FROM public.v_caca_compradores LIMIT 1;")
eq "FALLBACK fabricado sem recompor mas com cmc legítimo entra (lucro>60, não 58)" "$A3" "t"

# Gate de status (P1#1): F tem custo_producao=999 mas status=suspeito → IGNORA o 999, usa cmc=7.
# Se usasse o 999, F daria lucro 10-999=-989 → lucro_proxy despencaria. lucro=250 prova o gate.
A4=$(Pq -c "SELECT (lucro_proxy = 250.00) FROM public.v_caca_compradores LIMIT 1;")
eq "GATE status≠ok ignora custo_producao stale (F usa cmc=7, não o 999)" "$A4" "t"

# ── ZONA 5 — FALSIFICAÇÃO (Lei #3): a view do #1014 (CASE tipo_produto, sem fallback) regride ──
echo "── falsificação ──"
# re-aplica a MIG1 (view com CASE tipo_produto → fabricado degradado NÃO cai pro cmc):
# E (erro_api) e F (suspeito) perdem o cmc → degradam → lucro cai p/ 55. A1 (=250) DEVE ficar vermelho.
P -q -f "$MIG1"
FBUGVAL=$(Pq -c "SELECT lucro_proxy FROM public.v_caca_compradores LIMIT 1;")
FBUG=$(Pq -c "SELECT (lucro_proxy = 250.00) FROM public.v_caca_compradores LIMIT 1;")
case "$FBUG" in
  f) ok "F1 view #1014 (sem fallback) descarta cmc de E/F → lucro $FBUGVAL≠250 (fallback tem dente)" ;;
  *) bad "F1 voltei p/ a view #1014 e A1 NÃO mudou (veio $FBUGVAL) → assert fraco" ;;
esac

# restaura a view corrigida (MIG2)
P -q -f "$MIG2"
FRES=$(Pq -c "SELECT (lucro_proxy = 250.00) FROM public.v_caca_compradores LIMIT 1;")
eq "F1b view corrigida restaurada volta a 250" "$FRES" "t"

# ── veredito ──
echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
