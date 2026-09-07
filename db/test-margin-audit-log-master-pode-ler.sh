#!/usr/bin/env bash
# HARNESS PG17 — prova de 20260830122701_margin_audit_log_master_pode_ler.sql, com falsificação.
#   bash db/test-margin-audit-log-master-pode-ler.sh > /tmp/t.log 2>&1; echo "exit=$?"
# Lei de Ferro: (1) aplica a migration REAL; (2) assert negativo ancorado; (3) sabota → VERMELHO → restaura.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGBIN="/opt/homebrew/opt/postgresql@17/bin"
PORT="${PGPORT_TEST:-5479}"
SLUG="margin-audit-master"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C
MIG="$REPO_ROOT/supabase/migrations/20260830122701_margin_audit_log_master_pode_ler.sql"

[ -x "$PGBIN/initdb" ] || { echo "postgresql@17 ausente"; exit 1; }
[ -f "$MIG" ] || { echo "migration ausente: $MIG"; exit 1; }

CELLAR="$(brew --prefix postgresql@17)"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@17/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@17"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@17/" 2>/dev/null || true

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "/tmp/pg-${SLUG}.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
P()  { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }

P -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -q <<'SQL'
CREATE OR REPLACE FUNCTION auth.uid()  RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.uid',true),'')::uuid $f$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $f$ SELECT coalesce(nullif(current_setting('test.role',true),''),'authenticated') $f$;
ALTER ROLE service_role BYPASSRLS;
SQL

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  OK  $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 - esperado [$3], veio [$2]"; fi; }

# ── esquema mínimo fiel à prod ─────────────────────────────────────────────
P -q <<'SQL'
CREATE SCHEMA IF NOT EXISTS private;
DO $$ BEGIN CREATE TYPE public.app_role AS ENUM ('employee','customer','master'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE TYPE public.commercial_role AS ENUM ('operacional','gerencial','estrategico','super_admin','farmer','hunter','closer','master');

CREATE TABLE public.user_roles (user_id uuid NOT NULL, role public.app_role NOT NULL, PRIMARY KEY (user_id, role));
CREATE TABLE public.commercial_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE,
  commercial_role public.commercial_role NOT NULL DEFAULT 'operacional');

-- SECDEF: bypassam RLS, como em prod
CREATE FUNCTION public.has_role(_user_id uuid, _role public.app_role) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
  AS $f$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id=_user_id AND role=_role) $f$;
CREATE FUNCTION private.is_super_admin(_user_id uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
  AS $f$ SELECT EXISTS (SELECT 1 FROM public.commercial_roles WHERE user_id=_user_id AND commercial_role='super_admin') $f$;

CREATE TABLE public.margin_audit_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  margin_real numeric, created_at timestamptz NOT NULL DEFAULT now());
ALTER TABLE public.margin_audit_log ENABLE ROW LEVEL SECURITY;

-- FIDELIDADE: a subquery da policy le commercial_roles SOB RLS (nao e SECDEF).
-- Sem esta policy o ramo 'estrategico' seria falso-negativo por RLS, nao por autorizacao.
ALTER TABLE public.commercial_roles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Staff can view own commercial role" ON public.commercial_roles FOR SELECT TO authenticated USING (auth.uid() = user_id);

-- estado ANTES da migration = a policy medida em prod (sem ramo de master)
CREATE POLICY "Strategic+ can view margin audit" ON public.margin_audit_log
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (private.is_super_admin(auth.uid())
      OR ((SELECT cr.commercial_role FROM public.commercial_roles cr WHERE cr.user_id = auth.uid()) = 'estrategico'::public.commercial_role));
CREATE POLICY "System can insert margin audit" ON public.margin_audit_log
  AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK (public.has_role(auth.uid(),'master'::public.app_role) OR public.has_role(auth.uid(),'employee'::public.app_role));

GRANT USAGE ON SCHEMA public, private TO authenticated;
GRANT SELECT ON public.margin_audit_log, public.commercial_roles TO authenticated;
GRANT EXECUTE ON FUNCTION private.is_super_admin(uuid), public.has_role(uuid, public.app_role) TO authenticated;
SQL

UM='11111111-1111-1111-1111-111111111111'   # master   (user_roles master + commercial_roles master) = o founder
UF='22222222-2222-2222-2222-222222222222'   # farmer   (employee + farmer)
UE='33333333-3333-3333-3333-333333333333'   # estrategico (employee + estrategico) - vocabulario legado
US='44444444-4444-4444-4444-444444444444'   # super_admin (employee + super_admin) - vocabulario legado
UX='55555555-5555-5555-5555-555555555555'   # employee sem commercial_role nenhum

P -q <<SQL
INSERT INTO public.user_roles(user_id,role) VALUES
 ('$UM','master'),('$UF','employee'),('$UE','employee'),('$US','employee'),('$UX','employee');
INSERT INTO public.commercial_roles(user_id,commercial_role) VALUES
 ('$UM','master'),('$UF','farmer'),('$UE','estrategico'),('$US','super_admin');
INSERT INTO public.margin_audit_log(margin_real) SELECT g FROM generate_series(1,7) g;
SQL

# le como <uid> sob RLS, contando linhas visiveis
le() { Pq -c "SET ROLE authenticated; SELECT set_config('test.uid','$1',false); SELECT count(*) FROM public.margin_audit_log;" | tail -1; }
roles_da_policy() { Pq -c "SELECT coalesce((SELECT string_agg(rolname,',' ORDER BY rolname) FROM pg_roles WHERE oid=ANY(pol.polroles)),'PUBLIC') FROM pg_policy pol JOIN pg_class c ON c.oid=pol.polrelid WHERE c.relname='margin_audit_log' AND pol.polcmd='r';"; }

echo "-- ZONA 1: o BUG antes da migration --"
eq "A0 master NAO le (o defeito: 7 linhas invisiveis)" "$(le $UM)" "0"
eq "A0b estrategico ja lia" "$(le $UE)" "7"
eq "A0c super_admin ja lia" "$(le $US)" "7"

echo "-- ZONA 2: aplica a migration REAL --"
P -q -f "$MIG" >/dev/null
eq "A1 master PASSA A LER" "$(le $UM)" "7"
eq "A2 estrategico continua lendo (ramo legado preservado)" "$(le $UE)" "7"
eq "A3 super_admin continua lendo (ramo legado preservado)" "$(le $US)" "7"
eq "A4 farmer NAO le (a migration nao concede a ninguem novo)" "$(le $UF)" "0"
eq "A5 employee sem papel comercial NAO le" "$(le $UX)" "0"
eq "A6 policy segue TO authenticated (DROP+CREATE nao a abriu p/ PUBLIC)" "$(roles_da_policy)" "authenticated"
eq "A7 policy segue PERMISSIVE/SELECT" \
   "$(Pq -c "SELECT polpermissive::text||'/'||polcmd::text FROM pg_policy pol JOIN pg_class c ON c.oid=pol.polrelid WHERE c.relname='margin_audit_log' AND pol.polcmd='r';")" "true/r"

echo "-- ZONA 3: idempotencia (o founder pode re-colar) --"
P -q -f "$MIG" >/dev/null
eq "A8 re-aplicar nao quebra e master segue lendo" "$(le $UM)" "7"
eq "A9 continua existindo UMA unica policy de SELECT" \
   "$(Pq -c "SELECT count(*) FROM pg_policy pol JOIN pg_class c ON c.oid=pol.polrelid WHERE c.relname='margin_audit_log' AND pol.polcmd='r';")" "1"

echo "-- ZONA 4: FALSIFICACAO (sabota -> exige VERMELHO -> restaura) --"
falsificou() { if [ "$1" = "$2" ]; then bad "F$3 sabotagem NAO foi pega - o assert e teatro"; else ok "F$3 $4"; fi; }

# F1 - devolve a policy de ORIGEM (sem o ramo de master). A1 tem de mudar de valor.
P -q <<'SQL'
DROP POLICY "Strategic+ can view margin audit" ON public.margin_audit_log;
CREATE POLICY "Strategic+ can view margin audit" ON public.margin_audit_log
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (private.is_super_admin(auth.uid())
      OR ((SELECT cr.commercial_role FROM public.commercial_roles cr WHERE cr.user_id = auth.uid()) = 'estrategico'::public.commercial_role));
SQL
falsificou "$(le $UM)" "7" 1 "policy de origem de volta faz o master parar de ler"
P -q -f "$MIG" >/dev/null
eq "F1b restaurado: master volta a ler" "$(le $UM)" "7"

# F2 - o jeito ERRADO de recriar policy: sem TO authenticated. O comportamento do master NAO muda
# (controle inocuo), e o que quebra e o conjunto de roles - por isso A6 existe separado de A1.
P -q <<'SQL'
DROP POLICY "Strategic+ can view margin audit" ON public.margin_audit_log;
CREATE POLICY "Strategic+ can view margin audit" ON public.margin_audit_log
  AS PERMISSIVE FOR SELECT
  USING (public.has_role(auth.uid(),'master'::public.app_role)
      OR private.is_super_admin(auth.uid())
      OR ((SELECT cr.commercial_role FROM public.commercial_roles cr WHERE cr.user_id = auth.uid()) = 'estrategico'::public.commercial_role));
SQL
eq "F2a controle: o COMPORTAMENTO do master nao muda com a omissao de TO" "$(le $UM)" "7"
falsificou "$(roles_da_policy)" "authenticated" 2 "omitir TO authenticated abre a policy para PUBLIC"
P -q -f "$MIG" >/dev/null
eq "F2b restaurado: policy volta a TO authenticated" "$(roles_da_policy)" "authenticated"

# F3 - sentinela anti-teatro: sabotagem INOCUA nao pode ficar vermelha.
P -q -c "COMMENT ON POLICY \"Strategic+ can view margin audit\" ON public.margin_audit_log IS 'inocuo';"
eq "F3 controle inocuo (COMMENT) mantem tudo verde" "$(le $UM)" "7"

echo "------------------------------"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "HARNESS VERMELHO"; exit 1; }
echo "HARNESS VERDE"
