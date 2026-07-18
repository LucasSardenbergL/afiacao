#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║ PROVA PG17 — hotfix dos 4 callers órfãos do FU7 (#1421)                       ║
# ║ Migration: 20260718170000_fu7_conserta_callers_orfaos.sql                     ║
# ║   bash db/test-fu7-callers-orfaos.sh > /tmp/t.log 2>&1; echo $?                ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
# O QUE ESTA PROVA TRAVA: o #1421 moveu `carteira_visivel_para`/`is_super_admin` de
# `public` p/ `private` e não atualizou os 4 callers PL/pgSQL, que qualificam com
# `public.` EXPLÍCITO. `CREATE OR REPLACE`/`SET SCHEMA` NÃO validam o corpo ⇒ as 4
# funções só quebram ao EXECUTAR, com 42883 undefined_function.
#
# ⇒ Todo assert aqui EXECUTA a função. Um teste que só confira o TEXTO da definição
#   (grep por 'private.') passaria verde com a função quebrada — é exatamente o
#   falso-verde que o late-bound produz.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5472}"
SLUG="fu7-callers"
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

MASTER='10000000-0000-0000-0000-000000000001'
VEND_A='30000000-0000-0000-0000-000000000003'
CLI_OK='a0000000-0000-0000-0000-0000000000aa'

echo "═══ setup pronto (PG17 :$PORT) ═══"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — o estado PÓS-#1421: helpers em `private`, AUSENTES em `public`
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
CREATE SCHEMA IF NOT EXISTS private;
DO $$ BEGIN CREATE TYPE public.app_role AS ENUM ('master','employee','customer'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE public.commercial_role AS ENUM ('vendedor','gerencial','estrategico','super_admin'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS public.user_roles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, role public.app_role NOT NULL);
CREATE TABLE IF NOT EXISTS public.commercial_roles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, role public.commercial_role NOT NULL);
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $f$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id=_user_id AND role=_role) $f$;
CREATE OR REPLACE FUNCTION public.get_commercial_role(_uid uuid)
RETURNS public.commercial_role LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $f$ SELECT role FROM public.commercial_roles WHERE user_id=_uid LIMIT 1 $f$;
CREATE OR REPLACE FUNCTION public.pode_ver_carteira_completa(_uid uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $f$ SELECT has_role(_uid,'master'::app_role) OR (has_role(_uid,'employee'::app_role)
   AND get_commercial_role(_uid) IN ('gerencial'::commercial_role,'estrategico'::commercial_role,'super_admin'::commercial_role)) $f$;

CREATE TABLE IF NOT EXISTS public.carteira_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_user_id uuid NOT NULL UNIQUE, owner_user_id uuid NOT NULL,
  source text NOT NULL DEFAULT 'omie', eligible boolean NOT NULL DEFAULT true,
  valid_from timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS public.carteira_coverage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), covering_user_id uuid NOT NULL, covered_user_id uuid NOT NULL,
  valid_from timestamptz NOT NULL DEFAULT now(), valid_until timestamptz, active boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL DEFAULT gen_random_uuid(), created_at timestamptz NOT NULL DEFAULT now());

-- ⚠️ O ESTADO QUE O #1421 DEIXOU: helper existe SÓ em `private`. Nenhum wrapper em `public`.
--    Sem isto o harness "prova" um mundo onde public.carteira_visivel_para ainda existe,
--    e o hotfix passaria verde mesmo estando errado.
CREATE OR REPLACE FUNCTION private.carteira_visivel_para(_customer_user_id uuid, _uid uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $f$
  SELECT _uid IS NOT NULL AND (
    COALESCE(public.has_role(_uid,'master'::app_role),false)
    OR EXISTS (SELECT 1 FROM public.carteira_assignments a
               WHERE a.customer_user_id=_customer_user_id AND a.owner_user_id=_uid AND a.eligible IS TRUE)
    OR EXISTS (SELECT 1 FROM public.carteira_assignments a
               JOIN public.carteira_coverage c ON c.covered_user_id=a.owner_user_id
               WHERE a.customer_user_id=_customer_user_id AND a.eligible IS TRUE
                 AND c.covering_user_id=_uid AND c.active AND (c.valid_until IS NULL OR c.valid_until>now())));
$f$;
CREATE OR REPLACE FUNCTION private.is_super_admin(_uid uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $f$ SELECT COALESCE(public.get_commercial_role(_uid) = 'super_admin'::public.commercial_role, false) $f$;

CREATE TABLE IF NOT EXISTS public.farmer_tactical_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), farmer_id uuid NOT NULL, customer_user_id uuid NOT NULL,
  bundle_recommendation_id uuid, health_score numeric, churn_risk numeric, mix_gap integer,
  current_margin_pct numeric, cluster_avg_margin_pct numeric, expansion_potential numeric,
  strategic_objective text NOT NULL DEFAULT 'expansao_mix', customer_profile text,
  top_bundle jsonb, bundle_lie numeric, bundle_probability numeric, bundle_incremental_margin numeric,
  best_individual_lie numeric, diagnostic_questions jsonb, implication_question text, offer_transition text,
  probable_objections jsonb, approach_strategy text, plan_followed boolean, call_result text,
  actual_margin numeric, call_duration_seconds integer, objection_type text, notes text, effectiveness_score numeric,
  status text DEFAULT 'gerado', generated_at timestamptz DEFAULT now(), used_at timestamptz, completed_at timestamptz,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now(), plan_type text,
  approach_strategy_b text, second_bundle jsonb, ltv_projection jsonb, expected_result jsonb, operational_risks jsonb);

CREATE TABLE IF NOT EXISTS public.route_contact_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), data_rota date NOT NULL, customer_user_id uuid NOT NULL,
  farmer_id uuid NOT NULL, canal text NOT NULL, valor_da_ligacao numeric, bucket text, status text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now());

CREATE TABLE IF NOT EXISTS public.company_config (key text PRIMARY KEY, value text);
SQL

# o trigger de máscara do #1422 também vive nesta tabela — aplicar a migration anterior
# mantém o harness fiel à prod (as duas convivem).
P -q -f "$REPO_ROOT/supabase/migrations/20260718160000_tactical_plans_eligible_fail_closed.sql" >/dev/null 2>&1 || true
echo "pré-req: estado pós-#1421 (helpers só em private) + trigger do #1422"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — a migration REAL sob teste
# ══════════════════════════════════════════════════════════════════════════════
MIG="$REPO_ROOT/supabase/migrations/20260718170000_fu7_conserta_callers_orfaos.sql"
P -q -f "$MIG"
echo "migration aplicada: $(basename "$MIG")"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 3 — seeds
# ══════════════════════════════════════════════════════════════════════════════
P -q <<SQL
INSERT INTO auth.users(id) VALUES ('$MASTER'),('$VEND_A'),('$CLI_OK') ON CONFLICT DO NOTHING;
INSERT INTO public.user_roles(user_id, role) VALUES ('$MASTER','master'),('$VEND_A','employee');
INSERT INTO public.commercial_roles(user_id, role) VALUES ('$VEND_A','vendedor');
INSERT INTO public.carteira_assignments(customer_user_id, owner_user_id, eligible) VALUES ('$CLI_OK','$VEND_A', true);
INSERT INTO public.company_config(key, value) VALUES ('master_cpf','00000000000');
CREATE TRIGGER protect_master_config_trigger BEFORE INSERT OR UPDATE OR DELETE ON public.company_config
  FOR EACH ROW EXECUTE FUNCTION public.protect_master_config();
SQL
echo "seeds ok"

# Executa um comando e classifica em sentinelas MINHAS. O que importa é distinguir
# "42883 undefined_function" (o bug do FU7) de qualquer outro desfecho.
exec_sql() { # $1=uid $2=role $3=SQL
  P -tA 2>&1 <<SQL
SET test.uid='$1';
SET test.role='$2';
DO \$\$
DECLARE v_out text := 'OK';
BEGIN
  BEGIN
    $3
  EXCEPTION
    WHEN undefined_function THEN v_out := 'ORFA_42883';   -- o bug que este hotfix conserta
    WHEN insufficient_privilege THEN v_out := 'GATE_42501';
    WHEN raise_exception THEN v_out := 'GATE_P0001';
    WHEN OTHERS THEN v_out := 'OUTRO_'||SQLSTATE;
  END;
  RAISE NOTICE 'RES=%', v_out;
END \$\$;
SQL
}
espera() { case "$2" in *"RES=$3"*) ok "$1 ($3)" ;; *) bad "$1 — esperado RES=$3, veio: $(echo "$2" | tr '\n' ' ' | tail -c 110)" ;; esac; }

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4 — ASSERTS: cada função é EXECUTADA (late-bound só aparece rodando)
# ══════════════════════════════════════════════════════════════════════════════
echo "── A. as 4 funções resolvem o helper e EXECUTAM ──"
espera "A1 criar_plano_tatico (owner legítimo) executa" \
  "$(exec_sql "$VEND_A" 'authenticated' "PERFORM public.criar_plano_tatico('$CLI_OK'::uuid, '$VEND_A'::uuid, '{}'::jsonb);")" 'OK'
PID=$(Pq -c "SELECT id FROM public.farmer_tactical_plans LIMIT 1;")
espera "A2 registrar_resultado_plano (owner legítimo) executa" \
  "$(exec_sql "$VEND_A" 'authenticated' "PERFORM public.registrar_resultado_plano('$PID'::uuid, true, 'ganhou', 40, 600, NULL, NULL);")" 'OK'
espera "A3 registrar_contato_rota (owner legítimo) executa" \
  "$(exec_sql "$VEND_A" 'authenticated' "PERFORM public.registrar_contato_rota('$CLI_OK'::uuid, 'respondido', CURRENT_DATE, NULL, NULL);")" 'OK'
espera "A4 protect_master_config: super_admin ausente ⇒ bloqueia pelo GATE (não por 42883)" \
  "$(exec_sql "$VEND_A" 'authenticated' "UPDATE public.company_config SET value='11111111111' WHERE key='master_cpf';")" 'GATE_P0001'

echo "── B. EFEITO no dado (a função não só 'não deu erro' — ela fez o trabalho) ──"
eq "B1 o plano foi criado"                 "$(Pq -c "SELECT count(*) FROM public.farmer_tactical_plans;")" "1"
eq "B2 o resultado foi registrado"         "$(Pq -c "SELECT status FROM public.farmer_tactical_plans LIMIT 1;")" "concluido"
eq "B3 o contato de rota foi gravado"      "$(Pq -c "SELECT count(*) FROM public.route_contact_log;")" "1"
eq "B4 master_cpf ficou INTACTO (gate barrou)" "$(Pq -c "SELECT value FROM public.company_config WHERE key='master_cpf';")" "00000000000"

echo "── C. os gates de autorização continuam mordendo (o hotfix não afrouxou nada) ──"
OUTRO='90000000-0000-0000-0000-000000000009'
P -q -c "INSERT INTO auth.users(id) VALUES ('$OUTRO') ON CONFLICT DO NOTHING; INSERT INTO public.user_roles(user_id,role) VALUES ('$OUTRO','employee');"
espera "C1 employee fora da carteira: criar_plano_tatico nega" \
  "$(exec_sql "$OUTRO" 'authenticated' "PERFORM public.criar_plano_tatico('$CLI_OK'::uuid, '$VEND_A'::uuid, '{}'::jsonb);")" 'GATE_42501'
espera "C2 employee fora da carteira: registrar_contato_rota nega" \
  "$(exec_sql "$OUTRO" 'authenticated' "PERFORM public.registrar_contato_rota('$CLI_OK'::uuid, 'respondido', CURRENT_DATE, NULL, NULL);")" 'GATE_P0001'
espera "C3 super_admin PODE alterar master_cpf (o gate não virou bloqueio total)" \
  "$(P -tA 2>&1 <<SQL
INSERT INTO public.commercial_roles(user_id, role) VALUES ('$MASTER','super_admin');
SET test.uid='$MASTER'; SET test.role='authenticated';
DO \$\$
DECLARE v_out text := 'OK';
BEGIN
  BEGIN UPDATE public.company_config SET value='22222222222' WHERE key='master_cpf';
  EXCEPTION WHEN undefined_function THEN v_out := 'ORFA_42883';
           WHEN OTHERS THEN v_out := 'OUTRO_'||SQLSTATE; END;
  RAISE NOTICE 'RES=%', v_out;
END \$\$;
SQL
)" 'OK'

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICAÇÃO: restaura o `public.` (o estado quebrado) → exige 42883
# ══════════════════════════════════════════════════════════════════════════════
echo "── FALSIFICAÇÃO (reproduz o bug do FU7 em cada caller) ──"
P -q -c "CREATE OR REPLACE FUNCTION public.registrar_contato_rota(p_customer_user_id uuid,p_status text,p_data_rota date,p_bucket text DEFAULT NULL,p_valor numeric DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS \$f\$
DECLARE v_uid uuid := auth.uid(); v_id uuid;
BEGIN
  IF NOT (COALESCE(public.pode_ver_carteira_completa(v_uid),false) OR public.carteira_visivel_para(p_customer_user_id, v_uid)) THEN
    RAISE EXCEPTION 'forbidden: customer not visible'; END IF;
  INSERT INTO public.route_contact_log (data_rota,customer_user_id,farmer_id,canal,status)
  VALUES (p_data_rota,p_customer_user_id,v_uid,'ligacao',p_status) RETURNING id INTO v_id;
  RETURN jsonb_build_object('id', v_id);
END \$f\$;"
espera "F1 com 'public.' de volta, registrar_contato_rota QUEBRA (42883) → A3 tem dente" \
  "$(exec_sql "$VEND_A" 'authenticated' "PERFORM public.registrar_contato_rota('$CLI_OK'::uuid, 'respondido', CURRENT_DATE, NULL, NULL);")" 'ORFA_42883'

P -q -c "CREATE OR REPLACE FUNCTION public.protect_master_config() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS \$f\$
BEGIN
  IF (TG_OP IN ('UPDATE','DELETE')) AND (OLD.key IN ('master_cpf','master_cnpj')) AND NOT public.is_super_admin(auth.uid()) THEN
    RAISE EXCEPTION 'Somente super admin pode alterar master_cpf ou master_cnpj'; END IF;
  RETURN COALESCE(NEW, OLD);
END \$f\$;"
espera "F2 com 'public.' de volta, protect_master_config QUEBRA (42883) → A4 tem dente" \
  "$(exec_sql "$VEND_A" 'authenticated' "UPDATE public.company_config SET value='33333333333' WHERE key='master_cpf';")" 'ORFA_42883'

# ⚠️ o assert que um teste ingênuo escreveria — e por que ele MENTE:
P -q -f "$MIG"
GREP_OK=$(Pq -c "SELECT (pg_get_functiondef('public.registrar_contato_rota'::regproc) LIKE '%private.carteira_visivel_para%')::text;")
eq "F3 (meta) o grep por 'private.' passa — mas SÓ os asserts que EXECUTAM provam algo" "$GREP_OK" "true"
espera "F3' e a execução confirma de verdade" \
  "$(exec_sql "$VEND_A" 'authenticated' "PERFORM public.registrar_contato_rota('$CLI_OK'::uuid, 'sem_resposta', CURRENT_DATE, NULL, NULL);")" 'OK'

echo ""
echo "═══ RESULTADO: $PASS ok, $FAIL falhas ═══"
[ "$FAIL" -eq 0 ] || exit 1
