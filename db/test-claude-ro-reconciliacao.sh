#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  HARNESS PG17 — PROVA de migration money-path/auth com FALSIFICAÇÃO            ║
# ║  Copie p/ db/test-<slug>.sh, preencha as ZONAS [[...]], rode:                  ║
# ║      bash db/test-<slug>.sh > /tmp/t.log 2>&1; echo "exit=$?"                  ║
# ║  (NÃO pipe pra tail — engole o exit≠0; §2 do CLAUDE.md.)                       ║
# ║                                                                                ║
# ║  Lei de Ferro (skill prove-sql-money-path):                                    ║
# ║   1. Aplica a migration REAL (psql -f), não um stub da lógica.                 ║
# ║   2. Assert negativo captura a SQLSTATE esperada e RE-LANÇA o resto.           ║
# ║   3. Falsificação obrigatória: sabota a migração → exija VERMELHO → restaura.  ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

# ── arranque PG17 descartável (idêntico em todos os harnesses; contorna keg-only do brew) ──
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5489}"     # mude se rodar em paralelo com outro harness (40 worktrees)
SLUG="claude-ro-reconciliacao"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C          # sem isso o postmaster aborta ("became multithreaded during startup")

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER} pgvector"; exit 1; }

# keg-only do brew: share/lib do postgresql@17 podem não estar linkados → initdb/server falham. Copia do Cellar (idempotente).
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
Pq() { P -tA "$@"; }   # tuples-only, unaligned (pra capturar 1 valor)

# ── base mínima do Supabase: roles, schema auth, auth.uid()/role() via GUC (impersonação de RLS) ──
P -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -q <<'SQL'
CREATE OR REPLACE FUNCTION auth.uid()  RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.uid',  true), '')::uuid $f$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.role', true), '') $f$;
ALTER ROLE service_role BYPASSRLS;   -- espelha o admin role do Supabase (semear sem esbarrar em RLS)
SQL

# ── helpers de assert (pass/fail contados; exit 1 no fim se houve fail) ──
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }
# exige que um comando SQL FALHE (caminho negativo grosso). Pra checar a SQLSTATE exata, use o
# padrão DO/EXCEPTION de references/assert-patterns.md (preferível — Lei #2).
must_fail() { if P -q -c "$1" >/dev/null 2>&1; then bad "$2 — devia ter falhado e PASSOU"; else ok "$2 (rejeitado)"; fi; }

echo "═══ setup pronto (PG17 :$PORT) ═══"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — reproduzir o ESTADO ATUAL DE PROD (pós-fecho de 2026-08-25),
# medido em 2026-09-06 19:34 BRT. Sem isto o teste não prova nada sobre prod.
# ══════════════════════════════════════════════════════════════════════════════
echo "═══ ZONA 1: estado de prod pós-fecho ═══"
P -q <<'SQL'
ALTER ROLE supabase_admin SUPERUSER;
DO $r$ BEGIN CREATE ROLE claude_ro LOGIN BYPASSRLS; EXCEPTION WHEN duplicate_object THEN NULL; END $r$;
-- ⚠️ SEM pg_read_all_data: é exatamente o estado de hoje (membership = 0)

CREATE SCHEMA IF NOT EXISTS private;
CREATE SCHEMA IF NOT EXISTS supabase_migrations;

-- as 3 MVs reais de private (o que claude_ro perdeu sem catálogo)
CREATE TABLE public.fonte_mv(empresa text, n int);
INSERT INTO public.fonte_mv VALUES ('OBEN', 12);
CREATE MATERIALIZED VIEW private.mv_oportunidade_badge AS SELECT empresa, n FROM public.fonte_mv;
CREATE MATERIALIZED VIEW private.customer_metrics_mv AS SELECT empresa FROM public.fonte_mv;
CREATE MATERIALIZED VIEW private.mv_sku_ranking_negociacao_paralela AS SELECT n FROM public.fonte_mv;

CREATE TABLE public.aaa_diag(id int, valor numeric);
INSERT INTO public.aaa_diag VALUES (1, 42);
CREATE TABLE supabase_migrations.schema_migrations(version text);

-- os grants que o bloco de 25/08 aplicou (public, cron, supabase_migrations)
GRANT USAGE ON SCHEMA public, cron, supabase_migrations TO claude_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA public, supabase_migrations TO claude_ro;
GRANT SELECT ON cron.job_run_details TO claude_ro;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO claude_ro;
SQL

# auth: fechado para claude_ro, com o GRANT POR COLUNA *inerte* (o defeito de 25/08)
P -q <<'SQL'
ALTER TABLE auth.users ADD COLUMN IF NOT EXISTS email text;
CREATE TABLE IF NOT EXISTS auth.refresh_tokens(
  instance_id uuid, id bigserial PRIMARY KEY, token varchar(255), user_id varchar(255),
  revoked boolean DEFAULT false, created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(), parent varchar(255), session_id uuid);
INSERT INTO auth.refresh_tokens(token, user_id, revoked)
  VALUES ('TOKEN-DE-MASTER-VIVO','11111111-1111-1111-1111-111111111111', false);
REVOKE ALL ON SCHEMA auth FROM PUBLIC;            -- claude_ro NÃO tem USAGE
GRANT SELECT (instance_id, id, user_id, revoked, created_at, updated_at, session_id)
  ON auth.refresh_tokens TO claude_ro;             -- pousa, mas é INALCANÇÁVEL
SQL

# vault: fechado (o fecho que NÃO pode ser revertido por este bloco)
P -q <<'SQL'
SET ROLE supabase_admin;
CREATE SCHEMA vault;
CREATE TABLE vault.secrets(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text, secret text);
INSERT INTO vault.secrets(name, secret) VALUES ('cron-secret','cifra');
REVOKE ALL ON SCHEMA vault FROM PUBLIC;
RESET ROLE;
SQL

CRO() { "$PGBIN/psql" -p "$PORT" -h /tmp -U claude_ro -d prove -tA "$@"; }
CRO_STATE() {
  "$PGBIN/psql" -p "$PORT" -h /tmp -U claude_ro -d prove -tA \
    -c "$1" -c "\\echo SQLSTATE=:LAST_ERROR_SQLSTATE" 2>/dev/null \
    | grep '^SQLSTATE=' | tail -1 | cut -d= -f2
}
eq "detector: erro conhecido devolve SQLSTATE" "$(CRO_STATE 'SELECT 1/0')" "22012"

echo "── linha de base: as DUAS pontas soltas existem? (senão o bloco é vácuo) ──"
eq "ANTES: claude_ro NÃO alcança private"          "$(CRO_STATE 'SELECT count(*) FROM private.mv_oportunidade_badge')" "42501"
eq "ANTES: o GRANT por coluna é INERTE (schema)"   "$(CRO_STATE 'SELECT created_at FROM auth.refresh_tokens')"         "42501"
eq "ANTES: as 7 colunas ESTÃO no catálogo"         "$(Pq -c "SELECT count(*) FROM information_schema.column_privileges WHERE grantee='claude_ro' AND table_name='refresh_tokens'")" "7"
eq "ANTES: vault fechado (e tem de continuar)"     "$(CRO_STATE 'SELECT count(*) FROM vault.secrets')"                 "42501"
eq "ANTES: diagnóstico de public vivo"             "$(CRO -c 'SELECT valor FROM public.aaa_diag' 2>/dev/null)"         "42"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — aplicar o bloco REAL
# ══════════════════════════════════════════════════════════════════════════════
echo "═══ ZONA 2: aplicando o bloco REAL ═══"
BLOCO="$REPO_ROOT/db/reconciliacao-claude-ro-private-auth.sql"
[ -f "$BLOCO" ] || { echo "❌ bloco não encontrado: $BLOCO"; exit 1; }
P -q -f "$BLOCO"
echo "  ✅ aplicado (os guards de saída passaram)"
if P -q -f "$BLOCO"; then ok "idempotente: 2ª aplicação sem erro"; else bad "2ª aplicação FALHOU"; fi

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 3 — asserts
# ══════════════════════════════════════════════════════════════════════════════
echo "── (1) private devolvido ──"
eq "(1a) lê mv_oportunidade_badge"                "$(CRO -c 'SELECT n FROM private.mv_oportunidade_badge' 2>/dev/null)" "12"
eq "(1b) GRANT ON ALL TABLES alcança MATVIEW"     "$(Pq -c "SELECT count(*) FROM pg_class c WHERE c.relnamespace='private'::regnamespace AND c.relkind='m' AND has_table_privilege('claude_ro',c.oid,'SELECT')")" "3"

echo "── (2) telemetria de login restaurada ──"
eq "(2a) lê a ponte"                              "$(CRO -c 'SELECT user_id FROM private.auth_refresh_tokens_diag' 2>/dev/null)" "11111111-1111-1111-1111-111111111111"
eq "(2b) a coluna created_at (o sinal real) chega" "$(CRO -c "SELECT count(*) FROM private.auth_refresh_tokens_diag WHERE created_at > now()-interval '1 day'" 2>/dev/null)" "1"

echo "── (3) o FECHO de 25/08 NÃO foi revertido — o ponto crítico ──"
eq "(3a) a ponte NÃO tem coluna token"            "$(CRO_STATE 'SELECT token FROM private.auth_refresh_tokens_diag')"  "42703"
eq "(3b) a ponte NÃO tem coluna parent"           "$(CRO_STATE 'SELECT parent FROM private.auth_refresh_tokens_diag')" "42703"
eq "(3c) auth.refresh_tokens segue inalcançável"  "$(CRO_STATE 'SELECT token FROM auth.refresh_tokens')"               "42501"
eq "(3d) vault segue fechado"                     "$(CRO_STATE 'SELECT count(*) FROM vault.secrets')"                  "42501"
eq "(3e) sem USAGE em auth"                       "$(Pq -c "SELECT has_schema_privilege('claude_ro','auth','USAGE')")" "f"
eq "(3f) sem escrita na ponte"                    "$(CRO_STATE 'DELETE FROM private.auth_refresh_tokens_diag')"        "42501"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4 — FALSIFICAÇÃO: sabota → EXIGE vermelho → restaura
# ══════════════════════════════════════════════════════════════════════════════
echo "═══ ZONA 4: falsificação ═══"
FPASS=0; FFAIL=0
fok()  { FPASS=$((FPASS+1)); echo "  ✅ FALSIF [$1] — ficou VERMELHO como devia ($2)"; }
fbad() { FFAIL=$((FFAIL+1)); echo "  ❌ FALSIF [$1] — seguiu VERDE ($2): assert SEM DENTE"; }

# ── F1: a 2ª BARREIRA. Com invoker=on, acrescentar `token` à ponte NÃO basta
#        para vazar: o ACL de coluna de 25/08 nega. É o que torna `on` melhor
#        que `off` — e F1b mostra o contrafactual. ──
P -q -c "CREATE OR REPLACE VIEW private.auth_refresh_tokens_diag WITH (security_invoker = on) AS
         SELECT instance_id, id, user_id, revoked, created_at, updated_at, session_id, token FROM auth.refresh_tokens;"
V="$(CRO_STATE 'SELECT token FROM private.auth_refresh_tokens_diag')"
if [ "$V" = "42501" ]; then fok "F1 token na ponte c/ invoker=on" "ACL de coluna barrou (SQLSTATE=$V)"; else fbad "F1 token na ponte c/ invoker=on" "VAZOU (SQLSTATE=$V)"; fi
# F1b — contrafactual: com invoker=off a MESMA view vaza (por isso o bloco usa `on`)
P -q -c "CREATE OR REPLACE VIEW private.auth_refresh_tokens_diag WITH (security_invoker = off) AS
         SELECT instance_id, id, user_id, revoked, created_at, updated_at, session_id, token FROM auth.refresh_tokens;"
V="$(CRO_STATE 'SELECT token FROM private.auth_refresh_tokens_diag')"
if [ "$V" = "00000" ]; then fok "F1b contrafactual invoker=off" "vazou, como previsto: justifica o invoker=on"; else fbad "F1b contrafactual invoker=off" "nao vazou (SQLSTATE=$V): o contraste nao existe"; fi
P -q -c "DROP VIEW IF EXISTS private.auth_refresh_tokens_diag;" 
P -q -f "$BLOCO" >/dev/null 2>&1   # restaura pelo próprio bloco (prova que ele conserta)
eq "F1 restaurado: a ponte voltou a ler" "$(CRO -c 'SELECT user_id FROM private.auth_refresh_tokens_diag' 2>/dev/null)" "11111111-1111-1111-1111-111111111111"

# ── F2: a sabotagem PERIGOSA — projetar `token` reabre a escalada para master.
#        O guard (a') tem de ABORTAR a aplicação, não deixar passar. ──
P -q -c "CREATE OR REPLACE VIEW private.auth_refresh_tokens_diag WITH (security_invoker = off) AS
         SELECT instance_id, id, user_id, revoked, created_at, updated_at, session_id, token FROM auth.refresh_tokens;"
V="$(CRO_STATE 'SELECT token FROM private.auth_refresh_tokens_diag')"
if [ "$V" = "42703" ]; then fbad "F2 ponte com token" "coluna ainda ausente"; else fok "F2 ponte com token" "credencial exposta, SQLSTATE=$V"; fi
# e o bloco tem de RECUSAR aplicar por cima dessa view
if P -q -f "$BLOCO" >/dev/null 2>&1; then
  # CREATE OR REPLACE não remove coluna: o bloco falha no replace, o guard nem chega. Ambos servem.
  V2="$(CRO_STATE 'SELECT token FROM private.auth_refresh_tokens_diag')"
  if [ "$V2" = "42703" ]; then fok "F2b bloco corrigiu a ponte" "token sumiu"; else fbad "F2b bloco aplicou COM token" "SQLSTATE=$V2"; fi
else
  fok "F2b bloco RECUSOU aplicar sobre ponte adulterada" "abortou + rollback"
fi
P -q -c "DROP VIEW IF EXISTS private.auth_refresh_tokens_diag;" >/dev/null 2>&1
P -q -f "$BLOCO" >/dev/null 2>&1
eq "F2 restaurado: ponte sem token" "$(CRO_STATE 'SELECT token FROM private.auth_refresh_tokens_diag')" "42703"

# ── F3: reabrir o vault tem de fazer o guard (a) abortar — o bloco não pode
#        aplicar num banco onde o fecho foi desfeito. ──
P -q -c "GRANT pg_read_all_data TO claude_ro;"
if P -q -f "$BLOCO" >/dev/null 2>&1; then
  fbad "F3 guard do fecho" "aplicou com pg_read_all_data de volta"
else
  fok "F3 guard do fecho" "abortou + rollback"
fi
P -q -c "REVOKE pg_read_all_data FROM claude_ro;"
eq "F3 restaurado: vault fechado" "$(CRO_STATE 'SELECT count(*) FROM vault.secrets')" "42501"

# ── F4: sem o GRANT USAGE em private, as MVs somem ──
P -q -c "REVOKE USAGE ON SCHEMA private FROM claude_ro;"
V="$(CRO_STATE 'SELECT n FROM private.mv_oportunidade_badge')"
if [ "$V" = "00000" ]; then fbad "F4 revoga USAGE private" "leu mesmo assim"; else fok "F4 revoga USAGE private" "SQLSTATE=$V"; fi
P -q -f "$BLOCO" >/dev/null 2>&1
eq "F4 restaurado: MV legível" "$(CRO -c 'SELECT n FROM private.mv_oportunidade_badge' 2>/dev/null)" "12"

echo ""
echo "═══════════════════════════════════════════════════"
echo "  asserts:       $PASS ✅   $FAIL ❌"
echo "  falsificações: $FPASS ✅   $FFAIL ❌"
echo "═══════════════════════════════════════════════════"
if [ "$FAIL" -ne 0 ] || [ "$FFAIL" -ne 0 ]; then echo "REPROVADO"; exit 1; fi
echo "APROVADO"
