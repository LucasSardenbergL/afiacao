#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════════════════
# PROVA — persistir cobertura de custo (itens_com_custo/itens_sem_custo) em farmer_client_scores
# Migration: supabase/migrations/20260728120000_farmer_persiste_cobertura_custo.sql
# Roda:  bash db/test-farmer-cobertura-custo.sh > /tmp/t.log 2>&1; echo "exit=$?"
#
# Invariantes (só o DELTA desta migration; anti-ressurreição/recência/grants seguem em
# db/test-apply-score-updates.sh — aqui provo o que EU acrescentei sem regredir o guard):
#   PA  número no payload → itens_com_custo/itens_sem_custo PERSISTEM e sobrescrevem o valor velho.
#   PB  itens_com_custo=0 grava 0 (NÃO NULL): "tem itens, nenhum com custo" ≠ "não computado" (ausente≠zero).
#   PC  chave presente com null grava NULL (sobrescreve o valor velho: cliente parou de ter item computável).
#   PD  chave AUSENTE preserva o valor atual (retrocompat: edge ANTIGA não zera a base — as duas
#       ordens de deploy do Lovable ficam seguras). É o coração da migration.
#   PE  colunas são bigint, is_nullable=YES, column_default IS NULL (sem DEFAULT de propósito).
#   G1  guard das 12 chaves CORE PRESERVADO: payload sem health_score → check_violation, linha intocada.
#   Falsificação:
#   F1  RPC que OMITE itens_com_custo do SET → PA fica VERMELHO (a coluna não persiste). Restaura.
#   F2  RPC que troca o CASE jsonb_exists por sobrescrita direta → PD fica VERMELHO (chave ausente
#       vira NULL, apagando o valor velho). Prova que o jsonb_exists é o que segura a retrocompat.
#
# Nota: interpolação de uuid é feita pelo SHELL ('$VAR'); heredocs sem ids ficam <<'SQL' (aspados).
# ════════════════════════════════════════════════════════════════════════════════
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5478}"
SLUG="farmer-cobertura-custo"
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

B_ID="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
B_CUST="b0000000-0000-4000-8000-000000000002"
FARMER="f0000000-0000-4000-8000-000000000003"

echo "═══ setup pronto (PG17 :$PORT) ═══"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — PRÉ-REQUISITO: farmer_client_scores (schema real de PROD, SEM as colunas novas)
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
CREATE TABLE public.farmer_client_scores (
  id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  customer_user_id uuid NOT NULL,
  farmer_id uuid NOT NULL,
  rf_score numeric DEFAULT 0,
  m_score numeric,
  g_score numeric DEFAULT 0,
  x_score numeric DEFAULT 0,
  s_score numeric DEFAULT 0,
  health_score numeric DEFAULT 0,
  health_class text DEFAULT 'critico',
  churn_risk numeric DEFAULT 0,
  recover_score numeric DEFAULT 0,
  expansion_score numeric DEFAULT 0,
  eff_score numeric DEFAULT 0,
  priority_score numeric DEFAULT 0,
  days_since_last_purchase integer DEFAULT 0,
  avg_repurchase_interval numeric DEFAULT 0,
  avg_monthly_spend_180d numeric DEFAULT 0,
  gross_margin_pct numeric,
  category_count integer DEFAULT 0,
  answer_rate_60d numeric DEFAULT 0,
  whatsapp_reply_rate_60d numeric DEFAULT 0,
  revenue_potential numeric DEFAULT 0,
  calculated_at timestamptz DEFAULT now(),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  signal_modifiers jsonb DEFAULT '{}'::jsonb,
  last_signal_recalc_at timestamptz,
  sales_history_status text,
  CONSTRAINT farmer_client_scores_customer_unique UNIQUE (customer_user_id)
);
SQL

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — APLICAR A MIGRATION REAL (Lei #1)
# ══════════════════════════════════════════════════════════════════════════════
MIG="$REPO_ROOT/supabase/migrations/20260728120000_farmer_persiste_cobertura_custo.sql"
P -q -f "$MIG" >/dev/null
echo "migration aplicada: $(basename "$MIG")"

# Payload CORE (12 chaves obrigatórias) reusável — a cada caso concatenamos as chaves de cobertura.
# Mantido numa função SQL p/ não repetir as 12 chaves em cada assert (e não errar uma).
P -q <<SQL
CREATE FUNCTION public.core_payload() RETURNS jsonb LANGUAGE sql AS \$f\$
  SELECT jsonb_build_object(
    'id','$B_ID','health_score',88,'health_class','saudavel','churn_risk',12,'priority_score',77,
    'rf_score',90,'g_score',70,'days_since_last_purchase',7,'avg_monthly_spend_180d',2500,
    'category_count',4,'calculated_at','2026-07-28T12:00:00Z','updated_at','2026-07-28T12:00:00Z')
\$f\$;
GRANT SELECT, UPDATE ON public.farmer_client_scores TO service_role;
SQL

# reseed: sempre volta B ao estado VELHO distinguível (itens_com_custo=77, itens_sem_custo=88, gm=99)
reseed() {
  P -q -c "DELETE FROM public.farmer_client_scores WHERE id='$B_ID';
           INSERT INTO public.farmer_client_scores
             (id, customer_user_id, farmer_id, health_score, days_since_last_purchase,
              avg_monthly_spend_180d, category_count, gross_margin_pct, itens_com_custo, itens_sem_custo)
           VALUES ('$B_ID','$B_CUST','$FARMER', 10, 42, 111, 9, 99, 77, 88);"
}

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4 — ASSERTS
# ══════════════════════════════════════════════════════════════════════════════
echo "── PA: número persiste e sobrescreve o velho ──"
reseed
R=$(Pq -c "SELECT public.apply_score_updates(jsonb_build_array(
  public.core_payload() || jsonb_build_object('itens_com_custo', 3, 'itens_sem_custo', 37)));")
eq "PA0 retorno = 1 (B atualizado)" "$R" "1"
eq "PA1 itens_com_custo = 3"  "$(Pq -c "SELECT itens_com_custo FROM public.farmer_client_scores WHERE id='$B_ID';")" "3"
eq "PA2 itens_sem_custo = 37" "$(Pq -c "SELECT itens_sem_custo FROM public.farmer_client_scores WHERE id='$B_ID';")" "37"
eq "PA3 health_score core tambem aplicou (UPDATE inteiro OK)" "$(Pq -c "SELECT health_score FROM public.farmer_client_scores WHERE id='$B_ID';")" "88"

echo "── PB: itens_com_custo=0 grava 0, NÃO NULL (ausente≠zero) ──"
reseed
Pq -c "SELECT public.apply_score_updates(jsonb_build_array(
  public.core_payload() || jsonb_build_object('itens_com_custo', 0, 'itens_sem_custo', 40)));" >/dev/null
eq "PB1 itens_com_custo = 0 (nao NULL)" "$(Pq -c "SELECT itens_com_custo FROM public.farmer_client_scores WHERE id='$B_ID';")" "0"
eq "PB2 itens_com_custo NÃO é NULL"     "$(Pq -c "SELECT itens_com_custo IS NULL FROM public.farmer_client_scores WHERE id='$B_ID';")" "f"
eq "PB3 itens_sem_custo = 40"           "$(Pq -c "SELECT itens_sem_custo FROM public.farmer_client_scores WHERE id='$B_ID';")" "40"

echo "── PC: chave presente com null grava NULL (sobrescreve o velho) ──"
reseed
Pq -c "SELECT public.apply_score_updates(jsonb_build_array(
  public.core_payload() || jsonb_build_object('itens_com_custo', null, 'itens_sem_custo', null)));" >/dev/null
eq "PC1 itens_com_custo virou NULL (era 77)" "$(Pq -c "SELECT itens_com_custo IS NULL FROM public.farmer_client_scores WHERE id='$B_ID';")" "t"
eq "PC2 itens_sem_custo virou NULL (era 88)" "$(Pq -c "SELECT itens_sem_custo IS NULL FROM public.farmer_client_scores WHERE id='$B_ID';")" "t"

echo "── PD: chave AUSENTE preserva o valor atual (retrocompat / edge antiga) ──"
reseed
# payload = core + gross_margin_pct, SEM as chaves itens_* → a edge antiga (que não as conhece)
Pq -c "SELECT public.apply_score_updates(jsonb_build_array(
  public.core_payload() || jsonb_build_object('gross_margin_pct', 55)));" >/dev/null
eq "PD1 itens_com_custo PRESERVADO em 77 (nao zerou)" "$(Pq -c "SELECT itens_com_custo FROM public.farmer_client_scores WHERE id='$B_ID';")" "77"
eq "PD2 itens_sem_custo PRESERVADO em 88"             "$(Pq -c "SELECT itens_sem_custo FROM public.farmer_client_scores WHERE id='$B_ID';")" "88"
eq "PD3 gross_margin_pct aplicou (chave presente)"    "$(Pq -c "SELECT gross_margin_pct FROM public.farmer_client_scores WHERE id='$B_ID';")" "55"

echo "── PE: schema das colunas (bigint, nullable, SEM default) ──"
eq "PE1 itens_com_custo é bigint"        "$(Pq -c "SELECT data_type FROM information_schema.columns WHERE table_name='farmer_client_scores' AND column_name='itens_com_custo';")" "bigint"
eq "PE2 itens_com_custo is_nullable=YES" "$(Pq -c "SELECT is_nullable FROM information_schema.columns WHERE table_name='farmer_client_scores' AND column_name='itens_com_custo';")" "YES"
eq "PE3 itens_com_custo SEM default"     "$(Pq -c "SELECT column_default IS NULL FROM information_schema.columns WHERE table_name='farmer_client_scores' AND column_name='itens_com_custo';")" "t"
eq "PE4 itens_sem_custo SEM default"     "$(Pq -c "SELECT column_default IS NULL FROM information_schema.columns WHERE table_name='farmer_client_scores' AND column_name='itens_sem_custo';")" "t"

echo "── G1: guard das 12 chaves CORE PRESERVADO (não regredi ao recriar a RPC) ──"
reseed
# core SEM health_score (jsonb - remove a chave) → deve dar check_violation ANTES do UPDATE
R=$(P -tA 2>&1 <<SQL
SET ROLE service_role;
DO \$\$
BEGIN
  PERFORM public.apply_score_updates(jsonb_build_array(
    (public.core_payload() - 'health_score') || jsonb_build_object('itens_com_custo', 5, 'itens_sem_custo', 5)));
  RAISE NOTICE 'GUARD_NAO_BARROU';
EXCEPTION
  WHEN check_violation THEN RAISE NOTICE 'GUARD_BARROU';
  WHEN OTHERS THEN RAISE;
END \$\$;
SQL
) || true
case "$R" in *GUARD_BARROU*) ok "G1a payload sem health_score REJEITADO (check_violation)";; *) bad "G1a — esperava check_violation, veio: $R";; esac
eq "G1b linha INTOCADA: itens_com_custo continua 77 (UPDATE nao rodou)" "$(Pq -c "SELECT itens_com_custo FROM public.farmer_client_scores WHERE id='$B_ID';")" "77"

echo "── N1: ANTI-RESSURREIÇÃO (#971) preservada — recriei a função INTEIRA, tenho de reprovar ──"
# A RPC é UPDATE-only por id de propósito: se aplicar_exclusao_fornecedores() DELETAR a linha
# mid-run, o id stale não casa e a função NÃO pode re-inserir (ressuscitaria um fornecedor excluído).
reseed
P -q -c "DELETE FROM public.farmer_client_scores WHERE id='$B_ID';"
R=$(Pq -c "SELECT public.apply_score_updates(jsonb_build_array(
  public.core_payload() || jsonb_build_object('itens_com_custo', 3, 'itens_sem_custo', 37)));")
eq "N1a id deletado mid-run: retorno 0 (nada atualizado)" "$R" "0"
eq "N1b NAO ressuscitou a linha (UPDATE-only, jamais INSERT)" "$(Pq -c "SELECT count(*) FROM public.farmer_client_scores WHERE id='$B_ID';")" "0"

echo "── N3: grants preservados (REVOKE anon/authenticated + GRANT service_role, no fim da migration) ──"
# Falha ABERTA seria invisível ao CI: a função nasce com EXECUTE p/ PUBLIC se o REVOKE sumir.
for ROLE in anon authenticated; do
  R=$(P -tA 2>&1 <<SQL
SET ROLE $ROLE;
DO \$\$
BEGIN
  PERFORM public.apply_score_updates('[]'::jsonb);
  RAISE NOTICE 'EXEC_NAO_BARROU';
EXCEPTION
  WHEN insufficient_privilege THEN RAISE NOTICE 'EXEC_BARRADO';
  WHEN OTHERS THEN RAISE;
END \$\$;
SQL
  ) || true
  case "$R" in
    *EXEC_BARRADO*) ok "N3 $ROLE BARRADO (insufficient_privilege)";;
    *) bad "N3 $ROLE — esperava barrado, veio: $R";;
  esac
done
# -q suprime a tag de comando do SET (sem ele a saida vem "SET\n0" e o assert falha por ruido, nao por regressao)
R=$(P -tAq -c "SET ROLE service_role; SELECT public.apply_score_updates('[]'::jsonb);" 2>&1) || true
eq "N3 service_role EXECUTA (lista vazia → 0)" "$R" "0"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICAÇÃO (Lei #3: sabota → exige VERMELHO → restaura)
# ══════════════════════════════════════════════════════════════════════════════
echo "── falsificação ──"

# F1 — dente do PA: RPC que OMITE itens_com_custo do SET. EXIGE que a coluna NÃO persista (fica velha).
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.apply_score_updates(p_updates jsonb)
RETURNS integer LANGUAGE plpgsql SET search_path TO 'public' AS $fn$
DECLARE v_count int;
BEGIN
  UPDATE public.farmer_client_scores f SET
    health_score    = u.health_score,
    itens_sem_custo = CASE WHEN u.tem_itens_sem_custo THEN u.itens_sem_custo ELSE f.itens_sem_custo END
    -- itens_com_custo OMITIDO (sabotagem)
  FROM (
    SELECT (e.elem->>'id')::uuid AS id, (e.elem->>'health_score')::numeric AS health_score,
           (e.elem->>'itens_sem_custo')::bigint AS itens_sem_custo,
           jsonb_exists(e.elem,'itens_sem_custo') AS tem_itens_sem_custo
    FROM jsonb_array_elements(p_updates) AS e(elem)
  ) u WHERE f.id = u.id;
  GET DIAGNOSTICS v_count = ROW_COUNT; RETURN v_count;
END $fn$;
SQL
reseed
Pq -c "SELECT public.apply_score_updates(jsonb_build_array(
  public.core_payload() || jsonb_build_object('itens_com_custo', 3, 'itens_sem_custo', 37)));" >/dev/null
case "$(Pq -c "SELECT itens_com_custo FROM public.farmer_client_scores WHERE id='$B_ID';")" in
  3) bad "F1 sabotei (removi itens_com_custo do SET) e PA seguiu verde → PA é fraco";;
  *) ok  "F1 RPC sem itens_com_custo no SET NÃO persiste (=$( Pq -c "SELECT itens_com_custo FROM public.farmer_client_scores WHERE id='$B_ID';")) → PA tem dente";;
esac
P -q -f "$MIG" >/dev/null   # restaura a RPC verdadeira

# F2 — dente do PD (retrocompat): RPC que sobrescreve itens_com_custo SEM o CASE jsonb_exists (direto
# u.itens_com_custo). EXIGE que a chave AUSENTE apague o valor velho (vira NULL) → prova que o
# jsonb_exists é o que segura a retrocompat, e não o teste. Sentinela: o EFEITO (vira NULL), não o texto.
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.apply_score_updates(p_updates jsonb)
RETURNS integer LANGUAGE plpgsql SET search_path TO 'public' AS $fn$
DECLARE v_count int;
BEGIN
  UPDATE public.farmer_client_scores f SET
    health_score    = u.health_score,
    itens_com_custo = u.itens_com_custo,   -- SEM CASE jsonb_exists (sabotagem: ausente vira NULL)
    itens_sem_custo = u.itens_sem_custo
  FROM (
    SELECT (e.elem->>'id')::uuid AS id, (e.elem->>'health_score')::numeric AS health_score,
           (e.elem->>'itens_com_custo')::bigint AS itens_com_custo,
           (e.elem->>'itens_sem_custo')::bigint AS itens_sem_custo
    FROM jsonb_array_elements(p_updates) AS e(elem)
  ) u WHERE f.id = u.id;
  GET DIAGNOSTICS v_count = ROW_COUNT; RETURN v_count;
END $fn$;
SQL
reseed
# payload SEM as chaves itens_* (edge antiga) — com a sabotagem, deve zerar o 77 para NULL
Pq -c "SELECT public.apply_score_updates(jsonb_build_array(
  public.core_payload() || jsonb_build_object('gross_margin_pct', 55)));" >/dev/null
case "$(Pq -c "SELECT itens_com_custo IS NULL FROM public.farmer_client_scores WHERE id='$B_ID';")" in
  t) ok  "F2 RPC sem CASE jsonb_exists APAGA o valor na chave ausente → PD tem dente (jsonb_exists segura a retrocompat)";;
  *) bad "F2 removi o CASE jsonb_exists e a chave ausente NÃO apagou → PD é teatro/fraco";;
esac
P -q -f "$MIG" >/dev/null   # restaura a RPC verdadeira

# ── veredito ──
echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
