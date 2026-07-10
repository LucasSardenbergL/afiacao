#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  HARNESS PG17 — PROVA da migration Fatia 3 (opção C): omie_customer_account_map ║
# ║  Tabela nova ADITIVA (user_id, account) -> código Omie. Money-path (identidade  ║
# ║  de cliente p/ segments/preferred). Rodar:                                      ║
# ║      bash db/test-omie-customer-account-map.sh > /tmp/t.log 2>&1; echo "exit=$?"║
# ║  Lei de Ferro: (1) migration REAL; (2) negativo c/ SQLSTATE+re-raise;           ║
# ║  (3) falsificação → exige VERMELHO → restaura.                                  ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5457}"
SLUG="omie-customer-account-map"
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
# ZONA 1 — PRÉ-REQUISITOS (a migration lê has_role/app_role/user_roles + auth.users)
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
CREATE TYPE public.app_role AS ENUM ('master','employee','customer');
CREATE TABLE public.user_roles (user_id uuid NOT NULL, role public.app_role NOT NULL);
-- has_role fiel (SECURITY DEFINER como no repo): a RLS da migration chama has_role(auth.uid(), '...').
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $f$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role)
$f$;
SQL

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — MIGRATION REAL (o .sql que vai VERBATIM pro SQL Editor; não vive em
# supabase/migrations/ — proibido tocar, snapshot é DR)
# ══════════════════════════════════════════════════════════════════════════════
P -q -f "$REPO_ROOT/db/omie_customer_account_map.sql"
echo "migration aplicada: db/omie_customer_account_map.sql"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 3 — SEED + GRANT
# ══════════════════════════════════════════════════════════════════════════════
# user1=customer multi-conta · user2=customer · user3=master · user4=employee
P -q <<'SQL'
INSERT INTO auth.users(id) VALUES
  ('11111111-1111-1111-1111-111111111111'),
  ('22222222-2222-2222-2222-222222222222'),
  ('33333333-3333-3333-3333-333333333333'),
  ('44444444-4444-4444-4444-444444444444') ON CONFLICT DO NOTHING;
INSERT INTO public.user_roles(user_id, role) VALUES
  ('33333333-3333-3333-3333-333333333333','master'),
  ('44444444-4444-4444-4444-444444444444','employee') ON CONFLICT DO NOTHING;
INSERT INTO public.omie_customer_account_map(user_id, account, omie_codigo_cliente) VALUES
  ('11111111-1111-1111-1111-111111111111','oben',    100),
  ('11111111-1111-1111-1111-111111111111','colacor', 200),
  ('22222222-2222-2222-2222-222222222222','oben',    300);
-- migration é --no-privileges (Supabase concede em runtime) → conceder p/ os asserts de RLS lerem.
-- has_role é SECURITY DEFINER, então não precisa GRANT em user_roles p/ a policy.
GRANT SELECT ON public.omie_customer_account_map TO authenticated, anon;
SQL

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4 — ASSERTS
# ══════════════════════════════════════════════════════════════════════════════
echo "── asserts positivos ──"
V=$(Pq -c "SELECT count(*) FROM public.omie_customer_account_map WHERE user_id='11111111-1111-1111-1111-111111111111';")
eq "A1 multi-conta: user1 tem 2 linhas (oben+colacor)" "$V" "2"

# mesmo código (300) em contas DIFERENTES é permitido (namespaces Omie independentes)
Pq -c "INSERT INTO public.omie_customer_account_map(user_id,account,omie_codigo_cliente) VALUES ('22222222-2222-2222-2222-222222222222','colacor',300);" >/dev/null
V=$(Pq -c "SELECT count(*) FROM public.omie_customer_account_map WHERE omie_codigo_cliente=300;")
eq "A2 código 300 coexiste em oben+colacor (namespaces independentes)" "$V" "2"

echo "── asserts negativos (SQLSTATE + re-raise; sentinela própria) ──"
R=$(P -tA 2>&1 <<'SQL'
DO $$ BEGIN
  INSERT INTO public.omie_customer_account_map(user_id,account,omie_codigo_cliente) VALUES ('11111111-1111-1111-1111-111111111111','oben',999);
  RAISE NOTICE 'NAO_BARROU';
EXCEPTION WHEN unique_violation THEN RAISE NOTICE 'UQ_USER_OK'; WHEN OTHERS THEN RAISE; END $$;
SQL
); case "$R" in *UQ_USER_OK*) ok "A3 UNIQUE(user,account) barra 2ª linha na MESMA conta" ;; *NAO_BARROU*) bad "A3 NÃO barrou" ;; *) bad "A3 inesperado: $R" ;; esac

R=$(P -tA 2>&1 <<'SQL'
DO $$ BEGIN
  INSERT INTO public.omie_customer_account_map(user_id,account,omie_codigo_cliente) VALUES ('33333333-3333-3333-3333-333333333333','oben',100);
  RAISE NOTICE 'NAO_BARROU';
EXCEPTION WHEN unique_violation THEN RAISE NOTICE 'UQ_COD_OK'; WHEN OTHERS THEN RAISE; END $$;
SQL
); case "$R" in *UQ_COD_OK*) ok "A4 UNIQUE(codigo,account): 1 dono por código/conta (anti-colisão)" ;; *NAO_BARROU*) bad "A4 NÃO barrou" ;; *) bad "A4 inesperado: $R" ;; esac

R=$(P -tA 2>&1 <<'SQL'
DO $$ BEGIN
  INSERT INTO public.omie_customer_account_map(user_id,account,omie_codigo_cliente) VALUES ('33333333-3333-3333-3333-333333333333','conta_x',1);
  RAISE NOTICE 'NAO_BARROU';
EXCEPTION WHEN check_violation THEN RAISE NOTICE 'CHK_ACC_OK'; WHEN OTHERS THEN RAISE; END $$;
SQL
); case "$R" in *CHK_ACC_OK*) ok "A5 CHECK account rejeita fora de {oben,colacor,colacor_sc}" ;; *NAO_BARROU*) bad "A5 NÃO barrou" ;; *) bad "A5 inesperado: $R" ;; esac

R=$(P -tA 2>&1 <<'SQL'
DO $$ BEGIN
  INSERT INTO public.omie_customer_account_map(user_id,account,omie_codigo_cliente,source) VALUES ('33333333-3333-3333-3333-333333333333','oben',7,'xpto');
  RAISE NOTICE 'NAO_BARROU';
EXCEPTION WHEN check_violation THEN RAISE NOTICE 'CHK_SRC_OK'; WHEN OTHERS THEN RAISE; END $$;
SQL
); case "$R" in *CHK_SRC_OK*) ok "A6 CHECK source rejeita valor inválido" ;; *NAO_BARROU*) bad "A6 NÃO barrou" ;; *) bad "A6 inesperado: $R" ;; esac

echo "── asserts RLS (SET ROLE + GUC auth.uid; estado após A2: total=4, user1=2, user2=2) ──"
OWN=$(Pq -c "SET test.uid='11111111-1111-1111-1111-111111111111'; SET ROLE authenticated; SELECT count(*) FROM public.omie_customer_account_map;" | tail -1)
STAFF=$(Pq -c "SET test.uid='33333333-3333-3333-3333-333333333333'; SET ROLE authenticated; SELECT count(*) FROM public.omie_customer_account_map;" | tail -1)
EMP=$(Pq -c "SET test.uid='44444444-4444-4444-4444-444444444444'; SET ROLE authenticated; SELECT count(*) FROM public.omie_customer_account_map;" | tail -1)
ANON=$(Pq -c "SET ROLE anon; SELECT count(*) FROM public.omie_customer_account_map;" | tail -1)
eq "A7 own-scope: user1 (customer) vê só as próprias" "$OWN" "2"
eq "A8 staff master vê tudo"    "$STAFF" "4"
eq "A9 staff employee vê tudo"  "$EMP"   "4"
eq "A10 anon não vê nada"       "$ANON"  "0"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICAÇÃO (sabota → exige VERMELHO → restaura)
# ══════════════════════════════════════════════════════════════════════════════
echo "── falsificação ──"
# F1: RLS own-scope furada (USING true) → user1 passaria a ver tudo (3 agora, pós-CASCADE de user2)
TOTAL=$(Pq -c "SELECT count(*) FROM public.omie_customer_account_map;")
P -q <<'SQL'
DROP POLICY "Users can view their own account map" ON public.omie_customer_account_map;
CREATE POLICY "Users can view their own account map" ON public.omie_customer_account_map FOR SELECT TO authenticated USING (true);
SQL
OWN_SAB=$(Pq -c "SET test.uid='11111111-1111-1111-1111-111111111111'; SET ROLE authenticated; SELECT count(*) FROM public.omie_customer_account_map;" | tail -1)
if [ "$OWN_SAB" = "$TOTAL" ] && [ "$OWN_SAB" != "2" ]; then ok "F1 own-scope furado: user1 vê $OWN_SAB (=total) → A7 tem dente"; else bad "F1 sabotei own-scope e user1 vê $OWN_SAB → A7 fraco"; fi
P -q <<'SQL'
DROP POLICY "Users can view their own account map" ON public.omie_customer_account_map;
CREATE POLICY "Users can view their own account map" ON public.omie_customer_account_map FOR SELECT TO authenticated USING (auth.uid() = user_id);
SQL

# F2: sem UNIQUE(codigo,account) o insert-dup (código 100 em oben p/ outro user) passa
P -q -c "ALTER TABLE public.omie_customer_account_map DROP CONSTRAINT uq_ocam_codigo_account;"
if P -q -c "INSERT INTO public.omie_customer_account_map(user_id,account,omie_codigo_cliente) VALUES ('33333333-3333-3333-3333-333333333333','oben',100);" >/dev/null 2>&1; then
  ok "F2 sem UNIQUE(codigo,account) o dup passa → A4 tinha dente"
else bad "F2 droppei o UNIQUE e o insert AINDA falhou → A4 não provava a constraint"; fi
P -q -c "DELETE FROM public.omie_customer_account_map WHERE user_id='33333333-3333-3333-3333-333333333333' AND account='oben' AND omie_codigo_cliente=100;" >/dev/null 2>&1 || true
P -q -c "ALTER TABLE public.omie_customer_account_map ADD CONSTRAINT uq_ocam_codigo_account UNIQUE (omie_codigo_cliente, account);"

# F3: sem CHECK account o insert com conta inválida passa
P -q -c "ALTER TABLE public.omie_customer_account_map DROP CONSTRAINT chk_ocam_account;"
if P -q -c "INSERT INTO public.omie_customer_account_map(user_id,account,omie_codigo_cliente) VALUES ('33333333-3333-3333-3333-333333333333','conta_x',5);" >/dev/null 2>&1; then
  ok "F3 sem CHECK account o valor inválido passa → A5 tinha dente"
else bad "F3 droppei o CHECK e o insert AINDA falhou → A5 não provava o CHECK"; fi
P -q -c "DELETE FROM public.omie_customer_account_map WHERE account='conta_x';" >/dev/null 2>&1 || true
P -q -c "ALTER TABLE public.omie_customer_account_map ADD CONSTRAINT chk_ocam_account CHECK (account IN ('oben','colacor','colacor_sc'));"

echo "── CASCADE (por último: deleta user2, não interfere na F1 acima) ──"
Pq -c "DELETE FROM auth.users WHERE id='22222222-2222-2222-2222-222222222222';" >/dev/null
V=$(Pq -c "SELECT count(*) FROM public.omie_customer_account_map WHERE user_id='22222222-2222-2222-2222-222222222222';")
eq "A11 ON DELETE CASCADE: apagar user zera o mapa dele" "$V" "0"

echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
