#!/usr/bin/env bash
# ════════════════════════════════════════════════════════════════════════════════
# PROVA — apply_score_updates(jsonb): recompute UPDATE-only, anti-ressurreição + recência-viva
# Migration (v2): supabase/migrations/20260622140000_apply_score_updates_persiste_base_vendas.sql
# Roda:  bash db/test-apply-score-updates.sh > /tmp/t.log 2>&1; echo "exit=$?"
#
# Invariantes:
#   N1 (anti-ressurreição, #971): linha DELETADA mid-run (race com aplicar_exclusao_fornecedores)
#       NÃO recria via id stale (UPDATE-only). Falsificação F1: sabota p/ upsert → EXIGE ressurreição.
#   P13-15 (recência-viva, #970): days_since_last_purchase / avg_monthly_spend_180d / category_count
#       são PERSISTIDOS frescos (o #971 os congelava — regressão fechada aqui). Falsificação F4:
#       sabota recriando a RPC de 9 campos (#971) → EXIGE a base CONGELADA (vermelho).
#
# Nota: interpolação de uuid é feita pelo SHELL ('$VAR'); psql -c não expande :'var'.
# Heredocs com $$/$fn$ ficam aspados <<'SQL' (não usam ids).
# ════════════════════════════════════════════════════════════════════════════════
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5466}"
SLUG="apply-score-updates"
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

# ids fixos (8-4-4-4-12 hex)
A_ID="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"        # linha do FORNECEDOR (deletada mid-run)
A_CUST="a0000000-0000-4000-8000-000000000001"
B_ID="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"        # linha de CLIENTE normal
B_CUST="b0000000-0000-4000-8000-000000000002"
FARMER="f0000000-0000-4000-8000-000000000003"
APRIME_ID="a1111111-1111-4111-8111-111111111111"  # A recriada sob NOVO id (variante-colisão)

echo "═══ setup pronto (PG17 :$PORT) ═══"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — PRÉ-REQUISITO: farmer_client_scores (schema real + UNIQUE de PROD)
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
CREATE TABLE public.farmer_client_scores (
  id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  customer_user_id uuid NOT NULL,
  farmer_id uuid NOT NULL,
  rf_score numeric DEFAULT 0,
  m_score numeric DEFAULT 0,
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
  gross_margin_pct numeric DEFAULT 0,
  category_count integer DEFAULT 0,
  answer_rate_60d numeric DEFAULT 0,
  whatsapp_reply_rate_60d numeric DEFAULT 0,
  revenue_potential numeric DEFAULT 0,
  calculated_at timestamptz DEFAULT now(),
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(),
  signal_modifiers jsonb DEFAULT '{}'::jsonb,
  last_signal_recalc_at timestamptz,
  CONSTRAINT farmer_client_scores_customer_unique UNIQUE (customer_user_id)
);
SQL

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — APLICAR A MIGRATION REAL (Lei #1)
# ══════════════════════════════════════════════════════════════════════════════
MIG="$REPO_ROOT/supabase/migrations/20260622140000_apply_score_updates_persiste_base_vendas.sql"
P -q -f "$MIG" >/dev/null
echo "migration aplicada: $(basename "$MIG")"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 3 — SEED (valores ANTIGOS distinguíveis) + GRANT runtime do service_role
# ══════════════════════════════════════════════════════════════════════════════
P -q <<SQL
-- valores-base VELHOS distinguíveis (days=42, spend=111, category=9) → o positivo prova que viram frescos
INSERT INTO public.farmer_client_scores
  (id, customer_user_id, farmer_id, health_score, health_class, churn_risk, priority_score,
   rf_score, m_score, g_score, x_score, s_score, days_since_last_purchase,
   avg_monthly_spend_180d, category_count, calculated_at, updated_at)
VALUES
  ('$A_ID', '$A_CUST', '$FARMER', 10, 'critico', 90, 5, 1, 2, 3, 5, 7, 42, 111, 9, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
  ('$B_ID', '$B_CUST', '$FARMER', 10, 'critico', 90, 5, 1, 2, 3, 5, 7, 42, 111, 9, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z');
GRANT SELECT, UPDATE ON public.farmer_client_scores TO service_role;
SQL

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4 — ASSERTS
# ══════════════════════════════════════════════════════════════════════════════
echo "── positivos / paridade de colunas ──"
R=$(Pq <<SQL
SELECT public.apply_score_updates(jsonb_build_array(jsonb_build_object(
  'id', '$B_ID', 'health_score', 88, 'health_class', 'saudavel', 'churn_risk', 12,
  'priority_score', 77, 'rf_score', 90, 'm_score', 80, 'g_score', 70,
  'days_since_last_purchase', 7, 'avg_monthly_spend_180d', 2500, 'category_count', 4,
  'calculated_at', '2026-06-18T20:00:00Z', 'updated_at', '2026-06-18T20:00:00Z'
)));
SQL
)
eq "P0  retorno = 1 (B atualizado)"  "$R" "1"
eq "P1  health_score"   "$(Pq -c "SELECT health_score   FROM public.farmer_client_scores WHERE id='$B_ID';")" "88"
eq "P2  health_class"   "$(Pq -c "SELECT health_class   FROM public.farmer_client_scores WHERE id='$B_ID';")" "saudavel"
eq "P3  churn_risk"     "$(Pq -c "SELECT churn_risk     FROM public.farmer_client_scores WHERE id='$B_ID';")" "12"
eq "P4  priority_score" "$(Pq -c "SELECT priority_score FROM public.farmer_client_scores WHERE id='$B_ID';")" "77"
eq "P5  rf_score"       "$(Pq -c "SELECT rf_score       FROM public.farmer_client_scores WHERE id='$B_ID';")" "90"
eq "P6  m_score"        "$(Pq -c "SELECT m_score        FROM public.farmer_client_scores WHERE id='$B_ID';")" "80"
eq "P7  g_score"        "$(Pq -c "SELECT g_score        FROM public.farmer_client_scores WHERE id='$B_ID';")" "70"
eq "P8  calculated_at aplicado" "$(Pq -c "SELECT calculated_at='2026-06-18T20:00:00Z'::timestamptz FROM public.farmer_client_scores WHERE id='$B_ID';")" "t"
eq "P9  updated_at aplicado"    "$(Pq -c "SELECT updated_at='2026-06-18T20:00:00Z'::timestamptz   FROM public.farmer_client_scores WHERE id='$B_ID';")" "t"
eq "P10 customer_user_id PRESERVADO" "$(Pq -c "SELECT customer_user_id FROM public.farmer_client_scores WHERE id='$B_ID';")" "$B_CUST"
eq "P11 farmer_id PRESERVADO"        "$(Pq -c "SELECT farmer_id        FROM public.farmer_client_scores WHERE id='$B_ID';")" "$FARMER"
eq "P12 x_score INTOCADO (fora do contrato)"                  "$(Pq -c "SELECT x_score                  FROM public.farmer_client_scores WHERE id='$B_ID';")" "5"
eq "P13 days_since_last_purchase ATUALIZADO (recência-viva #970)" "$(Pq -c "SELECT days_since_last_purchase FROM public.farmer_client_scores WHERE id='$B_ID';")" "7"
eq "P14 avg_monthly_spend_180d ATUALIZADO (recência-viva #970)"   "$(Pq -c "SELECT avg_monthly_spend_180d   FROM public.farmer_client_scores WHERE id='$B_ID';")" "2500"
eq "P15 category_count ATUALIZADO (recência-viva #970)"           "$(Pq -c "SELECT category_count           FROM public.farmer_client_scores WHERE id='$B_ID';")" "4"

echo "── N1: ANTI-RESSURREIÇÃO (linha deletada mid-run não volta) ──"
# espelha aplicar_exclusao_fornecedores(): DELETE da linha do fornecedor DEPOIS de o compute lê-la
P -q -c "DELETE FROM public.farmer_client_scores WHERE id='$A_ID';"
R=$(Pq <<SQL
SELECT public.apply_score_updates(jsonb_build_array(
  jsonb_build_object('id','$A_ID','health_score',88,'health_class','saudavel','churn_risk',12,'priority_score',77,'rf_score',90,'m_score',80,'g_score',70,'days_since_last_purchase',7,'avg_monthly_spend_180d',2500,'category_count',4,'calculated_at','2026-06-18T20:00:00Z','updated_at','2026-06-18T20:00:00Z'),
  jsonb_build_object('id','$B_ID','health_score',50,'health_class','estavel','churn_risk',50,'priority_score',40,'rf_score',45,'m_score',35,'g_score',25,'days_since_last_purchase',8,'avg_monthly_spend_180d',2600,'category_count',5,'calculated_at','2026-06-18T20:00:00Z','updated_at','2026-06-18T20:00:00Z')
));
SQL
)
eq "N1a só B casa (A deletado não recria) → 1" "$R" "1"
eq "N1b A continua AUSENTE (sem ressurreição pura)"   "$(Pq -c "SELECT count(*) FROM public.farmer_client_scores WHERE id='$A_ID';")"               "0"
eq "N1c fornecedor não voltou (por customer_user_id)" "$(Pq -c "SELECT count(*) FROM public.farmer_client_scores WHERE customer_user_id='$A_CUST';")" "0"

echo "── N2: ANTI-COLISÃO 23505 (id stale com customer_user_id já recriado) ──"
# variante-colisão: A foi recriada sob NOVO id (ex.: reverter_exclusao_fornecedor → recalc)
P -q -c "INSERT INTO public.farmer_client_scores (id, customer_user_id, farmer_id) VALUES ('$APRIME_ID','$A_CUST','$FARMER');"
if OUT=$(Pq 2>&1 <<SQL
SELECT public.apply_score_updates(jsonb_build_array(jsonb_build_object(
  'id','$A_ID','customer_user_id','$A_CUST','health_score',88,'health_class','saudavel','churn_risk',12,'priority_score',77,'rf_score',90,'m_score',80,'g_score',70,'days_since_last_purchase',7,'avg_monthly_spend_180d',2500,'category_count',4,'calculated_at','2026-06-18T20:00:00Z','updated_at','2026-06-18T20:00:00Z'
)));
SQL
); then eq "N2a id stale não casa → 0 linhas, SEM 23505" "$OUT" "0"
else bad "N2a apply LANÇOU erro (esperava 0, provável 23505): $OUT"; fi
eq "N2b A' (novo id) íntegra, sem duplicar" "$(Pq -c "SELECT count(*) FROM public.farmer_client_scores WHERE customer_user_id='$A_CUST';")" "1"

echo "── N3: grants (REVOKE PUBLIC/anon/authenticated, GRANT service_role) ──"
R=$(P -tA 2>&1 <<'SQL'
SET ROLE authenticated;
DO $$
BEGIN
  PERFORM public.apply_score_updates('[]'::jsonb);
  RAISE EXCEPTION 'EXEC_NAO_BARROU';
EXCEPTION
  WHEN insufficient_privilege THEN RAISE NOTICE 'REVOKE_OK';
  WHEN OTHERS THEN RAISE;
END $$;
SQL
)
case "$R" in *REVOKE_OK*) ok "N3a authenticated BARRADO (REVOKE)";; *) bad "N3a — veio: $R";; esac
R=$(P -tA 2>&1 <<'SQL'
SET ROLE anon;
DO $$
BEGIN
  PERFORM public.apply_score_updates('[]'::jsonb);
  RAISE EXCEPTION 'EXEC_NAO_BARROU';
EXCEPTION
  WHEN insufficient_privilege THEN RAISE NOTICE 'REVOKE_OK';
  WHEN OTHERS THEN RAISE;
END $$;
SQL
)
case "$R" in *REVOKE_OK*) ok "N3b anon BARRADO (REVOKE)";; *) bad "N3b — veio: $R";; esac
eq "N3c service_role EXECUTA (0 linhas, vazio)" "$(Pq -c "SET ROLE service_role; SELECT public.apply_score_updates('[]'::jsonb);" | tail -n1)" "0"

echo "── N4: CONTRATO full-update (chave de base AUSENTE no JSON → coluna vira NULL) ──"
# Documenta o gume do contrato que o header da migration avisa (achado /codex P2#3): jsonb_to_recordset
# NÃO faz COALESCE → chave ausente vira SQL NULL e sobrescreve. O edge SEMPRE manda as 12 (?? sentinel),
# então isto NUNCA dispara em prod; o teste prova o que acontece SE um caller driftar (= a classe de bug
# do #971). NÃO há falsificação: N4 documenta um hazard, não protege um invariante.
P -q -c "DELETE FROM public.farmer_client_scores WHERE id='$B_ID'; INSERT INTO public.farmer_client_scores (id, customer_user_id, farmer_id, days_since_last_purchase, avg_monthly_spend_180d, category_count) VALUES ('$B_ID','$B_CUST','$FARMER', 42, 111, 9);"
# payload OMITE days_since_last_purchase (manda só spend+category dos 3 de base)
P -q <<SQL
SELECT public.apply_score_updates(jsonb_build_array(jsonb_build_object(
  'id','$B_ID','health_score',88,'health_class','saudavel','churn_risk',12,'priority_score',77,'rf_score',90,'m_score',80,'g_score',70,'avg_monthly_spend_180d',2500,'category_count',4,'calculated_at','2026-06-18T20:00:00Z','updated_at','2026-06-18T20:00:00Z'
)));
SQL
eq "N4a chave ausente → days_since_last_purchase vira NULL (contrato: caller DEVE mandar as 12)" "$(Pq -c "SELECT days_since_last_purchase IS NULL FROM public.farmer_client_scores WHERE id='$B_ID';")" "t"
eq "N4b campos presentes ainda aplicam (spend=2500)"                                             "$(Pq -c "SELECT avg_monthly_spend_180d FROM public.farmer_client_scores WHERE id='$B_ID';")" "2500"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICAÇÃO (Lei #3: sabota → exige VERMELHO → restaura)
# ══════════════════════════════════════════════════════════════════════════════
echo "── falsificação ──"

# F1 — dente do N1: troca a RPC por um UPSERT (re-insere id ausente). EXIGE ressuscitar.
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.apply_score_updates(p_updates jsonb)
RETURNS integer LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $fn$
DECLARE v_count int;
BEGIN
  INSERT INTO public.farmer_client_scores AS f
    (id, customer_user_id, farmer_id, health_score, health_class, churn_risk, priority_score, rf_score, m_score, g_score, calculated_at, updated_at)
  SELECT u.id, u.customer_user_id, u.farmer_id, u.health_score, u.health_class, u.churn_risk, u.priority_score, u.rf_score, u.m_score, u.g_score, u.calculated_at, u.updated_at
  FROM jsonb_to_recordset(p_updates) AS u(id uuid, customer_user_id uuid, farmer_id uuid, health_score numeric, health_class text, churn_risk numeric, priority_score numeric, rf_score numeric, m_score numeric, g_score numeric, calculated_at timestamptz, updated_at timestamptz)
  ON CONFLICT (id) DO UPDATE SET health_score = excluded.health_score;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $fn$;
SQL
# garante A ausente E libera o customer_user_id (apaga A' do N2) p/ o INSERT sabotado não bater no UNIQUE
P -q -c "DELETE FROM public.farmer_client_scores WHERE id='$A_ID' OR customer_user_id='$A_CUST';"
P -q <<SQL
SELECT public.apply_score_updates(jsonb_build_array(jsonb_build_object(
  'id','$A_ID','customer_user_id','$A_CUST','farmer_id','$FARMER','health_score',88,'health_class','saudavel','churn_risk',12,'priority_score',77,'rf_score',90,'m_score',80,'g_score',70,'calculated_at','2026-06-18T20:00:00Z','updated_at','2026-06-18T20:00:00Z'
)));
SQL
case "$(Pq -c "SELECT count(*) FROM public.farmer_client_scores WHERE id='$A_ID';")" in
  1) ok "F1 upsert RESSUSCITOU a linha deletada (N1 tem dente; a RPC real evita)";;
  *) bad "F1 sabotei p/ upsert e a linha NÃO voltou → N1 é fraco";;
esac
P -q -f "$MIG" >/dev/null                                              # restaura a RPC verdadeira
P -q -c "DELETE FROM public.farmer_client_scores WHERE id='$A_ID';"    # limpa a ressurreição

# F2 — dente do N3: concede EXECUTE a authenticated. EXIGE que passe a executar.
P -q -c "GRANT EXECUTE ON FUNCTION public.apply_score_updates(jsonb) TO authenticated; GRANT SELECT, UPDATE ON public.farmer_client_scores TO authenticated;"
R=$(P -tA 2>&1 <<'SQL'
SET ROLE authenticated;
DO $$
BEGIN
  PERFORM public.apply_score_updates('[]'::jsonb);
  RAISE NOTICE 'SABOTAGEM_EXECUTOU';
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'AINDA_BARRA'; END $$;
SQL
)
case "$R" in
  *SABOTAGEM_EXECUTOU*) ok "F2 com GRANT, authenticated executa (N3 tem dente)";;
  *) bad "F2 concedi GRANT e authenticated seguiu barrado → N3 fraco: $R";;
esac
P -q -f "$MIG" >/dev/null                                              # restaura (REVOKE da função)
P -q -c "REVOKE SELECT, UPDATE ON public.farmer_client_scores FROM authenticated;"

# F3 — dente da paridade (P2): RPC que OMITE health_class do SET. EXIGE health_class velho.
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.apply_score_updates(p_updates jsonb)
RETURNS integer LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $fn$
DECLARE v_count int;
BEGIN
  UPDATE public.farmer_client_scores f SET
    health_score = u.health_score        -- health_class OMITIDO (sabotagem)
  FROM jsonb_to_recordset(p_updates) AS u(id uuid, health_score numeric)
  WHERE f.id = u.id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $fn$;
SQL
P -q -c "DELETE FROM public.farmer_client_scores WHERE id='$B_ID'; INSERT INTO public.farmer_client_scores (id, customer_user_id, farmer_id, health_class) VALUES ('$B_ID','$B_CUST','$FARMER','critico');"
P -q <<SQL
SELECT public.apply_score_updates(jsonb_build_array(jsonb_build_object(
  'id','$B_ID','health_score',88,'health_class','saudavel','churn_risk',12,'priority_score',77,'rf_score',90,'m_score',80,'g_score',70,'calculated_at','2026-06-18T20:00:00Z','updated_at','2026-06-18T20:00:00Z'
)));
SQL
case "$(Pq -c "SELECT health_class FROM public.farmer_client_scores WHERE id='$B_ID';")" in
  critico) ok "F3 RPC sem health_class no SET deixa o valor velho (paridade P2 tem dente)";;
  *)       bad "F3 omiti health_class e ele mudou mesmo assim → P2 fraco";;
esac
P -q -f "$MIG" >/dev/null                                              # restaura a RPC verdadeira

# F4 — dente da recência-viva (P13-15): RPC que OMITE os 3 campos de base do SET (como a versão
# #971 de 9 campos). EXIGE que days/spend/category fiquem no valor VELHO (congelado) → prova que
# P13-15 têm dente E que era exatamente isto que o #971 causava. Sentinela anti-teatro: comparo o
# valor velho 42/111/9, não a string do código.
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.apply_score_updates(p_updates jsonb)
RETURNS integer LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $fn$
DECLARE v_count int;
BEGIN
  UPDATE public.farmer_client_scores f SET
    health_score = u.health_score   -- days/spend/category OMITIDOS (= regressão #971)
  FROM jsonb_to_recordset(p_updates) AS u(id uuid, health_score numeric)
  WHERE f.id = u.id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $fn$;
SQL
P -q -c "DELETE FROM public.farmer_client_scores WHERE id='$B_ID'; INSERT INTO public.farmer_client_scores (id, customer_user_id, farmer_id, days_since_last_purchase, avg_monthly_spend_180d, category_count) VALUES ('$B_ID','$B_CUST','$FARMER', 42, 111, 9);"
P -q <<SQL
SELECT public.apply_score_updates(jsonb_build_array(jsonb_build_object(
  'id','$B_ID','health_score',88,'health_class','saudavel','churn_risk',12,'priority_score',77,'rf_score',90,'m_score',80,'g_score',70,'days_since_last_purchase',7,'avg_monthly_spend_180d',2500,'category_count',4,'calculated_at','2026-06-18T20:00:00Z','updated_at','2026-06-18T20:00:00Z'
)));
SQL
case "$(Pq -c "SELECT days_since_last_purchase||'/'||avg_monthly_spend_180d||'/'||category_count FROM public.farmer_client_scores WHERE id='$B_ID';")" in
  42/111/9) ok "F4 RPC de 9 campos (#971) CONGELA a base → P13-15 têm dente (reproduz o bug)";;
  *)        bad "F4 omiti os 3 campos de base e eles mudaram mesmo assim → P13-15 fraco";;
esac
P -q -f "$MIG" >/dev/null                                              # restaura a RPC verdadeira (12 campos)

# ── veredito ──
echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
