#!/usr/bin/env bash
# Prova PG17 — 20260622120000_trigger_cleanup_orphan_score_on_carteira_delete.sql
#   DELETE-policy: CONSTRAINT TRIGGER DEFERRABLE INITIALLY DEFERRED em carteira_assignments
#   remove o farmer_client_scores ÓRFÃO no COMMIT, com NOT EXISTS guard.
#   Ponto sutil: delete+insert do MESMO cliente na mesma txn PRESERVA o score (deferred).
# Rode: bash db/test-cleanup-orphan-score-carteira-delete.sh > /tmp/t.log 2>&1; echo "exit=$?"
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5468}"
SLUG="cleanup-orphan-score-carteira"
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

echo "═══ setup (PG17 :$PORT) ═══"
OWNER1=aaaaaaaa-0000-0000-0000-000000000001
CLIENT_X=cccccccc-0000-0000-0000-000000000001   # D1: remoção definitiva
CLIENT_Y=cccccccc-0000-0000-0000-000000000002   # D2/F1/F2: delete+insert (replace)
CLIENT_Z=cccccccc-0000-0000-0000-000000000003   # D3: controle (intocado)
CLIENT_NOFCS=cccccccc-0000-0000-0000-000000000004 # D4: carteira sem fcs

# ── ZONA 1: tabelas + (worst-case cascata) trigger de fcs AFTER UPDATE (visit-recalc) ──
P -q <<SQL
CREATE TABLE public.carteira_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_user_id uuid NOT NULL UNIQUE,
  owner_user_id uuid NOT NULL
);
CREATE TABLE public.farmer_client_scores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_user_id uuid NOT NULL UNIQUE,
  farmer_id uuid NOT NULL,
  priority_score numeric DEFAULT 0,
  expansion_score numeric,
  churn_risk numeric DEFAULT 0,
  signal_modifiers jsonb DEFAULT '{}'::jsonb,
  updated_at timestamptz DEFAULT now()
);
CREATE TABLE public.visit_score_recalc_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_user_id uuid NOT NULL, farmer_id uuid NOT NULL, reason text,
  enqueued_at timestamptz DEFAULT now(), processed_at timestamptz
);
CREATE OR REPLACE FUNCTION public.enqueue_visit_score_recalc_from_client_score()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS \$\$
BEGIN
  IF (NEW.priority_score IS DISTINCT FROM OLD.priority_score
      OR NEW.churn_risk IS DISTINCT FROM OLD.churn_risk
      OR NEW.expansion_score IS DISTINCT FROM OLD.expansion_score
      OR NEW.signal_modifiers IS DISTINCT FROM OLD.signal_modifiers) THEN
    INSERT INTO public.visit_score_recalc_queue (customer_user_id, farmer_id, reason)
    VALUES (NEW.customer_user_id, NEW.farmer_id, 'score_changed');
  END IF;
  RETURN NEW;
END;
\$\$;
CREATE TRIGGER trg_fcs_enqueue_visit_recalc
  AFTER UPDATE ON public.farmer_client_scores
  FOR EACH ROW EXECUTE FUNCTION public.enqueue_visit_score_recalc_from_client_score();
SQL

# ── ZONA 2: aplica a migração REAL ──
MIG="$REPO_ROOT/supabase/migrations/20260622120000_trigger_cleanup_orphan_score_on_carteira_delete.sql"
P -q -f "$MIG"
echo "migration aplicada: $(basename "$MIG")"

# helper: (re)semeia carteira + fcs rico pro cliente
seed() { # $1=customer $2=owner $3=priority
  P -q -c "INSERT INTO public.carteira_assignments (customer_user_id, owner_user_id) VALUES ('$1','$2') ON CONFLICT (customer_user_id) DO UPDATE SET owner_user_id=EXCLUDED.owner_user_id;"
  P -q -c "INSERT INTO public.farmer_client_scores (customer_user_id, farmer_id, priority_score) VALUES ('$1','$2',$3) ON CONFLICT (customer_user_id) DO UPDATE SET priority_score=EXCLUDED.priority_score, farmer_id=EXCLUDED.farmer_id;"
}

# ── ZONA 3: seeds ──
seed "$CLIENT_X" "$OWNER1" 11
seed "$CLIENT_Y" "$OWNER1" 77
seed "$CLIENT_Z" "$OWNER1" 33
P -q -c "INSERT INTO public.carteira_assignments (customer_user_id, owner_user_id) VALUES ('$CLIENT_NOFCS','$OWNER1');"  # sem fcs

# ── ZONA 4: asserts ──
echo "── asserts ──"

# D1: remoção DEFINITIVA (1 statement = 1 txn; deferred dispara no commit) -> score órfão some
P -q -c "DELETE FROM public.carteira_assignments WHERE customer_user_id='$CLIENT_X';"
D1=$(Pq -c "SELECT count(*) FROM public.farmer_client_scores WHERE customer_user_id='$CLIENT_X';")
eq "D1 remoção definitiva limpa o score órfão" "$D1" "0"

# D1b (cascata): deletar o fcs NÃO enfileira visit-queue (trigger de fcs é AFTER UPDATE)
D1b=$(Pq -c "SELECT count(*) FROM public.visit_score_recalc_queue WHERE customer_user_id='$CLIENT_X';")
eq "D1b sem cascata ao deletar o score" "$D1b" "0"

# D2: delete+insert do MESMO cliente na MESMA txn (replace) -> score PRESERVADO (rico, priority 77)
P -q <<SQL
BEGIN;
DELETE FROM public.carteira_assignments WHERE customer_user_id='$CLIENT_Y';
INSERT INTO public.carteira_assignments (customer_user_id, owner_user_id) VALUES ('$CLIENT_Y','$OWNER1');
COMMIT;
SQL
D2=$(Pq -c "SELECT priority_score FROM public.farmer_client_scores WHERE customer_user_id='$CLIENT_Y';")
eq "D2 delete+insert na mesma txn PRESERVA o score (deferred+guard)" "$D2" "77"

# D3 (controle): a remoção de X não tocou o score de Z
D3=$(Pq -c "SELECT priority_score FROM public.farmer_client_scores WHERE customer_user_id='$CLIENT_Z';")
eq "D3 score de outro cliente intocado" "$D3" "33"

# D4: deletar carteira de cliente SEM fcs -> sem erro, no-op
P -q -c "DELETE FROM public.carteira_assignments WHERE customer_user_id='$CLIENT_NOFCS';"
D4=$(Pq -c "SELECT count(*) FROM public.farmer_client_scores WHERE customer_user_id='$CLIENT_NOFCS';")
eq "D4 carteira sem fcs: delete sem erro" "$D4" "0"

# ── ZONA 5: FALSIFICAÇÃO ──
echo "── falsificação ──"

# F1: trigger NÃO-deferido (regular AFTER DELETE) -> no replace, deleta o score mid-txn (antes do insert)
seed "$CLIENT_Y" "$OWNER1" 77
P -q <<SQL
DROP TRIGGER IF EXISTS trg_carteira_cleanup_orphan_score ON public.carteira_assignments;
CREATE TRIGGER trg_carteira_cleanup_orphan_score
  AFTER DELETE ON public.carteira_assignments   -- SABOTADO: regular (não-deferido)
  FOR EACH ROW EXECUTE FUNCTION public.cleanup_orphan_score_on_carteira_delete();
SQL
P -q <<SQL
BEGIN;
DELETE FROM public.carteira_assignments WHERE customer_user_id='$CLIENT_Y';
INSERT INTO public.carteira_assignments (customer_user_id, owner_user_id) VALUES ('$CLIENT_Y','$OWNER1');
COMMIT;
SQL
F1=$(Pq -c "SELECT count(*) FROM public.farmer_client_scores WHERE customer_user_id='$CLIENT_Y';")
if [ "$F1" = "0" ]; then ok "F1 não-deferido apaga o score no replace -> D2 (deferred) tem dente"; \
  else bad "F1 sabotei o deferred e o score sobreviveu (veio [$F1]) -> D2 fraco"; fi

# F2: deferido mas SEM o NOT EXISTS guard (sempre deleta) -> no replace, apaga mesmo re-inserido
P -q -f "$MIG" >/dev/null   # restaura trigger deferido verdadeiro
seed "$CLIENT_Y" "$OWNER1" 77
P -q <<SQL
CREATE OR REPLACE FUNCTION public.cleanup_orphan_score_on_carteira_delete()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS \$\$
BEGIN
  DELETE FROM public.farmer_client_scores WHERE customer_user_id = OLD.customer_user_id;  -- SABOTADO: sem guard
  RETURN NULL;
END;
\$\$;
SQL
P -q <<SQL
BEGIN;
DELETE FROM public.carteira_assignments WHERE customer_user_id='$CLIENT_Y';
INSERT INTO public.carteira_assignments (customer_user_id, owner_user_id) VALUES ('$CLIENT_Y','$OWNER1');
COMMIT;
SQL
F2=$(Pq -c "SELECT count(*) FROM public.farmer_client_scores WHERE customer_user_id='$CLIENT_Y';")
if [ "$F2" = "0" ]; then ok "F2 sem NOT EXISTS apaga o score mesmo re-inserido -> guard tem dente"; \
  else bad "F2 sabotei o guard e o score sobreviveu (veio [$F2]) -> D2 fraco"; fi

# restaura a versão verdadeira e confirma
P -q -f "$MIG" >/dev/null
F_OK=$(Pq -c "SELECT pg_get_functiondef('public.cleanup_orphan_score_on_carteira_delete'::regproc) ILIKE '%NOT EXISTS%';")
eq "F_OK restaurada a versao verdadeira (com guard)" "$F_OK" "t"

echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
