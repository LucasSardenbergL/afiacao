#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA PG17 — acoes_execucoes (última execução de ações globais)              ║
# ║  migration: 20260722100000_acoes_execucoes_ultima_execucao.sql                ║
# ║  Rode:  bash db/test-acoes-execucoes.sh > /tmp/t.log 2>&1; echo $?            ║
# ║                                                                                ║
# ║  Prova: staff insere/fecha SÓ a própria execução manual (alheia→42501,        ║
# ║  origem automatica→42501); customer/anon não leem nem escrevem; service_role  ║
# ║  bypassa (edges); delete sem policy → 0 linhas; status inválido → 23514.      ║
# ║  Falsifica: troca a policy de INSERT por with check(true) → alheia passa.     ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5475}"
SLUG="acoes-execucoes"
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
Pq() { P -q -tA "$@"; }

P -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -q <<'SQL'
CREATE OR REPLACE FUNCTION auth.uid()  RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.uid',  true), '')::uuid $f$;
ALTER ROLE service_role BYPASSRLS;   -- espelha prod (psql-ro: rolbypassrls=t)
SQL

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

MASTER='11111111-1111-1111-1111-111111111111'
STAFF_E='eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'
CUST_C='cccccccc-cccc-cccc-cccc-cccccccccccc'

echo "═══ setup (PG17 :$PORT) ═══"

# ── ZONA 1: pré-requisitos que a PROD já tem (enum, user_roles, has_role, users) ──
P -q <<SQL
DO \$\$ BEGIN CREATE TYPE public.app_role AS ENUM ('master','employee','customer'); EXCEPTION WHEN duplicate_object THEN NULL; END \$\$;
CREATE TABLE IF NOT EXISTS public.user_roles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, role public.app_role NOT NULL);
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS \$f\$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role)
\$f\$;
INSERT INTO auth.users (id, email) VALUES
  ('$MASTER', 'master@t'), ('$STAFF_E', 'staff@t'), ('$CUST_C', 'cust@t');
INSERT INTO public.user_roles (user_id, role) VALUES
  ('$MASTER', 'master'), ('$STAFF_E', 'employee'), ('$CUST_C', 'customer');
SQL

# ── ZONA 2: a migration REAL ──
P -q -f "$REPO_ROOT/supabase/migrations/20260722100000_acoes_execucoes_ultima_execucao.sql"

echo "═══ asserts ═══"

# A1: service_role (edge) insere automática — bypassa RLS
eq "A1 service_role insere automatica" "$(Pq <<'SQL'
SET ROLE service_role;
INSERT INTO public.acoes_execucoes (acao, origem, status)
VALUES ('teste.cron', 'automatica', 'sucesso') RETURNING 'inseriu';
SQL
)" "inseriu"

# A2: staff insere a própria execução manual
eq "A2 staff insere propria manual" "$(Pq <<SQL
SET ROLE authenticated; SELECT set_config('test.uid', '$MASTER', false) \gset _
INSERT INTO public.acoes_execucoes (acao, executado_por, executado_por_nome)
VALUES ('teste.manual', '$MASTER', 'Lucas') RETURNING 'inseriu';
SQL
)" "inseriu"

# A3: staff NÃO insere execução em nome de OUTRO → 42501
eq "A3 staff insere alheia -> 42501" "$(Pq <<SQL
SET ROLE authenticated; SELECT set_config('test.uid', '$MASTER', false) \gset _
DO \$\$ BEGIN
  INSERT INTO public.acoes_execucoes (acao, executado_por) VALUES ('teste.manual', '$STAFF_E');
  RAISE EXCEPTION 'NAO-BARROU';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'x'; END \$\$;
SELECT 'barrou-42501';
SQL
)" "barrou-42501"

# A4: staff NÃO insere origem automatica via PostgREST → 42501
eq "A4 staff origem automatica -> 42501" "$(Pq <<SQL
SET ROLE authenticated; SELECT set_config('test.uid', '$MASTER', false) \gset _
DO \$\$ BEGIN
  INSERT INTO public.acoes_execucoes (acao, executado_por, origem) VALUES ('teste.manual', '$MASTER', 'automatica');
  RAISE EXCEPTION 'NAO-BARROU';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'x'; END \$\$;
SELECT 'barrou-42501';
SQL
)" "barrou-42501"

# A5: customer NÃO insere → 42501
eq "A5 customer insere -> 42501" "$(Pq <<SQL
SET ROLE authenticated; SELECT set_config('test.uid', '$CUST_C', false) \gset _
DO \$\$ BEGIN
  INSERT INTO public.acoes_execucoes (acao, executado_por) VALUES ('teste.manual', '$CUST_C');
  RAISE EXCEPTION 'NAO-BARROU';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'x'; END \$\$;
SELECT 'barrou-42501';
SQL
)" "barrou-42501"

# A6: customer não LÊ nada (RLS filtra) → 0
eq "A6 customer select -> 0 linhas" "$(Pq <<SQL
SET ROLE authenticated; SELECT set_config('test.uid', '$CUST_C', false) \gset _
SELECT count(*) FROM public.acoes_execucoes;
SQL
)" "0"

# A7: anon sem grant → permission denied (42501)
eq "A7 anon select -> 42501" "$(Pq <<'SQL'
SET ROLE anon;
DO $$ BEGIN
  PERFORM count(*) FROM public.acoes_execucoes;
  RAISE EXCEPTION 'NAO-BARROU';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'x'; END $$;
SELECT 'barrou-42501';
SQL
)" "barrou-42501"

# A8: staff FECHA a própria execução (executando -> sucesso)
eq "A8 staff fecha propria -> 1 linha" "$(Pq <<SQL
SET ROLE authenticated; SELECT set_config('test.uid', '$MASTER', false) \gset _
WITH u AS (
  UPDATE public.acoes_execucoes
  SET status = 'sucesso', finalizado_em = now(), detalhes = '{"n": 1}'::jsonb
  WHERE acao = 'teste.manual' AND executado_por = '$MASTER' AND status = 'executando'
  RETURNING 1
) SELECT count(*) FROM u;
SQL
)" "1"

# A9: staff NÃO fecha execução alheia (do service, executado_por null) → 0 linhas
eq "A9 staff fecha alheia -> 0 linhas" "$(Pq <<SQL
SET ROLE authenticated; SELECT set_config('test.uid', '$MASTER', false) \gset _
WITH u AS (
  UPDATE public.acoes_execucoes SET status = 'erro'
  WHERE acao = 'teste.cron'
  RETURNING 1
) SELECT count(*) FROM u;
SQL
)" "0"

# A10: staff NÃO deleta — sem GRANT de delete, barra ANTES da RLS → 42501
eq "A10 staff delete -> 42501" "$(Pq <<SQL
SET ROLE authenticated; SELECT set_config('test.uid', '$MASTER', false) \gset _
DO \$\$ BEGIN
  DELETE FROM public.acoes_execucoes;
  RAISE EXCEPTION 'NAO-BARROU';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'x'; END \$\$;
SELECT 'barrou-42501';
SQL
)" "barrou-42501"

# A11: status fora do domínio → 23514 (check)
eq "A11 status invalido -> 23514" "$(Pq <<'SQL'
SET ROLE service_role;
DO $$ BEGIN
  INSERT INTO public.acoes_execucoes (acao, status) VALUES ('teste.check', 'rodando');
  RAISE EXCEPTION 'NAO-BARROU';
EXCEPTION WHEN check_violation THEN RAISE NOTICE 'x'; END $$;
SELECT 'barrou-23514';
SQL
)" "barrou-23514"

# A12: staff employee LÊ tudo (as 2 linhas inseridas)
eq "A12 staff le tudo" "$(Pq <<SQL
SET ROLE authenticated; SELECT set_config('test.uid', '$STAFF_E', false) \gset _
SELECT count(*) FROM public.acoes_execucoes;
SQL
)" "2"

echo "═══ FALSIFICAÇÃO (sabota a policy de INSERT → A3 tem que PASSAR a inserir) ═══"
P -q <<'SQL'
DROP POLICY "Staff registra execucao propria" ON public.acoes_execucoes;
CREATE POLICY "sabotada" ON public.acoes_execucoes FOR INSERT WITH CHECK (true);
SQL
eq "F1 sabotagem detectável (alheia agora INSERE)" "$(Pq <<SQL
SET ROLE authenticated; SELECT set_config('test.uid', '$MASTER', false) \gset _
INSERT INTO public.acoes_execucoes (acao, executado_por) VALUES ('teste.sabotagem', '$STAFF_E') RETURNING 'inseriu';
SQL
)" "inseriu"

echo ""
echo "═══ resultado: $PASS ✅ · $FAIL ❌ ═══"
[ "$FAIL" -eq 0 ]
