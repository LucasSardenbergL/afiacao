#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA — apply_score_updates v4: #987-guard + sales_history_status (COALESCE)  ║
# ║  Migrations:                                                                   ║
# ║    supabase/migrations/20260622165000_sales_history_status_coluna.sql (col+CHECK)║
# ║    supabase/migrations/20260622170000_apply_score_updates_sales_history_status.sql║
# ║  Money-path · anti-ressurreição · deploy bidirecional-seguro.                  ║
# ║  Lei de Ferro: (1) migration REAL; (2) negativo c/ SQLSTATE+re-raise;          ║
# ║  (3) falsificação obrigatória (sabota COALESCE → exige vermelho → restaura).   ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5466}"
SLUG="apply-score-updates-shs"
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
ALTER ROLE service_role BYPASSRLS;
SQL

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

# ids fixos
B_ID="bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
B_CUST="b0000000-0000-4000-8000-000000000002"
FARMER="f0000000-0000-4000-8000-000000000003"

echo "═══ setup pronto (PG17 :$PORT) ═══"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — PRÉ-REQUISITO: farmer_client_scores (schema real de PROD) + farmer_algorithm_config
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
-- farmer_algorithm_config: schema real de prod (value numeric NOT NULL). T2 insere o config.
CREATE TABLE public.farmer_algorithm_config (
  id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  key text NOT NULL,
  value numeric NOT NULL,
  description text,
  updated_at timestamptz DEFAULT now()
);
SQL

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — APLICAR AS MIGRATIONS REAIS (Lei #1: os .sql commitados)
# Pré-flight: a v4 estende a v3/guard (já em prod). Aqui parto do schema limpo e aplico
# T2 (coluna+CHECK+config) e T3 (a RPC v4) — o corpo testado = o corpo que vai pra prod.
# ══════════════════════════════════════════════════════════════════════════════
MIG_COL="$REPO_ROOT/supabase/migrations/20260622165000_sales_history_status_coluna.sql"
MIG_RPC="$REPO_ROOT/supabase/migrations/20260622170000_apply_score_updates_sales_history_status.sql"
P -q -f "$MIG_COL" >/dev/null
P -q -f "$MIG_RPC" >/dev/null
echo "migrations aplicadas: $(basename "$MIG_COL") + $(basename "$MIG_RPC")"

# sanidade do schema pós-T2: a coluna + o CHECK + o config existem
eq "S0a coluna sales_history_status existe" \
  "$(Pq -c "SELECT count(*) FROM information_schema.columns WHERE table_name='farmer_client_scores' AND column_name='sales_history_status';")" "1"
eq "S0b CHECK da coluna existe" \
  "$(Pq -c "SELECT count(*) FROM pg_constraint WHERE conname='farmer_client_scores_sales_history_status_check';")" "1"
eq "S0c config sales_active_threshold_days = 180" \
  "$(Pq -c "SELECT value FROM public.farmer_algorithm_config WHERE key='sales_active_threshold_days';")" "180"
# CHECK morde valor inválido (sanidade — fora dos 6 asserts pedidos, mas barato)
INVALID=$(P -tA 2>&1 <<SQL
DO \$\$ BEGIN
  INSERT INTO public.farmer_client_scores (id, customer_user_id, farmer_id, sales_history_status)
  VALUES ('cccccccc-cccc-4ccc-8ccc-cccccccccccc','c0000000-0000-4000-8000-000000000009','$FARMER','xpto');
  RAISE EXCEPTION 'CHECK_NAO_BARROU';
EXCEPTION
  WHEN check_violation THEN RAISE NOTICE 'CHECK_OK';
  WHEN OTHERS THEN RAISE;
END \$\$;
SQL
)
case "$INVALID" in *CHECK_OK*) ok "S0d CHECK rejeita valor fora do domínio" ;; *) bad "S0d CHECK — veio: $INVALID" ;; esac

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 3 — SEED + GRANT
# ══════════════════════════════════════════════════════════════════════════════
P -q <<SQL
INSERT INTO public.farmer_client_scores
  (id, customer_user_id, farmer_id, health_score, health_class, churn_risk, priority_score,
   rf_score, m_score, g_score, days_since_last_purchase, avg_monthly_spend_180d, category_count,
   sales_history_status, calculated_at, updated_at)
VALUES
  ('$B_ID','$B_CUST','$FARMER', 50,'estavel', 50, 40, 45, 35, 25, 90, 1234.50, 3,
   'ativo','2026-06-01T00:00:00Z','2026-06-01T00:00:00Z');
GRANT SELECT, UPDATE ON public.farmer_client_scores TO service_role;
SQL

echo "── asserts ──"

# ──────────────────────────────────────────────────────────────────────────────
# A1 — COALESCE PRESERVA (o teste-chave): 13 chaves core SEM sales_history_status → mantém 'ativo'.
# ──────────────────────────────────────────────────────────────────────────────
RET=$(Pq -c "SELECT public.apply_score_updates(jsonb_build_array(jsonb_build_object(
  'id','$B_ID','health_score',60,'health_class','estavel','churn_risk',40,'priority_score',45,
  'rf_score',55,'m_score',45,'g_score',35,'days_since_last_purchase',30,
  'avg_monthly_spend_180d',2000,'category_count',4,
  'calculated_at','2026-06-22T00:00:00Z','updated_at','2026-06-22T00:00:00Z')));" | tail -1)
eq "A1a RPC retorna 1 (1 linha afetada)" "$RET" "1"
eq "A1b sales_history_status PRESERVADO ('ativo', NÃO virou NULL)" \
  "$(Pq -c "SELECT sales_history_status FROM public.farmer_client_scores WHERE id='$B_ID';")" "ativo"
# e a base core foi de fato atualizada (prova que o UPDATE rodou de verdade, não no-op)
eq "A1c health_score atualizado p/ 60 (UPDATE rodou)" \
  "$(Pq -c "SELECT health_score FROM public.farmer_client_scores WHERE id='$B_ID';")" "60"

# ──────────────────────────────────────────────────────────────────────────────
# A2 — ATUALIZA: enviar sales_history_status='stale' → vira 'stale'.
# ──────────────────────────────────────────────────────────────────────────────
Pq -c "SELECT public.apply_score_updates(jsonb_build_array(jsonb_build_object(
  'id','$B_ID','health_score',60,'health_class','estavel','churn_risk',40,'priority_score',45,
  'rf_score',55,'m_score',45,'g_score',35,'days_since_last_purchase',30,
  'avg_monthly_spend_180d',2000,'category_count',4,'sales_history_status','stale',
  'calculated_at','2026-06-22T00:00:00Z','updated_at','2026-06-22T00:00:00Z')));" >/dev/null
eq "A2 sales_history_status ATUALIZADO p/ 'stale'" \
  "$(Pq -c "SELECT sales_history_status FROM public.farmer_client_scores WHERE id='$B_ID';")" "stale"

# ──────────────────────────────────────────────────────────────────────────────
# A3 — NULL EXPLÍCITO PRESERVA: linha em 'stale', enviar "sales_history_status": null → mantém 'stale'.
# (COALESCE(null, atual) = atual — null explícito é indistinguível de ausente p/ jsonb_to_recordset.)
# ──────────────────────────────────────────────────────────────────────────────
Pq -c "SELECT public.apply_score_updates(jsonb_build_array(jsonb_build_object(
  'id','$B_ID','health_score',60,'health_class','estavel','churn_risk',40,'priority_score',45,
  'rf_score',55,'m_score',45,'g_score',35,'days_since_last_purchase',30,
  'avg_monthly_spend_180d',2000,'category_count',4,'sales_history_status',NULL,
  'calculated_at','2026-06-22T00:00:00Z','updated_at','2026-06-22T00:00:00Z')));" >/dev/null
eq "A3 null explícito PRESERVA ('stale' mantido, NÃO virou NULL)" \
  "$(Pq -c "SELECT sales_history_status FROM public.farmer_client_scores WHERE id='$B_ID';")" "stale"

# ──────────────────────────────────────────────────────────────────────────────
# A4 — GUARD INTACTO: linha faltando health_class (campo CORE) → SQLSTATE 23514 (check_violation).
# Captura a SQLSTATE esperada e re-lança o resto (Lei #2). Sentinela própria (anti-teatro).
# ──────────────────────────────────────────────────────────────────────────────
R=$(P -tA 2>&1 <<SQL
DO \$\$ BEGIN
  PERFORM public.apply_score_updates(jsonb_build_array(jsonb_build_object(
    'id','$B_ID','health_score',60,'churn_risk',40,'priority_score',45,
    'rf_score',55,'m_score',45,'g_score',35,'days_since_last_purchase',30,
    'avg_monthly_spend_180d',2000,'category_count',4,
    'calculated_at','2026-06-22T00:00:00Z','updated_at','2026-06-22T00:00:00Z')));
  RAISE EXCEPTION 'GUARD_NAO_BARROU';
EXCEPTION
  WHEN check_violation THEN RAISE NOTICE 'GUARD_OK_23514';
  WHEN OTHERS THEN RAISE;
END \$\$;
SQL
)
case "$R" in *GUARD_OK_23514*) ok "A4 guard barra core-nulo c/ check_violation (23514)" ;; *) bad "A4 guard — veio: $R" ;; esac
# e a linha ficou INTOCADA (o lote inteiro abortou — sales_history_status segue 'stale')
eq "A4b lote abortado: linha intocada (sales_history_status='stale')" \
  "$(Pq -c "SELECT sales_history_status FROM public.farmer_client_scores WHERE id='$B_ID';")" "stale"

# ──────────────────────────────────────────────────────────────────────────────
# A5 — GRANT: authenticated NÃO executa (false); service_role executa (true). anon false.
# ──────────────────────────────────────────────────────────────────────────────
eq "A5a authenticated NÃO tem EXECUTE" \
  "$(Pq -c "SELECT has_function_privilege('authenticated','public.apply_score_updates(jsonb)','EXECUTE');")" "f"
eq "A5b service_role TEM EXECUTE" \
  "$(Pq -c "SELECT has_function_privilege('service_role','public.apply_score_updates(jsonb)','EXECUTE');")" "t"
eq "A5c anon NÃO tem EXECUTE" \
  "$(Pq -c "SELECT has_function_privilege('anon','public.apply_score_updates(jsonb)','EXECUTE');")" "f"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICAÇÃO (Lei #3): sabota o COALESCE → exige que A1b vire VERMELHO → restaura.
# ══════════════════════════════════════════════════════════════════════════════
echo "── falsificação ──"
# Reset: volta a linha pra 'ativo' (estado de entrada de A1).
P -q -c "UPDATE public.farmer_client_scores SET sales_history_status='ativo' WHERE id='$B_ID';" >/dev/null

# 1) SABOTA: recria a RPC trocando o COALESCE por atribuição direta (= u.sales_history_status).
#    Igual à v4, mas sem o COALESCE no SET → omitir a chave grava NULL.
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.apply_score_updates(p_updates jsonb)
RETURNS integer LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $fn$
DECLARE v_count int; v_total int; v_valid int;
BEGIN
  v_total := jsonb_array_length(p_updates);
  SELECT count(*) INTO v_valid FROM jsonb_to_recordset(p_updates) AS u(
    id uuid, health_score numeric, health_class text, churn_risk numeric, priority_score numeric,
    rf_score numeric, m_score numeric, g_score numeric, days_since_last_purchase integer,
    avg_monthly_spend_180d numeric, category_count integer, calculated_at timestamptz, updated_at timestamptz)
  WHERE id IS NOT NULL AND health_score IS NOT NULL AND health_class IS NOT NULL AND churn_risk IS NOT NULL
    AND priority_score IS NOT NULL AND rf_score IS NOT NULL AND m_score IS NOT NULL AND g_score IS NOT NULL
    AND days_since_last_purchase IS NOT NULL AND avg_monthly_spend_180d IS NOT NULL AND category_count IS NOT NULL
    AND calculated_at IS NOT NULL AND updated_at IS NOT NULL;
  IF v_valid <> v_total THEN
    RAISE EXCEPTION 'guard' USING ERRCODE='check_violation';
  END IF;
  UPDATE public.farmer_client_scores f SET
    health_score=u.health_score, health_class=u.health_class, churn_risk=u.churn_risk,
    priority_score=u.priority_score, rf_score=u.rf_score, m_score=u.m_score, g_score=u.g_score,
    days_since_last_purchase=u.days_since_last_purchase, avg_monthly_spend_180d=u.avg_monthly_spend_180d,
    category_count=u.category_count,
    sales_history_status = u.sales_history_status,   -- ◄ SABOTADO: sem COALESCE
    calculated_at=u.calculated_at, updated_at=u.updated_at
  FROM jsonb_to_recordset(p_updates) AS u(
    id uuid, health_score numeric, health_class text, churn_risk numeric, priority_score numeric,
    rf_score numeric, m_score numeric, g_score numeric, days_since_last_purchase integer,
    avg_monthly_spend_180d numeric, category_count integer, sales_history_status text,
    calculated_at timestamptz, updated_at timestamptz)
  WHERE f.id = u.id;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END $fn$;
SQL

# 2+3) RE-RODA A1 (omite a chave) e EXIGE que agora a coluna vire NULL (A1b ficaria vermelho).
Pq -c "SELECT public.apply_score_updates(jsonb_build_array(jsonb_build_object(
  'id','$B_ID','health_score',60,'health_class','estavel','churn_risk',40,'priority_score',45,
  'rf_score',55,'m_score',45,'g_score',35,'days_since_last_purchase',30,
  'avg_monthly_spend_180d',2000,'category_count',4,
  'calculated_at','2026-06-22T00:00:00Z','updated_at','2026-06-22T00:00:00Z')));" >/dev/null
SABOTADO=$(Pq -c "SELECT sales_history_status IS NULL FROM public.farmer_client_scores WHERE id='$B_ID';")
if [ "$SABOTADO" = "t" ]; then
  ok "F1 sabotagem (sem COALESCE) → omitir a chave APAGA p/ NULL → A1b tem dente"
else
  bad "F1 sabotei o COALESCE e a coluna NÃO virou NULL (veio IS NULL=$SABOTADO) → A1b é fraco"
fi

# 4) RESTAURA a versão verdadeira (re-aplica a migration real) e prova A1b verde de novo.
P -q -f "$MIG_RPC" >/dev/null
P -q -c "UPDATE public.farmer_client_scores SET sales_history_status='ativo' WHERE id='$B_ID';" >/dev/null
Pq -c "SELECT public.apply_score_updates(jsonb_build_array(jsonb_build_object(
  'id','$B_ID','health_score',60,'health_class','estavel','churn_risk',40,'priority_score',45,
  'rf_score',55,'m_score',45,'g_score',35,'days_since_last_purchase',30,
  'avg_monthly_spend_180d',2000,'category_count',4,
  'calculated_at','2026-06-22T00:00:00Z','updated_at','2026-06-22T00:00:00Z')));" >/dev/null
eq "F2 pós-restauro: COALESCE volta a PRESERVAR ('ativo' mantido ao omitir a chave)" \
  "$(Pq -c "SELECT sales_history_status FROM public.farmer_client_scores WHERE id='$B_ID';")" "ativo"

echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
