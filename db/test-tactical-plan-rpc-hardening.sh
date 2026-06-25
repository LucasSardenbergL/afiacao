#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA PG17 — hardening das RPCs de plano tático (achados /codex challenge)    ║
# ║  migration: 20260624040000_tactical_plan_rpc_hardening_codex.sql               ║
# ║  Rode:  bash db/test-tactical-plan-rpc-hardening.sh > /tmp/t.log 2>&1; echo $? ║
# ║                                                                                ║
# ║  Prova: [#4] _expected_owner obrigatório p/ autenticado; [#5] não reescreve    ║
# ║  resultado de plano concluído; [#3] FOR UPDATE presente no SELECT do owner.    ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5475}"
SLUG="tactplan-harden"
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

MASTER='11111111-1111-1111-1111-111111111111'
OWNER_A='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
CUST_X='50000000-0000-0000-0000-000000000001'
PLAN_X='99999999-9999-9999-9999-999999999999'
PAYLOAD='{"strategic_objective":"upsell_premium","health_score":50}'

echo "═══ setup (PG17 :$PORT) ═══"

# ── ZONA 1: pré-requisitos ──
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
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), farmer_id uuid NOT NULL, customer_user_id uuid NOT NULL,
  bundle_recommendation_id uuid, health_score numeric DEFAULT 0, churn_risk numeric DEFAULT 0, mix_gap integer DEFAULT 0,
  current_margin_pct numeric DEFAULT 0, cluster_avg_margin_pct numeric DEFAULT 0, expansion_potential numeric DEFAULT 0,
  strategic_objective text NOT NULL DEFAULT 'expansao_mix', customer_profile text DEFAULT 'misto',
  top_bundle jsonb DEFAULT '{}', bundle_lie numeric DEFAULT 0, bundle_probability numeric DEFAULT 0,
  bundle_incremental_margin numeric DEFAULT 0, best_individual_lie numeric DEFAULT 0,
  diagnostic_questions jsonb DEFAULT '[]', implication_question text, offer_transition text,
  probable_objections jsonb DEFAULT '[]', approach_strategy text, plan_followed boolean, call_result text,
  actual_margin numeric, call_duration_seconds integer, objection_type text, notes text, effectiveness_score numeric,
  status text DEFAULT 'gerado', generated_at timestamptz DEFAULT now(), used_at timestamptz, completed_at timestamptz,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(), plan_type text DEFAULT 'essencial',
  approach_strategy_b text, second_bundle jsonb DEFAULT '{}', ltv_projection jsonb, expected_result jsonb, operational_risks jsonb DEFAULT '[]'
);
ALTER TABLE public.farmer_tactical_plans ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.farmer_tactical_plans TO authenticated, anon, service_role;
SQL

# ── ZONA 2: migration REAL do PR3 (recria as 2 RPCs v2) ──
MIG="$REPO_ROOT/supabase/migrations/20260624040000_tactical_plan_rpc_hardening_codex.sql"
P -q -f "$MIG"
echo "migration aplicada: $(basename "$MIG")"

# ── ZONA 3: seed ──
P -q <<SQL
INSERT INTO auth.users(id) VALUES ('$MASTER'),('$OWNER_A'),('$CUST_X') ON CONFLICT DO NOTHING;
INSERT INTO public.user_roles(user_id,role) VALUES ('$MASTER','master'),('$OWNER_A','employee') ON CONFLICT DO NOTHING;
INSERT INTO public.carteira_assignments(customer_user_id,owner_user_id,source) VALUES ('$CUST_X','$OWNER_A','omie') ON CONFLICT DO NOTHING;
INSERT INTO public.farmer_tactical_plans(id,farmer_id,customer_user_id,status,strategic_objective) VALUES ('$PLAN_X','$OWNER_A','$CUST_X','gerado','upsell_premium');
SQL

echo "── asserts ──"

# P1 — dono cria com _expected_owner correto → posse=A, gerado (regressão: comportamento mantido)
NID=$(Pq -c "SET test.uid='$OWNER_A'; SET test.role='authenticated'; SET ROLE authenticated; SELECT public.criar_plano_tatico('$CUST_X'::uuid,'$OWNER_A'::uuid,'$PAYLOAD'::jsonb);" | tail -1)
eq "P1 dono cria (posse=A)" "$(Pq -c "SELECT farmer_id FROM public.farmer_tactical_plans WHERE id='$NID';")" "$OWNER_A"

# P2 — service_role cria com _expected_owner=NULL → OK (cron pode omitir; posse re-resolvida=A)
SID=$(Pq -c "SET test.role='service_role'; SET ROLE service_role; SELECT public.criar_plano_tatico('$CUST_X'::uuid, NULL,'$PAYLOAD'::jsonb);" | tail -1)
eq "P2 service_role cria com expected_owner NULL (posse=A)" "$(Pq -c "SELECT farmer_id FROM public.farmer_tactical_plans WHERE id='$SID';")" "$OWNER_A"

# Presença [#3] — FOR UPDATE no corpo de criar_plano_tatico
eq "INV #3 FOR UPDATE presente no SELECT do owner" "$(Pq -c "SELECT (position('FOR UPDATE' IN pg_get_functiondef('public.criar_plano_tatico(uuid,uuid,jsonb)'::regprocedure))>0);")" "t"

# N1 — [#4] dono autenticado cria com _expected_owner=NULL → RAISE (obrigatório)
R=$(P -tA 2>&1 <<'SQL'
SET test.uid='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'; SET test.role='authenticated'; SET ROLE authenticated;
DO $$ DECLARE _id uuid; BEGIN
  _id := public.criar_plano_tatico('50000000-0000-0000-0000-000000000001'::uuid, NULL,'{}'::jsonb);
  RAISE NOTICE 'N1_NAO_BARROU';
EXCEPTION WHEN raise_exception THEN RAISE NOTICE 'N1_EXIGE_OK'; WHEN OTHERS THEN RAISE; END $$;
SQL
)
case "$R" in *N1_EXIGE_OK*) ok "N1 [#4] autenticado SEM expected_owner é barrado";; *) bad "N1 — veio: $R";; esac

# P3 — dono registra PLAN_X (gerado) → concluido
Pq -c "SET test.uid='$OWNER_A'; SET test.role='authenticated'; SET ROLE authenticated; SELECT public.registrar_resultado_plano('$PLAN_X'::uuid,true,'ganho',30.5,600,NULL,NULL);" >/dev/null
eq "P3 registrar (gerado→concluido)" "$(Pq -c "SELECT status FROM public.farmer_tactical_plans WHERE id='$PLAN_X';")" "concluido"

# N2 — [#5] registrar de novo um plano JÁ concluído → RAISE (não reescreve)
R=$(P -tA 2>&1 <<SQL
SET test.uid='$OWNER_A'; SET test.role='authenticated'; SET ROLE authenticated;
DO \$\$ BEGIN
  PERFORM public.registrar_resultado_plano('$PLAN_X'::uuid,false,'perdido',9.9,100,NULL,NULL);
  RAISE NOTICE 'N2_NAO_BARROU';
EXCEPTION WHEN raise_exception THEN RAISE NOTICE 'N2_IMUTAVEL_OK'; WHEN OTHERS THEN RAISE; END \$\$;
SQL
)
case "$R" in *N2_IMUTAVEL_OK*) ok "N2 [#5] resultado de plano concluído NÃO é reescrito";; *) bad "N2 — veio: $R";; esac
eq "N2 actual_margin intacto (não reescrito)" "$(Pq -c "SELECT actual_margin FROM public.farmer_tactical_plans WHERE id='$PLAN_X';")" "30.5"

# ── ZONA 4: FALSIFICAÇÃO ──
echo "── falsificação ──"
restaura() { P -q -f "$MIG"; }

# F1 [#4] — remove o null-check → N1 (expected_owner NULL) passa a CRIAR
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.criar_plano_tatico(_customer_user_id uuid,_expected_owner uuid,_payload jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
DECLARE _uid uuid:=auth.uid(); _is_service boolean:=COALESCE(auth.role()='service_role',false); _owner uuid; _new_id uuid;
BEGIN
  IF NOT _is_service THEN
    IF _uid IS NULL THEN RAISE EXCEPTION 'na' USING ERRCODE='42501'; END IF;
    IF NOT public.carteira_visivel_para(_customer_user_id,_uid) THEN RAISE EXCEPTION 'fora' USING ERRCODE='42501'; END IF;
    -- NULL-CHECK REMOVIDO (sabotagem)
  END IF;
  SELECT a.owner_user_id INTO _owner FROM public.carteira_assignments a WHERE a.customer_user_id=_customer_user_id FOR UPDATE;
  IF _owner IS NULL THEN RAISE EXCEPTION 'sem dono'; END IF;
  IF _expected_owner IS NOT NULL AND _owner <> _expected_owner THEN RAISE EXCEPTION 'race'; END IF;
  INSERT INTO public.farmer_tactical_plans(farmer_id,customer_user_id,status,strategic_objective) VALUES (_owner,_customer_user_id,'gerado','upsell_premium') RETURNING id INTO _new_id;
  RETURN _new_id;
END $fn$;
SQL
R=$(P -tA 2>&1 <<'SQL'
SET test.uid='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'; SET test.role='authenticated'; SET ROLE authenticated;
DO $$ DECLARE _id uuid; BEGIN
  _id := public.criar_plano_tatico('50000000-0000-0000-0000-000000000001'::uuid, NULL,'{}'::jsonb);
  RAISE NOTICE 'N1_NAO_BARROU';
EXCEPTION WHEN raise_exception THEN RAISE NOTICE 'N1_EXIGE_OK'; WHEN OTHERS THEN RAISE; END $$;
SQL
)
case "$R" in *N1_NAO_BARROU*) ok "F1 sem o null-check, expected_owner NULL passa → N1 tem dente";; *) bad "F1 sabotei e N1 não mudou: $R";; esac
restaura

# F2 [#5] — remove o status-guard → N2 (registrar concluído de novo) passa a REESCREVER
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.registrar_resultado_plano(_plan_id uuid,_plan_followed boolean,_call_result text,_actual_margin numeric,_call_duration_seconds integer,_objection_type text DEFAULT NULL,_notes text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
DECLARE _uid uuid:=auth.uid(); _is_service boolean:=COALESCE(auth.role()='service_role',false); _customer uuid; _status text;
BEGIN
  SELECT p.customer_user_id,p.status INTO _customer,_status FROM public.farmer_tactical_plans p WHERE p.id=_plan_id;
  IF _customer IS NULL THEN RAISE EXCEPTION 'inexistente'; END IF;
  IF NOT _is_service THEN
    IF _uid IS NULL THEN RAISE EXCEPTION 'na' USING ERRCODE='42501'; END IF;
    IF NOT public.carteira_visivel_para(_customer,_uid) THEN RAISE EXCEPTION 'fora' USING ERRCODE='42501'; END IF;
  END IF;
  -- STATUS-GUARD REMOVIDO (sabotagem)
  UPDATE public.farmer_tactical_plans SET actual_margin=_actual_margin, status='concluido', updated_at=now() WHERE id=_plan_id;
END $fn$;
SQL
P -q -c "SET test.uid='$OWNER_A'; SET test.role='authenticated'; SET ROLE authenticated; SELECT public.registrar_resultado_plano('$PLAN_X'::uuid,false,'perdido',9.9,100,NULL,NULL);" >/dev/null
M=$(Pq -c "SELECT actual_margin FROM public.farmer_tactical_plans WHERE id='$PLAN_X';")
if [ "$M" = "9.9" ]; then ok "F2 sem o status-guard, plano concluído é reescrito → N2 tem dente"; else bad "F2 sabotei e N2 não mudou (margin=$M)"; fi
restaura

# F3 [#3] — recria criar SEM FOR UPDATE → o invariante de presença fica vermelho
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.criar_plano_tatico(_customer_user_id uuid,_expected_owner uuid,_payload jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
DECLARE _owner uuid; _new_id uuid;
BEGIN
  SELECT a.owner_user_id INTO _owner FROM public.carteira_assignments a WHERE a.customer_user_id=_customer_user_id; -- lock pessimista removido (sabotagem)
  IF _owner IS NULL THEN RAISE EXCEPTION 'sem dono'; END IF;
  INSERT INTO public.farmer_tactical_plans(farmer_id,customer_user_id,status,strategic_objective) VALUES (_owner,_customer_user_id,'gerado','upsell_premium') RETURNING id INTO _new_id;
  RETURN _new_id;
END $fn$;
SQL
HASLOCK=$(Pq -c "SELECT (position('FOR UPDATE' IN pg_get_functiondef('public.criar_plano_tatico(uuid,uuid,jsonb)'::regprocedure))>0);")
if [ "$HASLOCK" = "f" ]; then ok "F3 sem FOR UPDATE, o invariante de presença fica vermelho → tem dente"; else bad "F3 sabotei o FOR UPDATE e a presença não mudou"; fi
restaura

echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
