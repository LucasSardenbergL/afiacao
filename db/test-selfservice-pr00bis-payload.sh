#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  PR0.0-bis — PROVA PG17: fecha omie_payload/omie_response ao customer,         ║
# ║  mantém staff via RPC SECDEF gateada. Com FALSIFICAÇÃO.                        ║
# ║  Split em 2 migrations (achado Codex): A cria a RPC, B faz o REVOKE.           ║
# ║      bash db/test-selfservice-pr00bis-payload.sh > /tmp/t.log 2>&1; echo $?    ║
# ║                                                                                ║
# ║  Lei de Ferro: (1) aplica as migrations REAIS; (2) assert negativo captura a   ║
# ║  SQLSTATE esperada e re-lança o resto; (3) falsifica (sabota → vermelho).      ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5471}"
SLUG="pr00bis-payload"
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
SQL

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

echo "═══ setup pronto (PG17 :$PORT) ═══"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — PRÉ-REQUISITOS DE SCHEMA (o que a migração LÊ/ALTERA mas não cria)
# ══════════════════════════════════════════════════════════════════════════════
# ⚠️ default-privilege do Supabase: funções novas nascem executáveis por anon/authenticated/
#    service_role. Replicar ANTES de a migração criar a RPC — senão anon nasce SEM execute e o
#    REVOKE FROM anon dá FALSO-VERDE (database.md §5). O ALTER DEFAULT PRIVILEGES roda como
#    postgres, que é quem aplica a migração (ZONA 2) → a RPC herda o execute default.
P -q <<'SQL'
-- app_role + user_roles + has_role (verbatim do prod: SECDEF, EXISTS em user_roles)
CREATE TYPE public.app_role AS ENUM ('master', 'employee', 'customer');
CREATE TABLE public.user_roles (user_id uuid NOT NULL, role public.app_role NOT NULL);
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $fn$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $fn$;

-- sales_orders com as 27 colunas reais (ordinal do prod) — as 25 do GRANT precisam existir.
CREATE TABLE public.sales_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_user_id uuid,
  created_by uuid,
  items jsonb,
  subtotal numeric,
  discount numeric,
  total numeric,
  status text,
  notes text,
  omie_pedido_id bigint,
  omie_numero_pedido text,
  omie_payload jsonb,
  omie_response jsonb,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  account text,
  hash_payload text,
  customer_address text,
  customer_phone text,
  ready_by_date date,
  deleted_at timestamptz,
  order_date_kpi date,
  checkout_id uuid,
  origem text,
  atendimento_id uuid,
  pedido_programado_envio_id uuid,
  customer_document text
);
ALTER TABLE public.sales_orders ENABLE ROW LEVEL SECURITY;
-- policies reais (do prod): staff FOR ALL; customer SELECT own.
CREATE POLICY "Staff can manage sales orders" ON public.sales_orders
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'master'::public.app_role) OR public.has_role(auth.uid(), 'employee'::public.app_role));
CREATE POLICY "Customers can view their own sales orders" ON public.sales_orders
  FOR SELECT TO authenticated
  USING (auth.uid() = customer_user_id);

-- estado inicial de grants = como o Supabase entrega tabela nova (arwdDxtm p/ anon/auth/service_role).
GRANT ALL ON public.sales_orders TO anon, authenticated, service_role;

-- default-privilege de EXECUTE (replica o comportamento do Supabase p/ funções novas).
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
SQL
echo "pré-requisitos: app_role/user_roles/has_role + sales_orders(27 col)+RLS + default EXECUTE"

# sanidade: authenticated LÊ omie_payload ANTES das migrações (pré-condição do que vamos fechar)
V=$(Pq -c "SELECT has_column_privilege('authenticated','public.sales_orders','omie_payload','SELECT');")
eq "pre-cond: authenticated LÊ omie_payload antes do fix" "$V" "t"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — APLICAR AS MIGRATIONS REAIS (Lei #1) — A depois B, provando a sequência
# ══════════════════════════════════════════════════════════════════════════════
MIG_A="$REPO_ROOT/supabase/migrations/20260709163000_selfservice_pr00bis_a_rpc_staff_payload.sql"
MIG_B="$REPO_ROOT/supabase/migrations/20260709163500_selfservice_pr00bis_b_revoke_omie_payload.sql"
# A: cria a RPC. Prova que A SOZINHA não fecha nada — a sequência de deploy (A → Publish front → B)
# depende disso: aplicar A não pode quebrar o front velho nem fechar o payload cedo.
P -q -f "$MIG_A"
V=$(Pq -c "SELECT has_column_privilege('authenticated','public.sales_orders','omie_payload','SELECT');")
eq "sequência: após A (só a RPC), authenticated AINDA lê payload (fecha só na B)" "$V" "t"
# B: fecha a leitura.
P -q -f "$MIG_B"
echo "migrações aplicadas: A ($(basename "$MIG_A")) + B ($(basename "$MIG_B"))"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 3 — SEED
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
INSERT INTO auth.users(id) VALUES
  ('11111111-1111-1111-1111-111111111111'),   -- customer (dono do pedido)
  ('22222222-2222-2222-2222-222222222222'),   -- employee (staff)
  ('33333333-3333-3333-3333-333333333333')    -- master  (staff)
ON CONFLICT DO NOTHING;
INSERT INTO public.user_roles(user_id, role) VALUES
  ('11111111-1111-1111-1111-111111111111','customer'),
  ('22222222-2222-2222-2222-222222222222','employee'),
  ('33333333-3333-3333-3333-333333333333','master');
INSERT INTO public.sales_orders(id, customer_user_id, items, subtotal, total, status, omie_payload, omie_response, account) VALUES
  ('aaaaaaaa-0000-0000-0000-000000000001','11111111-1111-1111-1111-111111111111',
   '[]'::jsonb, 100, 100, 'rascunho',
   '{"cabecalho":{"codigo_parcela":"000","codigo_cliente":12345}}'::jsonb,
   '{"faultstring":null}'::jsonb, 'oben');
SQL
echo "seed: customer + employee + master + 1 pedido do customer (payload codigo_parcela=000)"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4 — ASSERTS
# ══════════════════════════════════════════════════════════════════════════════
echo "── asserts: gate de grants (auth-específico) ──"
V=$(Pq -c "SELECT has_column_privilege('authenticated','public.sales_orders','omie_payload','SELECT');")
eq "A1a authenticated NÃO lê omie_payload"        "$V" "f"
V=$(Pq -c "SELECT has_column_privilege('authenticated','public.sales_orders','omie_response','SELECT');")
eq "A1b authenticated NÃO lê omie_response"       "$V" "f"
V=$(Pq -c "SELECT has_table_privilege('authenticated','public.sales_orders','SELECT');")
eq "A1c authenticated sem SELECT table-level"     "$V" "f"
V=$(Pq -c "SELECT has_column_privilege('anon','public.sales_orders','omie_payload','SELECT');")
eq "A1d anon NÃO lê omie_payload (defense-in-depth)" "$V" "f"
V=$(Pq -c "SELECT has_table_privilege('anon','public.sales_orders','SELECT');")
eq "A1e anon sem SELECT table-level"              "$V" "f"
V=$(Pq -c "SELECT has_column_privilege('authenticated','public.sales_orders','id','SELECT');")
eq "A2a authenticated lê id (não-sensível)"       "$V" "t"
V=$(Pq -c "SELECT has_column_privilege('authenticated','public.sales_orders','total','SELECT');")
eq "A2b authenticated lê total (não-sensível)"    "$V" "t"
V=$(Pq -c "SELECT has_column_privilege('authenticated','public.sales_orders','customer_document','SELECT');")
eq "A2c authenticated lê customer_document"       "$V" "t"
V=$(Pq -c "SELECT has_column_privilege('service_role','public.sales_orders','omie_payload','SELECT');")
eq "A3 service_role AINDA lê payload (edge writer intacto)" "$V" "t"

echo "── asserts: caminho feliz (staff via RPC / customer nas colunas ok) ──"
# P1 — staff (employee) lê o payload pela RPC, apesar do REVOKE (SECDEF fura)
V=$(Pq -c "SET test.uid='22222222-2222-2222-2222-222222222222'; SET test.role='authenticated'; SET ROLE authenticated; SELECT omie_payload->'cabecalho'->>'codigo_parcela' FROM public.staff_get_sales_order_payload(ARRAY['aaaaaaaa-0000-0000-0000-000000000001'::uuid]);" | tail -1)
eq "P1 staff lê codigo_parcela via RPC"           "$V" "000"
# P1b — master também
V=$(Pq -c "SET test.uid='33333333-3333-3333-3333-333333333333'; SET ROLE authenticated; SELECT (omie_response->>'faultstring') IS NULL FROM public.staff_get_sales_order_payload(ARRAY['aaaaaaaa-0000-0000-0000-000000000001'::uuid]);" | tail -1)
eq "P1b master lê omie_response via RPC"           "$V" "t"
# P2 — customer AINDA lê as colunas não-sensíveis do PRÓPRIO pedido (não quebrei o acesso legítimo)
OWN=$(Pq -c "SET test.uid='11111111-1111-1111-1111-111111111111'; SET ROLE authenticated; SELECT count(*) FROM (SELECT id, total, status FROM public.sales_orders WHERE id='aaaaaaaa-0000-0000-0000-000000000001') t;" | tail -1)
eq "P2 customer lê colunas não-sensíveis do próprio pedido" "$OWN" "1"

echo "── asserts: a defesa morde (SQLSTATE + re-raise) ──"
# N1 — customer SELECT omie_payload do PRÓPRIO pedido → 42501
R=$(P -tA 2>&1 <<'SQL' || true
SET test.uid='11111111-1111-1111-1111-111111111111'; SET ROLE authenticated;
DO $$
DECLARE v jsonb;
BEGIN
  SELECT omie_payload INTO v FROM public.sales_orders WHERE id='aaaaaaaa-0000-0000-0000-000000000001';
  RAISE EXCEPTION 'CUSTOMER_LEU_PAYLOAD';
EXCEPTION
  WHEN insufficient_privilege THEN RAISE NOTICE 'N1_PAYLOAD_NEGADO';
  WHEN OTHERS THEN RAISE;
END $$;
SQL
)
case "$R" in *N1_PAYLOAD_NEGADO*) ok "N1 customer não lê omie_payload do próprio pedido (42501)" ;; *) bad "N1 — veio: $R" ;; esac

# N2 — customer SELECT * (o * inteiro cai porque payload/response negados) → 42501
R=$(P -tA 2>&1 <<'SQL' || true
SET test.uid='11111111-1111-1111-1111-111111111111'; SET ROLE authenticated;
DO $$
DECLARE r public.sales_orders%ROWTYPE;
BEGIN
  SELECT * INTO r FROM public.sales_orders WHERE id='aaaaaaaa-0000-0000-0000-000000000001';
  RAISE EXCEPTION 'CUSTOMER_LEU_STAR';
EXCEPTION
  WHEN insufficient_privilege THEN RAISE NOTICE 'N2_STAR_NEGADO';
  WHEN OTHERS THEN RAISE;
END $$;
SQL
)
case "$R" in *N2_STAR_NEGADO*) ok "N2 customer não faz SELECT * (42501 — o * inteiro cai)" ;; *) bad "N2 — veio: $R" ;; esac

# N3 — customer (não-staff) chamando a RPC → 42501 pelo gate has_role
R=$(P -tA 2>&1 <<'SQL' || true
SET test.uid='11111111-1111-1111-1111-111111111111'; SET test.role='authenticated'; SET ROLE authenticated;
DO $$
BEGIN
  PERFORM 1 FROM public.staff_get_sales_order_payload(ARRAY['aaaaaaaa-0000-0000-0000-000000000001'::uuid]);
  RAISE EXCEPTION 'CUSTOMER_CHAMOU_RPC';
EXCEPTION
  WHEN insufficient_privilege THEN RAISE NOTICE 'N3_GATE_NEGOU';
  WHEN OTHERS THEN RAISE;
END $$;
SQL
)
case "$R" in *N3_GATE_NEGOU*) ok "N3 customer barrado pelo gate has_role na RPC (42501)" ;; *) bad "N3 — veio: $R" ;; esac

# N4 — anon chamando a RPC → 42501 (REVOKE EXECUTE)
R=$(P -tA 2>&1 <<'SQL' || true
SET ROLE anon;
DO $$
BEGIN
  PERFORM 1 FROM public.staff_get_sales_order_payload(ARRAY['aaaaaaaa-0000-0000-0000-000000000001'::uuid]);
  RAISE EXCEPTION 'ANON_EXECUTOU_RPC';
EXCEPTION
  WHEN insufficient_privilege THEN RAISE NOTICE 'N4_ANON_SEM_EXECUTE';
  WHEN OTHERS THEN RAISE;
END $$;
SQL
)
case "$R" in *N4_ANON_SEM_EXECUTE*) ok "N4 anon sem EXECUTE na RPC (42501)" ;; *) bad "N4 — veio: $R" ;; esac

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICAÇÃO (sabota → exige VERMELHO → restaura)
# ══════════════════════════════════════════════════════════════════════════════
echo "── falsificação (prova que os asserts têm dente) ──"

# F1 ⭐ O ACHADO CENTRAL: REVOKE column-level (a versão do handoff) é NO-OP com o SELECT table-level.
#     Sabota = re-concede o table-level e revoga só as colunas (como o handoff assumia).
#     Exige has_column_privilege(payload) de volta a 't' → prova que A1 tem dente E que a
#     abordagem original vazaria.
P -q -c "GRANT SELECT ON public.sales_orders TO authenticated; REVOKE SELECT (omie_payload, omie_response) ON public.sales_orders FROM authenticated;" >/dev/null
V=$(Pq -c "SELECT has_column_privilege('authenticated','public.sales_orders','omie_payload','SELECT');")
case "$V" in
  t) ok "F1 REVOKE column-level é NO-OP com table-level presente → A1 tem dente (achado central provado)" ;;
  *) bad "F1 esperava 't' (no-op), veio [$V] — o modelo do achado está errado" ;;
esac
P -q -f "$MIG_B" >/dev/null   # restaura o REVOKE+GRANT (migration B)

# F2 — GATE removido da RPC: customer não-staff passa a ler via RPC → N3 tinha dente.
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.staff_get_sales_order_payload(p_order_ids uuid[])
RETURNS TABLE(id uuid, omie_payload jsonb, omie_response jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $fn$
BEGIN
  -- GATE has_role REMOVIDO de propósito
  RETURN QUERY SELECT so.id, so.omie_payload, so.omie_response FROM public.sales_orders so WHERE so.id = ANY(p_order_ids);
END $fn$;
GRANT EXECUTE ON FUNCTION public.staff_get_sales_order_payload(uuid[]) TO authenticated;
SQL
R=$(P -tA 2>&1 <<'SQL' || true
SET test.uid='11111111-1111-1111-1111-111111111111'; SET test.role='authenticated'; SET ROLE authenticated;
DO $$ BEGIN
  PERFORM 1 FROM public.staff_get_sales_order_payload(ARRAY['aaaaaaaa-0000-0000-0000-000000000001'::uuid]);
  RAISE NOTICE 'F2_SABOTAGEM_PASSOU';
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'F2_AINDA_BARRA'; END $$;
SQL
)
case "$R" in
  *F2_SABOTAGEM_PASSOU*) ok "F2 gate removido deixa customer ler via RPC → N3 tem dente" ;;
  *) bad "F2 sabotei o gate e N3 não mudou — assert fraco. Veio: $R" ;;
esac
P -q -f "$MIG_A" >/dev/null   # restaura a RPC com gate (migration A)

# F3 — REVOKE de anon + gate ambos removidos: anon LÊ o payload → N4 tinha dente.
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.staff_get_sales_order_payload(p_order_ids uuid[])
RETURNS TABLE(id uuid, omie_payload jsonb, omie_response jsonb)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $fn$
BEGIN
  RETURN QUERY SELECT so.id, so.omie_payload, so.omie_response FROM public.sales_orders so WHERE so.id = ANY(p_order_ids);
END $fn$;
GRANT EXECUTE ON FUNCTION public.staff_get_sales_order_payload(uuid[]) TO anon;
SQL
V=$(Pq -c "SET ROLE anon; SELECT omie_payload->'cabecalho'->>'codigo_parcela' FROM public.staff_get_sales_order_payload(ARRAY['aaaaaaaa-0000-0000-0000-000000000001'::uuid]);" 2>&1 | tail -1 || true)
case "$V" in
  000) ok "F3 sem REVOKE-anon + sem gate, anon LÊ o payload → N4 tem dente" ;;
  *) bad "F3 esperava anon lendo '000', veio: [$V]" ;;
esac
P -q -f "$MIG_A" >/dev/null   # restaura a RPC com gate + REVOKE execute anon (migration A)

# ── prova pós-restauração: os asserts-chave voltaram ao verde real ──
V=$(Pq -c "SELECT has_column_privilege('authenticated','public.sales_orders','omie_payload','SELECT');")
eq "pós-restauração: authenticated volta a NÃO ler payload" "$V" "f"

# ── veredito ──
echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
