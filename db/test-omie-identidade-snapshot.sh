#!/usr/bin/env bash
# ╔════════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA PG17 — RPC omie_sync_identity_snapshot (PR-1/A1 + PR-2/A2)              ║
# ║  Migrations (deploy): 20260711140000 → 20260713140000 → 20260713150000         ║
# ║  Rode:  bash db/test-omie-identidade-snapshot.sh > /tmp/t.log 2>&1; echo $?    ║
# ║                                                                                ║
# ║  PR-1 (doc_to_user): doc único → positiva; 2+ users → FORA + ambiguous_docs    ║
# ║  (fail-closed); doc<11 / nulo / só-pontuação excluídos.                        ║
# ║  PR-2 (client_to_user): prova POSITIVA codigo→user por conta —                 ║
# ║  (a) document: evidence NOT NULL + doc único (n_users=1) + aponta pro MESMO    ║
# ║  user + frescor 7d;  (b) manual: autoridade humana durável (sem TTL).          ║
# ║  Falsifica: n_users=1 off → ambíguo vaza (B2); user_id-match off → OUTRO       ║
# ║  user (B6, cenário A2); ramo manual off → override some (B9); 7d→7.5d →        ║
# ║  vínculo a 7.25d vaza (B10).  anon/authenticated barrados (42501).             ║
# ╚════════════════════════════════════════════════════════════════════════════════╝
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

# ══ ZONA 1 — pré-requisitos: profiles + proof-table SEM a coluna (a migration prova o ALTER) ══
P -q <<'SQL'
CREATE TABLE public.profiles (user_id uuid PRIMARY KEY, document text);
-- proof-table fiel ao schema prod (psql-ro 2026-07-13), SEM evidence_document_normalized: o ALTER da
-- migration PR-2 a adiciona (ZONA 2). Uniques reais (código,account)/(user,account) — pegam seed inválido.
CREATE TABLE public.omie_customer_account_map (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              uuid   NOT NULL,
  account              text   NOT NULL,
  omie_codigo_cliente  bigint NOT NULL,
  omie_codigo_vendedor bigint,
  source               text   NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_ocam_codigo_account UNIQUE (omie_codigo_cliente, account),
  CONSTRAINT uq_ocam_user_account   UNIQUE (user_id, account)
);
SQL

# ══ ZONA 2 — aplicar as migrations REAIS na ORDEM de deploy (PR-1 → PR-2 base → PR-2 correção manual) ══
MIG1="$REPO_ROOT/supabase/migrations/20260711140000_omie_sync_identity_snapshot.sql"
MIG2="$REPO_ROOT/supabase/migrations/20260713140000_omie_identity_snapshot_client_to_user.sql"
MIG3="$REPO_ROOT/supabase/migrations/20260713150000_omie_client_to_user_manual_authority.sql"
P -q -f "$MIG1"; echo "migration aplicada: $(basename "$MIG1")"
P -q -f "$MIG2"; echo "migration aplicada: $(basename "$MIG2")"
P -q -f "$MIG3"; echo "migration aplicada: $(basename "$MIG3")"
# a coluna tem de existir após o ALTER da PR-2 (prova o passo 1 do design §4.2)
eq "Z2 coluna evidence_document_normalized criada pela migration" \
   "$(Pq -c "SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name='omie_customer_account_map' AND column_name='evidence_document_normalized';")" "1"

# ══ ZONA 3 — seed + grants (service_role lê profiles + proof-table; RLS on prova SECURITY INVOKER) ══
P -q <<'SQL'
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.omie_customer_account_map ENABLE ROW LEVEL SECURITY;
INSERT INTO auth.users(id) VALUES
  ('00000000-0000-0000-0000-000000000001'),('00000000-0000-0000-0000-000000000002'),
  ('00000000-0000-0000-0000-000000000003'),('00000000-0000-0000-0000-000000000004'),
  ('00000000-0000-0000-0000-000000000005'),('00000000-0000-0000-0000-000000000006'),
  ('00000000-0000-0000-0000-000000000007'),('00000000-0000-0000-0000-000000000008'),
  ('00000000-0000-0000-0000-000000000009'),('00000000-0000-0000-0000-000000000010'),
  ('00000000-0000-0000-0000-000000000011'),('00000000-0000-0000-0000-000000000012'),
  ('00000000-0000-0000-0000-000000000013'),('00000000-0000-0000-0000-000000000014'),
  ('00000000-0000-0000-0000-000000000015'),('00000000-0000-0000-0000-000000000016') ON CONFLICT DO NOTHING;
INSERT INTO public.profiles(user_id, document) VALUES
  ('00000000-0000-0000-0000-000000000001', '11111111111'),      -- único → base do B1 positivo
  ('00000000-0000-0000-0000-000000000002', '222.222.222-22'),   -- ambíguo (mascarado), colide c/ o 3
  ('00000000-0000-0000-0000-000000000003', '22222222222'),      -- ambíguo (mesmo doc normalizado)
  ('00000000-0000-0000-0000-000000000004', '333.333.333-33'),   -- único, normaliza da máscara
  ('00000000-0000-0000-0000-000000000005', '123'),              -- doc<11 → excluído
  ('00000000-0000-0000-0000-000000000006', NULL),               -- doc NULL → excluído
  ('00000000-0000-0000-0000-000000000007', './-'),              -- só pontuação → '' → excluído
  ('00000000-0000-0000-0000-000000000008', '44444444444'),      -- único → B3 (evidence NULL)
  ('00000000-0000-0000-0000-000000000009', '55555555555'),      -- único → B4 (source=code)
  ('00000000-0000-0000-0000-000000000010', '66666666666'),      -- único → B5 (conta colacor)
  ('00000000-0000-0000-0000-000000000011', '77777777777'),      -- único → B6 (dono do vínculo, evidence de OUTRO)
  ('00000000-0000-0000-0000-000000000012', '88888888888'),      -- único → B7 (stale)
  ('00000000-0000-0000-0000-000000000013', '99999999999'),      -- único → dono do vínculo MANUAL (B9)
  ('00000000-0000-0000-0000-000000000014', '10101010101'),      -- único → fronteira frescor FORA 7.25d (B10)
  ('00000000-0000-0000-0000-000000000015', '12121212121');      -- único → fronteira frescor DENTRO 6.75d (B11)
  -- user16 SEM profile de propósito → evidence sem profile correspondente (B12)
-- proof-table: os 7 cenários de client_to_user (evidence_document_normalized existe pós-ZONA 2)
INSERT INTO public.omie_customer_account_map (user_id, account, omie_codigo_cliente, source, evidence_document_normalized, updated_at) VALUES
  ('00000000-0000-0000-0000-000000000001','oben',    1001,'document','11111111111', now()),          -- B1 doc único → MAPEIA
  ('00000000-0000-0000-0000-000000000002','oben',    1002,'document','22222222222', now()),          -- B2 doc ambíguo → FORA (user2=min)
  ('00000000-0000-0000-0000-000000000008','oben',    1003,'document', NULL,          now()),          -- B3 evidence NULL → FORA
  ('00000000-0000-0000-0000-000000000009','oben',    1004,'code',    '55555555555', now()),          -- B4 source=code → FORA
  ('00000000-0000-0000-0000-000000000010','colacor', 1005,'document','66666666666', now()),          -- B5 conta colacor (dentro só p/ colacor)
  ('00000000-0000-0000-0000-000000000011','oben',    1006,'document','11111111111', now()),          -- B6 evidence do user1, vínculo do user11 → FORA (A2)
  ('00000000-0000-0000-0000-000000000012','oben',    1007,'document','88888888888', now() - interval '8 days'),       -- B7 stale → FORA
  -- PR-2 correção pós-Codex (P1-b + fronteira):
  ('00000000-0000-0000-0000-000000000013','oben',    1008,'manual',  '11111111111', now()),          -- B9 MANUAL: evidence é o doc de user1, mas o vínculo é user13 → autoridade humana MAPEIA user13
  ('00000000-0000-0000-0000-000000000014','oben',    1009,'document','10101010101', now() - interval '7 days 6 hours'),  -- B10 fronteira: 7.25d > 7d → FORA (frescor)
  ('00000000-0000-0000-0000-000000000015','oben',    1010,'document','12121212121', now() - interval '6 days 18 hours'), -- B11 fronteira: 6.75d < 7d → DENTRO
  ('00000000-0000-0000-0000-000000000016','oben',    1011,'document','13131313131', now());           -- B12 evidence sem profile correspondente → FORA
GRANT SELECT ON public.profiles TO service_role;
GRANT SELECT ON public.omie_customer_account_map TO service_role;
SQL

# ══ ZONA 4 — asserts ══
echo "── asserts PR-1 (doc_to_user) ──"
eq "A1 doc único → doc_to_user aponta pro user" \
   "$(RS "SELECT public.omie_sync_identity_snapshot('oben')->'doc_to_user'->>'11111111111';")" \
   "00000000-0000-0000-0000-000000000001"
eq "A2 máscara normaliza (333.333.333-33 → 33333333333)" \
   "$(RS "SELECT public.omie_sync_identity_snapshot('oben')->'doc_to_user'->>'33333333333';")" \
   "00000000-0000-0000-0000-000000000004"
eq "A3 doc ambíguo FORA de doc_to_user (precisão>recall)" \
   "$(RS "SELECT (public.omie_sync_identity_snapshot('oben')->'doc_to_user'->>'22222222222') IS NULL;")" "t"
eq "A4 doc ambíguo LISTADO em ambiguous_docs" \
   "$(RS "SELECT public.omie_sync_identity_snapshot('oben')->'ambiguous_docs' @> '[\"22222222222\"]';")" "t"
eq "A5 doc<11 excluído de doc_to_user" \
   "$(RS "SELECT (public.omie_sync_identity_snapshot('oben')->'doc_to_user'->>'123') IS NULL;")" "t"
eq "A6 doc<11 excluído de ambiguous_docs" \
   "$(RS "SELECT public.omie_sync_identity_snapshot('oben')->'ambiguous_docs' @> '[\"123\"]';")" "f"
eq "A7b '' (doc só-pontuação) não vira chave em doc_to_user" \
   "$(RS "SELECT (public.omie_sync_identity_snapshot('oben')->'doc_to_user') ? '';")" "f"
eq "A7d ambiguous_docs = 1 (só 222...)" \
   "$(RS "SELECT jsonb_array_length(public.omie_sync_identity_snapshot('oben')->'ambiguous_docs');")" "1"

echo "── asserts PR-2 (client_to_user — prova positiva codigo→user) ──"
eq "B1 doc único + evidence consistente → client_to_user MAPEIA (positivo)" \
   "$(RS "SELECT public.omie_sync_identity_snapshot('oben')->'client_to_user'->>'1001';")" \
   "00000000-0000-0000-0000-000000000001"
eq "B2 doc AMBÍGUO → FORA de client_to_user (fail-closed)" \
   "$(RS "SELECT (public.omie_sync_identity_snapshot('oben')->'client_to_user') ? '1002';")" "f"
eq "B3 evidence NULL → FORA (backfill fail-closed: sem prova, cai no fallback)" \
   "$(RS "SELECT (public.omie_sync_identity_snapshot('oben')->'client_to_user') ? '1003';")" "f"
eq "B4 source='code' → FORA (v1 só document)" \
   "$(RS "SELECT (public.omie_sync_identity_snapshot('oben')->'client_to_user') ? '1004';")" "f"
eq "B5 conta colacor → FORA quando p_account='oben' (filtro por conta)" \
   "$(RS "SELECT (public.omie_sync_identity_snapshot('oben')->'client_to_user') ? '1005';")" "f"
eq "B5b MESMO vínculo colacor → DENTRO quando p_account='colacor' (account é filtro, não exclusão cega)" \
   "$(RS "SELECT public.omie_sync_identity_snapshot('colacor')->'client_to_user'->>'1005';")" \
   "00000000-0000-0000-0000-000000000010"
eq "B6 evidence aponta p/ OUTRO user (doc migrou) → FORA (cenário A2, prova positiva)" \
   "$(RS "SELECT (public.omie_sync_identity_snapshot('oben')->'client_to_user') ? '1006';")" "f"
eq "B7 vínculo stale (updated_at > 7d) → FORA (frescor)" \
   "$(RS "SELECT (public.omie_sync_identity_snapshot('oben')->'client_to_user') ? '1007';")" "f"
echo "── PR-2 correção pós-Codex (P1-b manual + fronteira de frescor + evidence sem profile) ──"
eq "B9 MANUAL → autoridade humana MAPEIA o user do vínculo (não depende do doc)" \
   "$(RS "SELECT public.omie_sync_identity_snapshot('oben')->'client_to_user'->>'1008';")" \
   "00000000-0000-0000-0000-000000000013"
eq "B9b MANUAL ignora o evidence: NÃO mapeia pro dono do doc (user1), e sim pro vínculo (user13)" \
   "$(RS "SELECT (public.omie_sync_identity_snapshot('oben')->'client_to_user'->>'1008') = '00000000-0000-0000-0000-000000000001';")" "f"
eq "B10 fronteira frescor: document a 7.25d (>7d) → FORA (mata mutante 7→7.5d, ver F8)" \
   "$(RS "SELECT (public.omie_sync_identity_snapshot('oben')->'client_to_user') ? '1009';")" "f"
eq "B11 fronteira frescor: document a 6.75d (<7d) → DENTRO (corte não é apertado demais)" \
   "$(RS "SELECT public.omie_sync_identity_snapshot('oben')->'client_to_user'->>'1010';")" \
   "00000000-0000-0000-0000-000000000015"
eq "B12 evidence sem profile correspondente (doc não existe em profiles) → FORA" \
   "$(RS "SELECT (public.omie_sync_identity_snapshot('oben')->'client_to_user') ? '1011';")" "f"
eq "B8 client_to_user('oben') tem EXATAMENTE 3 chaves (1001 document, 1008 manual, 1010 fronteira-dentro)" \
   "$(RS "SELECT count(*) FROM jsonb_object_keys(public.omie_sync_identity_snapshot('oben')->'client_to_user');")" "3"

echo "── gate de privilégio (catálogo) + SECURITY INVOKER ──"
FN='public.omie_sync_identity_snapshot(text)'
eq "A8a service_role TEM execute"           "$(Pq -c "SELECT has_function_privilege('service_role','$FN','EXECUTE');")" "t"
eq "A8b anon SEM execute (REVOKE)"          "$(Pq -c "SELECT has_function_privilege('anon','$FN','EXECUTE');")" "f"
eq "A8c authenticated SEM execute (REVOKE)" "$(Pq -c "SELECT has_function_privilege('authenticated','$FN','EXECUTE');")" "f"
eq "A8d PUBLIC SEM execute"                 "$(Pq -c "SELECT has_function_privilege('public','$FN','EXECUTE');")" "f"
eq "A8e função é SECURITY INVOKER (prosecdef=false)" \
   "$(Pq -c "SELECT prosecdef FROM pg_proc WHERE proname='omie_sync_identity_snapshot';")" "f"
eq "A9 service_role executa a RPC (RLS on em profiles + proof-table)" \
   "$(RS "SELECT (public.omie_sync_identity_snapshot('oben') IS NOT NULL);")" "t"

# ══ ZONA 5 — FALSIFICAÇÃO (Lei #3: sabota → exige vermelho → restaura) ══
echo "── falsificação PR-1 (doc_to_user) ──"
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
A3_EXPR="SELECT (public.omie_sync_identity_snapshot('oben')->'doc_to_user'->>'22222222222') IS NULL;"
case "$(Pq -c "$A3_EXPR")" in
  f) ok "F1 sem n_users=1 no doc_to_user → expressão do A3 vira 'f' → A3 ficaria VERMELHO (dente mecânico)" ;;
  *) bad "F1 mutante não mudou a expressão do A3 → assert fraco" ;;
esac

echo "── falsificação PR-2 (client_to_user) ──"
# M1: remove n_users=1 do client_valid → o doc AMBÍGUO (1002, user2=min) passa a mapear → B2 vaza.
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.omie_sync_identity_snapshot(p_account text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' BEGIN ATOMIC
  WITH doc_valid AS (
    SELECT regexp_replace(p.document,'\D','','g') AS doc, p.user_id FROM public.profiles p
    WHERE p.document IS NOT NULL AND length(regexp_replace(p.document,'\D','','g'))>=11),
  doc_agg AS (SELECT doc, count(DISTINCT user_id) AS n_users, min(user_id::text) AS user_id FROM doc_valid GROUP BY doc),
  client_valid AS (
    SELECT m.omie_codigo_cliente::text AS codigo, da.user_id AS user_id
    FROM public.omie_customer_account_map m JOIN doc_agg da
      ON da.doc = m.evidence_document_normalized AND da.user_id = m.user_id::text  -- SABOTADO: sem n_users=1
    WHERE m.account=p_account AND m.source='document' AND m.evidence_document_normalized IS NOT NULL
      AND m.updated_at >= now() - interval '7 days')
  SELECT jsonb_build_object(
    'doc_to_user',    coalesce((SELECT jsonb_object_agg(doc,user_id) FROM doc_agg WHERE n_users=1),'{}'::jsonb),
    'ambiguous_docs', coalesce((SELECT jsonb_agg(doc ORDER BY doc) FROM doc_agg WHERE n_users>1),'[]'::jsonb),
    'client_to_user', coalesce((SELECT jsonb_object_agg(codigo,user_id) FROM client_valid),'{}'::jsonb));
END;
SQL
B2_EXPR="SELECT (public.omie_sync_identity_snapshot('oben')->'client_to_user') ? '1002';"
case "$(RS "$B2_EXPR")" in
  t) ok "F3 sem n_users=1 no client_valid → doc ambíguo (1002) VAZA → B2 ficaria VERMELHO (dente mecânico)" ;;
  *) bad "F3 mutante não vazou o 1002 → B2 não mata o mutante, assert fraco" ;;
esac
# M2: remove o user_id-match do client_valid → o vínculo cujo doc migrou p/ OUTRO user (1006) passa a mapear → B6 vaza.
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.omie_sync_identity_snapshot(p_account text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' BEGIN ATOMIC
  WITH doc_valid AS (
    SELECT regexp_replace(p.document,'\D','','g') AS doc, p.user_id FROM public.profiles p
    WHERE p.document IS NOT NULL AND length(regexp_replace(p.document,'\D','','g'))>=11),
  doc_agg AS (SELECT doc, count(DISTINCT user_id) AS n_users, min(user_id::text) AS user_id FROM doc_valid GROUP BY doc),
  client_valid AS (
    SELECT m.omie_codigo_cliente::text AS codigo, da.user_id AS user_id
    FROM public.omie_customer_account_map m JOIN doc_agg da
      ON da.doc = m.evidence_document_normalized AND da.n_users = 1  -- SABOTADO: sem da.user_id=m.user_id
    WHERE m.account=p_account AND m.source='document' AND m.evidence_document_normalized IS NOT NULL
      AND m.updated_at >= now() - interval '7 days')
  SELECT jsonb_build_object(
    'doc_to_user',    coalesce((SELECT jsonb_object_agg(doc,user_id) FROM doc_agg WHERE n_users=1),'{}'::jsonb),
    'ambiguous_docs', coalesce((SELECT jsonb_agg(doc ORDER BY doc) FROM doc_agg WHERE n_users>1),'[]'::jsonb),
    'client_to_user', coalesce((SELECT jsonb_object_agg(codigo,user_id) FROM client_valid),'{}'::jsonb));
END;
SQL
B6_EXPR="SELECT (public.omie_sync_identity_snapshot('oben')->'client_to_user') ? '1006';"
case "$(RS "$B6_EXPR")" in
  t) ok "F4 sem user_id-match no client_valid → vínculo com doc migrado (1006) VAZA → B6 ficaria VERMELHO (cenário A2)" ;;
  *) bad "F4 mutante não vazou o 1006 → B6 não mata o mutante, assert fraco" ;;
esac
# M3: remove o UNION do ramo manual → o override humano (1008) SOME do client_to_user → B9 vermelho (regressão P1-b).
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.omie_sync_identity_snapshot(p_account text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' BEGIN ATOMIC
  WITH doc_valid AS (
    SELECT regexp_replace(p.document,'\D','','g') AS doc, p.user_id FROM public.profiles p
    WHERE p.document IS NOT NULL AND length(regexp_replace(p.document,'\D','','g'))>=11),
  doc_agg AS (SELECT doc, count(DISTINCT user_id) AS n_users, min(user_id::text) AS user_id FROM doc_valid GROUP BY doc),
  client_valid AS (
    SELECT m.omie_codigo_cliente::text AS codigo, da.user_id AS user_id
    FROM public.omie_customer_account_map m JOIN doc_agg da
      ON da.doc = m.evidence_document_normalized AND da.n_users = 1 AND da.user_id = m.user_id::text
    WHERE m.account=p_account AND m.source='document' AND m.evidence_document_normalized IS NOT NULL
      AND m.updated_at >= now() - interval '7 days')  -- SABOTADO: sem o UNION do ramo 'manual'
  SELECT jsonb_build_object(
    'doc_to_user',    coalesce((SELECT jsonb_object_agg(doc,user_id) FROM doc_agg WHERE n_users=1),'{}'::jsonb),
    'ambiguous_docs', coalesce((SELECT jsonb_agg(doc ORDER BY doc) FROM doc_agg WHERE n_users>1),'[]'::jsonb),
    'client_to_user', coalesce((SELECT jsonb_object_agg(codigo,user_id) FROM client_valid),'{}'::jsonb));
END;
SQL
case "$(RS "SELECT (public.omie_sync_identity_snapshot('oben')->'client_to_user') ? '1008';")" in
  f) ok "F_M3 sem o ramo manual → override (1008) SOME do client_to_user → B9 ficaria VERMELHO (regressão P1-b)" ;;
  *) bad "F_M3 mutante não removeu o 1008 → B9 não mata o mutante, assert fraco" ;;
esac
# M4: afrouxa o frescor do ramo document 7d → 7.5d → o vínculo a 7.25d (1009) passa a ENTRAR → B10 vermelho (fronteira).
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.omie_sync_identity_snapshot(p_account text)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' BEGIN ATOMIC
  WITH doc_valid AS (
    SELECT regexp_replace(p.document,'\D','','g') AS doc, p.user_id FROM public.profiles p
    WHERE p.document IS NOT NULL AND length(regexp_replace(p.document,'\D','','g'))>=11),
  doc_agg AS (SELECT doc, count(DISTINCT user_id) AS n_users, min(user_id::text) AS user_id FROM doc_valid GROUP BY doc),
  client_valid AS (
    SELECT m.omie_codigo_cliente::text AS codigo, da.user_id AS user_id
    FROM public.omie_customer_account_map m JOIN doc_agg da
      ON da.doc = m.evidence_document_normalized AND da.n_users = 1 AND da.user_id = m.user_id::text
    WHERE m.account=p_account AND m.source='document' AND m.evidence_document_normalized IS NOT NULL
      AND m.updated_at >= now() - interval '7 days 12 hours'  -- SABOTADO: 7d → 7.5d
    UNION
    SELECT m.omie_codigo_cliente::text, m.user_id::text
    FROM public.omie_customer_account_map m WHERE m.account=p_account AND m.source='manual')
  SELECT jsonb_build_object(
    'doc_to_user',    coalesce((SELECT jsonb_object_agg(doc,user_id) FROM doc_agg WHERE n_users=1),'{}'::jsonb),
    'ambiguous_docs', coalesce((SELECT jsonb_agg(doc ORDER BY doc) FROM doc_agg WHERE n_users>1),'[]'::jsonb),
    'client_to_user', coalesce((SELECT jsonb_object_agg(codigo,user_id) FROM client_valid),'{}'::jsonb));
END;
SQL
case "$(RS "SELECT (public.omie_sync_identity_snapshot('oben')->'client_to_user') ? '1009';")" in
  t) ok "F_M4 frescor afrouxado 7d→7.5d → o vínculo a 7.25d (1009) VAZA → B10 ficaria VERMELHO (fronteira)" ;;
  *) bad "F_M4 mutante não vazou o 1009 → B10 não mata o mutante, assert fraco" ;;
esac

# RESTAURA a versão boa (PR-2 vencedora = MIG3, a última a recriar) e reconfirma B1/B2/B6/B9 corretos
P -q -f "$MIG3"
eq "F5 restaurada: B1 volta a mapear o 1001" \
   "$(RS "SELECT public.omie_sync_identity_snapshot('oben')->'client_to_user'->>'1001';")" \
   "00000000-0000-0000-0000-000000000001"
eq "F6 restaurada: B2 (ambíguo) volta a FORA" \
   "$(RS "SELECT (public.omie_sync_identity_snapshot('oben')->'client_to_user') ? '1002';")" "f"
eq "F7 restaurada: B6 (doc migrado) volta a FORA" \
   "$(RS "SELECT (public.omie_sync_identity_snapshot('oben')->'client_to_user') ? '1006';")" "f"
eq "F8 restaurada: B9 (manual) volta a mapear o 1008 → user13" \
   "$(RS "SELECT public.omie_sync_identity_snapshot('oben')->'client_to_user'->>'1008';")" \
   "00000000-0000-0000-0000-000000000013"

# ── veredito ──
echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
