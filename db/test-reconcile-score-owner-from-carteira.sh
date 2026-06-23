#!/usr/bin/env bash
# Prova PG17 — 20260619120000_trigger_reconcile_score_owner_carteira.sql
#   B2b: trigger em carteira_assignments faz UPSERT em farmer_client_scores —
#        PROVISIONA a linha se faltar (dono + defaults) e RECONCILIA farmer_id=dono
#        quando owner_user_id muda (UPDATE) ou no INSERT (reimport por DELETE+INSERT).
# Rode: bash db/test-reconcile-score-owner-from-carteira.sh > /tmp/t.log 2>&1; echo "exit=$?"
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5467}"
SLUG="reconcile-score-owner-carteira"
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

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

echo "═══ setup pronto (PG17 :$PORT) ═══"

OWNER_OLD=aaaaaaaa-0000-0000-0000-000000000001
OWNER_NEW=aaaaaaaa-0000-0000-0000-000000000002
OWNER_BULK=aaaaaaaa-0000-0000-0000-000000000009
CLIENT_Y=cccccccc-0000-0000-0000-000000000001   # R1/R1b/R2/R4: UPDATE de owner
CLIENT_Z=cccccccc-0000-0000-0000-000000000002   # R3: reimport DELETE+INSERT
CLIENT_NEW=cccccccc-0000-0000-0000-000000000003 # R5: carteira sem fcs -> provisiona
CLIENT_B1=cccccccc-0000-0000-0000-000000000004  # R6 + F2 (cobertura INSERT)
CLIENT_B2=cccccccc-0000-0000-0000-000000000005  # R6 + F3 (cascata)
CLIENT_F1=cccccccc-0000-0000-0000-000000000006  # F1 (no-op)
CLIENT_F4=cccccccc-0000-0000-0000-000000000007  # F4 (provisão)
OLD_TS='2020-01-01 00:00:00+00'                  # sentinela p/ detectar bump de updated_at

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — pré-requisitos: as 2 tabelas (fcs com os DEFAULTS reais de prod) +
#          (MODELO WORST-CASE da cascata) o trigger de fcs->visit_score_recalc_queue
#          que existe em prod (AFTER UPDATE; corpo verbatim de 20260524180000).
# ══════════════════════════════════════════════════════════════════════════════
P -q <<SQL
CREATE TABLE public.carteira_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_user_id uuid NOT NULL UNIQUE,
  owner_user_id uuid NOT NULL,
  notes text,                                   -- coluna extra: prova o escopo UPDATE OF owner_user_id (R4)
  updated_at timestamptz DEFAULT now()
);
CREATE TABLE public.farmer_client_scores (    -- defaults espelham prod (psql-ro 2026-06-19)
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_user_id uuid NOT NULL UNIQUE,
  farmer_id uuid NOT NULL,
  priority_score numeric DEFAULT 0,
  health_score numeric DEFAULT 0,
  health_class text DEFAULT 'critico',
  churn_risk numeric DEFAULT 0,
  expansion_score numeric,
  signal_modifiers jsonb DEFAULT '{}'::jsonb,
  calculated_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);
CREATE TABLE public.visit_score_recalc_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_user_id uuid NOT NULL,
  farmer_id uuid NOT NULL,
  reason text,
  enqueued_at timestamptz DEFAULT now(),
  processed_at timestamptz
);
CREATE UNIQUE INDEX uniq_visit_score_queue_pending
  ON public.visit_score_recalc_queue (customer_user_id) WHERE processed_at IS NULL;

CREATE OR REPLACE FUNCTION public.enqueue_visit_score_recalc_from_client_score()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS \$\$
BEGIN
  IF (NEW.priority_score    IS DISTINCT FROM OLD.priority_score
      OR NEW.churn_risk      IS DISTINCT FROM OLD.churn_risk
      OR NEW.expansion_score IS DISTINCT FROM OLD.expansion_score
      OR NEW.signal_modifiers IS DISTINCT FROM OLD.signal_modifiers)
     AND NEW.customer_user_id IS NOT NULL
     AND NEW.farmer_id IS NOT NULL THEN
    INSERT INTO public.visit_score_recalc_queue (customer_user_id, farmer_id, reason)
    VALUES (NEW.customer_user_id, NEW.farmer_id, 'score_changed')
    ON CONFLICT (customer_user_id) WHERE processed_at IS NULL DO NOTHING;
  END IF;
  RETURN NEW;
END;
\$\$;
CREATE TRIGGER trg_fcs_enqueue_visit_recalc
  AFTER UPDATE ON public.farmer_client_scores
  FOR EACH ROW EXECUTE FUNCTION public.enqueue_visit_score_recalc_from_client_score();
SQL

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — aplica a migração REAL (Lei #1): cria a função upsert + o trigger sob teste
# ══════════════════════════════════════════════════════════════════════════════
MIG="$REPO_ROOT/supabase/migrations/20260619120000_trigger_reconcile_score_owner_carteira.sql"
P -q -f "$MIG"
echo "migration aplicada: $(basename "$MIG")"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 3 — seeds (fcs com dono ANTIGO + updated_at sentinela; carteira com dono ANTIGO)
# ══════════════════════════════════════════════════════════════════════════════
P -q <<SQL
INSERT INTO public.farmer_client_scores (customer_user_id, farmer_id, priority_score, churn_risk, expansion_score, updated_at) VALUES
  ('$CLIENT_Y','$OWNER_OLD', 50, 10, 5, '$OLD_TS'),
  ('$CLIENT_Z','$OWNER_OLD', 50, 10, 5, '$OLD_TS'),
  ('$CLIENT_B1','$OWNER_OLD', 50, 10, 5, '$OLD_TS'),
  ('$CLIENT_B2','$OWNER_OLD', 50, 10, 5, '$OLD_TS');
-- CLIENT_NEW e CLIENT_F4: SEM linha de fcs (R5 provisiona; F4 falsifica a provisão)
INSERT INTO public.carteira_assignments (customer_user_id, owner_user_id) VALUES
  ('$CLIENT_Y','$OWNER_OLD'),
  ('$CLIENT_Z','$OWNER_OLD'),
  ('$CLIENT_B1','$OWNER_OLD'),
  ('$CLIENT_B2','$OWNER_OLD');
SQL

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4 — asserts
# ══════════════════════════════════════════════════════════════════════════════
echo "── asserts ──"

# R1: UPDATE de owner reconcilia o farmer_id (caminho DO UPDATE do upsert)
P -q -c "UPDATE public.carteira_assignments SET owner_user_id='$OWNER_NEW' WHERE customer_user_id='$CLIENT_Y';"
R1=$(Pq -c "SELECT farmer_id FROM public.farmer_client_scores WHERE customer_user_id='$CLIENT_Y';")
eq "R1 UPDATE de owner reconcilia fcs.farmer_id (dono novo)" "$R1" "$OWNER_NEW"

# R1b (cascata): a mudança só-farmer_id NÃO enfileira na visit_score_recalc_queue
R1b=$(Pq -c "SELECT count(*) FROM public.visit_score_recalc_queue WHERE customer_user_id='$CLIENT_Y';")
eq "R1b sem cascata: update so-farmer_id nao enfileira visit-queue" "$R1b" "0"

# R1c: updated_at FOI bumpado (now() != sentinela)
R1c=$(Pq -c "SELECT (updated_at > '2021-01-01'::timestamptz) FROM public.farmer_client_scores WHERE customer_user_id='$CLIENT_Y';")
eq "R1c updated_at bumpado no reconcile" "$R1c" "t"

# R2 (no-op): setar owner pro MESMO valor -> WHERE DO UPDATE falso -> 0 efeito
P -q -c "UPDATE public.farmer_client_scores SET updated_at='$OLD_TS' WHERE customer_user_id='$CLIENT_Y';"
P -q -c "UPDATE public.carteira_assignments SET owner_user_id='$OWNER_NEW' WHERE customer_user_id='$CLIENT_Y';"
R2=$(Pq -c "SELECT (updated_at = '$OLD_TS'::timestamptz) FROM public.farmer_client_scores WHERE customer_user_id='$CLIENT_Y';")
eq "R2 no-op (owner ja casa) nao toca updated_at" "$R2" "t"

# R3 (INSERT cobre reimport DELETE+INSERT): fcs continua stale ate o insert reconciliar
P -q -c "DELETE FROM public.carteira_assignments WHERE customer_user_id='$CLIENT_Z';"
R3pre=$(Pq -c "SELECT farmer_id FROM public.farmer_client_scores WHERE customer_user_id='$CLIENT_Z';")
eq "R3pre apos DELETE da carteira o fcs segue no dono antigo" "$R3pre" "$OWNER_OLD"
P -q -c "INSERT INTO public.carteira_assignments (customer_user_id, owner_user_id) VALUES ('$CLIENT_Z','$OWNER_NEW');"
R3=$(Pq -c "SELECT farmer_id FROM public.farmer_client_scores WHERE customer_user_id='$CLIENT_Z';")
eq "R3 INSERT (reimport replace) reconcilia fcs.farmer_id existente" "$R3" "$OWNER_NEW"

# R4 (escopo OF owner_user_id): UPDATE de coluna NÃO-owner nao dispara o trigger
P -q -c "UPDATE public.farmer_client_scores SET updated_at='$OLD_TS' WHERE customer_user_id='$CLIENT_Y';"
P -q -c "UPDATE public.carteira_assignments SET notes='mexi so no notes' WHERE customer_user_id='$CLIENT_Y';"
R4=$(Pq -c "SELECT (updated_at = '$OLD_TS'::timestamptz) FROM public.farmer_client_scores WHERE customer_user_id='$CLIENT_Y';")
eq "R4 UPDATE de coluna nao-owner nao dispara (escopo OF owner_user_id)" "$R4" "t"

# R5 (PROVISIONA): carteira p/ cliente SEM fcs -> upsert cria a linha com o dono
P -q -c "INSERT INTO public.carteira_assignments (customer_user_id, owner_user_id) VALUES ('$CLIENT_NEW','$OWNER_NEW');"
R5=$(Pq -c "SELECT farmer_id FROM public.farmer_client_scores WHERE customer_user_id='$CLIENT_NEW';")
eq "R5 carteira sem fcs PROVISIONA a linha (upsert) com o dono" "$R5" "$OWNER_NEW"
R5b=$(Pq -c "SELECT priority_score FROM public.farmer_client_scores WHERE customer_user_id='$CLIENT_NEW';")
eq "R5b linha provisionada usa default priority_score=0 (ordena no fim da agenda)" "$R5b" "0"

# R6 (bulk per-row): UPDATE em massa por dono antigo reconcilia todas as linhas
P -q -c "UPDATE public.carteira_assignments SET owner_user_id='$OWNER_BULK' WHERE owner_user_id='$OWNER_OLD';"
R6=$(Pq -c "SELECT count(*) FROM public.farmer_client_scores WHERE customer_user_id IN ('$CLIENT_B1','$CLIENT_B2') AND farmer_id='$OWNER_BULK';")
eq "R6 UPDATE bulk reconcilia todas as linhas afetadas" "$R6" "2"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICAÇÃO (Lei #3)
# ══════════════════════════════════════════════════════════════════════════════
echo "── falsificação ──"

# F1: função no-op -> nem mudança REAL de dono reconcilia -> R1 tem dente
P -q <<SQL
CREATE OR REPLACE FUNCTION public.reconcile_score_owner_from_carteira()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS \$\$
BEGIN
  RETURN NEW;   -- SABOTADO: não reconcilia nada
END;
\$\$;
SQL
P -q -c "INSERT INTO public.farmer_client_scores (customer_user_id, farmer_id) VALUES ('$CLIENT_F1','$OWNER_OLD');"
P -q -c "INSERT INTO public.carteira_assignments (customer_user_id, owner_user_id) VALUES ('$CLIENT_F1','$OWNER_OLD');"
P -q -c "UPDATE public.carteira_assignments SET owner_user_id='$OWNER_NEW' WHERE customer_user_id='$CLIENT_F1';"
F1=$(Pq -c "SELECT farmer_id FROM public.farmer_client_scores WHERE customer_user_id='$CLIENT_F1';")
if [ "$F1" = "$OWNER_OLD" ]; then ok "F1 funcao no-op deixa fcs no dono antigo -> R1 tem dente"; \
  else bad "F1 sabotei e mesmo assim reconciliou (veio [$F1]) -> R1 fraco"; fi

# F2: trigger só AFTER UPDATE (sem INSERT) -> reimport DELETE+INSERT nao reconcilia -> R3 tem dente
P -q -f "$MIG" >/dev/null
P -q <<SQL
DROP TRIGGER IF EXISTS trg_carteira_reconcile_score_owner ON public.carteira_assignments;
CREATE TRIGGER trg_carteira_reconcile_score_owner
  AFTER UPDATE OF owner_user_id ON public.carteira_assignments   -- SABOTADO: sem INSERT
  FOR EACH ROW EXECUTE FUNCTION public.reconcile_score_owner_from_carteira();
SQL
P -q -c "UPDATE public.farmer_client_scores SET farmer_id='$OWNER_OLD' WHERE customer_user_id='$CLIENT_B1';"
P -q -c "DELETE FROM public.carteira_assignments WHERE customer_user_id='$CLIENT_B1';"
P -q -c "INSERT INTO public.carteira_assignments (customer_user_id, owner_user_id) VALUES ('$CLIENT_B1','$OWNER_NEW');"
F2=$(Pq -c "SELECT farmer_id FROM public.farmer_client_scores WHERE customer_user_id='$CLIENT_B1';")
if [ "$F2" = "$OWNER_OLD" ]; then ok "F2 trigger sem INSERT nao reconcilia no reimport -> R3 tem dente"; \
  else bad "F2 sabotei o INSERT e mesmo assim reconciliou (veio [$F2]) -> R3 fraco"; fi

# F3: função que TAMBÉM mexe em priority_score -> dispara a visit-queue -> R1b tem dente
P -q -f "$MIG" >/dev/null
P -q <<SQL
CREATE OR REPLACE FUNCTION public.reconcile_score_owner_from_carteira()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS \$\$
BEGIN
  UPDATE public.farmer_client_scores
     SET farmer_id = NEW.owner_user_id, updated_at = now(),
         priority_score = COALESCE(priority_score,0) + 1   -- SABOTADO: mexe em score col
   WHERE customer_user_id = NEW.customer_user_id;
  RETURN NEW;
END;
\$\$;
SQL
P -q -c "UPDATE public.visit_score_recalc_queue SET processed_at=now();"
P -q -c "UPDATE public.farmer_client_scores SET farmer_id='$OWNER_OLD', updated_at='$OLD_TS' WHERE customer_user_id='$CLIENT_B2';"
P -q -c "UPDATE public.carteira_assignments SET owner_user_id='$OWNER_NEW' WHERE customer_user_id='$CLIENT_B2';"
F3=$(Pq -c "SELECT count(*) FROM public.visit_score_recalc_queue WHERE customer_user_id='$CLIENT_B2' AND processed_at IS NULL;")
if [ "$F3" = "1" ]; then ok "F3 mexer em score col enfileira visit-queue -> R1b tem dente"; \
  else bad "F3 sabotei (priority_score++) e nao enfileirou (veio [$F3]) -> R1b fraco"; fi

# F4: função update-only (sem o INSERT do upsert) -> NÃO provisiona cliente novo -> R5 tem dente
P -q -f "$MIG" >/dev/null
P -q <<SQL
CREATE OR REPLACE FUNCTION public.reconcile_score_owner_from_carteira()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS \$\$
BEGIN
  UPDATE public.farmer_client_scores SET farmer_id = NEW.owner_user_id, updated_at = now()
   WHERE customer_user_id = NEW.customer_user_id AND farmer_id IS DISTINCT FROM NEW.owner_user_id;
  RETURN NEW;   -- SABOTADO: update-only, sem provisionar
END;
\$\$;
SQL
P -q -c "INSERT INTO public.carteira_assignments (customer_user_id, owner_user_id) VALUES ('$CLIENT_F4','$OWNER_NEW');"
F4=$(Pq -c "SELECT count(*) FROM public.farmer_client_scores WHERE customer_user_id='$CLIENT_F4';")
if [ "$F4" = "0" ]; then ok "F4 update-only nao provisiona cliente novo -> R5 tem dente"; \
  else bad "F4 sabotei a provisão e mesmo assim criou linha (veio [$F4]) -> R5 fraco"; fi

# restaura a versão verdadeira (upsert) e confirma
P -q -f "$MIG" >/dev/null
F_OK=$(Pq -c "SELECT pg_get_functiondef('public.reconcile_score_owner_from_carteira'::regproc) ILIKE '%ON CONFLICT (customer_user_id) DO UPDATE%';")
eq "F_OK restaurada a versao upsert verdadeira" "$F_OK" "t"

echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
