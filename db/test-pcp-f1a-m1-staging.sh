#!/usr/bin/env bash
# Prova PG17 — pcp F1A M1: staging da malha (RLS fail-closed).
# Rodar: bash db/test-pcp-f1a-m1-staging.sh > /tmp/t-m1.log 2>&1; echo "exit=$?"  (NÃO pipe pra tail)
# Lei de Ferro: aplica o SQL REAL; asserts; FALSIFICA (desliga RLS → não-staff passa a ver → prova que o bloqueio era do RLS).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5471}"
SLUG="pcp-f1a-m1"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C
MIG="$REPO_ROOT/db/pcp-f1a-m1-staging.sql"

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente"; exit 1; }
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
Pq() { P -tA -q "$@"; }

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

echo "═══ ZONA 1: pré-requisitos (estado de PROD: roles, auth, app_role, has_role VERBATIM) ═══"
P -q <<'SQL'
DO $$ BEGIN CREATE ROLE anon;          EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE service_role;  EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
CREATE TYPE public.app_role AS ENUM ('employee','customer','master');
CREATE TABLE public.user_roles (user_id uuid NOT NULL, role public.app_role NOT NULL);
-- has_role VERBATIM de prod (STABLE SECURITY DEFINER)
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $$;
GRANT EXECUTE ON FUNCTION public.has_role(uuid, app_role) TO authenticated, anon;
GRANT USAGE ON SCHEMA public TO anon, authenticated;
SQL

echo "═══ ZONA 2: aplica o SQL REAL do M1 ═══"
P -q -f "$MIG"

echo "═══ ZONA 3: fixtures (1 run + 1 staging; 1 user staff + 1 não-staff) ═══"
P -q <<'SQL'
INSERT INTO public.pcp_run_logs (funcao, status) VALUES ('omie-malha-sync','ok');
INSERT INTO public.pcp_malha_staging (omie_codigo_produto, payload, sync_run_id)
VALUES (4396000531, '{"ident":{"idProduto":4396000531}}'::jsonb, 1);
INSERT INTO public.user_roles VALUES ('00000000-0000-0000-0000-00000000aaaa','employee');
-- usuário bbbb existe mas NÃO tem role (fail-closed deve dar 0 linhas)
SQL

echo "═══ ZONA 4: asserts ═══"
eq "RLS ligado em pcp_malha_staging" "$(Pq -c "SELECT relrowsecurity FROM pg_class WHERE oid='public.pcp_malha_staging'::regclass")" "t"
eq "RLS ligado em pcp_run_logs"      "$(Pq -c "SELECT relrowsecurity FROM pg_class WHERE oid='public.pcp_run_logs'::regclass")" "t"
eq "anon SEM grant de SELECT" "$(Pq -c "SELECT has_table_privilege('anon','public.pcp_malha_staging','SELECT')")" "f"
eq "staff (employee) vê staging" "$(Pq -c "SET ROLE authenticated; SET request.jwt.claim.sub='00000000-0000-0000-0000-00000000aaaa'; SELECT count(*) FROM public.pcp_malha_staging")" "1"
eq "não-staff vê 0 (fail-closed)" "$(Pq -c "SET ROLE authenticated; SET request.jwt.claim.sub='00000000-0000-0000-0000-00000000bbbb'; SELECT count(*) FROM public.pcp_malha_staging")" "0"
INS_ERR=$(P -tA -c "SET ROLE authenticated; SET request.jwt.claim.sub='00000000-0000-0000-0000-00000000aaaa'; INSERT INTO public.pcp_malha_staging (omie_codigo_produto, payload) VALUES (1,'{}');" 2>&1 || true)
case "$INS_ERR" in *"permission denied"*|*"row-level security"*) ok "INSERT de authenticated bloqueado";; *) bad "INSERT de authenticated NÃO bloqueado: $INS_ERR";; esac

echo "═══ ZONA 5: FALSIFICAÇÃO (desliga RLS → não-staff PASSA a ver → prova que o teste detecta) ═══"
P -q -c "ALTER TABLE public.pcp_malha_staging DISABLE ROW LEVEL SECURITY;"
eq "FALSIFICAÇÃO: sem RLS, não-staff vê 1 (o bloqueio ERA do RLS)" "$(Pq -c "SET ROLE authenticated; SET request.jwt.claim.sub='00000000-0000-0000-0000-00000000bbbb'; SELECT count(*) FROM public.pcp_malha_staging")" "1"
P -q -c "ALTER TABLE public.pcp_malha_staging ENABLE ROW LEVEL SECURITY;"

echo ""
echo "RESULTADO: PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
