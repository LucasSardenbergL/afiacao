#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA PG17 — 20260727130000_farmer_scores_colunas_orfas_null.sql              ║
# ║  DROP DEFAULT + backfill NULL nas 6 colunas órfãs, enfileirando SÓ os fósseis. ║
# ║  Rode: bash db/test-farmer-scores-colunas-orfas.sh > /tmp/t.log 2>&1; echo $?  ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5471}"
SLUG="farmer-orfas"
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

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

echo "═══ setup PG17 :$PORT ═══"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — SCHEMA (reproduz prod ANTES: DEFAULT 0 nas 6) + trigger real + fila + SEED
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
CREATE TABLE public.farmer_client_scores (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_user_id  uuid NOT NULL,
  farmer_id         uuid NOT NULL,
  priority_score    numeric,
  churn_risk        numeric,
  signal_modifiers  jsonb,
  recover_score     numeric DEFAULT 0,
  expansion_score   numeric DEFAULT 0,
  revenue_potential numeric DEFAULT 0,
  x_score           numeric DEFAULT 0,
  s_score           numeric DEFAULT 0,
  eff_score         numeric DEFAULT 0
);

CREATE TABLE public.visit_score_recalc_queue (
  id               bigserial PRIMARY KEY,
  customer_user_id uuid NOT NULL,
  farmer_id        uuid NOT NULL,
  reason           text,
  processed_at     timestamptz,
  created_at       timestamptz DEFAULT now()
);
CREATE UNIQUE INDEX visit_score_recalc_queue_pending_uk
  ON public.visit_score_recalc_queue (customer_user_id) WHERE processed_at IS NULL;

-- trigger REAL de prod (corpo verbatim de pg_get_functiondef, 2026-07-22): observa expansion_score.
CREATE OR REPLACE FUNCTION public.enqueue_visit_score_recalc_from_client_score()
 RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
BEGIN
  IF (NEW.priority_score    IS DISTINCT FROM OLD.priority_score
      OR NEW.churn_risk      IS DISTINCT FROM OLD.churn_risk
      OR NEW.expansion_score IS DISTINCT FROM OLD.expansion_score
      OR NEW.signal_modifiers IS DISTINCT FROM OLD.signal_modifiers)
     AND NEW.customer_user_id IS NOT NULL
     AND NEW.farmer_id IS NOT NULL THEN
    INSERT INTO public.visit_score_recalc_queue
      (customer_user_id, farmer_id, reason)
    VALUES
      (NEW.customer_user_id, NEW.farmer_id, 'score_changed')
    ON CONFLICT (customer_user_id) WHERE processed_at IS NULL DO NOTHING;
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER trg_farmer_client_scores_enqueue_visit_recalc
  AFTER UPDATE ON public.farmer_client_scores
  FOR EACH ROW EXECUTE FUNCTION public.enqueue_visit_score_recalc_from_client_score();

-- SEED: 1 FÓSSIL (expansion=60, muda de missão) + 2 no DEFAULT 0 (expansion=0, missão não muda).
INSERT INTO public.farmer_client_scores (customer_user_id, farmer_id, priority_score, churn_risk, expansion_score)
VALUES ('a0000000-0000-0000-0000-000000000001','f0000000-0000-0000-0000-000000000009', 30, 96, 60);
INSERT INTO public.farmer_client_scores (customer_user_id, farmer_id, priority_score, churn_risk)
VALUES ('a0000000-0000-0000-0000-000000000002','f0000000-0000-0000-0000-000000000009', 30, 96);
INSERT INTO public.farmer_client_scores (customer_user_id, farmer_id, priority_score, churn_risk)
VALUES ('a0000000-0000-0000-0000-000000000003','f0000000-0000-0000-0000-000000000009', 30, 96);
SQL

SEED_FILA=$(Pq -c "SELECT count(*) FROM public.visit_score_recalc_queue;")
eq "SETUP fila vazia após seed" "$SEED_FILA" "0"
FOSSIL=$(Pq -c "SELECT count(*) FROM public.farmer_client_scores WHERE expansion_score = 60;")
eq "SETUP 1 linha fóssil expansion=60" "$FOSSIL" "1"
ZEROS=$(Pq -c "SELECT count(*) FROM public.farmer_client_scores WHERE recover_score = 0 AND x_score = 0 AND s_score = 0 AND eff_score = 0 AND revenue_potential = 0;")
eq "SETUP 3 linhas com as órfãs no DEFAULT 0" "$ZEROS" "3"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — APLICAR A MIGRATION REAL (Lei #1)
# ══════════════════════════════════════════════════════════════════════════════
MIG="$REPO_ROOT/supabase/migrations/20260727130000_farmer_scores_colunas_orfas_null.sql"
P -q -f "$MIG"
echo "migration aplicada: $(basename "$MIG")"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4 — ASSERTS
# ══════════════════════════════════════════════════════════════════════════════
echo "── asserts ──"

# P2 — backfill: TODAS as 6 colunas viram NULL em TODAS as linhas (0 e o fóssil 60).
NAONULOS=$(Pq -c "SELECT count(*) FROM public.farmer_client_scores
  WHERE recover_score IS NOT NULL OR expansion_score IS NOT NULL OR revenue_potential IS NOT NULL
     OR x_score IS NOT NULL OR s_score IS NOT NULL OR eff_score IS NOT NULL;")
eq "P2 backfill: 0 linhas com qualquer órfã não-nula" "$NAONULOS" "0"

# P1 — DROP DEFAULT: linha NOVA que OMITE as 6 nasce NULL, não 0.
P -q -c "INSERT INTO public.farmer_client_scores (customer_user_id, farmer_id, priority_score, churn_risk)
         VALUES ('a0000000-0000-0000-0000-0000000000ff','f0000000-0000-0000-0000-000000000009', 30, 96);"
NOVA=$(Pq -c "SELECT count(*) FROM public.farmer_client_scores
  WHERE customer_user_id='a0000000-0000-0000-0000-0000000000ff'
    AND recover_score IS NULL AND expansion_score IS NULL AND revenue_potential IS NULL
    AND x_score IS NULL AND s_score IS NULL AND eff_score IS NULL;")
eq "P1 DROP DEFAULT: INSERT omitindo as 6 → NULL (não 0)" "$NOVA" "1"

# P3 — propagação CIRÚRGICA: a fila tem SÓ o fóssil (1), NÃO as 3 linhas existentes.
#      (a linha nova P1 é INSERT com o trigger ativo, mas expansion NULL IS NOT DISTINCT de NULL →
#       o trigger não dispara; de todo modo INSERT não é UPDATE. Por isso a fila = 1, não 2.)
FILA=$(Pq -c "SELECT count(*) FROM public.visit_score_recalc_queue;")
eq "P3 fila tem SÓ o fóssil (não a base inteira)" "$FILA" "1"
FILA_FOSSIL=$(Pq -c "SELECT count(*) FROM public.visit_score_recalc_queue
  WHERE customer_user_id='a0000000-0000-0000-0000-000000000001' AND reason='expansion_orfa_backfill';")
eq "P3b o fóssil está na fila com o reason certo" "$FILA_FOSSIL" "1"
# P3c — os 2 não-fósseis (expansion era 0) NÃO foram enfileirados (supressão via session_replication_role)
NAO_FOSSEIS=$(Pq -c "SELECT count(*) FROM public.visit_score_recalc_queue
  WHERE customer_user_id IN ('a0000000-0000-0000-0000-000000000002','a0000000-0000-0000-0000-000000000003');")
eq "P3c não-fósseis (expansion=0) NÃO enfileirados" "$NAO_FOSSEIS" "0"

# P3d — session_replication_role foi RESTAURADO (SET LOCAL reverte no COMMIT; não vazou 'replica')
SRR=$(Pq -c "SHOW session_replication_role;")
eq "P3d session_replication_role restaurado a 'origin'" "$SRR" "origin"

# P4 — idempotência: re-aplicar a migration INTEIRA não muda a fila nem re-nula (WHERE guard).
P -q -f "$MIG"
FILA2=$(Pq -c "SELECT count(*) FROM public.visit_score_recalc_queue;")
eq "P4 idempotência: 2ª aplicação da migration não re-enfileira" "$FILA2" "1"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICAÇÃO (sabota → exige VERMELHO → restaura)
# ══════════════════════════════════════════════════════════════════════════════
echo "── falsificação ──"
FALSIF_OK=0; FALSIF_BAD=0
fok()  { FALSIF_OK=$((FALSIF_OK+1));  echo "  ✅ falsif: $1"; }
fbad() { FALSIF_BAD=$((FALSIF_BAD+1)); echo "  ❌ falsif INÓCUA: $1"; }

# F1 — DROP DEFAULT tem dente? Re-arma o DEFAULT 0 e insere omitindo → nasce 0 (P1 mordeu).
P -q -c "ALTER TABLE public.farmer_client_scores ALTER COLUMN expansion_score SET DEFAULT 0;"
P -q -c "INSERT INTO public.farmer_client_scores (customer_user_id, farmer_id, priority_score, churn_risk)
         VALUES ('b0000000-0000-0000-0000-0000000000f1','f0000000-0000-0000-0000-000000000009', 30, 96);"
SAB1=$(Pq -c "SELECT expansion_score FROM public.farmer_client_scores WHERE customer_user_id='b0000000-0000-0000-0000-0000000000f1';")
if [ "$SAB1" = "0" ]; then fok "F1 sem DROP DEFAULT, INSERT omitindo → 0 (P1 mordeu)"; else fbad "F1 esperava 0, veio [$SAB1]"; fi
P -q -c "ALTER TABLE public.farmer_client_scores ALTER COLUMN expansion_score DROP DEFAULT;"
P -q -c "DELETE FROM public.farmer_client_scores WHERE customer_user_id='b0000000-0000-0000-0000-0000000000f1';"

# F2 — P2 tem dente? Injeta fóssil remanescente → count não-null passa de 0 → 1.
P -q -c "INSERT INTO public.farmer_client_scores (customer_user_id, farmer_id, priority_score, churn_risk, expansion_score)
         VALUES ('b0000000-0000-0000-0000-0000000000f2','f0000000-0000-0000-0000-000000000009', 30, 96, 60);"
SAB2=$(Pq -c "SELECT count(*) FROM public.farmer_client_scores WHERE expansion_score IS NOT NULL;")
if [ "$SAB2" = "1" ]; then fok "F2 fóssil remanescente detectado por P2 (=1)"; else fbad "F2 esperava 1, veio [$SAB2]"; fi
P -q -c "DELETE FROM public.farmer_client_scores WHERE customer_user_id='b0000000-0000-0000-0000-0000000000f2';"

# F3 — a SUPRESSÃO (session_replication_role) tem dente? Prova que SEM ela o trigger enfileira o
#      não-fóssil também. Com replica → UPDATE de expansion NÃO enfileira; com origin → enfileira.
#      Se P3c fosse tautológico, este contraste não apareceria.
P -q -c "DELETE FROM public.visit_score_recalc_queue;"
# (a) sob replica: UPDATE de expansion no cliente 002 NÃO deve enfileirar
P -q -c "BEGIN; SET LOCAL session_replication_role = replica;
         UPDATE public.farmer_client_scores SET expansion_score = 5 WHERE customer_user_id='a0000000-0000-0000-0000-000000000002'; COMMIT;"
SAB3A=$(Pq -c "SELECT count(*) FROM public.visit_score_recalc_queue;")
# (b) sob origin (default): UPDATE de expansion no cliente 003 DEVE enfileirar (trigger ativo)
P -q -c "UPDATE public.farmer_client_scores SET expansion_score = 5 WHERE customer_user_id='a0000000-0000-0000-0000-000000000003';"
SAB3B=$(Pq -c "SELECT count(*) FROM public.visit_score_recalc_queue;")
if [ "$SAB3A" = "0" ] && [ "$SAB3B" = "1" ]; then
  fok "F3 supressão tem dente: replica não enfileira (=$SAB3A), origin enfileira (=$SAB3B)"
else
  fbad "F3 esperava replica=0 e origin=1, veio replica=$SAB3A origin=$SAB3B"
fi

echo "── falsificação: $FALSIF_OK com dente / $FALSIF_BAD inócuas ──"
[ "$FALSIF_BAD" = "0" ] || FAIL=$((FAIL+1))

echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
