#!/usr/bin/env bash
# Prova PG17 — fn_pcp_parse_dimensoes: golden set com descrições REAIS de prod.
# Rodar: bash db/test-pcp-parser-dimensoes.sh > /tmp/t-parser.log 2>&1; echo "exit=$?"
# Lei de Ferro: aplica M1+M2 REAIS; golden asserts; FALSIFICA (sabota a regex → golden TEM que quebrar).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5472}"
SLUG="pcp-parser"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C

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
Pq() { P -tA -q "$@"; }  # -q OBRIGATÓRIO: sem ele, "SET ...; SELECT ..." vaza linhas SET na captura

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

echo "═══ ZONA 1: pré-requisitos + stub de omie_products (view do M2 referencia) ═══"
P -q <<'SQL'
DO $$ BEGIN CREATE ROLE anon;          EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE authenticated; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE ROLE service_role;  EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
CREATE TYPE public.app_role AS ENUM ('employee','customer','master');
CREATE TABLE public.user_roles (user_id uuid NOT NULL, role public.app_role NOT NULL);
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $$;
GRANT USAGE ON SCHEMA public TO anon, authenticated;
CREATE TABLE public.omie_products (omie_codigo_produto bigint PRIMARY KEY, codigo text, descricao text,
  familia text, tipo_produto text, account text, metadata jsonb NOT NULL DEFAULT '{}');
SQL

echo "═══ ZONA 2: aplica M1 + M2 REAIS (ordem/dependência provadas) ═══"
P -q -f "$REPO_ROOT/db/pcp-f1a-m1-staging.sql"
P -q -f "$REPO_ROOT/db/pcp-f1a-m2-nucleo.sql"

echo "═══ ZONA 3: golden set (descrições REAIS; formato largura|comprimento|grao|diametro|formato) ═══"
gold() { # $1 descricao  $2 esperado
  local got
  got=$(Pq -c "SELECT coalesce(largura_mm::text,'-')||'|'||coalesce(comprimento_mm::text,'-')||'|'||coalesce(grao::text,'-')||'|'||coalesce(diametro_mm::text,'-')||'|'||formato FROM fn_pcp_parse_dimensoes(\$\$$1\$\$)")
  eq "parse: $1" "$got" "$2"
}
gold "CINTA KA169 150X6200MM P50"            "150|6200|50|-|dimensional"
gold "CINTA 2909 75X533MM P220"              "75|533|220|-|dimensional"
gold "CINTA XZ667 75X1000MM P50"             "75|1000|50|-|dimensional"
gold "JUMBO AC768 1410X100000MM P1500"       "1410|100000|1500|-|dimensional"
gold "ROLO 2909 600X2300MM P60"              "600|2300|60|-|dimensional"
gold "DISCO DE LIXA 1944 180MM P80"          "-|-|80|180|disco"
gold "DISCO DE LIXA CTN 152MM C/F P320"      "-|-|320|152|disco"
gold "TINGIDOR MEL ESCURO TEH 3505.162FG"    "-|-|-|-|sem_match"
gold "RL SAITAC 5G GR 320 - 1600 X 050M"     "-|-|-|-|sem_match"
gold "BLOCO DE LIXA 2988 RODA150X50X46 P100" "-|-|100|-|sem_match"
gold "DISCO DIAMANTADO CLASSIC TURBO 110X20MM" "-|-|-|-|sem_match"
gold "cinta ka169 150x6200mm p50"             "150|6200|50|-|dimensional"
eq "parse: NULL não explode" "$(Pq -c "SELECT formato FROM fn_pcp_parse_dimensoes(NULL)")" "sem_match"

echo "═══ ZONA 4: FALSIFICAÇÃO (regex sabotada ⇒ golden TEM que divergir) ═══"
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.fn_pcp_parse_dimensoes(p_descricao text)
RETURNS TABLE (largura_mm int, comprimento_mm int, grao int, diametro_mm int, formato text)
LANGUAGE sql IMMUTABLE AS $f$
WITH d AS (SELECT upper(coalesce(p_descricao,'')) AS s),
dims AS (SELECT regexp_match((SELECT s FROM d), '\m(\d{2,4})Y(\d{3,6})MM\M') AS m),  -- SABOTADO: X→Y
gr   AS (SELECT regexp_match((SELECT s FROM d), '\mP(\d{2,4})\M') AS m),
diam AS (SELECT regexp_match((SELECT s FROM d), '\m(\d{2,3})MM\M') AS m)
SELECT (SELECT m[1]::int FROM dims), (SELECT m[2]::int FROM dims), (SELECT m[1]::int FROM gr),
  CASE WHEN (SELECT m FROM dims) IS NULL AND (SELECT s FROM d) ~ '^(DISCO|BLOCO)' THEN (SELECT m[1]::int FROM diam) END,
  CASE WHEN (SELECT m FROM dims) IS NOT NULL THEN 'dimensional'
       WHEN (SELECT s FROM d) ~ '^(DISCO|BLOCO)' AND (SELECT m FROM diam) IS NOT NULL THEN 'disco'
       ELSE 'sem_match' END
$f$;
SQL
SAB=$(Pq -c "SELECT formato FROM fn_pcp_parse_dimensoes('CINTA KA169 150X6200MM P50')")
if [ "$SAB" = "sem_match" ]; then ok "FALSIFICAÇÃO: sabotagem detectada pelo golden (dimensional→sem_match)"; else bad "FALSIFICAÇÃO NÃO detectou sabotagem (veio $SAB)"; fi
# restaura aplicando o M2 real de novo (CREATE OR REPLACE)
P -q -f "$REPO_ROOT/db/pcp-f1a-m2-nucleo.sql"
eq "restaurado após falsificação" "$(Pq -c "SELECT formato FROM fn_pcp_parse_dimensoes('CINTA KA169 150X6200MM P50')")" "dimensional"

echo ""
echo "RESULTADO: PASS=$PASS FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
