#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  HARNESS PG17 — PROVA de migration money-path/auth com FALSIFICAÇÃO            ║
# ║  fin_balanco_inputs (RLS master-only, PK company+data_ref).                    ║
# ║      bash db/test-fin-balanco-inputs.sh > /tmp/t.log 2>&1; echo "exit=$?"      ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

# ── arranque PG17 descartável (contorna keg-only do brew) ──
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5457}"     # 5457 p/ não colidir com outros harnesses em paralelo
SLUG="fin-balanco-inputs"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C          # sem isso o postmaster aborta ("became multithreaded during startup")

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

# ── base mínima do Supabase: roles, schema auth, auth.uid()/role() via GUC ──
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

echo "═══ setup pronto (PG17 :$PORT) ═══"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — PRÉ-REQUISITOS (a migração lê user_roles + o enum app_role na policy)
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
CREATE TYPE public.app_role AS ENUM ('employee','customer','master');
CREATE TABLE public.user_roles (user_id uuid NOT NULL, role public.app_role NOT NULL);
SQL

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — APLICAR A MIGRATION REAL (Lei #1: o .sql commitado)
# ══════════════════════════════════════════════════════════════════════════════
MIG="$REPO_ROOT/supabase/migrations/20260701120000_fin_balanco_inputs.sql"
P -q -f "$MIG"
echo "migration aplicada: $(basename "$MIG")"
# idempotência: 2º apply não pode dar erro (o founder pode colar 2x no SQL Editor)
if P -q -f "$MIG" >/dev/null 2>&1; then ok "A0 migration idempotente (2º apply sem erro)"; else bad "A0 2º apply falhou — não idempotente"; fi

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 3 — SEED + GRANTs
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
INSERT INTO auth.users(id) VALUES
  ('33333333-3333-3333-3333-333333333333'),  -- master
  ('22222222-2222-2222-2222-222222222222')   -- não-master (employee)
  ON CONFLICT DO NOTHING;
INSERT INTO public.user_roles(user_id, role) VALUES
  ('33333333-3333-3333-3333-333333333333','master'),
  ('22222222-2222-2222-2222-222222222222','employee');
-- master (postgres superuser semeia) — 2 datas p/ oben (PK company+data_ref permite histórico)
INSERT INTO public.fin_balanco_inputs(company, data_ref, ativo_nao_circulante, passivo_nao_circulante, patrimonio_liquido) VALUES
  ('oben','2026-03-31', 1000, 500, 2500),
  ('oben','2026-06-30', 1100, 480, 2600),
  ('colacor','2026-03-31', 800, 200, 1500);
-- migração é --no-privileges (Supabase concede em runtime) → concede p/ os asserts de RLS lerem;
-- a policy faz subselect em user_roles → concede SELECT nela também (avaliada com privilégio do caller).
GRANT SELECT, INSERT, UPDATE ON public.fin_balanco_inputs TO authenticated, anon;
GRANT SELECT ON public.user_roles TO authenticated, anon;
SQL

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4 — ASSERTS
# ══════════════════════════════════════════════════════════════════════════════
echo "── asserts ──"

# POSITIVO: seed e histórico por data (PK permite N datas/empresa)
TOT=$(Pq -c "SELECT count(*) FROM public.fin_balanco_inputs;")
eq "A1 seed 3 linhas" "$TOT" "3"
OBEN=$(Pq -c "SELECT count(*) FROM public.fin_balanco_inputs WHERE company='oben';")
eq "A2 PK permite histórico por data (oben=2)" "$OBEN" "2"

# NEGATIVO CHECK: empresa inválida → check_violation (23514)
R=$(P -tA 2>&1 <<'SQL'
DO $$ BEGIN
  INSERT INTO public.fin_balanco_inputs(company,data_ref,ativo_nao_circulante,passivo_nao_circulante,patrimonio_liquido)
  VALUES ('empresa_x','2026-03-31',1,1,1);
  RAISE EXCEPTION 'CHECK_NAO_BARROU';
EXCEPTION
  WHEN check_violation THEN RAISE NOTICE 'CHECK_MORDEU';
  WHEN OTHERS THEN RAISE;
END $$;
SQL
)
case "$R" in *CHECK_MORDEU*) ok "A3 CHECK rejeita empresa inválida (23514)" ;; *) bad "A3 CHECK — veio: $R" ;; esac

# NEGATIVO PK: duplicata (company,data_ref) → unique_violation (23505)
R=$(P -tA 2>&1 <<'SQL'
DO $$ BEGIN
  INSERT INTO public.fin_balanco_inputs(company,data_ref,ativo_nao_circulante,passivo_nao_circulante,patrimonio_liquido)
  VALUES ('oben','2026-03-31',9,9,9);
  RAISE EXCEPTION 'PK_NAO_BARROU';
EXCEPTION
  WHEN unique_violation THEN RAISE NOTICE 'PK_MORDEU';
  WHEN OTHERS THEN RAISE;
END $$;
SQL
)
case "$R" in *PK_MORDEU*) ok "A4 PK rejeita duplicata company+data_ref (23505)" ;; *) bad "A4 PK — veio: $R" ;; esac

# RLS SELECT: master vê tudo; não-master 0; anon 0
MAST=$(Pq -c "SET test.uid='33333333-3333-3333-3333-333333333333'; SET ROLE authenticated; SELECT count(*) FROM public.fin_balanco_inputs;" | tail -1)
NOTM=$(Pq -c "SET test.uid='22222222-2222-2222-2222-222222222222'; SET ROLE authenticated; SELECT count(*) FROM public.fin_balanco_inputs;" | tail -1)
ANON=$(Pq -c "SET ROLE anon; SELECT count(*) FROM public.fin_balanco_inputs;" | tail -1)
eq "A5 master vê tudo (3)"       "$MAST" "3"
eq "A6 não-master vê 0 (RLS)"    "$NOTM" "0"
eq "A7 anon vê 0 (RLS)"          "$ANON" "0"

# RLS WRITE: não-master INSERT → insufficient_privilege (42501) via WITH CHECK
R=$(P -tA 2>&1 <<'SQL'
SET test.uid='22222222-2222-2222-2222-222222222222'; SET ROLE authenticated;
DO $$ BEGIN
  INSERT INTO public.fin_balanco_inputs(company,data_ref,ativo_nao_circulante,passivo_nao_circulante,patrimonio_liquido)
  VALUES ('colacor_sc','2026-03-31',1,1,1);
  RAISE EXCEPTION 'RLS_WRITE_NAO_BARROU';
EXCEPTION
  WHEN insufficient_privilege THEN RAISE NOTICE 'RLS_WRITE_MORDEU';
  WHEN OTHERS THEN RAISE;
END $$;
SQL
)
case "$R" in *RLS_WRITE_MORDEU*) ok "A8 não-master INSERT barrado (RLS WITH CHECK, 42501)" ;; *) bad "A8 RLS write — veio: $R" ;; esac

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICAÇÃO (sabota → exige VERMELHO → restaura)
# ══════════════════════════════════════════════════════════════════════════════
echo "── falsificação ──"

# F1: sabota a policy de SELECT (USING true → todo mundo vê). A6 deve virar vermelho.
P -q <<'SQL'
DROP POLICY fin_balanco_inputs_select_master ON public.fin_balanco_inputs;
CREATE POLICY fin_balanco_inputs_select_master ON public.fin_balanco_inputs FOR SELECT USING (true);
SQL
NOTM_SAB=$(Pq -c "SET test.uid='22222222-2222-2222-2222-222222222222'; SET ROLE authenticated; SELECT count(*) FROM public.fin_balanco_inputs;" | tail -1)
if [ "$NOTM_SAB" != "0" ]; then ok "F1 policy furada (USING true) deixou não-master ver ($NOTM_SAB) → A6 tem dente"; else bad "F1 sabotei o SELECT e não-master AINDA vê 0 → A6 é fraco"; fi
# restaura a policy verdadeira
P -q <<'SQL'
DROP POLICY fin_balanco_inputs_select_master ON public.fin_balanco_inputs;
CREATE POLICY fin_balanco_inputs_select_master ON public.fin_balanco_inputs
  FOR SELECT USING ((EXISTS ( SELECT 1 FROM public.user_roles
    WHERE ((user_roles.user_id = auth.uid()) AND (user_roles.role = 'master'::public.app_role)))));
SQL
NOTM_RES=$(Pq -c "SET test.uid='22222222-2222-2222-2222-222222222222'; SET ROLE authenticated; SELECT count(*) FROM public.fin_balanco_inputs;" | tail -1)
eq "F2 restaurada: não-master vê 0 de novo" "$NOTM_RES" "0"

# F3: sabota o CHECK (dropa constraint → empresa inválida entra). A3 deve virar vermelho.
P -q -c "ALTER TABLE public.fin_balanco_inputs DROP CONSTRAINT fin_balanco_inputs_company_check;"
if P -q -c "INSERT INTO public.fin_balanco_inputs(company,data_ref,ativo_nao_circulante,passivo_nao_circulante,patrimonio_liquido) VALUES ('empresa_x','2026-01-01',1,1,1);" >/dev/null 2>&1; then
  ok "F3 sem o CHECK a empresa inválida entra → A3 tinha dente"
  P -q -c "DELETE FROM public.fin_balanco_inputs WHERE company='empresa_x';" >/dev/null 2>&1 || true
else
  bad "F3 dropei o CHECK e o INSERT inválido AINDA falhou → A3 é fraco"
fi
# restaura o CHECK
P -q -c "ALTER TABLE public.fin_balanco_inputs ADD CONSTRAINT fin_balanco_inputs_company_check CHECK ((company = ANY (ARRAY['oben'::text,'colacor'::text,'colacor_sc'::text])));"

# ── veredito ──
echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
