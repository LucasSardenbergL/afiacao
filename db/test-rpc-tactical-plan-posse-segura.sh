#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA PG17 — RPCs de escrita de plano tático (posse + autorização)           ║
# ║  migration: 20260623180000_rpc_tactical_plan_posse_segura.sql                 ║
# ║  Rode:  bash db/test-rpc-tactical-plan-posse-segura.sh > /tmp/t.log 2>&1; echo $? ║
# ║  (NÃO pipe pra tail — engole o exit≠0; §2 do CLAUDE.md.)                       ║
# ║                                                                                ║
# ║  Prova: gate carteira_visivel_para (achados #1 registrar + #2 criar), posse   ║
# ║  re-resolvida server-side = DONO (não executor), abort no race de reatribuição ║
# ║  e em cliente sem dono, bypass service_role. Falsifica cada defesa (F1-F4).    ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5473}"     # mude se rodar em paralelo com outro harness
SLUG="tactplan-posse"
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

# ── identidades (mesmos literais nos blocos DO heredoc <<'SQL') ──
MASTER='11111111-1111-1111-1111-111111111111'
OWNER_A='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
OWNER_B='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
COVER_C='cccccccc-cccc-cccc-cccc-cccccccccccc'
STAFF_E='eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'
CUST_X='50000000-0000-0000-0000-000000000001'   # dono = A
CUST_Y='50000000-0000-0000-0000-000000000002'   # SEM dono (sem carteira_assignment)
PAYLOAD='{"health_score":55,"churn_risk":12,"mix_gap":4,"current_margin_pct":22,"cluster_avg_margin_pct":28,"expansion_potential":30,"strategic_objective":"upsell_premium","customer_profile":"misto","plan_type":"essencial","top_bundle":{"p":"X1"},"second_bundle":{},"bundle_lie":10,"bundle_probability":0.4,"bundle_incremental_margin":12,"best_individual_lie":0,"diagnostic_questions":[],"implication_question":"q","offer_transition":"o","probable_objections":[],"approach_strategy":"a","approach_strategy_b":"b","ltv_projection":null,"expected_result":null,"operational_risks":[]}'

echo "═══ setup pronto (PG17 :$PORT) ═══"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — PRÉ-REQUISITOS (o que a migração LÊ mas não cria) — fiéis a prod
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
DO $$ BEGIN CREATE TYPE public.app_role AS ENUM ('master','employee','customer'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.user_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL, role public.app_role NOT NULL,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now()
);
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $f$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id=_user_id AND role=_role) $f$;

CREATE TABLE IF NOT EXISTS public.carteira_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_user_id uuid NOT NULL UNIQUE,
  owner_user_id uuid NOT NULL,
  source text NOT NULL DEFAULT 'omie',
  eligible boolean NOT NULL DEFAULT true,
  valid_from timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public.carteira_coverage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  covering_user_id uuid NOT NULL, covered_user_id uuid NOT NULL,
  valid_from timestamptz NOT NULL DEFAULT now(), valid_until timestamptz,
  active boolean NOT NULL DEFAULT true, created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION public.carteira_visivel_para(_customer_user_id uuid, _uid uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $f$
  SELECT has_role(_uid,'master'::app_role)
    OR EXISTS (SELECT 1 FROM carteira_assignments a WHERE a.customer_user_id=_customer_user_id AND a.owner_user_id=_uid)
    OR EXISTS (SELECT 1 FROM carteira_assignments a JOIN carteira_coverage c ON c.covered_user_id=a.owner_user_id
               WHERE a.customer_user_id=_customer_user_id AND c.covering_user_id=_uid
                 AND c.active AND (c.valid_until IS NULL OR c.valid_until>now()));
$f$;

-- farmer_tactical_plans: colunas reais (recon psql-ro)
CREATE TABLE IF NOT EXISTS public.farmer_tactical_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farmer_id uuid NOT NULL,
  customer_user_id uuid NOT NULL,
  bundle_recommendation_id uuid,
  health_score numeric DEFAULT 0, churn_risk numeric DEFAULT 0, mix_gap integer DEFAULT 0,
  current_margin_pct numeric DEFAULT 0, cluster_avg_margin_pct numeric DEFAULT 0, expansion_potential numeric DEFAULT 0,
  strategic_objective text NOT NULL DEFAULT 'expansao_mix', customer_profile text DEFAULT 'misto',
  top_bundle jsonb DEFAULT '{}', bundle_lie numeric DEFAULT 0, bundle_probability numeric DEFAULT 0,
  bundle_incremental_margin numeric DEFAULT 0, best_individual_lie numeric DEFAULT 0,
  diagnostic_questions jsonb DEFAULT '[]', implication_question text, offer_transition text,
  probable_objections jsonb DEFAULT '[]', approach_strategy text,
  plan_followed boolean, call_result text, actual_margin numeric, call_duration_seconds integer,
  objection_type text, notes text, effectiveness_score numeric,
  status text DEFAULT 'gerado', generated_at timestamptz DEFAULT now(), used_at timestamptz,
  completed_at timestamptz, created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(),
  plan_type text DEFAULT 'essencial', approach_strategy_b text, second_bundle jsonb DEFAULT '{}',
  ltv_projection jsonb, expected_result jsonb, operational_risks jsonb DEFAULT '[]'
);
ALTER TABLE public.farmer_tactical_plans ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Staff can manage tactical plans" ON public.farmer_tactical_plans;
CREATE POLICY "Staff can manage tactical plans" ON public.farmer_tactical_plans
  FOR ALL USING (has_role(auth.uid(),'master') OR has_role(auth.uid(),'employee'))
  WITH CHECK (has_role(auth.uid(),'master') OR has_role(auth.uid(),'employee'));
SQL

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — APLICAR A MIGRATION REAL (Lei #1)
# ══════════════════════════════════════════════════════════════════════════════
MIG="$REPO_ROOT/supabase/migrations/20260623180000_rpc_tactical_plan_posse_segura.sql"
P -q -f "$MIG"
echo "migration aplicada: $(basename "$MIG")"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 3 — SEED (como postgres; superuser ignora RLS e tem privilégio)
# ══════════════════════════════════════════════════════════════════════════════
P -q <<SQL
INSERT INTO auth.users(id) VALUES
  ('$MASTER'),('$OWNER_A'),('$OWNER_B'),('$COVER_C'),('$STAFF_E'),('$CUST_X'),('$CUST_Y') ON CONFLICT DO NOTHING;
INSERT INTO public.user_roles(user_id, role) VALUES
  ('$MASTER','master'),('$OWNER_A','employee'),('$OWNER_B','employee'),
  ('$COVER_C','employee'),('$STAFF_E','employee') ON CONFLICT DO NOTHING;
INSERT INTO public.carteira_assignments(customer_user_id, owner_user_id, source) VALUES
  ('$CUST_X','$OWNER_A','omie') ON CONFLICT DO NOTHING;
INSERT INTO public.carteira_coverage(covering_user_id, covered_user_id, active, created_by) VALUES
  ('$COVER_C','$OWNER_A',true,'$MASTER') ON CONFLICT DO NOTHING;
SQL

echo "── asserts ──"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4 — ASSERTS
# ══════════════════════════════════════════════════════════════════════════════

# P1 — dono A cria plano de X: posse = A, status = gerado
PLAN_X=$(Pq -c "SET test.uid='$OWNER_A'; SET test.role='authenticated'; SET ROLE authenticated; SELECT public.criar_plano_tatico('$CUST_X'::uuid,'$OWNER_A'::uuid,'$PAYLOAD'::jsonb);" | tail -1)
eq "P1 retorna id"        "$(test -n "$PLAN_X" && echo ok)" "ok"
eq "P1 posse = dono A"    "$(Pq -c "SELECT farmer_id FROM public.farmer_tactical_plans WHERE id='$PLAN_X';")" "$OWNER_A"
eq "P1 status = gerado"   "$(Pq -c "SELECT status FROM public.farmer_tactical_plans WHERE id='$PLAN_X';")" "gerado"

# P2 — cobridor C cria plano de X: posse = DONO A (não o executor C)
PLAN_C=$(Pq -c "SET test.uid='$COVER_C'; SET test.role='authenticated'; SET ROLE authenticated; SELECT public.criar_plano_tatico('$CUST_X'::uuid,'$OWNER_A'::uuid,'$PAYLOAD'::jsonb);" | tail -1)
eq "P2 cobridor grava posse = DONO A (não C)" "$(Pq -c "SELECT farmer_id FROM public.farmer_tactical_plans WHERE id='$PLAN_C';")" "$OWNER_A"

# P3 — master cria: ok
PLAN_M=$(Pq -c "SET test.uid='$MASTER'; SET test.role='authenticated'; SET ROLE authenticated; SELECT public.criar_plano_tatico('$CUST_X'::uuid,'$OWNER_A'::uuid,'$PAYLOAD'::jsonb);" | tail -1)
eq "P3 master cria (posse=A)" "$(Pq -c "SELECT farmer_id FROM public.farmer_tactical_plans WHERE id='$PLAN_M';")" "$OWNER_A"

# P4 — service_role (cron) com uid que NÃO vê X: bypassa o gate, posse ainda = A
PLAN_S=$(Pq -c "SET test.uid='$STAFF_E'; SET test.role='service_role'; SET ROLE service_role; SELECT public.criar_plano_tatico('$CUST_X'::uuid,'$OWNER_A'::uuid,'$PAYLOAD'::jsonb);" | tail -1)
eq "P4 service_role bypassa gate (posse=A)" "$(Pq -c "SELECT farmer_id FROM public.farmer_tactical_plans WHERE id='$PLAN_S';")" "$OWNER_A"

# N1 — [#2 autz] staff E (não vê X) cria → 42501 (gate). "não barrou" via NOTICE (≠ exception → sem colisão de SQLSTATE).
R=$(P -tA 2>&1 <<'SQL'
SET test.uid='eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'; SET test.role='authenticated'; SET ROLE authenticated;
DO $$ DECLARE _id uuid; BEGIN
  _id := public.criar_plano_tatico('50000000-0000-0000-0000-000000000001'::uuid,'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid,'{}'::jsonb);
  RAISE NOTICE 'N1_NAO_BARROU';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'N1_GATE_OK'; WHEN OTHERS THEN RAISE; END $$;
SQL
)
case "$R" in *N1_GATE_OK*) ok "N1 staff fora da carteira NÃO cria (#2 autz)";; *) bad "N1 — veio: $R";; esac

# N3 — [#2 race] A cria com expected_owner=B (≠ dono atual A) → aborta (raise_exception).
R=$(P -tA 2>&1 <<'SQL'
SET test.uid='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'; SET test.role='authenticated'; SET ROLE authenticated;
DO $$ DECLARE _id uuid; BEGIN
  _id := public.criar_plano_tatico('50000000-0000-0000-0000-000000000001'::uuid,'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'::uuid,'{}'::jsonb);
  RAISE NOTICE 'N3_NAO_BARROU';
EXCEPTION WHEN raise_exception THEN RAISE NOTICE 'N3_RACE_OK'; WHEN OTHERS THEN RAISE; END $$;
SQL
)
case "$R" in *N3_RACE_OK*) ok "N3 race de reatribuição (dono≠esperado) aborta";; *) bad "N3 — veio: $R";; esac

# N4 — cliente Y sem dono → aborta (master passa o gate, mas não há owner).
R=$(P -tA 2>&1 <<'SQL'
SET test.uid='11111111-1111-1111-1111-111111111111'; SET test.role='authenticated'; SET ROLE authenticated;
DO $$ DECLARE _id uuid; BEGIN
  _id := public.criar_plano_tatico('50000000-0000-0000-0000-000000000002'::uuid, NULL,'{}'::jsonb);
  RAISE NOTICE 'N4_NAO_BARROU';
EXCEPTION WHEN raise_exception THEN RAISE NOTICE 'N4_SEMDONO_OK'; WHEN OTHERS THEN RAISE; END $$;
SQL
)
case "$R" in *N4_SEMDONO_OK*) ok "N4 cliente sem dono aborta (não fabrica posse)";; *) bad "N4 — veio: $R";; esac

# N5 — não autenticado (uid e role nulos) → 42501.
R=$(P -tA 2>&1 <<'SQL'
SET test.uid=''; SET test.role=''; SET ROLE authenticated;
DO $$ DECLARE _id uuid; BEGIN
  _id := public.criar_plano_tatico('50000000-0000-0000-0000-000000000001'::uuid,'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid,'{}'::jsonb);
  RAISE NOTICE 'N5_NAO_BARROU';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'N5_ANON_OK'; WHEN OTHERS THEN RAISE; END $$;
SQL
)
case "$R" in *N5_ANON_OK*) ok "N5 não autenticado NÃO cria";; *) bad "N5 — veio: $R";; esac

# N2 — [#1 autz] staff E (não vê X) registra resultado de PLAN_X → 42501 (gate). PLAN_X intacto.
R=$(P -tA 2>&1 <<SQL
SET test.uid='$STAFF_E'; SET test.role='authenticated'; SET ROLE authenticated;
DO \$\$ BEGIN
  PERFORM public.registrar_resultado_plano('$PLAN_X'::uuid, true, 'ganho', 30.5, 600, NULL, NULL);
  RAISE NOTICE 'N2_NAO_BARROU';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'N2_GATE_OK'; WHEN OTHERS THEN RAISE; END \$\$;
SQL
)
case "$R" in *N2_GATE_OK*) ok "N2 staff fora da carteira NÃO registra resultado (#1 autz)";; *) bad "N2 — veio: $R";; esac
eq "N2 PLAN_X intacto (status segue gerado)" "$(Pq -c "SELECT status FROM public.farmer_tactical_plans WHERE id='$PLAN_X';")" "gerado"

# P5 — cobridor C registra resultado de PLAN_X (cobre A) → concluido + actual_margin
Pq -c "SET test.uid='$COVER_C'; SET test.role='authenticated'; SET ROLE authenticated; SELECT public.registrar_resultado_plano('$PLAN_X'::uuid, true, 'ganho', 30.5, 600, 'preco', 'ok');" >/dev/null
eq "P5 cobridor registra: status concluido" "$(Pq -c "SELECT status FROM public.farmer_tactical_plans WHERE id='$PLAN_X';")" "concluido"
eq "P5 actual_margin gravado"               "$(Pq -c "SELECT actual_margin FROM public.farmer_tactical_plans WHERE id='$PLAN_X';")" "30.5"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICAÇÃO (sabota uma defesa → exige VERMELHO → restaura)
# ══════════════════════════════════════════════════════════════════════════════
echo "── falsificação ──"
restaura() { P -q -f "$MIG"; }

# F1 — gate de criar tem dente: recria SEM o gate carteira_visivel_para → N1 (staff E) passa a CRIAR.
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.criar_plano_tatico(_customer_user_id uuid,_expected_owner uuid,_payload jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
DECLARE _owner uuid; _rec public.farmer_tactical_plans; _new_id uuid;
BEGIN
  -- GATE REMOVIDO (sabotagem)
  SELECT a.owner_user_id INTO _owner FROM public.carteira_assignments a WHERE a.customer_user_id=_customer_user_id;
  IF _owner IS NULL THEN RAISE EXCEPTION 'sem dono'; END IF;
  IF _expected_owner IS NOT NULL AND _owner <> _expected_owner THEN RAISE EXCEPTION 'race'; END IF;
  _rec := jsonb_populate_record(NULL::public.farmer_tactical_plans,_payload);
  INSERT INTO public.farmer_tactical_plans(farmer_id,customer_user_id,status,strategic_objective)
  VALUES (_owner,_customer_user_id,'gerado',COALESCE(_rec.strategic_objective,'expansao_mix')) RETURNING id INTO _new_id;
  RETURN _new_id;
END $fn$;
SQL
R=$(P -tA 2>&1 <<'SQL'
SET test.uid='eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'; SET test.role='authenticated'; SET ROLE authenticated;
DO $$ DECLARE _id uuid; BEGIN
  _id := public.criar_plano_tatico('50000000-0000-0000-0000-000000000001'::uuid,'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'::uuid,'{}'::jsonb);
  RAISE NOTICE 'N1_NAO_BARROU';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'N1_GATE_OK'; WHEN OTHERS THEN RAISE; END $$;
SQL
)
case "$R" in *N1_NAO_BARROU*) ok "F1 sem o gate, staff fora da carteira CRIA → N1 tem dente";; *) bad "F1 sabotei o gate e N1 não mudou: $R";; esac
restaura

# F2 — abort no race tem dente: recria SEM o check expected_owner → N3 (expected=B) passa a CRIAR.
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.criar_plano_tatico(_customer_user_id uuid,_expected_owner uuid,_payload jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
DECLARE _uid uuid:=auth.uid(); _is_service boolean:=(auth.role()='service_role'); _owner uuid; _rec public.farmer_tactical_plans; _new_id uuid;
BEGIN
  IF NOT _is_service THEN
    IF _uid IS NULL THEN RAISE EXCEPTION 'na' USING ERRCODE='42501'; END IF;
    IF NOT public.carteira_visivel_para(_customer_user_id,_uid) THEN RAISE EXCEPTION 'fora' USING ERRCODE='42501'; END IF;
  END IF;
  SELECT a.owner_user_id INTO _owner FROM public.carteira_assignments a WHERE a.customer_user_id=_customer_user_id;
  IF _owner IS NULL THEN RAISE EXCEPTION 'sem dono'; END IF;
  -- CHECK DE RACE REMOVIDO (sabotagem)
  _rec := jsonb_populate_record(NULL::public.farmer_tactical_plans,_payload);
  INSERT INTO public.farmer_tactical_plans(farmer_id,customer_user_id,status,strategic_objective)
  VALUES (_owner,_customer_user_id,'gerado',COALESCE(_rec.strategic_objective,'expansao_mix')) RETURNING id INTO _new_id;
  RETURN _new_id;
END $fn$;
SQL
R=$(P -tA 2>&1 <<'SQL'
SET test.uid='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'; SET test.role='authenticated'; SET ROLE authenticated;
DO $$ DECLARE _id uuid; BEGIN
  _id := public.criar_plano_tatico('50000000-0000-0000-0000-000000000001'::uuid,'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'::uuid,'{}'::jsonb);
  RAISE NOTICE 'N3_NAO_BARROU';
EXCEPTION WHEN raise_exception THEN RAISE NOTICE 'N3_RACE_OK'; WHEN OTHERS THEN RAISE; END $$;
SQL
)
case "$R" in *N3_NAO_BARROU*) ok "F2 sem o check, race grava dono stale → N3 tem dente";; *) bad "F2 sabotei o race-check e N3 não mudou: $R";; esac
restaura

# F3 — posse server-side tem dente: recria gravando farmer_id = _uid (executor) → P2 grava C, não A.
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.criar_plano_tatico(_customer_user_id uuid,_expected_owner uuid,_payload jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
DECLARE _uid uuid:=auth.uid(); _is_service boolean:=(auth.role()='service_role'); _owner uuid; _rec public.farmer_tactical_plans; _new_id uuid;
BEGIN
  IF NOT _is_service THEN
    IF _uid IS NULL THEN RAISE EXCEPTION 'na' USING ERRCODE='42501'; END IF;
    IF NOT public.carteira_visivel_para(_customer_user_id,_uid) THEN RAISE EXCEPTION 'fora' USING ERRCODE='42501'; END IF;
  END IF;
  SELECT a.owner_user_id INTO _owner FROM public.carteira_assignments a WHERE a.customer_user_id=_customer_user_id;
  IF _owner IS NULL THEN RAISE EXCEPTION 'sem dono'; END IF;
  _rec := jsonb_populate_record(NULL::public.farmer_tactical_plans,_payload);
  INSERT INTO public.farmer_tactical_plans(farmer_id,customer_user_id,status,strategic_objective)
  VALUES (_uid,_customer_user_id,'gerado',COALESCE(_rec.strategic_objective,'expansao_mix')) RETURNING id INTO _new_id; -- POSSE=EXECUTOR (sabotagem)
  RETURN _new_id;
END $fn$;
SQL
PLAN_F3=$(Pq -c "SET test.uid='$COVER_C'; SET test.role='authenticated'; SET ROLE authenticated; SELECT public.criar_plano_tatico('$CUST_X'::uuid,'$OWNER_A'::uuid,'$PAYLOAD'::jsonb);" | tail -1)
F3_FARMER=$(Pq -c "SELECT farmer_id FROM public.farmer_tactical_plans WHERE id='$PLAN_F3';")
if [ "$F3_FARMER" = "$COVER_C" ]; then ok "F3 sabotado grava executor (C), não dono → P2 tem dente"; else bad "F3 sabotei a posse e P2 não mudou (veio $F3_FARMER)"; fi
restaura

# F4 — gate de registrar tem dente: recria SEM o gate → N2 (staff E) passa a ATUALIZAR plano alheio.
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.registrar_resultado_plano(_plan_id uuid,_plan_followed boolean,_call_result text,_actual_margin numeric,_call_duration_seconds integer,_objection_type text DEFAULT NULL,_notes text DEFAULT NULL)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $fn$
DECLARE _customer uuid;
BEGIN
  SELECT p.customer_user_id INTO _customer FROM public.farmer_tactical_plans p WHERE p.id=_plan_id;
  IF _customer IS NULL THEN RAISE EXCEPTION 'inexistente'; END IF;
  -- GATE REMOVIDO (sabotagem)
  UPDATE public.farmer_tactical_plans SET call_result=_call_result, status='concluido', updated_at=now() WHERE id=_plan_id;
END $fn$;
SQL
# CTE terminando em SELECT → saída = só o uuid (INSERT..RETURNING cru imprime o tag 'INSERT 0 1' e polui o tail)
PLAN_N2=$(Pq -c "WITH ins AS (INSERT INTO public.farmer_tactical_plans(farmer_id,customer_user_id,status) VALUES ('$OWNER_A','$CUST_X','gerado') RETURNING id) SELECT id FROM ins;" | tail -1)
R=$(P -tA 2>&1 <<SQL
SET test.uid='$STAFF_E'; SET test.role='authenticated'; SET ROLE authenticated;
DO \$\$ BEGIN
  PERFORM public.registrar_resultado_plano('$PLAN_N2'::uuid, true, 'ganho', 30.5, 600, NULL, NULL);
  RAISE NOTICE 'N2_NAO_BARROU';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'N2_GATE_OK'; WHEN OTHERS THEN RAISE; END \$\$;
SQL
)
case "$R" in *N2_NAO_BARROU*) ok "F4 sem o gate, staff fora da carteira REGISTRA alheio → N2 tem dente";; *) bad "F4 sabotei o gate de registrar e N2 não mudou: $R";; esac
restaura

# ── veredito ──
echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
