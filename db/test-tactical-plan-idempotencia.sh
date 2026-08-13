#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  HARNESS PG17 — PROVA de migration money-path/auth com FALSIFICAÇÃO            ║
# ║  Copie p/ db/test-<slug>.sh, preencha as ZONAS [[...]], rode:                  ║
# ║      bash db/test-<slug>.sh > /tmp/t.log 2>&1; echo "exit=$?"                  ║
# ║  (NÃO pipe pra tail — engole o exit≠0; §2 do CLAUDE.md.)                       ║
# ║                                                                                ║
# ║  Lei de Ferro (skill prove-sql-money-path):                                    ║
# ║   1. Aplica a migration REAL (psql -f), não um stub da lógica.                 ║
# ║   2. Assert negativo captura a SQLSTATE esperada e RE-LANÇA o resto.           ║
# ║   3. Falsificação obrigatória: sabota a migração → exija VERMELHO → restaura.  ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

# ── arranque PG17 descartável (idêntico em todos os harnesses; contorna keg-only do brew) ──
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5471}"     # mude se rodar em paralelo com outro harness (40 worktrees)
SLUG="tactical-idem"            # plano tático — idempotência do dia operacional
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C          # sem isso o postmaster aborta ("became multithreaded during startup")

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER} pgvector"; exit 1; }

# keg-only do brew: share/lib do postgresql@17 podem não estar linkados → initdb/server falham. Copia do Cellar (idempotente).
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
Pq() { P -tA "$@"; }   # tuples-only, unaligned (pra capturar 1 valor)

# ── base mínima do Supabase: roles, schema auth, auth.uid()/role() via GUC (impersonação de RLS) ──
P -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -q <<'SQL'
CREATE OR REPLACE FUNCTION auth.uid()  RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.uid',  true), '')::uuid $f$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.role', true), '') $f$;
ALTER ROLE service_role BYPASSRLS;   -- espelha o admin role do Supabase (semear sem esbarrar em RLS)
SQL

# ── helpers de assert (pass/fail contados; exit 1 no fim se houve fail) ──
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }
# exige que um comando SQL FALHE (caminho negativo grosso). Pra checar a SQLSTATE exata, use o
# padrão DO/EXCEPTION de references/assert-patterns.md (preferível — Lei #2).
must_fail() { if P -q -c "$1" >/dev/null 2>&1; then bad "$2 — devia ter falhado e PASSOU"; else ok "$2 (rejeitado)"; fi; }

echo "═══ setup pronto (PG17 :$PORT) ═══"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — PRÉ-REQUISITOS DE SCHEMA (o que a migração LÊ/ALTERA mas não cria)
# ══════════════════════════════════════════════════════════════════════════════
# Opção (a) MÍNIMO — stub só das tabelas/colunas que a migração toca:
# P -q <<'SQL'
# CREATE TABLE IF NOT EXISTS public.user_roles (user_id uuid, role text);
# CREATE TABLE IF NOT EXISTS public.[[tabela_que_a_migracao_le]] ( ... colunas usadas ... );
# SQL
#
# Opção (b) FIEL — aplica o snapshot inteiro (pega dependências reais; mais lento):
# RR="$(mktemp /tmp/snap-rr.XXXXXX.sql)"
# sed -E 's/^(CREATE SCHEMA public;)/-- \1/' "$REPO_ROOT/supabase/schema-snapshot.sql" \
#   | grep -vE '^\\(un)?restrict ' > "$RR"
# P -q -f "$REPO_ROOT/supabase/schema-extensions-prelude.sql"
# P --single-transaction -q -f "$RR"; rm -f "$RR"
# ⚠️ snapshot pode estar STALE — se faltar coluna recente, ALTER TABLE ... ADD COLUMN IF NOT EXISTS antes.
#
# Stub MÍNIMO: só o que a migration lê/altera. `farmer_tactical_plans` transcrita das
# colunas reais de prod (information_schema, 2026-07-31) — inclusive os `DEFAULT 0` que a
# migration existe para remover, senão o assert do DROP DEFAULT mediria o nada.
P -q <<'SQL'
CREATE TABLE public.carteira_assignments (
  customer_user_id uuid PRIMARY KEY,
  owner_user_id    uuid,
  eligible         boolean NOT NULL DEFAULT true
);

CREATE TABLE public.farmer_tactical_plans (
  id                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  farmer_id                 uuid NOT NULL,
  customer_user_id          uuid NOT NULL,
  status                    text DEFAULT 'gerado',
  bundle_recommendation_id  uuid,
  health_score              numeric,
  churn_risk                numeric,
  mix_gap                   integer,
  current_margin_pct        numeric,
  cluster_avg_margin_pct    numeric,
  expansion_potential       numeric,
  strategic_objective       text,
  customer_profile          text,
  plan_type                 text DEFAULT 'essencial',
  top_bundle                jsonb DEFAULT '{}'::jsonb,
  second_bundle             jsonb DEFAULT '{}'::jsonb,
  bundle_lie                numeric DEFAULT 0,
  bundle_probability        numeric DEFAULT 0,
  bundle_incremental_margin numeric DEFAULT 0,
  best_individual_lie       numeric DEFAULT 0,
  diagnostic_questions      jsonb DEFAULT '[]'::jsonb,
  implication_question      text,
  offer_transition          text,
  probable_objections       jsonb DEFAULT '[]'::jsonb,
  approach_strategy         text,
  approach_strategy_b       text,
  ltv_projection            jsonb,
  expected_result           jsonb,
  operational_risks         jsonb DEFAULT '[]'::jsonb,
  created_at                timestamptz DEFAULT now(),
  generated_at              timestamptz DEFAULT now()
);

-- A RPC de prod chama private.carteira_visivel_para; o gate de carteira não é o objeto sob
-- teste aqui (tem harness próprio), então stubamos permissivo — o que se prova é a
-- idempotência. O caminho service_role (o do cron) nem passa por ele.
CREATE SCHEMA IF NOT EXISTS private;
CREATE OR REPLACE FUNCTION private.carteira_visivel_para(_customer uuid, _uid uuid)
RETURNS boolean LANGUAGE sql STABLE AS $f$ SELECT true $f$;
SQL

# ── PASSIVO HISTÓRICO: reproduz o incidente de 2026-07-21 (30 grupos duplicados em prod).
# O índice único tem de nascer APESAR deles — se o recorte `>= 2026-07-22` for removido, o
# CREATE INDEX falha e o harness fica vermelho no A0. Sem esta seed, o recorte seria
# indistinguível de código morto.
P -q <<'SQL'
INSERT INTO public.farmer_tactical_plans (farmer_id, customer_user_id, status, plan_type, created_at)
SELECT '10000000-0000-0000-0000-000000000001'::uuid,
       ('20000000-0000-0000-0000-' || lpad(i::text, 12, '0'))::uuid,
       'gerado', 'estrategico',
       -- 22:03 e 19:03 UTC do dia 21 → MESMO dia operacional BRT (21/07), dias UTC iguais
       -- mas horários que o eixo antigo (00:00 UTC) tratava de forma inconsistente.
       (ARRAY['2026-07-21 22:03:29+00'::timestamptz, '2026-07-22 01:48:00+00'::timestamptz])[k]
  FROM generate_series(1, 30) i, generate_series(1, 2) k;
SQL
DUP_ANTES=$(Pq -c "SELECT count(*) FROM (SELECT 1 FROM public.farmer_tactical_plans WHERE status='gerado' GROUP BY farmer_id, customer_user_id, (((created_at AT TIME ZONE 'UTC') - interval '3 hours')::date), plan_type HAVING count(*)>1) t;")
eq "A0 passivo histórico semeado (grupos duplicados pré-corte)" "$DUP_ANTES" "30"



# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — APLICAR A MIGRATION REAL (Lei #1: o .sql commitado, não um stub)
# ══════════════════════════════════════════════════════════════════════════════
MIG="$REPO_ROOT/supabase/migrations/20260802130000_tactical_plan_idempotencia_dia.sql"
P -q -f "$MIG"
echo "migration aplicada: $(basename "$MIG")"


# ══════════════════════════════════════════════════════════════════════════════
# ZONA 3 — SEED + GRANTs (semeie como postgres; conceda privilégio p/ os asserts de RLS)
# ══════════════════════════════════════════════════════════════════════════════
# Semeie como postgres (superuser ignora RLS e TEM privilégio). NÃO use SET ROLE service_role p/
# semear: BYPASSRLS ignora a RLS mas NÃO concede GRANT → "permission denied" na tabela.
# A migration do repo é --no-privileges (Supabase concede em runtime); aqui você concede p/ que os
# asserts de RLS (SET ROLE authenticated/anon) leiam — a RLS filtra por cima.
# ⚠️ a policy é avaliada com os privilégios do CALLER: se faz subselect noutra tabela (ex.: user_roles),
#    conceda SELECT nela TAMBÉM, senão a própria policy dá permission denied.
# P -q <<'SQL'
# INSERT INTO auth.users(id) VALUES ('11111111-1111-1111-1111-111111111111') ON CONFLICT DO NOTHING;
# INSERT INTO public.[[tabela]] (...) VALUES (...);
# GRANT SELECT ON public.[[tabela]], public.user_roles TO authenticated, anon;
# SQL
#
FARMER=10000000-0000-0000-0000-000000000001
OUTRO=10000000-0000-0000-0000-000000000009
CLI_A=30000000-0000-0000-0000-00000000000a
CLI_B=30000000-0000-0000-0000-00000000000b
CLI_MASC=30000000-0000-0000-0000-0000000000cc

P -q <<SQL
INSERT INTO public.carteira_assignments (customer_user_id, owner_user_id, eligible) VALUES
  ('$CLI_A',    '$FARMER', true),
  ('$CLI_B',    '$FARMER', true),
  ('$CLI_MASC', '$FARMER', false);
SQL

# Payload mínimo que a edge manda no modo self-contained.
PAYLOAD_EST='{"plan_type":"estrategico","strategic_objective":"expansao_mix","approach_strategy":"x"}'
PAYLOAD_ESS='{"plan_type":"essencial","strategic_objective":"expansao_mix","approach_strategy":"x"}'
# `_expected_owner` NULL + service_role = o caminho do cron (auth.role()='service_role').
cria() { P -tA -c "SET test.role='service_role'; SELECT public.criar_plano_tatico('$1'::uuid, '$2'::uuid, '$3'::jsonb);" 2>&1 | tail -1; }



# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4 — ASSERTS (positivo / negativo-com-SQLSTATE / RLS) — ver assert-patterns.md
# ══════════════════════════════════════════════════════════════════════════════
echo "── asserts ──"
# POSITIVO:
#   V=$(Pq -c "SELECT status FROM public.[[...]] WHERE id='...';"); eq "A1 efeito" "$V" "aprovado"
# NEGATIVO (gate/CHECK rejeita — captura a SQLSTATE esperada e re-lança o resto):
#   R=$(P -tA 2>&1 <<'SQL' ... SQL )  ← 2>&1 ESSENCIAL: o RAISE NOTICE da sentinela sai no STDERR
#   ver references/assert-patterns.md (bloco DO ... EXCEPTION WHEN <sqlstate> ... WHEN OTHERS THEN RAISE)
# RLS (own-scope / staff / anon-deny):
#   OWN=$(Pq -c "SET test.uid='11111111-1111-1111-1111-111111111111'; SET ROLE authenticated; SELECT count(*) FROM public.[[...]];" | tail -1)
#   eq "A2 own-scope" "$OWN" "1"
#
# As PROPRIEDADES viram funções (retornam 0 = vale, 1 = quebrada) para que a ZONA 5
# re-rode EXATAMENTE o mesmo assert sob sabotagem — sem cópia que possa divergir do
# original e "falsificar" outra coisa.

# P1 — a 2ª geração do mesmo dia é recusada COM A MENSAGEM que o caller casa.
# A mensagem faz parte do contrato: `ehJaGeradoHojeDaRpc` (edge) e `ehJaGeradoHoje` (front)
# a leem para transformar a recusa em `skipped:'ja_gerado_hoje'`/toast informativo. Um
# 23505 com o texto padrão do Postgres viraria `http_500` no relatório do lote.
# Sentinelas ASCII e EXCLUSIVAS — nenhuma contém o texto que a RPC emite (anti-teatro).
p1_recusa_com_mensagem() {
  local r
  r=$(P -tA 2>&1 <<SQL
DO \$\$
BEGIN
  PERFORM set_config('test.role','service_role',true);
  PERFORM public.criar_plano_tatico('$CLI_A'::uuid, '$FARMER'::uuid, '$PAYLOAD_EST'::jsonb);
  RAISE NOTICE 'SENTINELA_DUPLICATA_PASSOU';
EXCEPTION
  WHEN unique_violation THEN
    IF SQLERRM ILIKE '%gerado hoje para este cliente%' THEN
      RAISE NOTICE 'SENTINELA_RECUSA_CORRETA';
    ELSE
      RAISE NOTICE 'SENTINELA_MENSAGEM_ERRADA';
    END IF;
  WHEN OTHERS THEN RAISE;
END \$\$;
SQL
)
  MOTIVO_P1="$r"
  case "$r" in *SENTINELA_RECUSA_CORRETA*) return 0;; *) return 1;; esac
}

# P2 — o ÍNDICE barra o INSERT que contorna a RPC (invariante do banco, não de um IF).
p2_indice_barra_insert_cru() {
  local r
  r=$(P -tA 2>&1 <<SQL
DO \$\$
BEGIN
  INSERT INTO public.farmer_tactical_plans (farmer_id, customer_user_id, status, plan_type)
  VALUES ('$FARMER'::uuid, '$CLI_A'::uuid, 'gerado', 'estrategico');
  RAISE NOTICE 'SENTINELA_INSERT_CRU_PASSOU';
EXCEPTION
  WHEN unique_violation THEN RAISE NOTICE 'SENTINELA_INDICE_MORDEU';
  WHEN OTHERS THEN RAISE;
END \$\$;
SQL
)
  MOTIVO_P2="$r"
  case "$r" in *SENTINELA_INDICE_MORDEU*) return 0;; *) return 1;; esac
}

# P3 — plan_type DIFERENTE no mesmo dia continua PERMITIDO (a trava não vira cadeado).
p3_outro_plan_type_permitido() {
  local id; id=$(cria "$CLI_A" "$FARMER" "$PAYLOAD_ESS")
  MOTIVO_P3="$id"
  case "$id" in ????????-????-????-????-????????????) return 0;; *) return 1;; esac
}

# P4 — nenhuma das 4 colunas de bundle carrega DEFAULT constante.
p4_sem_default_constante() {
  local n; n=$(Pq -c "SELECT count(*) FROM information_schema.columns WHERE table_name='farmer_tactical_plans' AND column_name IN ('bundle_lie','bundle_probability','bundle_incremental_margin','best_individual_lie') AND column_default IS NOT NULL;")
  MOTIVO_P4="colunas com default=$n"
  [ "$n" = "0" ]
}

# P5 — não sobrou zero FABRICADO (linha sem bundle com 0 nos números).
p5_sem_zero_fabricado() {
  local n; n=$(Pq -c "SELECT count(*) FROM public.farmer_tactical_plans WHERE bundle_recommendation_id IS NULL AND (bundle_lie = 0 OR bundle_probability = 0 OR bundle_incremental_margin = 0);")
  MOTIVO_P5="linhas fabricadas=$n"
  [ "$n" = "0" ]
}

# ── A1-A3: o índice existe, é ÚNICO e usa o eixo BRT ─────────────────────────
IDXDEF=$(Pq -c "SELECT indexdef FROM pg_indexes WHERE indexname='ux_farmer_tactical_plans_dia_operacional';")
if [ -n "$IDXDEF" ]; then ok "A1 índice criado APESAR do passivo de 30 duplicatas"; else bad "A1 índice NÃO foi criado"; fi
case "$IDXDEF" in *"CREATE UNIQUE INDEX"*) ok "A2 índice é UNIQUE";; *) bad "A2 índice não é UNIQUE: $IDXDEF";; esac
case "$IDXDEF" in *"03:00:00"*|*"3 hours"*) ok "A3 eixo do dia é o offset BRT fixo (-3h)";; *) bad "A3 sem o offset -3h: $IDXDEF";; esac

# ── A4: caminho feliz ────────────────────────────────────────────────────────
ID1=$(cria "$CLI_A" "$FARMER" "$PAYLOAD_EST")
case "$ID1" in
  ????????-????-????-????-????????????) ok "A4 1ª geração do dia grava";;
  *) bad "A4 1ª geração deveria ter gravado, veio: $ID1";;
esac

# ── A5/A6: o coração do P2 — duplicata do dia recusada, 1 linha só ───────────
if p1_recusa_com_mensagem; then ok "A5 2ª geração do MESMO dia recusada com a mensagem do contrato"; else bad "A5 $MOTIVO_P1"; fi
N=$(Pq -c "SELECT count(*) FROM public.farmer_tactical_plans WHERE customer_user_id='$CLI_A' AND status='gerado';")
eq "A6 exatamente 1 plano do dia para o cliente" "$N" "1"

# ── A7: a trava não vira cadeado ─────────────────────────────────────────────
if p3_outro_plan_type_permitido; then ok "A7 outro plan_type no mesmo dia é permitido"; else bad "A7 essencial deveria passar, veio: $MOTIVO_P3"; fi

# ── A8: outro cliente no mesmo dia ───────────────────────────────────────────
ID3=$(cria "$CLI_B" "$FARMER" "$PAYLOAD_EST")
case "$ID3" in
  ????????-????-????-????-????????????) ok "A8 outro cliente no mesmo dia é permitido";;
  *) bad "A8 outro cliente deveria passar, veio: $ID3";;
esac

# ── A9: a janela é do DIA, não eterna ────────────────────────────────────────
P -q -c "UPDATE public.farmer_tactical_plans SET created_at = now() - interval '2 days' WHERE customer_user_id='$CLI_B';"
ID4=$(cria "$CLI_B" "$FARMER" "$PAYLOAD_EST")
case "$ID4" in
  ????????-????-????-????-????????????) ok "A9 plano de dias atrás não bloqueia o de hoje";;
  *) bad "A9 deveria permitir novo plano hoje, veio: $ID4";;
esac

# ── A10: defesa ESTRUTURAL (índice) independe da RPC ─────────────────────────
if p2_indice_barra_insert_cru; then ok "A10 índice barra INSERT direto que contorna a RPC"; else bad "A10 $MOTIVO_P2"; fi

# ── A11: parcial de propósito — concluído sai do índice ──────────────────────
P -q -c "UPDATE public.farmer_tactical_plans SET status='concluido' WHERE customer_user_id='$CLI_A' AND plan_type='estrategico';"
ID5=$(cria "$CLI_A" "$FARMER" "$PAYLOAD_EST")
case "$ID5" in
  ????????-????-????-????-????????????) ok "A11 plano concluído no mesmo dia não bloqueia novo";;
  *) bad "A11 deveria permitir após conclusão, veio: $ID5";;
esac

# ── A12/A13: as defesas ANTERIORES da RPC continuam de pé ────────────────────
R=$(P -tA 2>&1 <<SQL
DO \$\$
BEGIN
  PERFORM set_config('test.role','service_role',true);
  PERFORM public.criar_plano_tatico('$CLI_MASC'::uuid, '$FARMER'::uuid, '$PAYLOAD_EST'::jsonb);
  RAISE NOTICE 'SENTINELA_MASCARADO_PASSOU';
EXCEPTION
  WHEN insufficient_privilege THEN RAISE NOTICE 'SENTINELA_MASCARA_OK';
  WHEN OTHERS THEN RAISE;
END \$\$;
SQL
)
case "$R" in *SENTINELA_MASCARA_OK*) ok "A12 máscara eligible continua fail-closed";; *) bad "A12 máscara eligible quebrou: $R";; esac

R=$(P -tA 2>&1 <<SQL
DO \$\$
BEGIN
  PERFORM set_config('test.role','service_role',true);
  PERFORM public.criar_plano_tatico('$CLI_B'::uuid, '$OUTRO'::uuid, '$PAYLOAD_ESS'::jsonb);
  RAISE NOTICE 'SENTINELA_RACE_PASSOU';
EXCEPTION
  WHEN raise_exception THEN
    IF SQLERRM ILIKE '%reatribu%' THEN RAISE NOTICE 'SENTINELA_RACE_OK';
    ELSE RAISE NOTICE 'SENTINELA_RACE_OUTRO'; END IF;
  WHEN OTHERS THEN RAISE;
END \$\$;
SQL
)
case "$R" in *SENTINELA_RACE_OK*) ok "A13 race-check de posse (_expected_owner) continua de pé";; *) bad "A13 race-check quebrou: $R";; esac

# ── A14-A16: colunas de bundle ───────────────────────────────────────────────
if p4_sem_default_constante; then ok "A14 nenhuma das 4 colunas de bundle tem DEFAULT constante"; else bad "A14 $MOTIVO_P4"; fi
if p5_sem_zero_fabricado; then ok "A15 zero fabricado eliminado do histórico sem bundle"; else bad "A15 $MOTIVO_P5"; fi
BIL=$(Pq -c "SELECT count(*) FROM public.farmer_tactical_plans WHERE best_individual_lie IS NOT NULL;")
eq "A16 best_individual_lie NULL em todas as linhas (ninguém o calcula)" "$BIL" "0"

# ── A17: o zero MEDIDO sobrevive (o erro simétrico também é bug) ─────────────
P -q <<SQL
INSERT INTO public.farmer_tactical_plans (farmer_id, customer_user_id, status, plan_type, bundle_recommendation_id, bundle_lie, bundle_probability, bundle_incremental_margin)
VALUES ('$FARMER'::uuid, '40000000-0000-0000-0000-00000000000f'::uuid, 'concluido', 'estrategico', gen_random_uuid(), 0, 0, 0);
SQL
MEDIDO=$(Pq -c "SELECT count(*) FROM public.farmer_tactical_plans WHERE bundle_recommendation_id IS NOT NULL AND bundle_lie = 0;")
eq "A17 zero MEDIDO (linha COM bundle) não é apagado pelo backfill" "$MEDIDO" "1"

# ── A18: recorte ≠ deleção — o passivo do incidente segue intacto ────────────
PASSIVO=$(Pq -c "SELECT count(*) FROM public.farmer_tactical_plans WHERE (((created_at AT TIME ZONE 'UTC') - interval '3 hours')::date) = DATE '2026-07-21';")
eq "A18 as 60 linhas do incidente de 21/07 seguem intactas" "$PASSIVO" "60"


# ══════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICAÇÃO (Lei #3: sabota a migração → exija VERMELHO → restaura)
# ══════════════════════════════════════════════════════════════════════════════
# Padrão (ver assert-patterns.md p/ a versão completa, incl. sentinela anti-teatro):
#   1. sabota:   recria a policy/trigger/função NA VERSÃO FURADA
#   2. re-roda:  o MESMO assert do passo 4
#   3. exige:    que ele agora FALHE (se passar → assert fraco → conserte)
#   4. restaura: a versão verdadeira (cirurgicamente, só o que sabotou)
#
# Cada sabotagem PROVA QUE APLICOU antes de julgar (money-path: "sabotagem que não casou
# nada" devolve verde de código intacto, que se lê como "o assert não tem dente"). O
# veredito distingue os TRÊS desfechos: pegou / não pegou / sabotagem inválida.
FALS_OK=0; FALS_BAD=0
falsifica() { # $1=nome  $2=fn da propriedade  ($2 tem de FALHAR sob sabotagem)
  if "$2"; then FALS_BAD=$((FALS_BAD+1)); echo "  ❌ FALSIFICAÇÃO $1 — assert seguiu VERDE sob sabotagem (sem dente)";
  else FALS_OK=$((FALS_OK+1)); echo "  ✅ FALSIFICAÇÃO $1 — vermelho como esperado"; fi
}
# Estado limpo para a bateria: um único plano 'gerado' de hoje para CLI_A/estrategico.
reset_cli_a() {
  P -q -c "DELETE FROM public.farmer_tactical_plans WHERE customer_user_id='$CLI_A';" >/dev/null
  cria "$CLI_A" "$FARMER" "$PAYLOAD_EST" >/dev/null
}
# Recria a RPC SEM o bloco de idempotência, derivando-a do corpo REAL em vigor (não de uma
# cópia colada): assim a sabotagem não pode divergir da função que está sendo testada.
rpc_sem_exists() {
  P -q <<'SQL'
DO $$
DECLARE d text;
BEGIN
  d := pg_get_functiondef('public.criar_plano_tatico(uuid,uuid,jsonb)'::regprocedure);
  -- remove o IF EXISTS(...) THEN RAISE ... END IF; da idempotência
  d := regexp_replace(d, 'IF EXISTS \(\s*SELECT 1 FROM public\.farmer_tactical_plans.*?END IF;', '', 'ns');
  -- e o tradutor de unique_violation, para o texto do contrato não vir por outra via
  d := regexp_replace(d, 'EXCEPTION WHEN unique_violation THEN.*?USING ERRCODE = ''23505'';', 'EXCEPTION WHEN unique_violation THEN RAISE;', 'ns');
  IF d LIKE '%gerado hoje para este cliente%' THEN
    RAISE EXCEPTION 'SABOTAGEM INVALIDA: o bloco de idempotencia nao foi removido';
  END IF;
  EXECUTE d;
END $$;
SQL
}
# Restaurar exige LIMPAR ANTES: a própria sabotagem GRAVA a duplicata que ela prova (é o
# ponto), e o `CREATE UNIQUE INDEX` da migration falharia sobre ela. Um restore que falha em
# silêncio deixaria o harness terminar verde com a migration sabotada — o pior desfecho.
# (Pego pelo A19, que existe exatamente para isso.)
restaura_tudo() {
  P -q -c "DELETE FROM public.farmer_tactical_plans WHERE customer_user_id='$CLI_A';" >/dev/null
  P -q -f "$MIG" >/dev/null
}

echo "── falsificação ──"

# F1 — sem o ÍNDICE, a defesa estrutural some (mas a RPC ainda segura → P1 fica verde,
#      e é isso que mostra que P1 e P2 medem coisas DIFERENTES).
reset_cli_a
P -q -c "DROP INDEX public.ux_farmer_tactical_plans_dia_operacional;"
[ -z "$(Pq -c "SELECT indexname FROM pg_indexes WHERE indexname='ux_farmer_tactical_plans_dia_operacional';")" ] \
  && echo "  · sabotagem F1 aplicada (índice removido)" || { echo "  ⚠️  F1 NÃO aplicou — falsificação inválida"; FALS_BAD=$((FALS_BAD+1)); }
falsifica "F1 índice ausente → A10" p2_indice_barra_insert_cru
if p1_recusa_com_mensagem; then echo "  ✅ CONTROLE F1 — a RPC continua segurando sem o índice (P1 e P2 são independentes)"; else echo "  ❌ CONTROLE F1 — P1 caiu junto: os asserts não são independentes"; FALS_BAD=$((FALS_BAD+1)); fi
restaura_tudo

# F2 — RPC sem o re-check, ÍNDICE intacto: a duplicata continua barrada (pelo índice), mas
#      com a mensagem CRUA do Postgres → o caller leria `http_500` em vez de `skipped`.
#      É a prova de que o assert mede o CONTRATO da mensagem, não só "deu erro".
reset_cli_a
rpc_sem_exists
echo "  · sabotagem F2 aplicada (re-check removido do corpo em vigor)"
falsifica "F2 sem re-check → A5 (mensagem do contrato)" p1_recusa_com_mensagem
case "$MOTIVO_P1" in *SENTINELA_MENSAGEM_ERRADA*) echo "  · discriminador F2 correto: barrou, mas com mensagem fora do contrato";; *) echo "  ⚠️  F2 caiu por outro motivo: $MOTIVO_P1";; esac
restaura_tudo

# F3 — as DUAS defesas fora: a duplicata REALMENTE entra (o bug original, reproduzido).
reset_cli_a
P -q -c "DROP INDEX public.ux_farmer_tactical_plans_dia_operacional;"
rpc_sem_exists
echo "  · sabotagem F3 aplicada (índice + re-check fora)"
falsifica "F3 bug original reproduzido → A5" p1_recusa_com_mensagem
case "$MOTIVO_P1" in *SENTINELA_DUPLICATA_PASSOU*) echo "  · discriminador F3 correto: o 2º plano do dia foi GRAVADO";; *) echo "  ⚠️  F3 caiu por outro motivo: $MOTIVO_P1";; esac
restaura_tudo

# F4 — o RECORTE `>= 2026-07-22` não é código morto: sem ele o índice NÃO NASCE, porque as
#      30 duplicatas de 21/07 (que este harness semeia de propósito) o violam.
R=$(P -tA 2>&1 <<'SQL'
DO $$
BEGIN
  EXECUTE $i$
    CREATE UNIQUE INDEX ux_falsifica_sem_recorte ON public.farmer_tactical_plans (
      farmer_id, customer_user_id,
      (((created_at AT TIME ZONE 'UTC') - interval '3 hours')::date),
      (COALESCE(plan_type, 'essencial'))
    ) WHERE status = 'gerado'
  $i$;
  RAISE NOTICE 'SENTINELA_SEM_RECORTE_CRIOU';
EXCEPTION WHEN unique_violation THEN RAISE NOTICE 'SENTINELA_PASSIVO_BLOQUEIA';
END $$;
SQL
)
case "$R" in
  *SENTINELA_PASSIVO_BLOQUEIA*) FALS_OK=$((FALS_OK+1)); echo "  ✅ FALSIFICAÇÃO F4 — sem o recorte o índice não nasce (o recorte é necessário)";;
  *SENTINELA_SEM_RECORTE_CRIOU*) FALS_BAD=$((FALS_BAD+1)); echo "  ❌ FALSIFICAÇÃO F4 — índice sem recorte nasceu: o passivo não foi semeado, e o recorte parece código morto"; P -q -c "DROP INDEX IF EXISTS public.ux_falsifica_sem_recorte;";;
  *) FALS_BAD=$((FALS_BAD+1)); echo "  ❌ FALSIFICAÇÃO F4 — desfecho inesperado: $R";;
esac

# F5 — DEFAULT 0 de volta: o guard do "rótulo com default constante" acusa.
P -q -c "ALTER TABLE public.farmer_tactical_plans ALTER COLUMN bundle_lie SET DEFAULT 0;"
case "$(Pq -c "SELECT column_default FROM information_schema.columns WHERE table_name='farmer_tactical_plans' AND column_name='bundle_lie';")" in
  0) echo "  · sabotagem F5 aplicada (DEFAULT 0 recolocado)";;
  *) echo "  ⚠️  F5 NÃO aplicou — falsificação inválida"; FALS_BAD=$((FALS_BAD+1));;
esac
falsifica "F5 DEFAULT 0 de volta → A14" p4_sem_default_constante
P -q -c "ALTER TABLE public.farmer_tactical_plans ALTER COLUMN bundle_lie DROP DEFAULT;"

# F6 — o assert do backfill discrimina: uma linha fabricada nova o derruba.
P -q -c "INSERT INTO public.farmer_tactical_plans (farmer_id, customer_user_id, status, plan_type, bundle_lie, bundle_probability, bundle_incremental_margin) VALUES ('$FARMER'::uuid, '50000000-0000-0000-0000-0000000000ff'::uuid, 'concluido', 'essencial', 0, 0, 0);"
echo "  · sabotagem F6 aplicada (linha com zero fabricado inserida)"
falsifica "F6 zero fabricado novo → A15" p5_sem_zero_fabricado
P -q -c "DELETE FROM public.farmer_tactical_plans WHERE customer_user_id='50000000-0000-0000-0000-0000000000ff';"

# F7 — plan_type FORA da chave: a trava viraria cadeado e barraria o essencial legítimo.
reset_cli_a
P -q -c "DROP INDEX public.ux_farmer_tactical_plans_dia_operacional;"
P -q -c "CREATE UNIQUE INDEX ux_farmer_tactical_plans_dia_operacional ON public.farmer_tactical_plans (farmer_id, customer_user_id, (((created_at AT TIME ZONE 'UTC') - interval '3 hours')::date)) WHERE status = 'gerado' AND (((created_at AT TIME ZONE 'UTC') - interval '3 hours')::date) >= DATE '2026-07-22';"
rpc_sem_exists   # sem o re-check, quem decide é só o índice — isola a CHAVE
echo "  · sabotagem F7 aplicada (chave sem plan_type)"
falsifica "F7 chave sem plan_type → A7 (essencial legítimo barrado)" p3_outro_plan_type_permitido
P -q -c "DROP INDEX public.ux_farmer_tactical_plans_dia_operacional;"
restaura_tudo

echo "── falsificação: $FALS_OK com dente / $FALS_BAD problemática ──"
[ "$FALS_BAD" = "0" ] || FAIL=$((FAIL+1))

# Estado final tem de voltar ao verdadeiro — senão o harness terminaria "verde" com a
# migration sabotada, que é o pior desfecho possível.
# `reset_cli_a` porque `restaura_tudo` limpa as linhas de CLI_A (a duplicata que a sabotagem
# grava impediria o CREATE INDEX): P1 precisa de UM plano de hoje para o 2º ser recusado.
reset_cli_a
if p1_recusa_com_mensagem && p2_indice_barra_insert_cru && p4_sem_default_constante; then
  ok "A19 migration RESTAURADA ao fim da falsificação"
else
  bad "A19 harness terminou com sabotagem residual"
fi



# ── veredito ──
echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
