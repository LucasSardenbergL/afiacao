#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  Prova PG17 do fecho da margem em farmer_tactical_plans (FU4-F)                ║
# ║    bash db/test-tactical-plans-margem.sh > log 2>&1; echo $?                   ║
# ║  (NÃO pipe pra tail — engole o exit≠0.)                                        ║
# ║                                                                               ║
# ║  Aplica as DUAS migrations reais, na ordem de prod:                           ║
# ║   A 20261015120000 — RPC get_planos_margem + saneador do texto + trigger +     ║
# ║                      backup privado + saneamento do histórico                  ║
# ║   B 20261015120100 — REVOKE SELECT de tabela + GRANT das 38 outras colunas     ║
# ║                                                                               ║
# ║  O que prova:                                                                 ║
# ║   · LINHA DE BASE: com o ACL de prod a vendedora LÊ a margem por coluna E por ║
# ║     texto (os dois furos)                                                      ║
# ║   · TEXTO: o histórico perde as frases com o número (e a seguinte, se tiver %);║
# ║     o resto fica; texto sem número volta byte a byte; o original vai para o    ║
# ║     backup que authenticated não lê; toda gravação nova passa pelo saneador    ║
# ║   · RPC: números exatos sob cap_custo_ler; NULL + margem_visivel=false sem ela;║
# ║     não-staff, sem uid, sem ids → 0 linhas; anon não executa                   ║
# ║   · COLUNA: ninguém authenticated lê/filtra/ordena as 3 colunas — nem o master ║
# ║   · writers intactos: criar_plano_tatico e registrar_resultado_plano seguem    ║
# ║     gravando depois do fecho; service_role lê; a RLS segue mordendo            ║
# ║   · FALSIFICAÇÃO: 13 sabotagens, cada uma exige o seu vermelho EXATO           ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17
PORT="${PGPORT_TEST:-5493}"
SLUG="tpmargem"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
RODADA="$(dirname "$DATA")"
export LC_ALL=C LANG=C

# shellcheck disable=SC1091
. "$REPO_ROOT/db/lib/pg-harness.sh"

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$RODADA"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$RODADA/pg.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
P()  { "$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }

P -q -f "$REPO_ROOT/db/stubs-supabase.sql"

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  OK  $1"; }
bad() { FAIL=$((FAIL+1)); echo "  XX  $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

MIG_A="$REPO_ROOT/supabase/migrations/20261015120000_tactical_plans_margem_rpc_saneia_texto.sql"
MIG_B="$REPO_ROOT/supabase/migrations/20261015120100_tactical_plans_margem_fecha_coluna.sql"
FIXTURE="$REPO_ROOT/db/fixtures/tactical-plans-margem-prod-20261015.sql"

# ── ZONA 1: stubs espelhando a PROD (psql-ro, 2026-10-15) ─────────────────────
# 41 colunas na ordem e com os defaults de prod; ACL de prod (anon/authenticated/service_role = rDxtm:
# ninguém fora das RPCs escreve); RLS ligada com a policy única de prod. Os DEFAULT PRIVILEGES de
# função do Supabase entram ANTES da migration: sem eles o REVOKE de anon seria no-op e o assert
# nasceria verde.
P -q <<'SQL'
CREATE OR REPLACE FUNCTION auth.uid()  RETURNS uuid LANGUAGE sql STABLE AS $f$
  SELECT nullif(current_setting('test.uid', true), '')::uuid $f$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $f$
  SELECT nullif(current_setting('test.role', true), '') $f$;
ALTER ROLE service_role BYPASSRLS;

CREATE SCHEMA IF NOT EXISTS private;
ALTER DEFAULT PRIVILEGES IN SCHEMA private GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public  GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
GRANT USAGE ON SCHEMA private TO authenticated, anon, service_role;
GRANT USAGE ON SCHEMA public  TO authenticated, anon, service_role;

CREATE TYPE public.app_role AS ENUM ('master', 'employee', 'customer');
CREATE TABLE public.user_roles (user_id uuid NOT NULL, role public.app_role NOT NULL);
CREATE TABLE public.carteira_assignments (customer_user_id uuid PRIMARY KEY, owner_user_id uuid, eligible boolean);
CREATE TABLE public.carteira_coverage (covering_user_id uuid, covered_user_id uuid, active boolean, valid_until timestamptz);

-- Capability controlável por GUC (a prod resolve por has_role/commercial_roles).
CREATE OR REPLACE FUNCTION private.cap_custo_ler(_uid uuid) RETURNS boolean
  LANGUAGE sql STABLE AS $f$ SELECT coalesce(nullif(current_setting('test.cap_custo',true),'')::boolean,false) $f$;

CREATE TABLE public.farmer_tactical_plans (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  farmer_id uuid NOT NULL,
  customer_user_id uuid NOT NULL,
  bundle_recommendation_id uuid,
  health_score numeric DEFAULT 0,
  churn_risk numeric DEFAULT 0,
  mix_gap integer DEFAULT 0,
  current_margin_pct numeric DEFAULT 0,
  cluster_avg_margin_pct numeric DEFAULT 0,
  expansion_potential numeric DEFAULT 0,
  strategic_objective text NOT NULL DEFAULT 'expansao_mix'::text,
  customer_profile text DEFAULT 'misto'::text,
  top_bundle jsonb DEFAULT '{}'::jsonb,
  bundle_lie numeric,
  bundle_probability numeric,
  bundle_incremental_margin numeric,
  best_individual_lie numeric,
  diagnostic_questions jsonb DEFAULT '[]'::jsonb,
  implication_question text,
  offer_transition text,
  probable_objections jsonb DEFAULT '[]'::jsonb,
  approach_strategy text,
  plan_followed boolean,
  call_result text,
  actual_margin numeric,
  call_duration_seconds integer,
  objection_type text,
  notes text,
  effectiveness_score numeric,
  status text DEFAULT 'gerado'::text,
  generated_at timestamp with time zone DEFAULT now(),
  used_at timestamp with time zone,
  completed_at timestamp with time zone,
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now(),
  plan_type text DEFAULT 'essencial'::text,
  approach_strategy_b text,
  second_bundle jsonb DEFAULT '{}'::jsonb,
  ltv_projection jsonb,
  expected_result jsonb,
  operational_risks jsonb DEFAULT '[]'::jsonb
);
GRANT SELECT, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN ON public.farmer_tactical_plans TO anon, authenticated, service_role;
ALTER TABLE public.farmer_tactical_plans ENABLE ROW LEVEL SECURITY;
SQL

# Corpos de PROD de has_role, carteira_visivel_para, trigger de máscara e as duas RPCs-writer.
P -q -f "$FIXTURE"
P -q <<'SQL'
CREATE TRIGGER trg_tactical_plan_recusa_mascarado BEFORE INSERT ON public.farmer_tactical_plans
  FOR EACH ROW EXECUTE FUNCTION tactical_plan_recusa_cliente_mascarado();
-- Policy de prod (pg_policies, 2026-10-15).
CREATE POLICY tactical_plans_select_staff ON public.farmer_tactical_plans FOR SELECT
  USING (has_role(auth.uid(), 'master'::app_role) OR has_role(auth.uid(), 'employee'::app_role));
SQL

M=a0000000-0000-0000-0000-00000000000f    # master (cap_custo_ler)
A=aa000000-0000-0000-0000-00000000000a    # vendedora A
B=bb000000-0000-0000-0000-00000000000b    # vendedora B
U=cc000000-0000-0000-0000-00000000000c    # cliente (role customer)
C1=c1000000-0000-0000-0000-000000000001
C2=c2000000-0000-0000-0000-000000000002
C3=c3000000-0000-0000-0000-000000000003
P1=f1000000-0000-0000-0000-000000000001
P2=f2000000-0000-0000-0000-000000000002

# Seed: textos SINTÉTICOS no formato que a IA produz em prod (medido: "margem bruta atual (37,73%)",
# "média do cluster (55,25%)", "A sua está em 37%.", "4 p.p. de margem", "~19pp").
P -q <<SQL
INSERT INTO public.user_roles VALUES ('$M','master'), ('$A','employee'), ('$B','employee'), ('$U','customer');
INSERT INTO public.carteira_assignments VALUES ('$C1','$A',true), ('$C2','$A',true), ('$C3','$B',true);
INSERT INTO public.farmer_tactical_plans (id, farmer_id, customer_user_id, plan_type, current_margin_pct,
  cluster_avg_margin_pct, expected_result, approach_strategy, approach_strategy_b, implication_question,
  offer_transition, diagnostic_questions, probable_objections, operational_risks, churn_risk)
VALUES
 ('$P1','$A','$C1','estrategico', 37.73, 55.25,
  '{"likely_margin": 48, "best_case_margin": 55.23, "worst_case_margin": 40.97}',
  E'Cliente ativo com compra recente. O risco de churn de 62% pede abordagem consultiva. Sua margem bruta é de 37,73%. A média do cluster é 55,25%. A sua está em 37%. Das 36 categorias, quais têm maior margem?\n\nFoque em ciclo de afiação.',
  'Gap de margem de ~19pp em relação ao cluster.',
  'Recuperar 4 p.p. de margem equivale a R\$ 1.350/mês. Quanto custa a parada de máquina?',
  E'Posso te mostrar como clientes parecidos resolvem isso?\nVamos lá.',
  '[{"question": "Quantas peças por ferramenta?", "purpose": "Medir rendimento.", "expected_insight": "Abre conversa sobre margem de 37,73%."}]',
  '[{"objection": "Já tenho fornecedor.", "probability": 55, "economic_response": "Clientes do cluster têm 55,25% de margem. O custo por peça cai.", "technical_response": "Análise de ciclo de vida."}]',
  '["Margem bruta atual (37,73%) abaixo da média do cluster (55,25%).", "HealthScore de 38 e churnRisk de 62%."]',
  62),
 ('$P2','$B','$C3','estrategico', 55, NULL, NULL,
  'Cliente fiel, reforçar o serviço.', NULL, 'Qual etapa mais para a produção?', NULL,
  '[]', '[]', '["Sem dado de potencial."]', 30);
SQL

# como <uid> <cap_custo> <sql> — roda como authenticated. `SET ROLE` (não SET LOCAL: em autocommit ele
# não pega e o assert rodaria como superuser — money-path.md).
como() { P -tA -q -c "SET test.uid='$1'; SET test.cap_custo='$2'; SET test.role=''; SET ROLE authenticated; $3" 2>&1; }
# nega <uid> <cap_custo> <sql> — passa só se o SQL der 42501 (insufficient_privilege). Qualquer outro
# erro é RE-LANÇADO; sucesso devolve a marca de vazamento. Sentinelas ASCII que o Postgres não emite.
nega() {
  P -tA -q 2>&1 <<SQL || true
SET test.uid='$1'; SET test.cap_custo='$2'; SET test.role=''; SET ROLE authenticated;
DO \$neg\$
BEGIN
  BEGIN
    EXECUTE \$q\$ $3 \$q\$;
    RAISE NOTICE 'MARCA_VAZOU_8T';
  EXCEPTION
    WHEN insufficient_privilege THEN RAISE NOTICE 'MARCA_BARRADO_8T';
    WHEN OTHERS THEN RAISE;
  END;
END
\$neg\$;
SQL
}
nega_anon() {
  P -tA -q 2>&1 <<SQL || true
SET ROLE anon;
DO \$neg\$ BEGIN
  EXECUTE \$q\$ $1 \$q\$;
  RAISE NOTICE 'MARCA_VAZOU_8T';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'MARCA_BARRADO_8T';
          WHEN OTHERS THEN RAISE;
END \$neg\$;
SQL
}
veredito_nega() { case "$1" in *MARCA_BARRADO_8T*) echo barrado ;; *MARCA_VAZOU_8T*) echo vazou ;; *) echo "outro: $1" ;; esac; }
# texto <coluna> <plano> — lê como superuser (o que ESTÁ gravado, independente de quem pode ler).
texto() { P -tA -q -c "SELECT $1 FROM public.farmer_tactical_plans WHERE id='$2';"; }

# grava_c2 — grava um plano NOVO para C2 pela RPC-writer de prod (caminho service_role = edge
# self-contained), com texto vazando a margem. Apaga o plano anterior de C2 antes (a RPC recusa 2 abertos).
PAYLOAD_VAZA='{"plan_type": "estrategico", "current_margin_pct": 37.73, "cluster_avg_margin_pct": 55.25,
  "approach_strategy": "O risco de churn de 62% pede cuidado. Sua margem bruta é de 37,73%. A média do cluster é 55,25%. A sua está em 37%. Foque no ciclo.",
  "probable_objections": [{"objection": "Caro.", "probability": 55, "economic_response": "Sua margem de 37,73% permite flexibilizar."}]}'
grava_c2() {
  P -q -c "DELETE FROM public.farmer_tactical_plans WHERE customer_user_id='$C2';"
  P -tA -q -c "SET test.role='service_role'; SELECT public.criar_plano_tatico('$C2', '$A', \$j\$${PAYLOAD_VAZA}\$j\$::jsonb) IS NOT NULL;" 2>&1
}
c2() { P -tA -q -c "SELECT $1 FROM public.farmer_tactical_plans WHERE customer_user_id='$C2';"; }

# ═════════════════════════ LINHA DE BASE (ACL de prod hoje) ═════════════════════════
echo "-- L. linha de base: os dois furos existem hoje --"
eq "L1 vendedora A LÊ a margem do cliente por COLUNA" \
   "$(como $A false "SELECT current_margin_pct FROM public.farmer_tactical_plans WHERE id='$P1';")" "37.73"
eq "L2 vendedora B (outra carteira) também lê: a policy é staff-wide" \
   "$(como $B false "SELECT cluster_avg_margin_pct FROM public.farmer_tactical_plans WHERE id='$P1';")" "55.25"
eq "L3 vendedora A LÊ a margem pelo TEXTO do plano" \
   "$(como $A false "SELECT approach_strategy ~ '37,73' FROM public.farmer_tactical_plans WHERE id='$P1';")" "t"

# ═════════════════════════ MIGRATION A ═════════════════════════
P -q -f "$MIG_A"
echo "migration A aplicada"

echo "-- T. saneamento do histórico --"
eq "T1 approach: caem as frases com o número; churn, a pergunta sem unidade e o fecho ficam" \
   "$(texto approach_strategy $P1)" \
   "Cliente ativo com compra recente. O risco de churn de 62% pede abordagem consultiva. Das 36 categorias, quais têm maior margem? Foque em ciclo de afiação."
eq "T2 '4 p.p. de margem' cai, a pergunta fica" "$(texto implication_question $P1)" "Quanto custa a parada de máquina?"
eq "T3 campo todo sobre margem ('~19pp') vira o aviso, não fica em branco" \
   "$(texto approach_strategy_b $P1)" "[trecho removido: citava a margem]"
eq "T4 texto sem número volta BYTE A BYTE (inclusive a quebra de linha)" \
   "$(P -tA -q -c "SELECT offer_transition = E'Posso te mostrar como clientes parecidos resolvem isso?\nVamos lá.' FROM public.farmer_tactical_plans WHERE id='$P1';")" "t"
eq "T5 jsonb: a resposta econômica perde o número, a probability (número) e as chaves ficam" \
   "$(texto "probable_objections->0->>'economic_response' || '|' || (probable_objections->0->>'probability') || '|' || (probable_objections->0->>'technical_response')" $P1)" \
   "O custo por peça cai.|55|Análise de ciclo de vida."
eq "T6 jsonb: risco só de margem vira aviso; o risco de churn (outra string) fica" \
   "$(texto "operational_risks::text" $P1)" '["[trecho removido: citava a margem]", "HealthScore de 38 e churnRisk de 62%."]'
eq "T7 jsonb aninhado: expected_insight da pergunta saneado, question intacta" \
   "$(texto "(diagnostic_questions->0->>'question') || '|' || (diagnostic_questions->0->>'expected_insight')" $P1)" \
   "Quantas peças por ferramenta?|[trecho removido: citava a margem]"
eq "T8 nenhuma folha do P1 segue citando 37,73 ou 55,25" \
   "$(texto "concat_ws(' ', approach_strategy, approach_strategy_b, implication_question, offer_transition, diagnostic_questions::text, probable_objections::text, operational_risks::text) ~ '(37,73|55,25)'" $P1)" "f"
eq "T9 backup guardou o ORIGINAL do P1" \
   "$(P -tA -q -c "SELECT approach_strategy ~ 'Sua margem bruta é de 37,73%' AND operational_risks->>0 ~ '37,73' FROM private.farmer_tactical_plans_texto_original WHERE plan_id='$P1';")" "t"
eq "T10 plano sem número (P2) não foi tocado nem foi para o backup" \
   "$(P -tA -q -c "SELECT count(*) FROM private.farmer_tactical_plans_texto_original WHERE plan_id='$P2';")|$(texto approach_strategy $P2)" \
   "0|Cliente fiel, reforçar o serviço."
eq "T11 backup: vendedora NÃO lê (42501)" \
   "$(veredito_nega "$(nega $A false "SELECT approach_strategy FROM private.farmer_tactical_plans_texto_original")")" "barrado"
eq "T12 colunas numéricas NÃO são tocadas pela A (o fecho delas é a B)" \
   "$(texto "current_margin_pct || '|' || cluster_avg_margin_pct" $P1)" "37.73|55.25"
eq "T13 saneador é idempotente: sanear(sanear(x)) = sanear(x)" \
   "$(P -tA -q -c "SELECT private.sanear_texto_margem(approach_strategy) = approach_strategy AND private.sanear_jsonb_margem(operational_risks) = operational_risks FROM public.farmer_tactical_plans WHERE id='$P1';")" "t"

asserts_gravacao() {
  echo "-- G. toda gravação nova passa pelo saneador (trigger) --"
  eq "G0 criar_plano_tatico (service_role) grava" "$(grava_c2)" "t"
  eq "G1 a frase 'Sua margem bruta é de 37,73%' não chega ao banco" "$(c2 "approach_strategy ~ '37,73'")" "f"
  eq "G2 a frase seguinte com % ('A sua está em 37%') também não" "$(c2 "approach_strategy ~ 'A sua est'")" "f"
  eq "G3 jsonb: objeção sem o número, probability intacta" "$(c2 "(probable_objections::text ~ '37,73') || '|' || (probable_objections->0->>'probability')")" "false|55"
  eq "G4 o resto do texto chega" "$(c2 "approach_strategy")" "O risco de churn de 62% pede cuidado. Foque no ciclo."
}
asserts_gravacao

asserts_rpc() {
  echo "-- R. RPC get_planos_margem --"
  eq "R1 master com cap_custo_ler: números EXATOS" \
     "$(como $M true "SELECT current_margin_pct||'|'||cluster_avg_margin_pct||'|'||(expected_result->>'likely_margin')||'|'||margem_visivel FROM public.get_planos_margem(ARRAY['$P1']::uuid[]);")" "37.73|55.25|48|true"
  eq "R2 vendedora SEM cap_custo_ler: linha presente, tudo NULL, margem_visivel=false" \
     "$(como $A false "SELECT coalesce(current_margin_pct::text,'(null)')||'|'||coalesce(cluster_avg_margin_pct::text,'(null)')||'|'||coalesce(expected_result::text,'(null)')||'|'||margem_visivel FROM public.get_planos_margem(ARRAY['$P1']::uuid[]);")" "(null)|(null)|(null)|false"
  eq "R3 escopo = a policy (staff-wide): vendedora B recebe a linha de P1" \
     "$(como $B false "SELECT count(*) FROM public.get_planos_margem(ARRAY['$P1','$P2']::uuid[]);")" "2"
  eq "R4 cliente (não-staff) com cap permissiva: 0 linhas" \
     "$(como $U true "SELECT count(*) FROM public.get_planos_margem(ARRAY['$P1']::uuid[]);")" "0"
  eq "R5 fail-closed: sem uid → 0" \
     "$(P -tA -q -c "SET test.uid=''; SET test.cap_custo='true'; SET ROLE authenticated; SELECT count(*) FROM public.get_planos_margem(ARRAY['$P1']::uuid[]);" 2>&1)" "0"
  eq "R6 sem ids → 0 (não é via de dump)" \
     "$(como $M true "SELECT count(*) FROM public.get_planos_margem(NULL);")" "0"
  eq "R7 anon NÃO executa a RPC (42501)" \
     "$(veredito_nega "$(nega_anon "SELECT * FROM public.get_planos_margem(ARRAY['$P1']::uuid[])")")" "barrado"
}
asserts_rpc

# ═════════════════════════ MIGRATION B ═════════════════════════
P -q -f "$MIG_B"
echo "migration B aplicada"

COLS_ABERTAS="id, farmer_id, customer_user_id, bundle_recommendation_id, health_score, churn_risk, mix_gap, expansion_potential, strategic_objective, customer_profile, top_bundle, bundle_lie, bundle_probability, bundle_incremental_margin, best_individual_lie, diagnostic_questions, implication_question, offer_transition, probable_objections, approach_strategy, plan_followed, call_result, actual_margin, call_duration_seconds, objection_type, notes, effectiveness_score, status, generated_at, used_at, completed_at, created_at, updated_at, plan_type, approach_strategy_b, second_bundle, ltv_projection, operational_risks"

asserts_coluna() {
  echo "-- C. colunas fechadas --"
  eq "C1 vendedora: current_margin_pct → 42501" \
     "$(veredito_nega "$(nega $A false "SELECT current_margin_pct FROM public.farmer_tactical_plans")")" "barrado"
  eq "C1b vendedora: cluster_avg_margin_pct → 42501" \
     "$(veredito_nega "$(nega $A false "SELECT cluster_avg_margin_pct FROM public.farmer_tactical_plans")")" "barrado"
  eq "C1c vendedora: expected_result (cenários de margem) → 42501" \
     "$(veredito_nega "$(nega $A false "SELECT expected_result FROM public.farmer_tactical_plans")")" "barrado"
  eq "C2 master/cap_custo_ler também não lê DIRETO (privilégio é por papel)" \
     "$(veredito_nega "$(nega $M true "SELECT current_margin_pct FROM public.farmer_tactical_plans")")" "barrado"
  eq "C3 select * quebra (as telas não podem usá-lo)" \
     "$(veredito_nega "$(nega $A false "SELECT * FROM public.farmer_tactical_plans")")" "barrado"
  eq "C4 oráculo por FILTRO (WHERE margem > x) → 42501" \
     "$(veredito_nega "$(nega $A false "SELECT count(*) FROM public.farmer_tactical_plans WHERE current_margin_pct > 30")")" "barrado"
  eq "C5 oráculo por ORDEM → 42501" \
     "$(veredito_nega "$(nega $A false "SELECT id FROM public.farmer_tactical_plans ORDER BY cluster_avg_margin_pct")")" "barrado"
  eq "C6 anon não lê nem as colunas abertas" \
     "$(veredito_nega "$(nega_anon "SELECT id FROM public.farmer_tactical_plans")")" "barrado"

  echo "-- S. o que tem de seguir funcionando --"
  eq "S1 vendedora lê as 38 colunas restantes (policy staff-wide: P1, P2 e o de C2)" \
     "$(como $A false "SELECT count(*) FROM (SELECT $COLS_ABERTAS FROM public.farmer_tactical_plans) t;")" "3"
  eq "S2 a RLS segue mordendo numa coluna aberta: cliente (não-staff) lê 0" \
     "$(como $U false "SELECT count(*) FROM public.farmer_tactical_plans;")" "0"
  eq "S3 service_role (edges) lê a margem" \
     "$(P -tA -q -c "SET ROLE service_role; SELECT current_margin_pct FROM public.farmer_tactical_plans WHERE id='$P1';" 2>&1)" "37.73"
}
asserts_coluna

echo "-- W. writers depois do fecho --"
eq "W1 criar_plano_tatico pelo browser (vendedora, sem cap) grava e devolve o id" \
   "$(P -q -c "DELETE FROM public.farmer_tactical_plans WHERE customer_user_id='$C2';" >/dev/null; como $A false "SELECT public.criar_plano_tatico('$C2', '$A', '{\"plan_type\":\"estrategico\",\"approach_strategy\":\"Plano.\"}'::jsonb) IS NOT NULL;")" "t"
eq "W2 registrar_resultado_plano conclui o plano" \
   "$(como $A false "SELECT public.registrar_resultado_plano((SELECT id FROM public.farmer_tactical_plans WHERE customer_user_id='$C2'), true, 'fechou', NULL, NULL); SELECT status FROM public.farmer_tactical_plans WHERE customer_user_id='$C2';" | tail -1)" "concluido"
asserts_gravacao
echo "-- R pós-B: a RPC é a via legítima que sobra --"
asserts_rpc

echo "-- I. idempotência: re-aplicar A e B não erra, não reabre e não perde o original --"
P -q -f "$MIG_A"; P -q -f "$MIG_B"
eq "I1 após re-apply, vendedora segue barrada" \
   "$(veredito_nega "$(nega $A false "SELECT current_margin_pct FROM public.farmer_tactical_plans")")" "barrado"
eq "I2 o backup segue com o ORIGINAL (não foi sobrescrito pelo texto saneado)" \
   "$(P -tA -q -c "SELECT approach_strategy ~ '37,73' FROM private.farmer_tactical_plans_texto_original WHERE plan_id='$P1';")" "t"
eq "I3 o texto saneado não mudou com o re-apply" \
   "$(texto approach_strategy $P1)" \
   "Cliente ativo com compra recente. O risco de churn de 62% pede abordagem consultiva. Das 36 categorias, quais têm maior margem? Foque em ciclo de afiação."

# ═════════════════════════ FALSIFICAÇÃO ═════════════════════════
# Cada sabotagem recria UMA defesa na versão furada, re-roda o assert que a protege e EXIGE o vermelho
# EXATO; depois restaura reaplicando a migration real. Sabotagem que segue verde = assert sem dente.
# A migration nunca é editada no lugar (supabase/migrations/ é DR): a sabotada é uma cópia no tmpdir.
echo "-- K. falsificação --"
exige_vermelho() { # <rótulo> <valor obtido> <valor do verde> <vermelho esperado>
  if [ "$2" = "$3" ]; then bad "$1 — SABOTADO e seguiu verde [$2]: assert sem dente"
  elif [ "$2" = "$4" ]; then ok "$1 — sabotado ficou vermelho [$2]"
  else bad "$1 — sabotagem deu resultado inesperado [$2], esperava o vermelho [$4]"; fi
}
sabota_a() { # <perl expr> — aplica a migration A com o corpo sabotado
  perl -0pe "$1" "$MIG_A" > "$RODADA/a-sabotada.sql"
  if cmp -s "$MIG_A" "$RODADA/a-sabotada.sql"; then bad "sabotagem não alterou a migration A ($1)"; fi
  # As postcondições da própria migration gritam com parte das sabotagens; aqui queremos o estado
  # sabotado no banco, então a postcondição sai do arquivo sabotado.
  perl -0pi -e 's/DO \$pos\$.*?\$pos\$;//s' "$RODADA/a-sabotada.sql"
  P -q -f "$RODADA/a-sabotada.sql"
}

# K1 — B furada: o GRANT de tabela volta (um GRANT colado no SQL Editor).
P -q -c "GRANT SELECT ON public.farmer_tactical_plans TO authenticated;"
exige_vermelho "K1 GRANT de tabela devolvido → C1" "$(veredito_nega "$(nega $A false "SELECT current_margin_pct FROM public.farmer_tactical_plans")")" "barrado" "vazou"
P -q -f "$MIG_B"
eq "K1r restaurado" "$(veredito_nega "$(nega $A false "SELECT current_margin_pct FROM public.farmer_tactical_plans")")" "barrado"

# K2 — B furada por COLUNA: a margem entra na lista do GRANT → C4 (oráculo por filtro).
P -q -c "GRANT SELECT (current_margin_pct) ON public.farmer_tactical_plans TO authenticated;"
exige_vermelho "K2 margem na lista do GRANT → C4" "$(veredito_nega "$(nega $A false "SELECT count(*) FROM public.farmer_tactical_plans WHERE current_margin_pct > 30")")" "barrado" "vazou"
P -q -f "$MIG_B"
eq "K2r restaurado" "$(veredito_nega "$(nega $A false "SELECT count(*) FROM public.farmer_tactical_plans WHERE current_margin_pct > 30")")" "barrado"

# K3 — RPC sem gate de PROJEÇÃO na margem do cliente → R2.
sabota_a 's/CASE WHEN v_pode_num THEN p\.current_margin_pct END/p.current_margin_pct/'
exige_vermelho "K3 projeção removida → R2" \
  "$(como $A false "SELECT coalesce(current_margin_pct::text,'(null)')||'|'||coalesce(cluster_avg_margin_pct::text,'(null)')||'|'||coalesce(expected_result::text,'(null)')||'|'||margem_visivel FROM public.get_planos_margem(ARRAY['$P1']::uuid[]);")" \
  "(null)|(null)|(null)|false" "37.73|(null)|(null)|false"
P -q -f "$MIG_A"

# K4 — RPC sem o gate de staff → R4 (a RPC alargaria a policy para o cliente).
sabota_a 's/IF NOT \(public\.has_role\(v_uid/IF false AND NOT (public.has_role(v_uid/'
exige_vermelho "K4 gate de staff removido → R4" \
  "$(como $U true "SELECT count(*) FROM public.get_planos_margem(ARRAY['$P1']::uuid[]);")" "0" "1"
P -q -f "$MIG_A"

# K5 — anon com EXECUTE → R7.
P -q -c "GRANT EXECUTE ON FUNCTION public.get_planos_margem(uuid[]) TO anon;"
exige_vermelho "K5 anon com EXECUTE → R7" \
  "$(veredito_nega "$(nega_anon "SELECT * FROM public.get_planos_margem(ARRAY['$P1']::uuid[])")")" "barrado" "vazou"
P -q -f "$MIG_A"

# K6 — backup legível por authenticated → T11.
P -q -c "GRANT SELECT ON private.farmer_tactical_plans_texto_original TO authenticated; CREATE POLICY k6 ON private.farmer_tactical_plans_texto_original FOR SELECT USING (true);"
exige_vermelho "K6 backup com GRANT → T11" \
  "$(veredito_nega "$(nega $A false "SELECT approach_strategy FROM private.farmer_tactical_plans_texto_original")")" "barrado" "vazou"
P -q -c "DROP POLICY k6 ON private.farmer_tactical_plans_texto_original;"
P -q -f "$MIG_A"
eq "K6r restaurado" "$(veredito_nega "$(nega $A false "SELECT approach_strategy FROM private.farmer_tactical_plans_texto_original")")" "barrado"

# K7 — trigger removido: a edge grava o texto como a IA escreveu → G1.
P -q -c "DROP TRIGGER trg_tactical_plan_saneia_margem ON public.farmer_tactical_plans;"
grava_c2 >/dev/null
exige_vermelho "K7 sem trigger → G1" "$(c2 "approach_strategy ~ '37,73'")" "f" "t"
P -q -f "$MIG_A"

# K8 — saneador sem a palavra 'margem' no contexto → G1.
sabota_a 's/\(margem\|margens\|rentabil/(margens|rentabil/'
grava_c2 >/dev/null
exige_vermelho "K8 contexto sem 'margem' → G1" "$(c2 "approach_strategy ~ '37,73'")" "f" "t"
P -q -f "$MIG_A"

# K9 — saneador sem a regra de contiguidade → G2.
sabota_a 's/IF v_fala OR \(v_tem_numero AND v_anterior_fala\) THEN/IF v_fala THEN/'
grava_c2 >/dev/null
exige_vermelho "K9 sem contiguidade → G2" "$(c2 "approach_strategy ~ 'A sua est'")" "f" "t"
P -q -f "$MIG_A"

# K10 — saneador de jsonb sem descer em objeto → G3 (a objeção leva o número).
sabota_a "s/WHEN 'object' THEN/WHEN 'objeto_nao' THEN/"
grava_c2 >/dev/null
exige_vermelho "K10 jsonb sem recursão em objeto → G3" \
  "$(c2 "(probable_objections::text ~ '37,73') || '|' || (probable_objections->0->>'probability')")" "false|55" "true|55"
P -q -f "$MIG_A"

# K11 — backfill sem o UPDATE: o histórico seguiria vazando → T8. Re-semeia o texto ORIGINAL do P1
# (trigger desligado só para o seed) e apaga o backup dele, como se a A nunca tivesse rodado.
P -q <<SQL
ALTER TABLE public.farmer_tactical_plans DISABLE TRIGGER trg_tactical_plan_saneia_margem;
UPDATE public.farmer_tactical_plans p SET approach_strategy = o.approach_strategy, approach_strategy_b = o.approach_strategy_b,
       implication_question = o.implication_question, offer_transition = o.offer_transition,
       diagnostic_questions = o.diagnostic_questions, probable_objections = o.probable_objections,
       operational_risks = o.operational_risks
  FROM private.farmer_tactical_plans_texto_original o WHERE o.plan_id = p.id AND p.id = '$P1';
DELETE FROM private.farmer_tactical_plans_texto_original WHERE plan_id = '$P1';
ALTER TABLE public.farmer_tactical_plans ENABLE TRIGGER trg_tactical_plan_saneia_margem;
SQL
sabota_a 's/UPDATE public\.farmer_tactical_plans p\n   SET approach_strategy    = .*? WHERE p\.id IN \(SELECT o\.plan_id FROM private\.farmer_tactical_plans_texto_original o\);//s'
exige_vermelho "K11 backfill sem UPDATE → T8" \
  "$(texto "concat_ws(' ', approach_strategy, approach_strategy_b, implication_question, offer_transition, diagnostic_questions::text, probable_objections::text, operational_risks::text) ~ '(37,73|55,25)'" $P1)" "f" "t"
P -q -f "$MIG_A"
eq "K11r a A real saneia o histórico re-semeado (e re-guarda o original)" \
   "$(texto approach_strategy $P1)|$(P -tA -q -c "SELECT approach_strategy ~ '37,73' FROM private.farmer_tactical_plans_texto_original WHERE plan_id='$P1';")" \
   "Cliente ativo com compra recente. O risco de churn de 62% pede abordagem consultiva. Das 36 categorias, quais têm maior margem? Foque em ciclo de afiação.|t"

# K12 — saneador sem a normalização de "p.p." → T2 ("4 p.p." e "de margem" ficam em frases separadas).
P -q <<SQL
ALTER TABLE public.farmer_tactical_plans DISABLE TRIGGER trg_tactical_plan_saneia_margem;
UPDATE public.farmer_tactical_plans p SET implication_question = o.implication_question
  FROM private.farmer_tactical_plans_texto_original o WHERE o.plan_id = p.id AND p.id = '$P1';
DELETE FROM private.farmer_tactical_plans_texto_original WHERE plan_id = '$P1';
ALTER TABLE public.farmer_tactical_plans ENABLE TRIGGER trg_tactical_plan_saneia_margem;
SQL
sabota_a "s/regexp_replace\(p_texto, '\\\\mp\\\\.\\\\s\?p\\\\.', 'pp', 'gi'\)/p_texto/"
exige_vermelho "K12 sem normalizar p.p. → T2" "$(texto implication_question $P1)" \
  "Quanto custa a parada de máquina?" "Recuperar 4 p.p. de margem equivale a R\$ 1.350/mês. Quanto custa a parada de máquina?"
P -q -f "$MIG_A"
eq "K12r restaurado" "$(texto implication_question $P1)" "Quanto custa a parada de máquina?"

# K13 — o POS8 da PRÓPRIA migration tem dente: com o backfill sabotado (sem UPDATE) e a postcondição
# MANTIDA, o apply tem de ABORTAR nomeando o resíduo — é o que impede um apply parcial em prod.
P -q <<SQL
ALTER TABLE public.farmer_tactical_plans DISABLE TRIGGER trg_tactical_plan_saneia_margem;
-- literal, não o backup: o K12 re-guardou o P1 com o approach já saneado.
UPDATE public.farmer_tactical_plans SET approach_strategy = 'Sua margem bruta é de 37,73%.' WHERE id = '$P1';
ALTER TABLE public.farmer_tactical_plans ENABLE TRIGGER trg_tactical_plan_saneia_margem;
SQL
perl -0pe 's/UPDATE public\.farmer_tactical_plans p\n   SET approach_strategy    = .*? WHERE p\.id IN \(SELECT o\.plan_id FROM private\.farmer_tactical_plans_texto_original o\);//s' \
  "$MIG_A" > "$RODADA/a-sem-update.sql"
K13=$(P -q -f "$RODADA/a-sem-update.sql" 2>&1 || true)
case "$K13" in
  *"POS8 FALHOU: 1 plano(s) seguem citando margem com numero"*) ok "K13 POS8 aborta o apply com resíduo — vermelho exato" ;;
  *) bad "K13 POS8 não abortou com a mensagem esperada: [$K13]" ;;
esac
P -q -f "$MIG_A"
eq "K13r restaurado" "$(texto "approach_strategy ~ '37,73'" $P1)" "f"

echo "-- pós-falsificação: tudo restaurado volta verde --"
asserts_gravacao
asserts_rpc
asserts_coluna

echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "HARNESS VERMELHO"; exit 1; }
echo "HARNESS VERDE"
