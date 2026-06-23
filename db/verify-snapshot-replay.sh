#!/usr/bin/env bash
# Verifica o REPLAY do snapshot de schema num Postgres local descartável.
# Prova ordem/dependência/sintaxe do schema-snapshot.sql + CRIAÇÃO das 474 policies, e
# (Silver+, 2026-05-30) ENFORCEMENT de RLS AMOSTRADO em runtime: own-scope / staff-gate /
# anon-deny, via override de auth.uid() por GUC de sessão (ver seção no fim do script).
# NÃO é o "Gold" completo (runtime Supabase real com TODAS as 474 policies + auth/storage):
# pra isso, projeto Supabase cloud vazio ou docker (`supabase start` exige docker, ausente
# nesta máquina). O Silver+ pega a classe de bug "policy não filtra" sem docker.
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

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; rm -f "${RR:-}"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l /tmp/pg-snap.log -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres baseline_verify
P() { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d baseline_verify "$@"; }

# Snapshot restore-ready: remove meta-comandos psql do pg_dump 17 e o CREATE SCHEMA
# public (já existe num DB novo). Ver "Armadilhas" no README-schema.md.
RR="$(mktemp "${TMPDIR:-/tmp}/snap-rr.XXXXXX")"   # X no FINAL: BSD mktemp (macOS) não substitui X no meio do template → criaria arquivo literal
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

# ─────────────────────────────────────────────────────────────────────────────
# Silver+ : ENFORCEMENT de RLS amostrado. O replay acima prova schema + CRIAÇÃO das
# 474 policies; aqui provamos que elas FILTRAM em runtime (o gap pro "Gold"). Override
# de auth.uid()/auth.role() via GUC de sessão (impersona) + seed mínimo + assert em
# recurring_schedules: own-scope (auth.uid()=user_id), staff-gate (has_role master),
# e anon-deny (sem uid → 0). NÃO é Gold (runtime Supabase completo precisa docker/cloud);
# é o teto sem docker — pega a classe de bug "policy não filtra".
echo ""
echo "ENFORCEMENT RLS (amostra Silver+):"
P -v ON_ERROR_STOP=1 -q <<'SQL'
-- auth.uid()/auth.role() passam a ler GUCs de sessão (impersonação de teste)
CREATE OR REPLACE FUNCTION auth.uid()  RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.uid',  true), '')::uuid $f$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.role', true), '') $f$;
-- seed: 2 clientes + 1 master
INSERT INTO auth.users(id) VALUES
  ('11111111-1111-1111-1111-111111111111'),
  ('22222222-2222-2222-2222-222222222222'),
  ('33333333-3333-3333-3333-333333333333') ON CONFLICT DO NOTHING;
INSERT INTO public.user_roles(user_id, role) VALUES
  ('33333333-3333-3333-3333-333333333333','master'::public.app_role) ON CONFLICT DO NOTHING;
INSERT INTO public.recurring_schedules(user_id, next_order_date) VALUES
  ('11111111-1111-1111-1111-111111111111','2026-01-01'),
  ('22222222-2222-2222-2222-222222222222','2026-01-01');
-- snapshot é --no-privileges → o Supabase concede em runtime; concedo no teste (RLS filtra por cima)
GRANT SELECT ON public.recurring_schedules TO authenticated, anon;
SQL

# tail -1: psql ecoa "SET" como status de cada SET → a contagem é a ÚLTIMA linha.
OWN=$(P -tA -c "SET test.uid='11111111-1111-1111-1111-111111111111'; SET ROLE authenticated; SELECT count(*) FROM public.recurring_schedules;" | tail -1)
STAFF=$(P -tA -c "SET test.uid='33333333-3333-3333-3333-333333333333'; SET ROLE authenticated; SELECT count(*) FROM public.recurring_schedules;" | tail -1)
ANON=$(P -tA -c "SET ROLE anon; SELECT count(*) FROM public.recurring_schedules;" | tail -1)
echo "  own-scope (cliente1, espera 1): ${OWN}"
echo "  staff-all (master,   espera 2): ${STAFF}"
echo "  anon      (sem uid,  espera 0): ${ANON}"
if [ "$OWN" = "1" ] && [ "$STAFF" = "2" ] && [ "$ANON" = "0" ]; then
  echo "ENFORCEMENT RLS OK (own-scope + staff-gate + anon-deny filtram em runtime)"
else
  echo "ENFORCEMENT RLS FALHOU"; exit 1
fi
