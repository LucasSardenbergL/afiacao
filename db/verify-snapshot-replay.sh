#!/usr/bin/env bash
# Verifica o REPLAY do snapshot de schema num Postgres local descartável.
# Prova ordem/dependência/sintaxe do schema-snapshot.sql; NÃO prova comportamento
# runtime do Supabase (RLS/auth reais) — pra isso, projeto Supabase vazio ou docker.
#
# Executado com sucesso em 2026-05-24 (PostgreSQL 17, macOS/brew): replay limpo,
# contagens batem 1:1 com produção (212 tabelas / 37 views / 4 matviews /
# 86 funções / 76 triggers / 14 enums / 474 policies).
#
# Pré-requisitos: brew install postgresql@17 pgvector
#
# ⚠️ Percalços do keg-only do brew (descobertos na marra; o script contorna):
#   - O sharedir e o pkglibdir do postgresql@17 NÃO ficam linkados em
#     /opt/homebrew/{share,lib}/postgresql@17 — initdb falha ("postgres.bki não
#     existe") e o server falha ("$libdir/dict_snowball"). Copiamos do Cellar.
#   - Os módulos no macOS são .dylib (não .so).
#   - Sem LC_ALL o postmaster aborta ("became multithreaded during startup").
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT=5433
DATA="$(mktemp -d /tmp/pgtest-snap.XXXXXX)/data"
export LC_ALL=C LANG=C

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER} pgvector"; exit 1; }

# Contorna o keg-only: popula share/lib se o brew não linkou (idempotente, no-clobber).
CELLAR="$(brew --prefix postgresql@${PGVER})"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l /tmp/pg-snap.log -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres baseline_verify
P() { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d baseline_verify "$@"; }

# Snapshot restore-ready: remove meta-comandos psql do pg_dump 17 e o CREATE SCHEMA
# public (já existe num DB novo). Ver "Armadilhas" no README-schema.md.
RR="$(mktemp /tmp/snap-rr.XXXXXX.sql)"
sed -E 's/^(CREATE SCHEMA public;)/-- \1/' "$REPO_ROOT/supabase/schema-snapshot.sql" \
  | grep -vE '^\\(un)?restrict ' > "$RR"

P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -v ON_ERROR_STOP=1 -q -f "$REPO_ROOT/supabase/schema-extensions-prelude.sql"
P --single-transaction -v ON_ERROR_STOP=1 -q -f "$RR"
rm -f "$RR"

echo "REPLAY OK. Contagens (esperado prod: tabelas=212 views=37 matviews=4 functions=86 triggers=76 enums=14 policies=474):"
P -tA <<'SQL'
SELECT 'tabelas='  ||count(*) FROM information_schema.tables  WHERE table_schema='public' AND table_type='BASE TABLE'
UNION ALL SELECT 'views='   ||count(*) FROM information_schema.views WHERE table_schema='public'
UNION ALL SELECT 'matviews='||count(*) FROM pg_matviews WHERE schemaname='public'
UNION ALL SELECT 'functions='||count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
  WHERE n.nspname='public' AND NOT EXISTS(SELECT 1 FROM pg_depend d WHERE d.objid=p.oid AND d.deptype='e')
UNION ALL SELECT 'triggers='||count(*) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND NOT t.tgisinternal
UNION ALL SELECT 'enums='   ||count(*) FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public' AND t.typtype='e'
UNION ALL SELECT 'policies='||count(*) FROM pg_policies WHERE schemaname='public';
SQL
