#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA PG17 — RPC omie_sync_identity_snapshot (PR-1, achado A1)                ║
# ║  Migration: supabase/migrations/20260711140000_omie_sync_identity_snapshot.sql║
# ║  Rode:  bash db/test-omie-identidade-snapshot.sh > /tmp/t.log 2>&1; echo $?    ║
# ║                                                                                ║
# ║  Prova: doc único → doc_to_user (prova positiva); doc com 2+ users → FORA de   ║
# ║  doc_to_user E em ambiguous_docs (fail-closed, precisão>recall); doc<11 e doc  ║
# ║  nulo excluídos; máscara normaliza; client_to_user vazio no PR-1; anon/        ║
# ║  authenticated BARRADOS no EXECUTE (42501); service_role executa. Falsifica:   ║
# ║  remover o filtro n_users=1 → doc ambíguo vaza p/ doc_to_user → vermelho.      ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

# ── arranque PG17 descartável (contorna keg-only do brew) ──
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5473}"
SLUG="omie-identidade-snapshot"
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

# ── base Supabase: roles, schema auth, GUC ──
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
# roda a RPC como service_role (o role REAL do edge) e pega o último valor (psql ecoa "SET")
RS()  { Pq -c "SET ROLE service_role; $1" | tail -1; }

echo "═══ setup pronto (PG17 :$PORT) ═══"

# ══ ZONA 1 — pré-requisito: profiles (a RPC lê user_id + document) ══
P -q <<'SQL'
CREATE TABLE public.profiles (user_id uuid PRIMARY KEY, document text);
SQL

# ══ ZONA 2 — aplicar a migration REAL (Lei #1) ══
MIG="$REPO_ROOT/supabase/migrations/20260711140000_omie_sync_identity_snapshot.sql"
P -q -f "$MIG"
echo "migration aplicada: $(basename "$MIG")"

# ══ ZONA 3 — seed + grant p/ o caminho real (service_role lê profiles) ══
P -q <<'SQL'
INSERT INTO auth.users(id) VALUES
  ('00000000-0000-0000-0000-000000000001'),
  ('00000000-0000-0000-0000-000000000002'),
  ('00000000-0000-0000-0000-000000000003'),
  ('00000000-0000-0000-0000-000000000004'),
  ('00000000-0000-0000-0000-000000000005') ON CONFLICT DO NOTHING;
INSERT INTO public.profiles(user_id, document) VALUES
  ('00000000-0000-0000-0000-000000000001', '11111111111'),      -- único
  ('00000000-0000-0000-0000-000000000002', '222.222.222-22'),   -- ambíguo (mascarado), colide com o 3
  ('00000000-0000-0000-0000-000000000003', '22222222222'),      -- ambíguo (mesmo doc normalizado, outro user)
  ('00000000-0000-0000-0000-000000000004', '333.333.333-33'),   -- único, normaliza da máscara
  ('00000000-0000-0000-0000-000000000005', '123');              -- doc<11 → excluído
GRANT SELECT ON public.profiles TO service_role;
SQL

# ══ ZONA 4 — asserts (positivo / fail-closed / gate 42501) ══
echo "── asserts ──"

# POSITIVO — prova positiva de doc único (via service_role = caminho do edge)
eq "A1 doc único → doc_to_user aponta pro user" \
   "$(RS "SELECT public.omie_sync_identity_snapshot('oben')->'doc_to_user'->>'11111111111';")" \
   "00000000-0000-0000-0000-000000000001"
eq "A2 máscara normaliza (333.333.333-33 → 33333333333)" \
   "$(RS "SELECT public.omie_sync_identity_snapshot('oben')->'doc_to_user'->>'33333333333';")" \
   "00000000-0000-0000-0000-000000000004"

# NEGATIVO (fail-closed) — doc ambíguo FORA de doc_to_user, DENTRO de ambiguous_docs
eq "A3 doc ambíguo FORA de doc_to_user (precisão>recall)" \
   "$(RS "SELECT (public.omie_sync_identity_snapshot('oben')->'doc_to_user'->>'22222222222') IS NULL;")" "t"
eq "A4 doc ambíguo LISTADO em ambiguous_docs" \
   "$(RS "SELECT public.omie_sync_identity_snapshot('oben')->'ambiguous_docs' @> '[\"22222222222\"]';")" "t"
eq "A5 doc<11 excluído de doc_to_user" \
   "$(RS "SELECT (public.omie_sync_identity_snapshot('oben')->'doc_to_user'->>'123') IS NULL;")" "t"
eq "A6 doc<11 excluído de ambiguous_docs" \
   "$(RS "SELECT public.omie_sync_identity_snapshot('oben')->'ambiguous_docs' @> '[\"123\"]';")" "f"
eq "A7 client_to_user vazio no PR-1" \
   "$(RS "SELECT public.omie_sync_identity_snapshot('oben')->>'client_to_user';")" "{}"

# GATE — anon/authenticated barrados no EXECUTE (42501); sentinela PRÓPRIA (anti-teatro)
for R in anon authenticated; do
  OUT=$(P -tA 2>&1 <<SQL || true
SET ROLE $R;
DO \$\$ BEGIN
  PERFORM public.omie_sync_identity_snapshot('oben');
  RAISE EXCEPTION 'GATE_NAO_BARROU';
EXCEPTION
  WHEN insufficient_privilege THEN RAISE NOTICE 'GATE_OK_42501';
  WHEN OTHERS THEN RAISE;
END \$\$;
SQL
)
  case "$OUT" in *GATE_OK_42501*) ok "A8 $R barrado no EXECUTE (42501)" ;; *) bad "A8 $R — veio: $OUT" ;; esac
done

# service_role CONSEGUE executar (o caminho real não regrediu)
eq "A9 service_role executa a RPC" \
   "$(RS "SELECT (public.omie_sync_identity_snapshot('oben') IS NOT NULL);")" "t"

# ══ ZONA 5 — FALSIFICAÇÃO (Lei #3: sabota → exija vermelho → restaura) ══
echo "── falsificação ──"
# SABOTA: remove o filtro n_users=1 do doc_to_user → doc ambíguo passa a vazar
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.omie_sync_identity_snapshot(p_account text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' BEGIN ATOMIC
  WITH doc_valid AS (
    SELECT regexp_replace(p.document,'\D','','g') AS doc, p.user_id FROM public.profiles p
    WHERE p.document IS NOT NULL AND length(regexp_replace(p.document,'\D','','g'))>=11),
  doc_agg AS (SELECT doc, count(DISTINCT user_id) AS n_users, min(user_id::text) AS user_id FROM doc_valid GROUP BY doc)
  SELECT jsonb_build_object(
    'doc_to_user',    coalesce((SELECT jsonb_object_agg(doc,user_id) FROM doc_agg),'{}'::jsonb),  -- SABOTADO: sem WHERE n_users=1
    'ambiguous_docs', coalesce((SELECT jsonb_agg(doc ORDER BY doc) FROM doc_agg WHERE n_users>1),'[]'::jsonb),
    'client_to_user', '{}'::jsonb);
END;
SQL
LEAK=$(Pq -c "SELECT (public.omie_sync_identity_snapshot('oben')->'doc_to_user'->>'22222222222') IS NOT NULL;")
case "$LEAK" in
  t) ok "F1 sem o filtro n_users=1 o doc ambíguo VAZA p/ doc_to_user (A3 tem dente)" ;;
  *) bad "F1 sabotei o filtro e o doc ambíguo NÃO vazou → A3 é fraco, conserte o assert" ;;
esac
# RESTAURA a versão verdadeira
P -q -f "$MIG"
RESTORED=$(Pq -c "SELECT (public.omie_sync_identity_snapshot('oben')->'doc_to_user'->>'22222222222') IS NULL;")
eq "F2 restaurada: doc ambíguo volta a ficar FORA de doc_to_user" "$RESTORED" "t"

# ── veredito ──
echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
