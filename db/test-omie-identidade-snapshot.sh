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
# RLS ON em profiles: prova o caminho SECURITY INVOKER + service_role BYPASSRLS (Codex challenge PR-1).
P -q <<'SQL'
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
INSERT INTO auth.users(id) VALUES
  ('00000000-0000-0000-0000-000000000001'),
  ('00000000-0000-0000-0000-000000000002'),
  ('00000000-0000-0000-0000-000000000003'),
  ('00000000-0000-0000-0000-000000000004'),
  ('00000000-0000-0000-0000-000000000005'),
  ('00000000-0000-0000-0000-000000000006'),
  ('00000000-0000-0000-0000-000000000007') ON CONFLICT DO NOTHING;
INSERT INTO public.profiles(user_id, document) VALUES
  ('00000000-0000-0000-0000-000000000001', '11111111111'),      -- único
  ('00000000-0000-0000-0000-000000000002', '222.222.222-22'),   -- ambíguo (mascarado), colide com o 3
  ('00000000-0000-0000-0000-000000000003', '22222222222'),      -- ambíguo (mesmo doc normalizado, outro user)
  ('00000000-0000-0000-0000-000000000004', '333.333.333-33'),   -- único, normaliza da máscara
  ('00000000-0000-0000-0000-000000000005', '123'),              -- doc<11 → excluído
  ('00000000-0000-0000-0000-000000000006', NULL),               -- doc NULL → excluído (WHERE document IS NOT NULL)
  ('00000000-0000-0000-0000-000000000007', './-');              -- só pontuação → regexp vira '' (len 0) → excluído
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

# NULL / só-pontuação / totais (Codex PR-1: o cabeçalho prometia NULL mas o seed não tinha; faltava pontuação)
eq "A7b '' (doc só-pontuação) não vira chave em doc_to_user" \
   "$(RS "SELECT (public.omie_sync_identity_snapshot('oben')->'doc_to_user') ? '';")" "f"
eq "A7c docs únicos = 2 (NULL, só-pontuação e doc<11 excluídos; sobram 111... e 333...)" \
   "$(RS "SELECT count(*) FROM jsonb_object_keys(public.omie_sync_identity_snapshot('oben')->'doc_to_user');")" "2"
eq "A7d ambiguous_docs = 1 (só 222...)" \
   "$(RS "SELECT jsonb_array_length(public.omie_sync_identity_snapshot('oben')->'ambiguous_docs');")" "1"

# GATE — pelo CATÁLOGO (has_function_privilege), NÃO por execução real (Codex PR-1): executar como anon
# confunde "denied na FUNÇÃO" com "denied na TABELA profiles" — ambos 42501, o A8 ficaria verde-falso.
FN='public.omie_sync_identity_snapshot(text)'
eq "A8a service_role TEM execute"           "$(Pq -c "SELECT has_function_privilege('service_role','$FN','EXECUTE');")" "t"
eq "A8b anon SEM execute (REVOKE)"          "$(Pq -c "SELECT has_function_privilege('anon','$FN','EXECUTE');")" "f"
eq "A8c authenticated SEM execute (REVOKE)" "$(Pq -c "SELECT has_function_privilege('authenticated','$FN','EXECUTE');")" "f"
eq "A8d PUBLIC SEM execute"                 "$(Pq -c "SELECT has_function_privilege('public','$FN','EXECUTE');")" "f"
eq "A8e função é SECURITY INVOKER (prosecdef=false)" \
   "$(Pq -c "SELECT prosecdef FROM pg_proc WHERE proname='omie_sync_identity_snapshot';")" "f"

# service_role CONSEGUE executar de verdade (runtime; complementa o catálogo, prova SECURITY INVOKER+BYPASSRLS)
eq "A9 service_role executa a RPC (RLS on em profiles)" \
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
# Re-roda a EXPRESSÃO EXATA do A3 ("doc ambíguo IS NULL em doc_to_user", que o A3 exige ='t'). Sob o
# mutante ela vira 'f' → o assert A3 ficaria VERMELHO. Prova MECÂNICA de que A3 mata este mutante (Codex
# PR-1: só mostrar que o doc vaza não prova que o conjunto de asserts o pega).
A3_EXPR="SELECT (public.omie_sync_identity_snapshot('oben')->'doc_to_user'->>'22222222222') IS NULL;"
SOB_MUTANTE=$(Pq -c "$A3_EXPR")
case "$SOB_MUTANTE" in
  f) ok "F1 sob o mutante (sem n_users=1) a expressão do A3 vira 'f' → A3 ficaria VERMELHO (dente mecânico)" ;;
  *) bad "F1 mutante não mudou a expressão do A3 (veio '$SOB_MUTANTE') → A3 não mata o mutante, assert fraco" ;;
esac
# RESTAURA e reconfirma que a MESMA expressão do A3 volta a 't' (verde)
P -q -f "$MIG"
eq "F2 restaurada: a expressão do A3 volta a 't' (doc ambíguo FORA de doc_to_user)" "$(Pq -c "$A3_EXPR")" "t"

# ── veredito ──
echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
