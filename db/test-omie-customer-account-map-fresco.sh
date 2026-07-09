#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  HARNESS PG17 — PROVA da view omie_customer_account_map_fresco (P1a staleness)  ║
# ║  View FRESCA sobre a proof-table (user_id,account)->código Omie. Money-path     ║
# ║  (identidade de cliente p/ Customer360/reposição). Rodar:                       ║
# ║      bash db/test-omie-customer-account-map-fresco.sh > /tmp/t.log 2>&1; echo $?║
# ║  Lei de Ferro: (1) migration REAL (versionada); (2) negativo c/ SQLSTATE;       ║
# ║  (3) falsificação → exige VERMELHO → restaura.                                  ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5458}"   # 5458 (o harness da tabela usa 5457) — não colide se rodarem juntos
SLUG="omie-customer-account-map-fresco"
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
# ZONA 1 — PRÉ-REQUISITOS (has_role/app_role/user_roles + auth.users — a RLS da
# tabela base, herdada pela view via security_invoker, chama has_role(auth.uid(),…))
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
CREATE TYPE public.app_role AS ENUM ('master','employee','customer');
CREATE TABLE public.user_roles (user_id uuid NOT NULL, role public.app_role NOT NULL);
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $f$
  SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role)
$f$;
SQL

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — MIGRATIONS REAIS (versionadas — vão VERBATIM pro SQL Editor)
#   1) a tabela base (db/omie_customer_account_map.sql)
#   2) a view fresca sob teste (db/omie_customer_account_map_fresco.sql)
# ══════════════════════════════════════════════════════════════════════════════
P -q -f "$REPO_ROOT/db/omie_customer_account_map.sql"
P -q -f "$REPO_ROOT/db/omie_customer_account_map_fresco.sql"
echo "migrations aplicadas: tabela + view fresca"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 3 — SEED (frescor controlado via updated_at explícito)
#   user1=customer multi-conta (1 FRESCA oben + 1 VELHA colacor) · user2=customer (FRESCA)
#   user3=master · user4=employee
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
INSERT INTO auth.users(id) VALUES
  ('11111111-1111-1111-1111-111111111111'),
  ('22222222-2222-2222-2222-222222222222'),
  ('33333333-3333-3333-3333-333333333333'),
  ('44444444-4444-4444-4444-444444444444') ON CONFLICT DO NOTHING;
INSERT INTO public.user_roles(user_id, role) VALUES
  ('33333333-3333-3333-3333-333333333333','master'),
  ('44444444-4444-4444-4444-444444444444','employee') ON CONFLICT DO NOTHING;
-- código 100 (oben) FRESCA; código 200 (colacor) VELHA (>7d); código 300 (oben, user2) FRESCA.
INSERT INTO public.omie_customer_account_map(user_id, account, omie_codigo_cliente, updated_at) VALUES
  ('11111111-1111-1111-1111-111111111111','oben',    100, now()),
  ('11111111-1111-1111-1111-111111111111','colacor', 200, now() - interval '10 days'),
  ('22222222-2222-2222-2222-222222222222','oben',    300, now());
GRANT SELECT ON public.omie_customer_account_map TO authenticated, anon;
SQL

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4 — ASSERTS
# ══════════════════════════════════════════════════════════════════════════════
echo "── asserts positivos: a VIEW filtra por frescor (rodados como superuser, sem RLS) ──"
V=$(Pq -c "SELECT count(*) FROM public.omie_customer_account_map_fresco WHERE omie_codigo_cliente=100;")
eq "V1 fresca (código 100, updated_at=now) APARECE na view" "$V" "1"
V=$(Pq -c "SELECT count(*) FROM public.omie_customer_account_map_fresco WHERE omie_codigo_cliente=200;")
eq "V2 velha (código 200, updated_at=now-10d) NÃO aparece na view" "$V" "0"
V=$(Pq -c "SELECT count(*) FROM public.omie_customer_account_map WHERE omie_codigo_cliente=200;")
eq "V3 a velha EXISTE na tabela base (é a VIEW que filtra, não a ausência)" "$V" "1"
V=$(Pq -c "SELECT count(*) FROM public.omie_customer_account_map_fresco;")
eq "V3b view = só as 2 frescas de 3 linhas totais" "$V" "2"

echo "── asserts RLS herdada via security_invoker (SET ROLE authenticated + GUC auth.uid) ──"
OWN=$(Pq -c "SET test.uid='11111111-1111-1111-1111-111111111111'; SET ROLE authenticated; SELECT count(*) FROM public.omie_customer_account_map_fresco;" | tail -1)
STAFF=$(Pq -c "SET test.uid='33333333-3333-3333-3333-333333333333'; SET ROLE authenticated; SELECT count(*) FROM public.omie_customer_account_map_fresco;" | tail -1)
EMP=$(Pq -c "SET test.uid='44444444-4444-4444-4444-444444444444'; SET ROLE authenticated; SELECT count(*) FROM public.omie_customer_account_map_fresco;" | tail -1)
ANON=$(Pq -c "SET ROLE anon; SELECT count(*) FROM public.omie_customer_account_map_fresco;" | tail -1)
eq "V4 own-scope+frescor: user1 vê só a PRÓPRIA FRESCA (1 de suas 2 linhas)" "$OWN" "1"
eq "V5 staff master vê todas as frescas"    "$STAFF" "2"
eq "V6 staff employee vê todas as frescas"  "$EMP"   "2"
eq "V7 anon não vê nada (RLS herdada nega)" "$ANON"  "0"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICAÇÃO (sabota → exige VERMELHO → restaura)
# ══════════════════════════════════════════════════════════════════════════════
echo "── falsificação ──"
# F1: view SEM o filtro de frescor → a velha (código 200) passa a aparecer → V2 tinha dente
P -q <<'SQL'
CREATE OR REPLACE VIEW public.omie_customer_account_map_fresco
WITH (security_invoker = true) AS
SELECT id, user_id, account, omie_codigo_cliente, omie_codigo_vendedor, source, created_at, updated_at
FROM public.omie_customer_account_map;
SQL
V=$(Pq -c "SELECT count(*) FROM public.omie_customer_account_map_fresco WHERE omie_codigo_cliente=200;")
if [ "$V" = "1" ]; then ok "F1 sem WHERE updated_at a velha aparece (=1) → V2 tinha dente"; else bad "F1 sabotei o filtro e a velha ainda não aparece (=$V) → V2 fraco"; fi

# F2: view com security_invoker=FALSE → roda como owner (postgres/superuser, BYPASSRLS) → user1 vê TODAS
#     as frescas (2), não só a própria (1) → V4 tinha dente (o security_invoker é o que segura a RLS).
P -q <<'SQL'
CREATE OR REPLACE VIEW public.omie_customer_account_map_fresco
WITH (security_invoker = false) AS
SELECT id, user_id, account, omie_codigo_cliente, omie_codigo_vendedor, source, created_at, updated_at
FROM public.omie_customer_account_map
WHERE updated_at >= now() - interval '7 days';
GRANT SELECT ON public.omie_customer_account_map_fresco TO authenticated, anon;
SQL
OWN_SAB=$(Pq -c "SET test.uid='11111111-1111-1111-1111-111111111111'; SET ROLE authenticated; SELECT count(*) FROM public.omie_customer_account_map_fresco;" | tail -1)
if [ "$OWN_SAB" = "2" ]; then ok "F2 security_invoker=false: user1 vê 2 (RLS bypassada) → V4 tinha dente"; else bad "F2 sabotei security_invoker e user1 vê $OWN_SAB (≠2) → V4 fraco"; fi

# restaura a view VERDADEIRA (versionada)
P -q -f "$REPO_ROOT/db/omie_customer_account_map_fresco.sql"
REST=$(Pq -c "SET test.uid='11111111-1111-1111-1111-111111111111'; SET ROLE authenticated; SELECT count(*) FROM public.omie_customer_account_map_fresco;" | tail -1)
eq "F3 restaurada: user1 volta a ver só a própria fresca (1)" "$REST" "1"

echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
