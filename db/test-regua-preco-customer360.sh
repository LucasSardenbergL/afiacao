#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  HARNESS PG17 — PROVA da 20260616120001_regua_preco_customer360 (money-path)  ║
# ║      bash db/test-regua-preco-customer360.sh > /tmp/t.log 2>&1; echo "exit=$?"║
# ║  A customer360 REUSA get_regua_preco — aplico as DUAS migrations.             ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5462}"
SLUG="regua-preco-360"
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
Pq() { P -qtA "$@"; }

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

# ════════ ZONA 1 — pré-requisitos (note: order_items COM omie_codigo_produto) ════════
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
  product_id uuid, omie_codigo_produto bigint, quantity numeric, unit_price numeric, sales_order_id uuid);
SQL

# ════════ ZONA 2 — aplicar as DUAS migrations REAIS (get_regua_preco primeiro; customer360 reusa) ════════
MIG="$REPO_ROOT/supabase/migrations/20260616120000_regua_preco.sql"
MIG360="$REPO_ROOT/supabase/migrations/20260616120001_regua_preco_customer360.sql"
P -q -f "$MIG"
P -q -f "$MIG360"
echo "migrations aplicadas: $(basename "$MIG") + $(basename "$MIG360")"

# ════════ ZONA 3 — seeds ════════
# CA=cliente do 360. P1 caso feliz (omie 7001), P2 abaixo do piso (7002), 7003 sem_produto, P4 sem_preco (7004).
P -q <<'SQL'
INSERT INTO public.user_roles VALUES
  ('33333333-3333-3333-3333-333333333333','employee'),
  ('44444444-4444-4444-4444-444444444444','customer');
UPDATE public.company_config SET value='0.20' WHERE key='regua_preco_aliquota_venda_oben';  -- piso = cmc/0.8

INSERT INTO public.inventory_position VALUES
  ('a1111111-1111-1111-1111-111111111111','oben',100),  -- P1: cmc 100 -> piso 125
  ('a2222222-2222-2222-2222-222222222222','oben',100),  -- P2: cmc 100 -> piso 125
  ('a4444444-4444-4444-4444-444444444444','oben',100);  -- P4: cmc 100

INSERT INTO public.sales_orders (id, account, order_date_kpi, deleted_at, customer_user_id) VALUES
  ('d0000000-0000-0000-0000-000000000001','oben', current_date-40, NULL, '11111111-1111-1111-1111-111111111111'), -- CA P1 ANTIGO
  ('d0000000-0000-0000-0000-000000000002','oben', current_date-10, NULL, '11111111-1111-1111-1111-111111111111'), -- CA P1 RECENTE
  ('d0000000-0000-0000-0000-000000000003','oben', current_date-5,  NULL, '11111111-1111-1111-1111-111111111111'), -- CA P2
  ('d0000000-0000-0000-0000-000000000004','oben', current_date-7,  NULL, '11111111-1111-1111-1111-111111111111'), -- CA P4 (preço 0)
  ('e0000000-0000-0000-0000-000000000001','oben', current_date-10, NULL, '55555555-5555-5555-5555-555555550001'), -- comparável C1
  ('e0000000-0000-0000-0000-000000000002','oben', current_date-10, NULL, '55555555-5555-5555-5555-555555550002'); -- comparável C2

INSERT INTO public.order_items (customer_user_id, product_id, omie_codigo_produto, quantity, unit_price, sales_order_id) VALUES
  -- CA P1 (7001): antigo qty20/128, recente qty10/130 -> preco_atual=130, qty_ref=mediana(10,20)=15, n=2
  ('11111111-1111-1111-1111-111111111111','a1111111-1111-1111-1111-111111111111',7001,20,128,'d0000000-0000-0000-0000-000000000001'),
  ('11111111-1111-1111-1111-111111111111','a1111111-1111-1111-1111-111111111111',7001,10,130,'d0000000-0000-0000-0000-000000000002'),
  -- CA P2 (7002): qty5/90 -> abaixo do piso 125
  ('11111111-1111-1111-1111-111111111111','a2222222-2222-2222-2222-222222222222',7002, 5, 90,'d0000000-0000-0000-0000-000000000003'),
  -- CA P4 (7004): unit_price 0 -> resolve product_id mas sem preco_atual -> sem_preco
  ('11111111-1111-1111-1111-111111111111','a4444444-4444-4444-4444-444444444444',7004, 8,  0,'d0000000-0000-0000-0000-000000000004'),
  -- comparáveis de P1 (banda 7.5..30, 180d, outros clientes)
  ('55555555-5555-5555-5555-555555550001','a1111111-1111-1111-1111-111111111111',7001,10,120,'e0000000-0000-0000-0000-000000000001'),
  ('55555555-5555-5555-5555-555555550002','a1111111-1111-1111-1111-111111111111',7001,12,122,'e0000000-0000-0000-0000-000000000002');
GRANT SELECT ON public.user_roles TO authenticated, anon;
SQL

# ════════ ZONA 4 — asserts ════════
echo "── asserts ──"
S="33333333-3333-3333-3333-333333333333"        # staff uid
CUST="44444444-4444-4444-4444-444444444444"      # customer (não-staff)
CA="11111111-1111-1111-1111-111111111111"
ARR="ARRAY[7001,7002,7003,7004]::bigint[]"
fnum() { Pq -c "SET test.uid='$S'; SELECT ((e->>'$2')::numeric = $3) FROM jsonb_array_elements(public.get_regua_preco_customer360('$CA'::uuid, $ARR)) e WHERE (e->>'omie_codigo')::bigint=$1;" | tail -1; }
ftxt() { Pq -c "SET test.uid='$S'; SELECT (e->>'$2') FROM jsonb_array_elements(public.get_regua_preco_customer360('$CA'::uuid, $ARR)) e WHERE (e->>'omie_codigo')::bigint=$1;" | tail -1; }
has360() { Pq -c "SET test.uid='$S'; SELECT EXISTS(SELECT 1 FROM jsonb_array_elements((SELECT e->'comparaveis' FROM jsonb_array_elements(public.get_regua_preco_customer360('$CA'::uuid,$ARR)) e WHERE (e->>'omie_codigo')::bigint=7001)) c WHERE (c->>'preco')::numeric=$1);" | tail -1; }

# A1 — camada customer360 (caso feliz 7001)
eq "A1a 7001 product_id = P1"            "$(ftxt 7001 product_id)" "a1111111-1111-1111-1111-111111111111"
eq "A1b 7001 preco_atual = 130 (ÚLTIMO)" "$(fnum 7001 preco_atual 130)" "t"
eq "A1c 7001 preco_atual_at = date-10"   "$(ftxt 7001 preco_atual_at)" "$(Pq -c "SELECT (current_date-10)::text;" | tail -1)"
eq "A1d 7001 qty_ref = 15 (mediana 10,20)" "$(fnum 7001 qty_ref 15)" "t"
eq "A1e 7001 qty_ref_n = 2"              "$(fnum 7001 qty_ref_n 2)" "t"
eq "A1f 7001 qty_ref_source = cliente"   "$(ftxt 7001 qty_ref_source)" "cliente"
eq "A1g 7001 hide_reason null"           "$(ftxt 7001 hide_reason)" ""

# A2 — merge do pacote (prova reuso da get_regua_preco: herda cmc/alíquota)
eq "A2a 7001 piso_mc = 125 (cmc/(1-0.20))" "$(fnum 7001 piso_mc 125)" "t"
eq "A2b 7001 cmc = 100"                  "$(fnum 7001 cmc 100)" "t"
eq "A2c 7001 cmc_confiavel = true"       "$(ftxt 7001 cmc_confiavel)" "true"

# A3 — comparaveis chegou íntegro (leave-one-customer-out aplicado pela get_regua_preco)
eq "A3a 7001 comparaveis tem 120"        "$(has360 120)" "t"
eq "A3b 7001 comparaveis tem 122"        "$(has360 122)" "t"
eq "A3c 7001 comparaveis NÃO tem 130 (CA, leave-one-out)" "$(has360 130)" "f"

# A4 — abaixo do piso (RPC só FETCHA; decisão 'piso' é do helper TS)
eq "A4a 7002 preco_atual = 90"           "$(fnum 7002 preco_atual 90)" "t"
eq "A4b 7002 piso_mc = 125 (preco<piso)" "$(fnum 7002 piso_mc 125)" "t"

# A5 — sem_produto (omie que o cliente nunca comprou)
eq "A5a 7003 hide_reason = sem_produto"  "$(ftxt 7003 hide_reason)" "sem_produto"
eq "A5b 7003 sem product_id"             "$(ftxt 7003 product_id)" ""

# A6 — sem_preco (resolve product_id mas sem unit_price>0)
eq "A6a 7004 hide_reason = sem_preco"    "$(ftxt 7004 hide_reason)" "sem_preco"
eq "A6b 7004 product_id = P4 (resolveu)" "$(ftxt 7004 product_id)" "a4444444-4444-4444-4444-444444444444"

# A7 — preco_atual é o ÚLTIMO real, não o mais antigo (reforço money-path)
eq "A7 7001 preco_atual <> 128 (antigo)" "$(Pq -c "SET test.uid='$S'; SELECT (e->>'preco_atual')::numeric <> 128 FROM jsonb_array_elements(public.get_regua_preco_customer360('$CA'::uuid,$ARR)) e WHERE (e->>'omie_codigo')::bigint=7001;" | tail -1)" "t"

# A8 — dedupe do array de entrada
eq "A8 dedupe [7001,7001] -> 1 objeto"   "$(Pq -c "SET test.uid='$S'; SELECT jsonb_array_length(public.get_regua_preco_customer360('$CA'::uuid, ARRAY[7001,7001]::bigint[]));" | tail -1)" "1"

# A9 — entradas vazias
eq "A9a [] -> array vazio"               "$(Pq -c "SET test.uid='$S'; SELECT jsonb_array_length(public.get_regua_preco_customer360('$CA'::uuid, ARRAY[]::bigint[]));" | tail -1)" "0"
eq "A9b NULL -> array vazio"             "$(Pq -c "SET test.uid='$S'; SELECT jsonb_array_length(public.get_regua_preco_customer360('$CA'::uuid, NULL));" | tail -1)" "0"

# N1 — gate barra customer no caminho hide_reason (o que SÓ o gate da customer360 protege).
#      Sentinela 'GATEBARROU360' ≠ texto do código ('forbidden'/'staff') — anti-teatro.
R=$(P -tA 2>&1 <<SQL || true
SET test.uid='$CUST';
DO \$\$
BEGIN
  PERFORM public.get_regua_preco_customer360('$CA'::uuid, ARRAY[7003]::bigint[]);
  RAISE EXCEPTION 'XGATEFUROUX';
EXCEPTION
  WHEN insufficient_privilege THEN RAISE NOTICE 'GATEBARROU360';
  WHEN OTHERS THEN RAISE;
END \$\$;
SQL
)
case "$R" in *GATEBARROU360*) ok "N1 gate barra customer (42501) no caminho sem_produto";; *) bad "N1 gate furado — [$R]";; esac

# ════════ ZONA 5 — falsificação (sabota → exige vermelho → restaura) ════════
echo "── falsificação ──"

# F1 — preco_atual DEVE ser o ÚLTIMO. Sabota DESC->ASC: vira o mais antigo (128) -> A1b/A7 perdem o dente se não detectar.
sed 's/DESC NULLS LAST/ASC NULLS LAST/g' "$MIG360" > /tmp/sab-360-preco.sql
P -q -f /tmp/sab-360-preco.sql
if [ "$(fnum 7001 preco_atual 128)" = "t" ]; then ok "F1 preco_atual sabotado (ASC) → vira 128 (A1b/A7 têm dente)"; else bad "F1 sabotagem não mudou preco_atual → A1b é teatro"; fi
P -q -f "$MIG360"  # restaura
eq "F1b restaurado → preco_atual = 130" "$(fnum 7001 preco_atual 130)" "t"

# F2 — gate da customer360 protege o caminho hide_reason. Sabota (IF false): customer recebe dados, não 42501.
sed "s/IF NOT (public.has_role(auth.uid(), 'employee') OR public.has_role(auth.uid(), 'master')) THEN/IF false THEN/" "$MIG360" > /tmp/sab-360-gate.sql
P -q -f /tmp/sab-360-gate.sql
RG=$(P -tA 2>&1 <<SQL || true
SET test.uid='$CUST';
SELECT jsonb_array_length(public.get_regua_preco_customer360('$CA'::uuid, ARRAY[7003]::bigint[]));
SQL
)
case "$RG" in *1*) ok "F2 gate furado → customer recebe dados (N1 tem dente)";; *) bad "F2 sabotagem do gate não detectada → N1 é teatro [$RG]";; esac
P -q -f "$MIG360"  # restaura
RG2=$(P -tA 2>&1 <<SQL || true
SET test.uid='$CUST';
DO \$\$ BEGIN PERFORM public.get_regua_preco_customer360('$CA'::uuid, ARRAY[7003]::bigint[]); RAISE EXCEPTION 'XX'; EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'REBARROU360'; WHEN OTHERS THEN RAISE; END \$\$;
SQL
)
case "$RG2" in *REBARROU360*) ok "F2b restaurado → customer barrado de novo";; *) bad "F2b restauração falhou — [$RG2]";; esac

# ── veredito ──
echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
