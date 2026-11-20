#!/usr/bin/env bash
# PROVA PG17 — meta_potencial (migration 20261120230000): gate master, congelamento só a partir do dia 3,
# mês congelado não recalcula, segmentos exclusivos com recência primeiro, calibração ausente → meta NULL,
# sensor de visualização, dias úteis pelo calendário de operação, ACL fechada ao JWT. EXECUTA as funções.
# bash db/test-meta-potencial.sh > /tmp/t.log 2>&1; echo "exit=$?"
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5473}"
SLUG="meta-potencial"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL="${LC_ALL:-C}" LANG="${LANG:-C}"
MIG="${MIG_META:-$REPO_ROOT/supabase/migrations/20261120230000_meta_potencial.sql}"

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER}"; exit 1; }
CELLAR="$(brew --prefix "postgresql@${PGVER}")"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "/tmp/pg-${SLUG}.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
P()  { "$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }

P -q -f "$REPO_ROOT/db/stubs-supabase.sql"

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

MASTER=00000000-0000-0000-0000-00000000000a
REGINA=00000000-0000-0000-0000-00000000000b
LUCAS=00000000-0000-0000-0000-00000000000e
CLIENTE=00000000-0000-0000-0000-00000000000c
A1=10000000-0000-0000-0000-000000000001
X1=10000000-0000-0000-0000-000000000002
D1=10000000-0000-0000-0000-000000000003
PROD=20000000-0000-0000-0000-000000000001
PROD2=20000000-0000-0000-0000-000000000002

# ── pré-req: schema mínimo como na PROD ──
P -q <<SQL
CREATE TYPE public.app_role AS ENUM ('master', 'employee', 'customer');
CREATE TABLE public.user_roles (user_id uuid NOT NULL, role public.app_role NOT NULL);
CREATE FUNCTION public.has_role(_user_id uuid, _role public.app_role) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
  AS \$\$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) \$\$;
INSERT INTO public.user_roles VALUES ('$MASTER', 'master'), ('$REGINA', 'employee'), ('$CLIENTE', 'customer');
CREATE TABLE public.profiles (user_id uuid, name text);
INSERT INTO public.profiles VALUES ('$REGINA', 'Regina');
CREATE TABLE public.sales_orders (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_user_id uuid, account text,
  total numeric, status text, deleted_at timestamptz, order_date_kpi date, vendedor_user_id uuid);
CREATE TABLE public.omie_products (id uuid PRIMARY KEY, familia text);
CREATE TABLE public.order_items (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), sales_order_id uuid, product_id uuid,
  quantity numeric, unit_price numeric, desconto_valor numeric);
CREATE TABLE public.carteira_assignments (customer_user_id uuid UNIQUE, owner_user_id uuid, eligible boolean);
CREATE TABLE public.calendario_operacao_empresa (data date, empresa text, status text, peso numeric);
INSERT INTO public.calendario_operacao_empresa VALUES ('2026-11-02', 'OBEN', 'fechado', 0), ('2026-11-20', 'OBEN', 'fechado', 0);
INSERT INTO public.omie_products VALUES ('$PROD', 'Catalisadores PU'), ('$PROD2', 'Diluente PU');
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;

-- A1 (Regina): R\$ 1000 todo mês desde 2024-11 → A, base 1000.
INSERT INTO public.sales_orders (customer_user_id, account, total, status, order_date_kpi, vendedor_user_id)
SELECT '$A1', 'oben', 1000, 'faturado', (m + interval '9 days')::date, '$REGINA'
FROM generate_series('2024-11-01'::date, '2026-10-01'::date, interval '1 month') m;
-- X1 (Regina): comprou mai–ago/2026 (4 de 6 meses) e parou em 15/08 → 78 dias no corte = C (recência manda).
INSERT INTO public.sales_orders (customer_user_id, account, total, status, order_date_kpi, vendedor_user_id)
SELECT '$X1', 'oben', 600, 'faturado', (m + interval '14 days')::date, '$REGINA'
FROM generate_series('2026-05-01'::date, '2026-08-01'::date, interval '1 month') m;
-- D1 (Regina): 1 pedido em 10/04/2026 → 205 dias = D.
INSERT INTO public.sales_orders (customer_user_id, account, total, status, order_date_kpi, vendedor_user_id)
VALUES ('$D1', 'oben', 2000, 'faturado', '2026-04-10', '$REGINA');
-- Pedido inválido (orçamento) do A1 em out: não pode entrar em nada.
INSERT INTO public.sales_orders (customer_user_id, account, total, status, order_date_kpi, vendedor_user_id)
VALUES ('$A1', 'oben', 50000, 'orcamento', '2026-10-20', '$REGINA');
-- População de calibração (Lucas): 30 clientes comprando a cada 3 ou 7 meses desde 2024-11 → C/D com retorno.
INSERT INTO public.sales_orders (customer_user_id, account, total, status, order_date_kpi, vendedor_user_id)
SELECT ('30000000-0000-0000-0000-' || lpad(i::text, 12, '0'))::uuid, 'oben', 500, 'faturado', (m + interval '4 days')::date, '$LUCAS'
FROM generate_series(1, 30) i, generate_series('2024-11-01'::date, '2026-10-01'::date, interval '1 month') m
WHERE (extract(year FROM m) * 12 + extract(month FROM m) + i)::int % (CASE WHEN i <= 15 THEN 3 ELSE 7 END) = 0;
-- Estreias de família: a população compra Diluente até abr/2026 e passa a comprar Catalisador a partir de mai
-- → cada cliente estreia Catalisador 1x no semestre (30 estreias ≥ 20 do mínimo).
INSERT INTO public.order_items (sales_order_id, product_id, quantity, unit_price)
SELECT o.id, CASE WHEN o.order_date_kpi >= '2026-05-01' THEN '$PROD' ELSE '$PROD2' END::uuid, 1, 200
FROM public.sales_orders o WHERE o.vendedor_user_id = '$LUCAS';
-- Colacor só com 5 meses de história → calibração ausente → meta NULL (ausente ≠ zero).
INSERT INTO public.sales_orders (customer_user_id, account, total, status, order_date_kpi, vendedor_user_id)
SELECT '40000000-0000-0000-0000-000000000001', 'colacor', 300, 'faturado', (m + interval '3 days')::date, '$REGINA'
FROM generate_series('2026-06-01'::date, '2026-10-01'::date, interval '1 month') m;
-- Colacor: 1 cliente que comprou 1x em jun/2026 → C em só 3 cortes (< 6) → taxa_c tem de ficar NULL.
INSERT INTO public.sales_orders (customer_user_id, account, total, status, order_date_kpi, vendedor_user_id)
VALUES ('40000000-0000-0000-0000-000000000002', 'colacor', 800, 'faturado', '2026-06-05', '$REGINA');
INSERT INTO public.carteira_assignments VALUES ('$A1', '$REGINA', true), ('$X1', '$REGINA', true), ('$D1', '$REGINA', true),
  ('40000000-0000-0000-0000-000000000001', '$REGINA', true);
SQL

P -q -f "$MIG"
P -q -f "$MIG"   # idempotente: re-colar não pode quebrar
ok "migration aplica 2x sem erro"

# ── segmentos exclusivos, recência primeiro ──
eq "A1 = A" "$(Pq -c "SELECT segmento FROM public._meta_potencial_clientes('2026-11-01') WHERE customer_user_id='$A1'")" "A"
eq "X1 (4/6 meses, parado 78d) = C" "$(Pq -c "SELECT segmento FROM public._meta_potencial_clientes('2026-11-01') WHERE customer_user_id='$X1'")" "C"
eq "D1 = D" "$(Pq -c "SELECT segmento FROM public._meta_potencial_clientes('2026-11-01') WHERE customer_user_id='$D1'")" "D"
eq "orçamento fora do universo (A1 rev6 = 6000)" "$(Pq -c "SELECT rev6::int FROM public._meta_potencial_clientes('2026-11-01') WHERE customer_user_id='$A1'")" "6000"

# ── dia 2: provisória, nada gravado ──
eq "dia 2 → provisória" "$(Pq -c "SELECT public._meta_potencial_mes_em('2026-11-02', '$MASTER') ->> 'status'")" "provisoria"
eq "dia 2 não grava" "$(Pq -c "SELECT count(*) FROM public.meta_potencial_mensal")" "0"
eq "provisória já traz a linha da Regina" \
  "$(Pq -c "SELECT count(*) FROM jsonb_array_elements(public._meta_potencial_mes_em('2026-11-02', NULL) -> 'linhas') l WHERE l->>'owner_user_id' = '$REGINA' AND l->>'account'='oben'")" "1"

# ── dia 3: congela ──
eq "dia 3 → congelada" "$(Pq -c "SELECT public._meta_potencial_mes_em('2026-11-03', '$MASTER') ->> 'status'")" "congelada"
R() { echo "SELECT $1 FROM public.meta_potencial_mensal WHERE mes='2026-11-01' AND account='oben' AND owner_user_id='$REGINA'"; }
eq "base Regina = 1000 (só A+B)" "$(Pq -c "$(R 'base::int')")" "1000"
eq "inc_c = 10% × 600" "$(Pq -c "$(R 'inc_c')")" "60.00"
eq "inc_d = 5% × 2000" "$(Pq -c "$(R 'inc_d')")" "100.00"
eq "contagens A/B/C/D" "$(Pq -c "$(R "n_a||'/'||n_b||'/'||n_c||'/'||n_d")")" "1/0/1/1"
eq "taxas, índice e estreia calibrados (não nulos)" "$(Pq -c "$(R '(taxa_c IS NOT NULL AND taxa_d IS NOT NULL AND indice_sazonal IS NOT NULL AND inc_cross IS NOT NULL)::text')")" "true"
eq "meta = soma × índice" "$(Pq -c "$(R '(meta = round((base+esp_c+esp_d+novos+inc_c+inc_d+inc_b+inc_cross)*indice_sazonal,2))::text')")" "true"
eq "Regina ativa" "$(Pq -c "$(R 'owner_ativo::text')")" "true"
eq "Colacor sem histórico → meta NULL" "$(Pq -c "SELECT count(*) FILTER (WHERE meta IS NULL)||'/'||count(*) FROM public.meta_potencial_mensal WHERE account='colacor'")" "2/2"
eq "Colacor: C em < 6 cortes → taxa_c NULL" "$(Pq -c "SELECT count(*) FILTER (WHERE taxa_c IS NULL) FROM public.meta_potencial_mensal WHERE account='colacor'")" "2"
eq "carteira congelada (3 da Regina na oben)" "$(Pq -c "SELECT count(*) FROM public.meta_potencial_carteira WHERE account='oben' AND owner_user_id='$REGINA'")" "3"

# ── congelada não recalcula (sync tardio de outubro) e realizado é vivo ──
META1="$(Pq -c "$(R 'meta')")"
Pq -c "INSERT INTO public.sales_orders (customer_user_id, account, total, status, order_date_kpi, vendedor_user_id)
       VALUES ('$A1', 'oben', 99999, 'faturado', '2026-10-25', '$REGINA'), ('$A1', 'oben', 500, 'faturado', '2026-11-05', '$REGINA')" >/dev/null
J="$(Pq -c "SELECT public._meta_potencial_mes_em('2026-11-06', '$MASTER')")"
eq "meta não muda após pedido tardio" "$(Pq -c "$(R 'meta')")" "$META1"
eq "realizado vivo da Regina = 500" "$(Pq -c "SELECT (l->>'realizado')::numeric::int FROM jsonb_array_elements('$J'::jsonb -> 'linhas') l WHERE l->>'owner_user_id'='$REGINA' AND l->>'account'='oben'")" "500"
eq "nome da dona" "$(Pq -c "SELECT l->>'owner_nome' FROM jsonb_array_elements('$J'::jsonb -> 'linhas') l WHERE l->>'owner_user_id'='$REGINA' AND l->>'account'='oben'")" "Regina"
eq "1 linha por conta×dono (Regina + sem dono)" "$(Pq -c "SELECT count(*) FROM public.meta_potencial_mensal WHERE account='oben'")" "2"

# ── dias úteis (nov/2026: 21 dias seg–sex, OBEN fecha 02 e 20) ──
eq "dias úteis oben total" "$(Pq -c "SELECT '$J'::jsonb -> 'dias_uteis' -> 'oben' ->> 'total'")" "19"
eq "dias úteis oben restantes em 06/11" "$(Pq -c "SELECT '$J'::jsonb -> 'dias_uteis' -> 'oben' ->> 'restantes'")" "16"
eq "colacor sem exceção: 21" "$(Pq -c "SELECT '$J'::jsonb -> 'dias_uteis' -> 'colacor' ->> 'total'")" "21"
eq "grupo: aberto se alguma conta abre" "$(Pq -c "SELECT '$J'::jsonb -> 'dias_uteis_grupo' ->> 'total'")" "21"

# ── sensor ──
Pq -c "SELECT public._meta_potencial_mes_em('2026-11-06', '$MASTER')" >/dev/null
eq "sensor: 2 aberturas no dia 06" "$(Pq -c "SELECT n FROM public.meta_potencial_visualizacao WHERE dia='2026-11-06' AND user_id='$MASTER'")" "2"
eq "sensor: dias distintos" "$(Pq -c "SELECT count(*) FROM public.meta_potencial_visualizacao WHERE user_id='$MASTER'")" "3"

# ── gate na fronteira do JWT ──
chamar() {
  Pq -c "DO \$\$ BEGIN
    PERFORM set_config('request.jwt.claim.sub', '$1', true);
    PERFORM public.meta_potencial_mes();
    RAISE NOTICE 'OK';
  EXCEPTION WHEN SQLSTATE '42501' THEN
    RAISE EXCEPTION 'ESTADO=%', SQLSTATE;
  END \$\$;" 2>&1 | grep -oE 'ESTADO=[0-9A-Z]+|NOTICE:  OK' | head -1
}
eq "customer barrado" "$(chamar "$CLIENTE")" "ESTADO=42501"
eq "employee barrado" "$(chamar "$REGINA")" "ESTADO=42501"
eq "sem sub barrado" "$(chamar "")" "ESTADO=42501"
eq "master passa" "$(chamar "$MASTER")" "NOTICE:  OK"

# ── ACL ──
eq "authenticated NÃO executa o escritor interno" "$(Pq -c "SELECT has_function_privilege('authenticated', 'public._meta_potencial_mes_em(date,uuid)', 'EXECUTE')")" "f"
eq "authenticated NÃO lê a tabela" "$(Pq -c "SELECT has_table_privilege('authenticated', 'public.meta_potencial_mensal', 'SELECT')")" "f"
eq "anon NÃO executa a RPC" "$(Pq -c "SELECT has_function_privilege('anon', 'public.meta_potencial_mes()', 'EXECUTE')")" "f"

echo
echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ] && echo "__PROVA_META_POTENCIAL_OK__"
[ "$FAIL" -eq 0 ]
