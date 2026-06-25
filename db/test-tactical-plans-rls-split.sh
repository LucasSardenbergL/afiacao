#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA PG17 — split da RLS de farmer_tactical_plans (fecha a escrita direta)   ║
# ║  migration: 20260624020000_tactical_plans_split_rls_escrita.sql                ║
# ║  Rode:  bash db/test-tactical-plans-rls-split.sh > /tmp/t.log 2>&1; echo $?    ║
# ║                                                                                ║
# ║  Prova: pós-split, authenticated LÊ mas NÃO escreve direto (insert→42501,      ║
# ║  update/delete→0 linhas); as RPCs SECURITY DEFINER e service_role (bypassrls)  ║
# ║  seguem escrevendo. Falsifica: policy ALL de volta → insert direto passa.      ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5474}"
SLUG="tactplan-rls-split"
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
ALTER ROLE service_role BYPASSRLS;   -- espelha prod (psql-ro: rolbypassrls=t)
SQL

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

MASTER='11111111-1111-1111-1111-111111111111'
OWNER_A='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
STAFF_E='eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'   # employee, NÃO dono de X
CUST_X='50000000-0000-0000-0000-000000000001'
PLAN_X='99999999-9999-9999-9999-999999999999'   # plano existente (dono A)
PAYLOAD='{"strategic_objective":"upsell_premium","health_score":50}'

echo "═══ setup (PG17 :$PORT) ═══"

# ── ZONA 1: pré-requisitos (tabela + RLS policy ALL pré-split + carteira + has_role) ──
P -q <<'SQL'
DO $$ BEGIN CREATE TYPE public.app_role AS ENUM ('master','employee','customer'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE TABLE IF NOT EXISTS public.user_roles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, role public.app_role NOT NULL);
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $f$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id=_user_id AND role=_role) $f$;

CREATE TABLE IF NOT EXISTS public.carteira_assignments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_user_id uuid NOT NULL UNIQUE, owner_user_id uuid NOT NULL, source text NOT NULL DEFAULT 'omie', eligible boolean NOT NULL DEFAULT true, valid_from timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS public.carteira_coverage (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), covering_user_id uuid NOT NULL, covered_user_id uuid NOT NULL, valid_from timestamptz NOT NULL DEFAULT now(), valid_until timestamptz, active boolean NOT NULL DEFAULT true, created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE OR REPLACE FUNCTION public.carteira_visivel_para(_customer_user_id uuid, _uid uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $f$
  SELECT has_role(_uid,'master'::app_role)
    OR EXISTS (SELECT 1 FROM carteira_assignments a WHERE a.customer_user_id=_customer_user_id AND a.owner_user_id=_uid)
    OR EXISTS (SELECT 1 FROM carteira_assignments a JOIN carteira_coverage c ON c.covered_user_id=a.owner_user_id
               WHERE a.customer_user_id=_customer_user_id AND c.covering_user_id=_uid AND c.active AND (c.valid_until IS NULL OR c.valid_until>now()));
$f$;

CREATE TABLE IF NOT EXISTS public.farmer_tactical_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farmer_id uuid NOT NULL, customer_user_id uuid NOT NULL,
  bundle_recommendation_id uuid, health_score numeric DEFAULT 0, churn_risk numeric DEFAULT 0, mix_gap integer DEFAULT 0,
  current_margin_pct numeric DEFAULT 0, cluster_avg_margin_pct numeric DEFAULT 0, expansion_potential numeric DEFAULT 0,
  strategic_objective text NOT NULL DEFAULT 'expansao_mix', customer_profile text DEFAULT 'misto',
  top_bundle jsonb DEFAULT '{}', bundle_lie numeric DEFAULT 0, bundle_probability numeric DEFAULT 0,
  bundle_incremental_margin numeric DEFAULT 0, best_individual_lie numeric DEFAULT 0,
  diagnostic_questions jsonb DEFAULT '[]', implication_question text, offer_transition text,
  probable_objections jsonb DEFAULT '[]', approach_strategy text,
  plan_followed boolean, call_result text, actual_margin numeric, call_duration_seconds integer,
  objection_type text, notes text, effectiveness_score numeric, status text DEFAULT 'gerado',
  generated_at timestamptz DEFAULT now(), used_at timestamptz, completed_at timestamptz,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(), plan_type text DEFAULT 'essencial',
  approach_strategy_b text, second_bundle jsonb DEFAULT '{}', ltv_projection jsonb, expected_result jsonb, operational_risks jsonb DEFAULT '[]'
);
ALTER TABLE public.farmer_tactical_plans ENABLE ROW LEVEL SECURITY;
-- estado PRÉ-split: a policy ALL staff-vê-tudo (o que existe em prod antes desta migration)
CREATE POLICY "Staff can manage tactical plans" ON public.farmer_tactical_plans
  FOR ALL USING (has_role(auth.uid(),'master') OR has_role(auth.uid(),'employee'))
  WITH CHECK (has_role(auth.uid(),'master') OR has_role(auth.uid(),'employee'));
-- GRANTs amplos (como o Supabase) → a RLS é o GATE, não o grant. service_role
-- precisa do GRANT mesmo com bypassrls (bypassrls ignora a RLS, não concede privilégio).
GRANT SELECT, INSERT, UPDATE, DELETE ON public.farmer_tactical_plans TO authenticated, anon, service_role;
GRANT SELECT ON public.user_roles, public.carteira_assignments, public.carteira_coverage TO authenticated, anon;
SQL

# aplicar a migration do PR1 (cria as RPCs criar_plano_tatico/registrar_resultado_plano)
P -q -f "$REPO_ROOT/supabase/migrations/20260623180000_rpc_tactical_plan_posse_segura.sql"

# ── ZONA 2: aplicar a migration REAL do split (PR2) ──
MIG="$REPO_ROOT/supabase/migrations/20260624020000_tactical_plans_split_rls_escrita.sql"
P -q -f "$MIG"
echo "migration aplicada: $(basename "$MIG")"

# ── ZONA 3: seed ──
P -q <<SQL
INSERT INTO auth.users(id) VALUES ('$MASTER'),('$OWNER_A'),('$STAFF_E'),('$CUST_X') ON CONFLICT DO NOTHING;
INSERT INTO public.user_roles(user_id,role) VALUES ('$MASTER','master'),('$OWNER_A','employee'),('$STAFF_E','employee') ON CONFLICT DO NOTHING;
INSERT INTO public.carteira_assignments(customer_user_id,owner_user_id,source) VALUES ('$CUST_X','$OWNER_A','omie') ON CONFLICT DO NOTHING;
INSERT INTO public.farmer_tactical_plans(id,farmer_id,customer_user_id,status,strategic_objective) VALUES ('$PLAN_X','$OWNER_A','$CUST_X','gerado','upsell_premium');
SQL

echo "── asserts ──"

# P1 — leitura staff preservada (SELECT policy)
eq "P1 staff lê (SELECT preservado)" "$(Pq -c "SET test.uid='$STAFF_E'; SET ROLE authenticated; SELECT count(*) FROM public.farmer_tactical_plans;" | tail -1)" "1"

# N1 — INSERT direto por staff → negado pela RLS (sem policy INSERT) → 42501
R=$(P -tA 2>&1 <<'SQL'
SET test.uid='eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'; SET ROLE authenticated;
DO $$ BEGIN
  INSERT INTO public.farmer_tactical_plans(farmer_id,customer_user_id,strategic_objective)
  VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','50000000-0000-0000-0000-000000000001','upsell_premium');
  RAISE NOTICE 'N1_NAO_BARROU';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'N1_RLS_OK'; WHEN OTHERS THEN RAISE; END $$;
SQL
)
case "$R" in *N1_RLS_OK*) ok "N1 INSERT direto de staff NEGADO pela RLS (42501)";; *) bad "N1 — veio: $R";; esac

# N2 — UPDATE direto por staff → 0 linhas (RLS filtra a linha como invisível), status inalterado
P -q -c "SET test.uid='$STAFF_E'; SET ROLE authenticated; UPDATE public.farmer_tactical_plans SET status='hackeado' WHERE id='$PLAN_X';" >/dev/null
eq "N2 UPDATE direto de staff NÃO altera (RLS)" "$(Pq -c "SELECT status FROM public.farmer_tactical_plans WHERE id='$PLAN_X';")" "gerado"

# N3 — DELETE direto por staff → 0 linhas, plano persiste
P -q -c "SET test.uid='$STAFF_E'; SET ROLE authenticated; DELETE FROM public.farmer_tactical_plans WHERE id='$PLAN_X';" >/dev/null
eq "N3 DELETE direto de staff NÃO apaga (RLS)" "$(Pq -c "SELECT count(*) FROM public.farmer_tactical_plans WHERE id='$PLAN_X';")" "1"

# P2 — a RPC SECURITY DEFINER (dono que vê a carteira) AINDA insere
NID=$(Pq -c "SET test.uid='$OWNER_A'; SET test.role='authenticated'; SET ROLE authenticated; SELECT public.criar_plano_tatico('$CUST_X'::uuid,'$OWNER_A'::uuid,'$PAYLOAD'::jsonb);" | tail -1)
eq "P2 RPC criar_plano_tatico ainda escreve (definer bypassa RLS)" "$(Pq -c "SELECT farmer_id FROM public.farmer_tactical_plans WHERE id='$NID';")" "$OWNER_A"

# P3 — a RPC de registrar AINDA atualiza o PLAN_X
Pq -c "SET test.uid='$OWNER_A'; SET test.role='authenticated'; SET ROLE authenticated; SELECT public.registrar_resultado_plano('$PLAN_X'::uuid,true,'ganho',30.5,600,NULL,NULL);" >/dev/null
eq "P3 RPC registrar_resultado_plano ainda atualiza" "$(Pq -c "SELECT status FROM public.farmer_tactical_plans WHERE id='$PLAN_X';")" "concluido"

# P4 — service_role escreve DIRETO (bypassrls) → engines/cron intactos
SID=$(Pq -c "SET test.role='service_role'; SET ROLE service_role; WITH ins AS (INSERT INTO public.farmer_tactical_plans(farmer_id,customer_user_id,status,strategic_objective) VALUES ('$OWNER_A','$CUST_X','gerado','upsell_premium') RETURNING id) SELECT id FROM ins;" | tail -1)
eq "P4 service_role escreve direto (bypassrls)" "$(test -n "$SID" && echo ok)" "ok"

# ── ZONA 5: FALSIFICAÇÃO ──
echo "── falsificação ──"

# F1 — desfaz o split (policy ALL de volta) → N1 (insert direto) passa a CRIAR
P -q <<'SQL'
DROP POLICY IF EXISTS "tactical_plans_select_staff" ON public.farmer_tactical_plans;
CREATE POLICY "Staff can manage tactical plans" ON public.farmer_tactical_plans
  FOR ALL USING (has_role(auth.uid(),'master') OR has_role(auth.uid(),'employee'))
  WITH CHECK (has_role(auth.uid(),'master') OR has_role(auth.uid(),'employee'));
SQL
R=$(P -tA 2>&1 <<'SQL'
SET test.uid='eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'; SET ROLE authenticated;
DO $$ BEGIN
  INSERT INTO public.farmer_tactical_plans(farmer_id,customer_user_id,strategic_objective)
  VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','50000000-0000-0000-0000-000000000001','upsell_premium');
  RAISE NOTICE 'N1_NAO_BARROU';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'N1_RLS_OK'; WHEN OTHERS THEN RAISE; END $$;
SQL
)
case "$R" in *N1_NAO_BARROU*) ok "F1 com a policy ALL, INSERT direto PASSA → N1 tem dente";; *) bad "F1 sabotei o split e N1 não mudou: $R";; esac
P -q -f "$MIG"   # restaura o split

# F2 — adiciona policy UPDATE p/ authenticated → N2 (update direto) passa a alterar
P -q <<'SQL'
CREATE POLICY "tmp_upd_authenticated" ON public.farmer_tactical_plans
  FOR UPDATE USING (has_role(auth.uid(),'employee')) WITH CHECK (true);
SQL
PLAN_F2=$(Pq -c "WITH ins AS (INSERT INTO public.farmer_tactical_plans(farmer_id,customer_user_id,status,strategic_objective) VALUES ('$OWNER_A','$CUST_X','gerado','upsell_premium') RETURNING id) SELECT id FROM ins;" | tail -1)
P -q -c "SET test.uid='$STAFF_E'; SET ROLE authenticated; UPDATE public.farmer_tactical_plans SET status='hackeado' WHERE id='$PLAN_F2';" >/dev/null
ST=$(Pq -c "SELECT status FROM public.farmer_tactical_plans WHERE id='$PLAN_F2';")
if [ "$ST" = "hackeado" ]; then ok "F2 com policy UPDATE, staff altera direto → N2 tem dente"; else bad "F2 sabotei e N2 não mudou (status=$ST)"; fi
P -q -c "DROP POLICY IF EXISTS \"tmp_upd_authenticated\" ON public.farmer_tactical_plans;" >/dev/null

echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
