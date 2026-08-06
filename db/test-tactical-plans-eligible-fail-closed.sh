#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║ PROVA PG17 — máscara `eligible` fail-closed no plano tático (money-path/autz) ║
# ║ Migration: 20260718160000_tactical_plans_eligible_fail_closed.sql             ║
# ║   bash db/test-tactical-plans-eligible-fail-closed.sh > /tmp/t.log 2>&1; echo $? ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
# O QUE ESTA PROVA TRAVA (o furo do follow-up do #1416):
#   `criar_plano_tatico` é a ÚNICA via de INSERT em farmer_tactical_plans (medido em prod:
#   varredura pg_proc + tabela sem policy de INSERT). O ramo service_role PULA o gate
#   `carteira_visivel_para` por desenho → o batch noturno materializaria plano tático COM
#   CONTEÚDO de cliente mascarado (eligible=false), numa tabela que qualquer employee lia.
#
# ⚠️ FIDELIDADE: `carteira_visivel_para` NÃO é transcrito aqui — a migration REAL do #1398 é
#    aplicada na ZONA 1. Transcrever o gate faria o harness provar o mundo que eu quis ter
#    (armadilha "espelhe a PROD, não o design", money-path.md).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5471}"
SLUG="tactplans-eligible"
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

# atores
MASTER='10000000-0000-0000-0000-000000000001'
GESTOR='20000000-0000-0000-0000-000000000002'
VEND_A='30000000-0000-0000-0000-000000000003'   # dona de CLI_OK e de CLI_MASC
VEND_B='40000000-0000-0000-0000-000000000004'   # employee sem carteira nenhuma
CLI_OK='a0000000-0000-0000-0000-0000000000aa'   # eligible=true
CLI_MASC='b0000000-0000-0000-0000-0000000000bb' # eligible=false  ← o mascarado
CLI_ORFAO='c0000000-0000-0000-0000-0000000000cc' # sem assignment

echo "═══ setup pronto (PG17 :$PORT) ═══"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — pré-requisitos (espelham a PROD, medidos via psql-ro em 2026-07-18)
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
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

-- espelha prod (pg_get_functiondef 2026-07-18)
CREATE OR REPLACE FUNCTION public.pode_ver_carteira_completa(_uid uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $f$
  SELECT has_role(_uid, 'master'::app_role)
    OR (has_role(_uid, 'employee'::app_role)
        AND get_commercial_role(_uid) IN ('gerencial'::commercial_role,'estrategico'::commercial_role,'super_admin'::commercial_role));
$f$;

-- prod: eligible boolean NOT NULL DEFAULT true; UNIQUE(customer_user_id)
CREATE TABLE IF NOT EXISTS public.carteira_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), customer_user_id uuid NOT NULL UNIQUE, owner_user_id uuid NOT NULL,
  source text NOT NULL DEFAULT 'omie', eligible boolean NOT NULL DEFAULT true,
  valid_from timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS public.carteira_coverage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), covering_user_id uuid NOT NULL, covered_user_id uuid NOT NULL,
  valid_from timestamptz NOT NULL DEFAULT now(), valid_until timestamptz, active boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL DEFAULT gen_random_uuid(), created_at timestamptz NOT NULL DEFAULT now());

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
  approach_strategy_b text, second_bundle jsonb DEFAULT '{}', ltv_projection jsonb, expected_result jsonb, operational_risks jsonb DEFAULT '[]');
ALTER TABLE public.farmer_tactical_plans ENABLE ROW LEVEL SECURITY;

-- relacl amplo de fábrica (default privilege do Supabase, medido em prod: authenticated=arwdDxtm)
-- ⇒ a RLS é a ÚNICA barreira de leitura. Sem replicar isto, o teste de policy dá falso-verde por
--    falta de GRANT em vez de por RLS (armadilha (a) das 3 de harness, database.md §4).
GRANT SELECT, INSERT, UPDATE, DELETE ON public.farmer_tactical_plans TO authenticated, anon, service_role;
GRANT SELECT ON public.user_roles, public.commercial_roles, public.carteira_assignments, public.carteira_coverage TO authenticated, anon, service_role;

-- ESTADO PRÉ-MIGRATION: a policy broad-staff que existe em prod hoje (pg_policies 2026-07-18).
CREATE POLICY tactical_plans_select_staff ON public.farmer_tactical_plans FOR SELECT
  USING (has_role(auth.uid(),'master'::app_role) OR has_role(auth.uid(),'employee'::app_role));
SQL

# gate real do #1398 (aplicado, não transcrito)
P -q -f "$REPO_ROOT/supabase/migrations/20260717181500_carteira_visivel_para_filtra_eligible.sql"
echo "pré-req aplicado: 20260717181500 (carteira_visivel_para com eligible)"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — a migration REAL sob teste (Lei #1)
# ══════════════════════════════════════════════════════════════════════════════
MIG="$REPO_ROOT/supabase/migrations/20260718160000_tactical_plans_eligible_fail_closed.sql"
P -q -f "$MIG"
echo "migration aplicada: $(basename "$MIG")"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 3 — seeds
# ══════════════════════════════════════════════════════════════════════════════
P -q <<SQL
INSERT INTO auth.users(id) VALUES ('$MASTER'),('$GESTOR'),('$VEND_A'),('$VEND_B'),('$CLI_OK'),('$CLI_MASC'),('$CLI_ORFAO') ON CONFLICT DO NOTHING;
INSERT INTO public.user_roles(user_id, role) VALUES
  ('$MASTER','master'),('$GESTOR','employee'),('$VEND_A','employee'),('$VEND_B','employee');
INSERT INTO public.commercial_roles(user_id, role) VALUES ('$GESTOR','gerencial'),('$VEND_A','vendedor'),('$VEND_B','vendedor');
INSERT INTO public.carteira_assignments(customer_user_id, owner_user_id, eligible) VALUES
  ('$CLI_OK','$VEND_A', true),
  ('$CLI_MASC','$VEND_A', false);
SQL
echo "seeds ok"

# helper: chama criar_plano_tatico com identidade dada e classifica a saída em sentinelas MINHAS
# (anti-teatro: VIA_* / CRIOU não são texto que o código emite; distinguem QUAL gate mordeu).
chama_rpc() { # $1=uid ('' p/ service) $2=role $3=customer $4=expected_owner ('NULL' literal aceito)
  P -tA 2>&1 <<SQL
SET test.uid='$1';
SET test.role='$2';
DO \$\$
DECLARE v_out text := 'CRIOU'; v_id uuid;
BEGIN
  BEGIN
    v_id := public.criar_plano_tatico('$3'::uuid, $4, '{}'::jsonb);
  EXCEPTION
    WHEN insufficient_privilege THEN            -- 42501: gate de máscara OU gate de carteira
      IF SQLERRM LIKE '%mascarado%'        THEN v_out := 'VIA_MASCARA';
      ELSIF SQLERRM LIKE '%fora da sua%'   THEN v_out := 'VIA_CARTEIRA';
      ELSIF SQLERRM LIKE '%autenticado%'   THEN v_out := 'VIA_ANON';
      ELSE                                      v_out := 'VIA_42501_OUTRA'; END IF;
    WHEN raise_exception THEN                   -- P0001: sem dono / reatribuída / expected_owner
      IF SQLERRM LIKE '%sem dono%'         THEN v_out := 'VIA_SEM_DONO';
      ELSIF SQLERRM LIKE '%reatribu%'      THEN v_out := 'VIA_REATRIBUIDA';
      ELSIF SQLERRM LIKE '%expected_owner%' THEN v_out := 'VIA_EXPOWNER_NULL';
      ELSE                                      v_out := 'VIA_P0001_OUTRA'; END IF;
    WHEN OTHERS THEN RAISE;                     -- qualquer outro: RELANÇA (não engole)
  END;
  RAISE NOTICE 'RES=%', v_out;                  -- decisão FORA do bloco (sem colisão de SQLSTATE)
END \$\$;
SQL
}
espera() { # $1=nome $2=saida_da_rpc $3=sentinela_esperada
  case "$2" in *"RES=$3"*) ok "$1 ($3)" ;; *) bad "$1 — esperado RES=$3, veio: $(echo "$2" | tr '\n' ' ' | tail -c 120)" ;; esac
}

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4 — ASSERTS
# ══════════════════════════════════════════════════════════════════════════════
echo "── A. escrita: o caminho legítimo segue funcionando ──"
espera "A1 service_role cria plano p/ cliente ELEGÍVEL (batch legítimo preservado)" "$(chama_rpc '' 'service_role' "$CLI_OK" 'NULL')" 'CRIOU'
espera "A2 vendedora dona cria plano p/ cliente ELEGÍVEL (front preservado)"        "$(chama_rpc "$VEND_A" 'authenticated' "$CLI_OK" "'$VEND_A'::uuid")" 'CRIOU'
espera "A3 master cria plano p/ cliente ELEGÍVEL"                                   "$(chama_rpc "$MASTER" 'authenticated' "$CLI_OK" "'$VEND_A'::uuid")" 'CRIOU'

echo "── B. escrita: a máscara morde (o furo) ──"
espera "B1 ⭐ service_role NÃO materializa plano de MASCARADO (o furo do batch)" "$(chama_rpc '' 'service_role' "$CLI_MASC" 'NULL')" 'VIA_MASCARA'
espera "B2 master NÃO materializa plano de MASCARADO (ato ≠ leitura; master-as-auditor)" "$(chama_rpc "$MASTER" 'authenticated' "$CLI_MASC" "'$VEND_A'::uuid")" 'VIA_MASCARA'
# a dona é barrada ANTES, pelo gate do #1398 — provar QUAL gate mordeu evita creditar ao meu fix
# uma proteção que já existia (e detecta se o #1398 regredir).
espera "B3 vendedora dona é barrada pelo gate do #1398 (carteira), não pelo novo" "$(chama_rpc "$VEND_A" 'authenticated' "$CLI_MASC" "'$VEND_A'::uuid")" 'VIA_CARTEIRA'

echo "── C. comportamento da v2 preservado (não regride #1037/#1043/Codex#4) ──"
espera "C1 cliente sem assignment → 'sem dono' (mensagem DISTINTA da máscara)" "$(chama_rpc '' 'service_role' "$CLI_ORFAO" 'NULL')" 'VIA_SEM_DONO'
espera "C2 expected_owner divergente → race-check ainda morde"                 "$(chama_rpc "$VEND_A" 'authenticated' "$CLI_OK" "'$VEND_B'::uuid")" 'VIA_REATRIBUIDA'
espera "C3 expected_owner NULL p/ autenticado → ainda obrigatório"             "$(chama_rpc "$VEND_A" 'authenticated' "$CLI_OK" 'NULL')" 'VIA_EXPOWNER_NULL'
espera "C4 anon (uid NULL, role authenticated) → não autenticado"              "$(chama_rpc '' 'authenticated' "$CLI_OK" 'NULL')" 'VIA_ANON'

echo "── D. EFEITO no dado (≠ só a exceção): nenhum plano de mascarado existe ──"
V=$(Pq -c "SELECT count(*) FROM public.farmer_tactical_plans WHERE customer_user_id='$CLI_MASC';")
eq "D1 zero planos materializados p/ o cliente mascarado" "$V" "0"
V=$(Pq -c "SELECT count(*) FROM public.farmer_tactical_plans WHERE customer_user_id='$CLI_OK';")
eq "D2 os 3 planos do cliente elegível existem" "$V" "3"

echo "── E. barreiras ESTRUTURAIS da tabela (achado 1 do Codex xhigh) ──"
# A RPC não era a fronteira única que eu afirmei: medido em prod, service_role tem
# has_table_privilege INSERT=t E rolbypassrls=t ⇒ escreveria DIRETO, pulando a RPC.
R=$(P -tA 2>&1 <<SQL
SET test.role='service_role';
SET ROLE service_role;
DO \$\$
DECLARE v_out text := 'INSERIU';
BEGIN
  BEGIN
    INSERT INTO public.farmer_tactical_plans(farmer_id, customer_user_id) VALUES ('$VEND_A','$CLI_MASC');
  EXCEPTION WHEN insufficient_privilege THEN v_out := 'NEGADO_ACL';
            WHEN OTHERS THEN RAISE;
  END;
  RAISE NOTICE 'RES=%', v_out;
END \$\$;
SQL
)
case "$R" in *'RES=NEGADO_ACL'*) ok "E1 ⭐ INSERT DIRETO como service_role é negado pelo REVOKE (pula-RPC fechado)" ;;
             *) bad "E1 service_role INSERIU direto na tabela — a RPC não é fronteira: $(echo "$R" | tr '\n' ' ' | tail -c 120)" ;; esac

# postgres (owner/superuser) passa o ACL — é o que uma função SECURITY DEFINER futura faria.
# Aqui só o TRIGGER pode barrar.
R=$(P -tA 2>&1 <<SQL
DO \$\$
DECLARE v_out text := 'INSERIU';
BEGIN
  BEGIN
    INSERT INTO public.farmer_tactical_plans(farmer_id, customer_user_id) VALUES ('$VEND_A','$CLI_MASC');
  EXCEPTION WHEN insufficient_privilege THEN v_out := 'NEGADO_TRIGGER';
            WHEN OTHERS THEN RAISE;
  END;
  RAISE NOTICE 'RES=%', v_out;
END \$\$;
SQL
)
case "$R" in *'RES=NEGADO_TRIGGER'*) ok "E2 ⭐ INSERT como postgres (≡ SECDEF futura) é negado pelo TRIGGER" ;;
             *) bad "E2 postgres INSERIU plano de mascarado — o trigger não morde: $(echo "$R" | tr '\n' ' ' | tail -c 120)" ;; esac

P -q -c "INSERT INTO public.farmer_tactical_plans(farmer_id, customer_user_id) VALUES ('$VEND_A','$CLI_OK');"
V=$(Pq -c "SELECT count(*) FROM public.farmer_tactical_plans WHERE customer_user_id='$CLI_OK';")
eq "E3 trigger NÃO bloqueia cliente elegível (não quebrei o caminho legítimo)" "$V" "4"

echo "── F. registrar_resultado_plano: máscara superveniente (achado 5 do Codex xhigh) ──"
# Cenário que refuta meu argumento circular: o plano nasce ELEGÍVEL e o cliente é
# mascarado DEPOIS. O plano existe; sem gate, master/service gravariam actual_margin nele.
P -q <<SQL
INSERT INTO public.carteira_assignments(customer_user_id, owner_user_id, eligible) VALUES ('$CLI_ORFAO','$VEND_A', true);
INSERT INTO public.farmer_tactical_plans(id, farmer_id, customer_user_id, status)
  VALUES ('dddddddd-dddd-dddd-dddd-dddddddddddd','$VEND_A','$CLI_ORFAO','gerado');
UPDATE public.carteira_assignments SET eligible = false WHERE customer_user_id = '$CLI_ORFAO';
SQL
reg_result() { # $1=uid $2=role $3=plan_id
  P -tA 2>&1 <<SQL
SET test.uid='$1';
SET test.role='$2';
DO \$\$
DECLARE v_out text := 'REGISTROU';
BEGIN
  BEGIN
    PERFORM public.registrar_resultado_plano('$3'::uuid, true, 'ganhou', 42.5, 900, NULL, NULL);
  EXCEPTION
    WHEN insufficient_privilege THEN
      IF SQLERRM LIKE '%mascarado%' THEN v_out := 'VIA_MASCARA'; ELSE v_out := 'VIA_42501_OUTRA'; END IF;
    WHEN raise_exception THEN v_out := 'VIA_P0001';
    WHEN OTHERS THEN RAISE;
  END;
  RAISE NOTICE 'RES=%', v_out;
END \$\$;
SQL
}
espera "F1 ⭐ service_role NÃO registra resultado de plano mascarado" "$(reg_result '' 'service_role' 'dddddddd-dddd-dddd-dddd-dddddddddddd')" 'VIA_MASCARA'
espera "F2 ⭐ master NÃO registra resultado de plano mascarado"       "$(reg_result "$MASTER" 'authenticated' 'dddddddd-dddd-dddd-dddd-dddddddddddd')" 'VIA_MASCARA'
V=$(Pq -c "SELECT coalesce(actual_margin::text,'INTACTO')||'/'||status FROM public.farmer_tactical_plans WHERE id='dddddddd-dddd-dddd-dddd-dddddddddddd';")
eq "F3 campos do plano mascarado ficam INTACTOS (nada gravado parcial)" "$V" "INTACTO/gerado"
# e o caminho legítimo continua vivo:
PID_OK=$(Pq -c "SELECT id FROM public.farmer_tactical_plans WHERE customer_user_id='$CLI_OK' LIMIT 1;")
espera "F4 resultado de plano de cliente ELEGÍVEL é registrado (fluxo preservado)" "$(reg_result '' 'service_role' "$PID_OK")" 'REGISTROU'

echo "── G. leitura: o que FICOU DE FORA (registrado, não esquecido) ──"
rls() { Pq -c "SET test.uid='$1'; SET test.role='authenticated'; SET ROLE authenticated; SELECT count(*) FROM public.farmer_tactical_plans;" | tail -1; }
# A policy segue broad-staff DE PROPÓSITO (ver §follow-up da migration: estreitá-la
# quebraria a métrica histórica pós-reatribuição). Este assert TRAVA o estado conhecido:
# se alguém estreitar a policy sem resolver o histórico, ele fica vermelho e força a conversa.
TOT=$(Pq -c "SELECT count(*) FROM public.farmer_tactical_plans;")
eq "G1 employee sem carteira AINDA lê tudo — broad-staff mantida (follow-up aberto)" "$(rls "$VEND_B")" "$TOT"
V=$(Pq -c "SET test.uid=''; SET test.role='anon'; SET ROLE anon; SELECT count(*) FROM public.farmer_tactical_plans;" | tail -1)
eq "G2 anon não lê nada" "$V" "0"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICAÇÃO (Lei #3): sabota → exige VERMELHO → restaura
# ══════════════════════════════════════════════════════════════════════════════
echo "── FALSIFICAÇÃO (cada sabotagem tem de virar o assert que ela mira) ──"

# F-A: remove o gate de máscara da RPC → B1 (o furo) tem de reabrir.
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.criar_plano_tatico(_customer_user_id uuid, _expected_owner uuid, _payload jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE _uid uuid := auth.uid(); _is_service boolean := COALESCE(auth.role()='service_role',false);
        _owner uuid; _eligible boolean; _new_id uuid;
BEGIN
  IF NOT _is_service THEN
    IF _uid IS NULL THEN RAISE EXCEPTION 'Não autenticado' USING ERRCODE='42501'; END IF;
    IF NOT public.carteira_visivel_para(_customer_user_id,_uid) THEN RAISE EXCEPTION 'Cliente fora da sua carteira' USING ERRCODE='42501'; END IF;
    IF _expected_owner IS NULL THEN RAISE EXCEPTION 'expected_owner é obrigatório para chamador autenticado (race-check da posse)'; END IF;
  END IF;
  SELECT a.owner_user_id, a.eligible INTO _owner,_eligible FROM public.carteira_assignments a WHERE a.customer_user_id=_customer_user_id FOR UPDATE;
  IF _owner IS NULL THEN RAISE EXCEPTION 'Cliente % sem dono de carteira', _customer_user_id; END IF;
  -- [SABOTAGEM F-A] gate de máscara REMOVIDO
  IF _expected_owner IS NOT NULL AND _owner <> _expected_owner THEN RAISE EXCEPTION 'Carteira do cliente % foi reatribuída durante a geração (dono atual diverge do esperado)', _customer_user_id; END IF;
  INSERT INTO public.farmer_tactical_plans(farmer_id,customer_user_id,status) VALUES (_owner,_customer_user_id,'gerado') RETURNING id INTO _new_id;
  RETURN _new_id;
END $function$;
SQL
# F-A1: só o gate da RPC removido — o TRIGGER ainda segura. Isto NÃO é "a sabotagem falhou":
# é a defesa em profundidade sendo medida. (Descoberto pela própria falsificação: a v1 deste
# assert exigia CRIOU aqui e ficou vermelha, porque presumia barreira única.)
R=$(chama_rpc '' 'service_role' "$CLI_MASC" 'NULL')
case "$R" in *'RES=VIA_MASCARA'*) ok "F-A1 removido o gate da RPC, o TRIGGER ainda barra (defesa em profundidade real)" ;;
             *'RES=CRIOU'*)       bad "F-A1 sem o gate da RPC o furo reabriu — o trigger NÃO é 2ª barreira" ;;
             *)                   bad "F-A1 resultado inesperado: $(echo "$R" | tr '\n' ' ' | tail -c 120)" ;; esac
# F-A2: agora as DUAS barreiras fora → o furo tem de reabrir. Só isto prova que B1 mede
# as barreiras (e não algum outro acaso do harness).
P -q -c "DROP TRIGGER IF EXISTS trg_tactical_plan_recusa_mascarado ON public.farmer_tactical_plans;"
R=$(chama_rpc '' 'service_role' "$CLI_MASC" 'NULL')
case "$R" in *'RES=CRIOU'*) ok "F-A2 sem RPC-gate E sem trigger, o furo REABRE → B1 tem dente" ;;
             *) bad "F-A2 furo não reabriu sem nenhuma barreira — B1 não mede o que promete: $(echo "$R" | tr '\n' ' ' | tail -c 120)" ;; esac
P -q -c "DELETE FROM public.farmer_tactical_plans WHERE customer_user_id='$CLI_MASC' AND status='gerado';"
P -q -f "$MIG"   # restaura a versão verdadeira (RPC + trigger)

# F-B: `IS NOT TRUE` → `= false` (a formulação ingênua) e uma linha com eligible NULL.
# Prova que a escolha do operador não é estilo: `= false` deixa NULL passar (fail-OPEN),
# que é exatamente o cenário do FU6 (writer futuro de identidade não-resolvida).
CLI_NULO='e0000000-0000-0000-0000-0000000000ee'
P -q <<SQL
INSERT INTO auth.users(id) VALUES ('$CLI_NULO') ON CONFLICT DO NOTHING;
ALTER TABLE public.carteira_assignments ALTER COLUMN eligible DROP NOT NULL;
INSERT INTO public.carteira_assignments(customer_user_id, owner_user_id, eligible) VALUES ('$CLI_NULO','$VEND_A', NULL);
SQL
espera "F-B1 eligible NULL é RECUSADO pelo IS NOT TRUE (fail-closed)" "$(chama_rpc '' 'service_role' "$CLI_NULO" 'NULL')" 'VIA_MASCARA'
# sabota AMBOS os pontos que checam a máscara (RPC e trigger) p/ '= false'
P -q -c "CREATE OR REPLACE FUNCTION public.tactical_plan_recusa_cliente_mascarado() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS \$f\$
DECLARE _e boolean; BEGIN
  SELECT a.eligible INTO _e FROM public.carteira_assignments a WHERE a.customer_user_id=NEW.customer_user_id FOR UPDATE;
  IF _e = false THEN RAISE EXCEPTION 'mascarado' USING ERRCODE='42501'; END IF; RETURN NEW;
END \$f\$;"
P -q -c "CREATE OR REPLACE FUNCTION public.criar_plano_tatico(_customer_user_id uuid,_expected_owner uuid,_payload jsonb) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS \$f\$
DECLARE _uid uuid := auth.uid(); _is_service boolean := COALESCE(auth.role()='service_role',false); _owner uuid; _eligible boolean; _new_id uuid;
BEGIN
  IF NOT _is_service THEN
    IF _uid IS NULL THEN RAISE EXCEPTION 'Não autenticado' USING ERRCODE='42501'; END IF;
    IF NOT public.carteira_visivel_para(_customer_user_id,_uid) THEN RAISE EXCEPTION 'Cliente fora da sua carteira' USING ERRCODE='42501'; END IF;
  END IF;
  SELECT a.owner_user_id,a.eligible INTO _owner,_eligible FROM public.carteira_assignments a WHERE a.customer_user_id=_customer_user_id FOR UPDATE;
  IF _owner IS NULL THEN RAISE EXCEPTION 'Cliente % sem dono de carteira', _customer_user_id; END IF;
  IF _eligible = false THEN RAISE EXCEPTION 'Cliente % está mascarado na carteira (eligible) — plano tático não é materializado', _customer_user_id USING ERRCODE='42501'; END IF;
  INSERT INTO public.farmer_tactical_plans(farmer_id,customer_user_id,status) VALUES (_owner,_customer_user_id,'gerado') RETURNING id INTO _new_id;
  RETURN _new_id;
END \$f\$;"
R=$(chama_rpc '' 'service_role' "$CLI_NULO" 'NULL')
case "$R" in *'RES=CRIOU'*) ok "F-B2 sabotagem (= false) deixa NULL passar → F-B1 tem dente" ;;
             *) bad "F-B2 '= false' também recusou NULL — F-B1 não distingue as formulações: $(echo "$R" | tr '\n' ' ' | tail -c 120)" ;; esac
P -q -c "DELETE FROM public.farmer_tactical_plans WHERE customer_user_id='$CLI_NULO';"
P -q -c "DELETE FROM public.carteira_assignments WHERE customer_user_id='$CLI_NULO';"
P -q -c "ALTER TABLE public.carteira_assignments ALTER COLUMN eligible SET NOT NULL;"
P -q -f "$MIG"

# F-C: dropa o TRIGGER → E2 (INSERT direto como postgres) tem de voltar a passar.
P -q -c "DROP TRIGGER IF EXISTS trg_tactical_plan_recusa_mascarado ON public.farmer_tactical_plans;"
R=$(P -tA 2>&1 <<SQL
DO \$\$
DECLARE v_out text := 'INSERIU';
BEGIN
  BEGIN INSERT INTO public.farmer_tactical_plans(farmer_id, customer_user_id) VALUES ('$VEND_A','$CLI_MASC');
  EXCEPTION WHEN insufficient_privilege THEN v_out := 'NEGADO'; WHEN OTHERS THEN RAISE; END;
  RAISE NOTICE 'RES=%', v_out;
END \$\$;
SQL
)
case "$R" in *'RES=INSERIU'*) ok "F-C sem o trigger, o INSERT direto PASSA → E2 tem dente" ;;
             *) bad "F-C removi o trigger e o INSERT continuou negado — E2 não prova o trigger: $(echo "$R" | tr '\n' ' ' | tail -c 120)" ;; esac
P -q -c "DELETE FROM public.farmer_tactical_plans WHERE customer_user_id='$CLI_MASC';"
P -q -f "$MIG"

# F-D: re-concede IUD a service_role → E1 (REVOKE) tem de voltar a passar o ACL.
P -q -c "GRANT INSERT, UPDATE, DELETE ON public.farmer_tactical_plans TO service_role;"
R=$(P -tA 2>&1 <<SQL
SET test.role='service_role'; SET ROLE service_role;
DO \$\$
DECLARE v_out text := 'INSERIU_OU_TRIGGER';
BEGIN
  BEGIN INSERT INTO public.farmer_tactical_plans(farmer_id, customer_user_id) VALUES ('$VEND_A','$CLI_OK');
  EXCEPTION WHEN insufficient_privilege THEN v_out := 'NEGADO_ACL'; WHEN OTHERS THEN RAISE; END;
  RAISE NOTICE 'RES=%', v_out;
END \$\$;
SQL
)
case "$R" in *'RES=INSERIU_OU_TRIGGER'*) ok "F-D com o grant de volta, o ACL deixa passar → E1 prova o REVOKE (não o trigger)" ;;
             *) bad "F-D re-concedi IUD e ainda deu NEGADO_ACL — E1 não prova o REVOKE: $(echo "$R" | tr '\n' ' ' | tail -c 120)" ;; esac
P -q -f "$MIG"

# F-E: remove o gate de máscara do registrar_resultado_plano → F1 tem de voltar a gravar.
P -q -c "CREATE OR REPLACE FUNCTION public.registrar_resultado_plano(_plan_id uuid,_plan_followed boolean,_call_result text,_actual_margin numeric,_call_duration_seconds integer,_objection_type text DEFAULT NULL,_notes text DEFAULT NULL) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS \$f\$
DECLARE _uid uuid := auth.uid(); _is_service boolean := COALESCE(auth.role()='service_role',false); _customer uuid; _status text;
BEGIN
  SELECT p.customer_user_id,p.status INTO _customer,_status FROM public.farmer_tactical_plans p WHERE p.id=_plan_id;
  IF _customer IS NULL THEN RAISE EXCEPTION 'Plano % inexistente', _plan_id; END IF;
  IF _status='concluido' THEN RAISE EXCEPTION 'Plano % já concluído', _plan_id; END IF;
  UPDATE public.farmer_tactical_plans SET actual_margin=_actual_margin, status='concluido' WHERE id=_plan_id;
END \$f\$;"
R=$(reg_result '' 'service_role' 'dddddddd-dddd-dddd-dddd-dddddddddddd')
case "$R" in *'RES=REGISTROU'*) ok "F-E sem o gate, o resultado de plano mascarado É gravado → F1 tem dente" ;;
             *) bad "F-E removi o gate e ainda recusou — F1 não prova o gate: $(echo "$R" | tr '\n' ' ' | tail -c 120)" ;; esac
P -q -c "UPDATE public.farmer_tactical_plans SET actual_margin=NULL, status='gerado' WHERE id='dddddddd-dddd-dddd-dddd-dddddddddddd';"
P -q -f "$MIG"
espera "F-E' gate re-aplicado volta a recusar" "$(reg_result '' 'service_role' 'dddddddd-dddd-dddd-dddd-dddddddddddd')" 'VIA_MASCARA'

echo ""
echo "═══ RESULTADO: $PASS ok, $FAIL falhas ═══"
[ "$FAIL" -eq 0 ] || exit 1
