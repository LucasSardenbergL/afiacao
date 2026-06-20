#!/usr/bin/env bash
# Harness DIFERENCIAL TS×SQL da normalização de cidade (#16-full):
# prova que public.route_city_norm (migration 20260611150000) produz, byte a
# byte, a MESMA cidade normalizada que normalizeCityKey (route-city.ts) — o
# gate de paridade exigido pelo design (consult Codex 2026-06-11) antes de
# qualquer corte do filtro client-side da fila de ligação.
#
# Corpus = db/city-norm-corpus.txt (casos visíveis) + casos INVISÍVEIS gerados
# aqui (NBSP, múltiplos espaços, trailing). Também valida a GENERATED column
# na customer_visit_scores REAL (snapshot de prod) + função aceita em
# generated (IMMUTABLE de verdade).
#
# Corpus de PROD (opcional): se db/city-norm-corpus-prod.txt existir (gerado
# pelo founder via SQL Editor — ver query no PR), entra no diferencial.
#
# Base: db/verify-snapshot-replay.sh. Pré-req: brew install postgresql@17.
# ⚠️ initdb com locale en_US.UTF-8 (NÃO C): upper() precisa do comportamento
# unicode de prod (Supabase = en_US.UTF-8); locale=C não converte não-ASCII.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# LC_ALL precisa ser um locale VÁLIDO no processo (postmaster no macOS aborta
# com "became multithreaded" sem isso). en_US.UTF-8 — o MESMO do cluster
# (initdb --locale abaixo) e do Supabase de prod (upper() unicode fiel).
export LC_ALL=en_US.UTF-8 LANG=en_US.UTF-8
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT=5441
DATA="$(mktemp -d /tmp/pgtest-citynorm.XXXXXX)/data"
WORK="$(mktemp -d /tmp/citynorm-work.XXXXXX)"

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER}"; exit 1; }

CELLAR="$(brew --prefix postgresql@${PGVER})"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")" "$WORK"; rm -f "${RR:-}"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=en_US.UTF-8 >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l /tmp/pg-citynorm.log -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres citynorm_verify
P() { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d citynorm_verify "$@"; }

RR="$(mktemp "${TMPDIR:-/tmp}/snap-citynorm.XXXXXX")"
sed -E 's/^(CREATE SCHEMA public;)/-- \1/' "$REPO_ROOT/supabase/schema-snapshot.sql" \
  | grep -vE '^\\(un)?restrict ' > "$RR"

echo "→ stubs + prelude + snapshot…"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/schema-extensions-prelude.sql"
P --single-transaction -v ON_ERROR_STOP=1 -q -f "$RR"
rm -f "$RR"

echo "→ migration 20260611150000 (função + generated column + índice)…"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/migrations/20260611150000_route_city_norm.sql" >/dev/null

# ── corpus EFETIVO = estático + casos invisíveis gerados ─────────────────────
CORPUS="$WORK/corpus.txt"
grep -v '^#' "$REPO_ROOT/db/city-norm-corpus.txt" | grep -v '^$' > "$CORPUS"
# NBSP (U+00A0) no meio · múltiplos espaços + bordas · NBSP nas bordas · só espaços.
# (TAB fica de fora: é delimitador do COPY text e ambos os lados o tratam via
#  \s/[[:space:]] igualmente — a divergência que importa é NBSP/unicode.)
printf 'NOVA\xc2\xa0SERRANA (MG)\n' >> "$CORPUS"
printf '  Carmo   do  Cajuru  (MG)  \n' >> "$CORPUS"
printf '\xc2\xa0Divin\xc3\xb3polis\xc2\xa0(MG)\xc2\xa0\n' >> "$CORPUS"
printf '   \n' >> "$CORPUS"

echo "→ lado TS (bun + normalizeCityKey)…"
( cd "$REPO_ROOT" && bun scripts/city-norm-print.ts "$CORPUS" ) > "$WORK/ts.out"

echo "→ lado SQL (route_city_norm)…"
# COPY text interpreta \ como escape — o corpus não tem backslash (assert):
if grep -q '\\' "$CORPUS"; then echo "FAIL: corpus com backslash (COPY text escaparia)"; exit 1; fi
P -v ON_ERROR_STOP=1 -q <<SQL
CREATE TABLE corpus_caso (id bigserial PRIMARY KEY, raw text);
SQL
P -v ON_ERROR_STOP=1 -q -c "\\copy corpus_caso(raw) FROM '$CORPUS'"
P -v ON_ERROR_STOP=1 -qAt -c "SELECT coalesce(public.route_city_norm(raw), '∅') FROM corpus_caso ORDER BY id;" > "$WORK/sql.out"

echo "→ diff TS × SQL (paridade byte a byte)…"
if ! diff -u "$WORK/ts.out" "$WORK/sql.out"; then
  echo "FAIL: TS e SQL DIVERGEM no corpus acima"; exit 1
fi
N_CASOS=$(wc -l < "$WORK/ts.out" | tr -d ' ')
echo "   ✓ paridade em $N_CASOS casos"

# ── corpus de PROD (opcional) ────────────────────────────────────────────────
if [ -f "$REPO_ROOT/db/city-norm-corpus-prod.txt" ]; then
  echo "→ corpus de PROD detectado — diferencial…"
  PRODC="$WORK/prod.txt"
  grep -v '^#' "$REPO_ROOT/db/city-norm-corpus-prod.txt" | grep -v '^$' > "$PRODC"
  if grep -q '\\' "$PRODC"; then echo "FAIL: corpus de prod com backslash"; exit 1; fi
  ( cd "$REPO_ROOT" && bun scripts/city-norm-print.ts "$PRODC" ) > "$WORK/ts-prod.out"
  P -v ON_ERROR_STOP=1 -q -c "TRUNCATE corpus_caso;"
  P -v ON_ERROR_STOP=1 -q -c "\\copy corpus_caso(raw) FROM '$PRODC'"
  P -v ON_ERROR_STOP=1 -qAt -c "SELECT coalesce(public.route_city_norm(raw), '∅') FROM corpus_caso ORDER BY id;" > "$WORK/sql-prod.out"
  if ! diff -u "$WORK/ts-prod.out" "$WORK/sql-prod.out"; then
    echo "FAIL: TS e SQL divergem no corpus de PROD"; exit 1
  fi
  echo "   ✓ paridade no corpus de prod ($(wc -l < "$WORK/ts-prod.out" | tr -d ' ') cidades)"
else
  echo "   (corpus de prod ausente — gate final exige rodar com ele antes do corte)"
fi

# ── generated column na tabela REAL + asserts de comportamento ───────────────
echo "→ asserts da generated column…"
P -v ON_ERROR_STOP=1 -qAt <<'SQL'
DO $$
DECLARE
  expr text;
  got text;
BEGIN
  -- 1. coluna existe, é GENERATED STORED e usa a função
  SELECT pg_get_expr(d.adbin, d.adrelid) INTO expr
    FROM pg_attribute a
    JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
   WHERE a.attrelid = 'public.customer_visit_scores'::regclass
     AND a.attname = 'city_norm' AND a.attgenerated = 's';
  IF expr IS NULL OR expr NOT LIKE '%route_city_norm%' THEN
    RAISE EXCEPTION 'FAIL: city_norm não é GENERATED STORED com route_city_norm (expr=%)', expr;
  END IF;

  -- 2. a coluna COMPUTA num INSERT real (FKs do snapshot não bloqueiam: a
  --    tabela não tem FK pra profiles no snapshot — uuids sintéticos servem)
  INSERT INTO public.customer_visit_scores (customer_user_id, farmer_id, city)
  VALUES (gen_random_uuid(), gen_random_uuid(), 'Divinópolis (MG)');
  SELECT city_norm INTO got FROM public.customer_visit_scores WHERE city = 'Divinópolis (MG)' LIMIT 1;
  IF got IS DISTINCT FROM 'DIVINOPOLIS' THEN
    RAISE EXCEPTION 'FAIL: generated esperava DIVINOPOLIS, veio %', got;
  END IF;

  -- 3. UF Tocantins produz o MESMO city_norm (a exclusão é client-side, por UF)
  INSERT INTO public.customer_visit_scores (customer_user_id, farmer_id, city)
  VALUES (gen_random_uuid(), gen_random_uuid(), 'DIVINOPOLIS (TO)');
  IF (SELECT count(DISTINCT city_norm) FROM public.customer_visit_scores
       WHERE city_norm = 'DIVINOPOLIS') = 0 THEN
    RAISE EXCEPTION 'FAIL: TO deveria normalizar pra DIVINOPOLIS também';
  END IF;

  -- 4. city NULL / vazia → city_norm NULL (fica fora do índice parcial e do .in())
  INSERT INTO public.customer_visit_scores (customer_user_id, farmer_id, city)
  VALUES (gen_random_uuid(), gen_random_uuid(), '   ');
  IF (SELECT city_norm FROM public.customer_visit_scores WHERE city = '   ') IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL: city só-espaços deveria dar city_norm NULL';
  END IF;

  RAISE NOTICE 'asserts generated column: OK';
END $$;
SQL

echo ""
echo "✅ city-norm: paridade TS×SQL + generated column OK"
