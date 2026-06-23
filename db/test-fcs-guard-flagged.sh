#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA PG17 — fcs_block_flagged_insert (guard de fronteira anti-ressurreição)  ║
# ║  Migration: supabase/migrations/20260621130000_fcs_guard_flagged_insert.sql   ║
# ║  Rode:  bash db/test-fcs-guard-flagged.sh > /tmp/t.log 2>&1; echo $?          ║
# ║                                                                                ║
# ║  Prova que NENHUMA via de INSERT em farmer_client_scores ressuscita um         ║
# ║  fornecedor flagged — incl. ON CONFLICT (reconcile) e sob RLS (authenticated). ║
# ║  Falsifica: (F1) sem o trigger o flagged entra; (F2) com INVOKER o flagged     ║
# ║  vaza sob authenticated (prova que SECURITY DEFINER é necessário).             ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5458}"
SLUG="fcs-guard"
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

echo "═══ setup pronto (PG17 :$PORT) ═══"

# ── ZONA 1 — pré-requisitos (as 2 tabelas que o trigger toca/lê) ──
P -q <<'SQL'
CREATE TABLE public.farmer_client_scores (
  customer_user_id uuid NOT NULL UNIQUE,
  farmer_id        uuid NOT NULL,
  updated_at       timestamptz DEFAULT now()
);
CREATE TABLE public.cliente_classificacao (
  user_id             uuid PRIMARY KEY,
  excluir_da_carteira boolean NOT NULL DEFAULT false
);
SQL

# ── ZONA 2 — aplicar a migration REAL ──
MIG="$REPO_ROOT/supabase/migrations/20260621130000_fcs_guard_flagged_insert.sql"
P -q -f "$MIG"
echo "migration aplicada: $(basename "$MIG")"

# ── ZONA 3 — seed: a2/a5 flagged; a1/a3/a4 limpos (a3 sem linha de classificação) ──
P -q <<'SQL'
INSERT INTO public.cliente_classificacao (user_id, excluir_da_carteira) VALUES
  ('00000000-0000-0000-0000-0000000000a1'::uuid, false),
  ('00000000-0000-0000-0000-0000000000a2'::uuid, true),   -- flagged
  ('00000000-0000-0000-0000-0000000000a4'::uuid, false),
  ('00000000-0000-0000-0000-0000000000a5'::uuid, true);   -- flagged
-- u3 NÃO tem linha em cliente_classificacao (não-fornecedor implícito → pode entrar)

-- RLS: cliente_classificacao escondida de authenticated (deny-all) — espelha prod p/ provar o DEFINER.
ALTER TABLE public.cliente_classificacao ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.cliente_classificacao TO authenticated;            -- grant existe; RLS filtra tudo
GRANT INSERT, SELECT ON public.farmer_client_scores TO authenticated;     -- p/ o INSERT do teste RLS
SQL

FARMER="00000000-0000-0000-0000-0000000000f1"

# ── ZONA 4 — asserts ──
echo "── asserts ──"
# A1: não-flagged entra
Pq -c "INSERT INTO public.farmer_client_scores (customer_user_id, farmer_id) VALUES ('00000000-0000-0000-0000-0000000000a1','$FARMER');" >/dev/null
eq "A1 não-flagged INSERTa"            "$(Pq -c "SELECT count(*) FROM public.farmer_client_scores WHERE customer_user_id='00000000-0000-0000-0000-0000000000a1';")" "1"

# A2 ⭐: flagged NÃO entra (trigger pula)
Pq -c "INSERT INTO public.farmer_client_scores (customer_user_id, farmer_id) VALUES ('00000000-0000-0000-0000-0000000000a2','$FARMER');" >/dev/null
eq "A2 ⭐ flagged NÃO INSERTa (anti-ressurreição)" "$(Pq -c "SELECT count(*) FROM public.farmer_client_scores WHERE customer_user_id='00000000-0000-0000-0000-0000000000a2';")" "0"

# A3: sem linha de classificação entra
Pq -c "INSERT INTO public.farmer_client_scores (customer_user_id, farmer_id) VALUES ('00000000-0000-0000-0000-0000000000a3','$FARMER');" >/dev/null
eq "A3 sem classificação INSERTa"      "$(Pq -c "SELECT count(*) FROM public.farmer_client_scores WHERE customer_user_id='00000000-0000-0000-0000-0000000000a3';")" "1"

# A4: via RECONCILE (INSERT ... ON CONFLICT DO UPDATE). u4 limpo provisiona e reconcilia dono;
#     u5 flagged via mesmo caminho NÃO entra (cobre a via do reconcile_score_owner_from_carteira).
Pq -c "INSERT INTO public.farmer_client_scores (customer_user_id, farmer_id) VALUES ('00000000-0000-0000-0000-0000000000a4','$FARMER') ON CONFLICT (customer_user_id) DO UPDATE SET farmer_id=EXCLUDED.farmer_id;" >/dev/null
Pq -c "INSERT INTO public.farmer_client_scores (customer_user_id, farmer_id) VALUES ('00000000-0000-0000-0000-0000000000a4','00000000-0000-0000-0000-0000000000f2') ON CONFLICT (customer_user_id) DO UPDATE SET farmer_id=EXCLUDED.farmer_id;" >/dev/null
eq "A4a reconcile: limpo provisiona+reconcilia dono" "$(Pq -c "SELECT farmer_id FROM public.farmer_client_scores WHERE customer_user_id='00000000-0000-0000-0000-0000000000a4';")" "00000000-0000-0000-0000-0000000000f2"
Pq -c "INSERT INTO public.farmer_client_scores (customer_user_id, farmer_id) VALUES ('00000000-0000-0000-0000-0000000000a5','$FARMER') ON CONFLICT (customer_user_id) DO UPDATE SET farmer_id=EXCLUDED.farmer_id;" >/dev/null
eq "A4b ⭐ reconcile: flagged NÃO ressuscita" "$(Pq -c "SELECT count(*) FROM public.farmer_client_scores WHERE customer_user_id='00000000-0000-0000-0000-0000000000a5';")" "0"

# A5 ⭐: sob authenticated (RLS esconde cliente_classificacao) o trigger DEFINER AINDA bloqueia o flagged
Pq -c "SET ROLE authenticated; INSERT INTO public.farmer_client_scores (customer_user_id, farmer_id) VALUES ('00000000-0000-0000-0000-0000000000a2','$FARMER');" >/dev/null 2>&1 || true
eq "A5 ⭐ DEFINER bloqueia flagged mesmo sob authenticated/RLS" "$(Pq -c "SELECT count(*) FROM public.farmer_client_scores WHERE customer_user_id='00000000-0000-0000-0000-0000000000a2';")" "0"

# ── ZONA 5 — FALSIFICAÇÃO ──
echo "── falsificação ──"
# F1: DROP do trigger → o flagged u2 AGORA entra (prova que A2 dependia do trigger)
P -q -c "DROP TRIGGER trg_fcs_block_flagged_insert ON public.farmer_client_scores;"
Pq -c "INSERT INTO public.farmer_client_scores (customer_user_id, farmer_id) VALUES ('00000000-0000-0000-0000-0000000000a2','$FARMER');" >/dev/null
if [ "$(Pq -c "SELECT count(*) FROM public.farmer_client_scores WHERE customer_user_id='00000000-0000-0000-0000-0000000000a2';")" = "1" ]; then
  ok "F1 sem o trigger o flagged ENTRA → A2 tem dente"
else
  bad "F1 droppei o trigger e o flagged NÃO entrou → A2 é fraco"
fi
P -q -c "DELETE FROM public.farmer_client_scores WHERE customer_user_id='00000000-0000-0000-0000-0000000000a2';"
P -q -f "$MIG"   # restaura o trigger (recria função + trigger)

# F2 ⭐: função como SECURITY INVOKER → sob authenticated (RLS esconde o flag) o flagged VAZA
#        (prova que SECURITY DEFINER é o que faz o guard valer sob authenticated)
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.fcs_block_flagged_insert()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $f$
BEGIN
  IF EXISTS (SELECT 1 FROM public.cliente_classificacao cc WHERE cc.user_id = NEW.customer_user_id AND cc.excluir_da_carteira) THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END $f$;
SQL
Pq -c "SET ROLE authenticated; INSERT INTO public.farmer_client_scores (customer_user_id, farmer_id) VALUES ('00000000-0000-0000-0000-0000000000a5','$FARMER');" >/dev/null 2>&1 || true
if [ "$(Pq -c "SELECT count(*) FROM public.farmer_client_scores WHERE customer_user_id='00000000-0000-0000-0000-0000000000a5';")" = "1" ]; then
  ok "F2 ⭐ com INVOKER o flagged VAZA sob authenticated → SECURITY DEFINER tem dente"
else
  bad "F2 troquei p/ INVOKER e o flagged NÃO vazou → o assert RLS (A5) não prova o DEFINER"
fi
P -q -c "DELETE FROM public.farmer_client_scores WHERE customer_user_id='00000000-0000-0000-0000-0000000000a5';"
P -q -f "$MIG"   # restaura DEFINER

# sanidade pós-restauro: flagged volta a ser bloqueado
Pq -c "INSERT INTO public.farmer_client_scores (customer_user_id, farmer_id) VALUES ('00000000-0000-0000-0000-0000000000a2','$FARMER');" >/dev/null
eq "A6 pós-restauro: flagged de novo bloqueado" "$(Pq -c "SELECT count(*) FROM public.farmer_client_scores WHERE customer_user_id='00000000-0000-0000-0000-0000000000a2';")" "0"

echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
