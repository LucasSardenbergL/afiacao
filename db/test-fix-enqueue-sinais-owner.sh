#!/usr/bin/env bash
# Prova PG17 — 20260618230000_fix_enqueue_sinais_owner_e_reconcile_fila.sql
#   P0a: enqueue_score_recalc_from_sinais resolve o DONO (COALESCE(v_owner, NEW.farmer_id))
#   P0c: reconcile defensivo da fila pendente (ator -> dono)
# Rode: bash db/test-fix-enqueue-sinais-owner.sh > /tmp/t.log 2>&1; echo "exit=$?"
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5466}"
SLUG="fix-enqueue-sinais-owner"
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

# UUIDs legíveis
OWNER_X=aaaaaaaa-0000-0000-0000-000000000001
OWNER_Y=aaaaaaaa-0000-0000-0000-000000000003
OWNER_W=aaaaaaaa-0000-0000-0000-000000000004
OWNER_A4=aaaaaaaa-0000-0000-0000-000000000005
OWNER_F1=aaaaaaaa-0000-0000-0000-000000000006
ACTOR=bbbbbbbb-0000-0000-0000-000000000002      # farmer que LIGA mas NÃO é dono
CLIENT_X=cccccccc-0000-0000-0000-000000000001   # P0c: fila com ator-errado
CLIENT_Y=cccccccc-0000-0000-0000-000000000002   # A1: positivo
CLIENT_Z=cccccccc-0000-0000-0000-000000000003   # A2: SEM carteira (fallback)
CLIENT_W=cccccccc-0000-0000-0000-000000000004   # A3: status != extraido
CLIENT_A4=cccccccc-0000-0000-0000-000000000005  # A4: guard IS DISTINCT FROM OLD
CLIENT_F1=cccccccc-0000-0000-0000-000000000006  # F1: falsificação
CALL_Y=dddddddd-0000-0000-0000-000000000002
CALL_Z=dddddddd-0000-0000-0000-000000000003
CALL_W=dddddddd-0000-0000-0000-000000000004
CALL_A4=dddddddd-0000-0000-0000-000000000005
CALL_F1=dddddddd-0000-0000-0000-000000000006
EXTR='{"status":"extraido","sinais":{"houve_sinal":true}}'
EXTR2='{"status":"extraido","sinais":{"houve_sinal":true},"v":2}'
PEND='{"status":"pendente"}'

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — pré-requisitos: tabelas que a migração lê/altera + o trigger (binding) +
#          a função BUGADA (pré-fix) p/ o binding existir + 1 linha de fila ator-errada
# ══════════════════════════════════════════════════════════════════════════════
P -q <<SQL
CREATE TABLE public.carteira_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_user_id uuid NOT NULL UNIQUE,
  owner_user_id uuid NOT NULL
);
CREATE TABLE public.farmer_calls (
  id uuid PRIMARY KEY,
  customer_user_id uuid,
  farmer_id uuid,
  sinais_ligacao jsonb,
  entities_extracted jsonb,
  started_at timestamptz DEFAULT now()
);
CREATE TABLE public.score_recalc_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_user_id uuid NOT NULL,
  farmer_id uuid NOT NULL,
  reason text,
  source_call_id uuid,
  enqueued_at timestamptz DEFAULT now(),
  processed_at timestamptz
);
CREATE UNIQUE INDEX uniq_score_recalc_queue_pending
  ON public.score_recalc_queue (customer_user_id) WHERE processed_at IS NULL;

-- função BUGADA (versão pré-fix de 20260616140941: enfileira NEW.farmer_id cru)
-- só p/ o trigger ter o que apontar; ZONA 2 a substitui pela corrigida.
CREATE OR REPLACE FUNCTION public.enqueue_score_recalc_from_sinais()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS \$\$
BEGIN
  IF NEW.sinais_ligacao IS NOT NULL
     AND (NEW.sinais_ligacao->>'status') = 'extraido'
     AND (TG_OP = 'INSERT' OR NEW.sinais_ligacao IS DISTINCT FROM OLD.sinais_ligacao)
     AND NEW.customer_user_id IS NOT NULL
     AND NEW.farmer_id IS NOT NULL THEN
    INSERT INTO public.score_recalc_queue (customer_user_id, farmer_id, reason, source_call_id)
    VALUES (NEW.customer_user_id, NEW.farmer_id, 'sinais_extraidos', NEW.id)
    ON CONFLICT (customer_user_id) WHERE processed_at IS NULL DO NOTHING;
  END IF;
  RETURN NEW;
END;
\$\$;
CREATE TRIGGER trg_farmer_calls_enqueue_recalc_sinais
  AFTER INSERT OR UPDATE OF sinais_ligacao ON public.farmer_calls
  FOR EACH ROW EXECUTE FUNCTION public.enqueue_score_recalc_from_sinais();
SQL

# P0c: cliente com dono OWNER_X, mas a fila pendente aponta pro ATOR (estado ruim pré-migração)
P -q -c "INSERT INTO public.carteira_assignments(customer_user_id, owner_user_id) VALUES ('$CLIENT_X','$OWNER_X');"
P -q -c "INSERT INTO public.score_recalc_queue(customer_user_id, farmer_id, reason) VALUES ('$CLIENT_X','$ACTOR','sinais_extraidos');"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — aplica a migração REAL (Lei #1): troca a função + roda o P0c
# ══════════════════════════════════════════════════════════════════════════════
MIG="$REPO_ROOT/supabase/migrations/20260618230000_fix_enqueue_sinais_owner_e_reconcile_fila.sql"
P -q -f "$MIG"
echo "migration aplicada: $(basename "$MIG")"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 3 — seeds dos cenários do trigger (carteira de Y/W/A4/F1; Z fica SEM carteira)
# ══════════════════════════════════════════════════════════════════════════════
P -q -c "INSERT INTO public.carteira_assignments(customer_user_id, owner_user_id) VALUES
  ('$CLIENT_Y','$OWNER_Y'),('$CLIENT_W','$OWNER_W'),('$CLIENT_A4','$OWNER_A4'),('$CLIENT_F1','$OWNER_F1');"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4 — asserts
# ══════════════════════════════════════════════════════════════════════════════
echo "── asserts ──"

# C1 (P0c): a linha de fila do CLIENT_X virou DONO ao aplicar a migração
C1=$(Pq -c "SELECT farmer_id FROM public.score_recalc_queue WHERE customer_user_id='$CLIENT_X' AND processed_at IS NULL;")
eq "C1 P0c reconcilia fila pendente (ator->dono)" "$C1" "$OWNER_X"

# A1 (positivo): call de sinais por NÃO-dono enfileira o DONO
P -q -c "INSERT INTO public.farmer_calls(id, customer_user_id, farmer_id, sinais_ligacao) VALUES ('$CALL_Y','$CLIENT_Y','$ACTOR','$EXTR'::jsonb);"
A1=$(Pq -c "SELECT farmer_id FROM public.score_recalc_queue WHERE customer_user_id='$CLIENT_Y' AND processed_at IS NULL;")
eq "A1 sinais por nao-dono enfileira o DONO" "$A1" "$OWNER_Y"

# A2 (fallback): cliente SEM carteira -> COALESCE cai no NEW.farmer_id (ator)
P -q -c "INSERT INTO public.farmer_calls(id, customer_user_id, farmer_id, sinais_ligacao) VALUES ('$CALL_Z','$CLIENT_Z','$ACTOR','$EXTR'::jsonb);"
A2=$(Pq -c "SELECT farmer_id FROM public.score_recalc_queue WHERE customer_user_id='$CLIENT_Z' AND processed_at IS NULL;")
eq "A2 cliente sem carteira -> fallback NEW.farmer_id" "$A2" "$ACTOR"

# A3 (negativo): status != 'extraido' -> NÃO enfileira
P -q -c "INSERT INTO public.farmer_calls(id, customer_user_id, farmer_id, sinais_ligacao) VALUES ('$CALL_W','$CLIENT_W','$ACTOR','$PEND'::jsonb);"
A3=$(Pq -c "SELECT count(*) FROM public.score_recalc_queue WHERE customer_user_id='$CLIENT_W';")
eq "A3 status!=extraido nao enfileira" "$A3" "0"

# A4 (guard IS DISTINCT FROM OLD): insert enfileira -> marca processado -> UPDATE com JSON IDÊNTICO nao re-enfileira
P -q -c "INSERT INTO public.farmer_calls(id, customer_user_id, farmer_id, sinais_ligacao) VALUES ('$CALL_A4','$CLIENT_A4','$ACTOR','$EXTR'::jsonb);"
P -q -c "UPDATE public.score_recalc_queue SET processed_at=now() WHERE customer_user_id='$CLIENT_A4';"
P -q -c "UPDATE public.farmer_calls SET sinais_ligacao='$EXTR'::jsonb WHERE id='$CALL_A4';"   # idêntico
A4=$(Pq -c "SELECT count(*) FROM public.score_recalc_queue WHERE customer_user_id='$CLIENT_A4' AND processed_at IS NULL;")
eq "A4 update identico nao re-enfileira (guard preservado)" "$A4" "0"
# sanity: um update DIFERENTE re-enfileira (prova que o trigger nao morreu)
P -q -c "UPDATE public.farmer_calls SET sinais_ligacao='$EXTR2'::jsonb WHERE id='$CALL_A4';"
A4b=$(Pq -c "SELECT farmer_id FROM public.score_recalc_queue WHERE customer_user_id='$CLIENT_A4' AND processed_at IS NULL;")
eq "A4b update diferente re-enfileira o DONO (trigger vivo)" "$A4b" "$OWNER_A4"

# C2 (P0c idempotente): re-rodar o reconcile nao muda nada
C2=$(Pq -c "WITH upd AS (UPDATE public.score_recalc_queue q SET farmer_id=a.owner_user_id FROM public.carteira_assignments a WHERE q.processed_at IS NULL AND q.customer_user_id=a.customer_user_id AND q.farmer_id IS DISTINCT FROM a.owner_user_id RETURNING 1) SELECT count(*) FROM upd;")
eq "C2 P0c idempotente (2a rodada = 0 linhas)" "$C2" "0"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICAÇÃO (Lei #3): sabota a função (sem COALESCE) -> A1 deve virar VERMELHO
# ══════════════════════════════════════════════════════════════════════════════
echo "── falsificação ──"
P -q <<SQL
CREATE OR REPLACE FUNCTION public.enqueue_score_recalc_from_sinais()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS \$\$
BEGIN
  IF NEW.sinais_ligacao IS NOT NULL
     AND (NEW.sinais_ligacao->>'status') = 'extraido'
     AND (TG_OP = 'INSERT' OR NEW.sinais_ligacao IS DISTINCT FROM OLD.sinais_ligacao)
     AND NEW.customer_user_id IS NOT NULL
     AND NEW.farmer_id IS NOT NULL THEN
    INSERT INTO public.score_recalc_queue (customer_user_id, farmer_id, reason, source_call_id)
    VALUES (NEW.customer_user_id, NEW.farmer_id, 'sinais_extraidos', NEW.id)   -- SABOTADO: ator cru
    ON CONFLICT (customer_user_id) WHERE processed_at IS NULL DO NOTHING;
  END IF;
  RETURN NEW;
END;
\$\$;
SQL
P -q -c "INSERT INTO public.farmer_calls(id, customer_user_id, farmer_id, sinais_ligacao) VALUES ('$CALL_F1','$CLIENT_F1','$ACTOR','$EXTR'::jsonb);"
F1=$(Pq -c "SELECT farmer_id FROM public.score_recalc_queue WHERE customer_user_id='$CLIENT_F1' AND processed_at IS NULL;")
if [ "$F1" = "$ACTOR" ]; then ok "F1 sabotagem (sem COALESCE) enfileira o ATOR -> A1 tem dente"; \
  else bad "F1 sabotei e NAO enfileirou o ator (veio [$F1]) -> A1 fraco"; fi
# restaura a versão verdadeira
P -q -f "$MIG"
F1r=$(Pq -c "SELECT pg_get_functiondef('public.enqueue_score_recalc_from_sinais'::regproc) ILIKE '%COALESCE(v_owner%';")
eq "F1r restaurada a versao com COALESCE" "$F1r" "t"

echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
