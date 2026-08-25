#!/usr/bin/env bash
# shellcheck disable=SC2329  # `cleanup` e invocada indiretamente, pelo `trap` (o shellcheck nao ve).
# PROVA PG17: quem NAO é dono (e nao tem grant option) consegue REVOGAR?
# Espelha a topologia MEDIDA na PROD: net.http_post proacl=NULL (default => EXECUTE p/ PUBLIC),
# dono=supabase_admin; executor do SQL Editor = postgres (NAO membro do dono); leitor=claude_ro (pg_read_all_data).
set -euo pipefail
PGBIN="/opt/homebrew/opt/postgresql@17/bin"; PORT="${PGPORT_TEST:-5479}"
DATA="$(mktemp -d /tmp/pgtest-revoke.XXXXXX)/data"
export LC_ALL=C LANG=C
CELLAR="$(brew --prefix postgresql@17)"
cp -Rn "$CELLAR"/share/postgresql/. /opt/homebrew/share/postgresql@17/ 2>/dev/null || true
mkdir -p /opt/homebrew/lib/postgresql@17
cp -Rn "$CELLAR"/lib/postgresql/. /opt/homebrew/lib/postgresql@17/ 2>/dev/null || true
cleanup(){ "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT
"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null 2>&1
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l /tmp/pg-revoke.log -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
P(){ "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq(){ P -tA "$@"; }

P -q <<'SQL'
CREATE ROLE dono     NOSUPERUSER;
CREATE ROLE operador NOSUPERUSER;
CREATE ROLE leitor   NOSUPERUSER IN ROLE pg_read_all_data;
GRANT CREATE ON DATABASE prove TO dono;
SET ROLE dono;
CREATE SCHEMA net_like;
GRANT USAGE ON SCHEMA net_like TO PUBLIC;
CREATE FUNCTION net_like.http_post(url text) RETURNS bigint LANGUAGE sql AS $$ SELECT 1::bigint $$;
CREATE TABLE net_like.http_request_queue(id bigserial primary key, url text);
GRANT ALL ON net_like.http_request_queue TO PUBLIC;   -- espelha relacl medido (PUBLIC=arwdDxtm, SEM '*')
RESET ROLE;
SQL

echo "--- topologia espelha a PROD? ---"
echo "  proacl NULL (default=PUBLIC): $(Pq -c "SELECT proacl IS NULL FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='net_like' AND proname='http_post'")"
echo "  operador e membro do dono?:   $(Pq -c "SELECT pg_has_role('operador','dono','MEMBER')")"
echo "  leitor EXECUTE antes:         $(Pq -c "SELECT has_function_privilege('leitor','net_like.http_post(text)','EXECUTE')")"
echo "  leitor INSERT fila antes:     $(Pq -c "SELECT has_table_privilege('leitor','net_like.http_request_queue','INSERT')")"

run_revoke(){ # $1=rotulo  $2=sql — captura saida E exit code SEM pipe (pipe engoliria o exit)
  local out rc
  set +e; out="$(P -c "$2" 2>&1)"; rc=$?; set -e
  printf '  [%s] exit=%s\n' "$1" "$rc"
  printf '%s\n' "$out" | sed 's/^/      /'
}

echo; echo "--- CENARIO A: 'REVOKE ... FROM claude_ro' (o conserto PROPOSTO), rodado pelo OPERADOR ---"
run_revoke A-func "SET ROLE operador; REVOKE EXECUTE ON FUNCTION net_like.http_post(text) FROM leitor;"
run_revoke A-tab  "SET ROLE operador; REVOKE INSERT, UPDATE, DELETE ON net_like.http_request_queue FROM leitor;"
A_FUNC=$(Pq -c "SELECT has_function_privilege('leitor','net_like.http_post(text)','EXECUTE')")
A_INS=$(Pq  -c "SELECT has_table_privilege('leitor','net_like.http_request_queue','INSERT')")
echo "  => leitor EXECUTE depois: $A_FUNC | INSERT depois: $A_INS"

echo; echo "--- CENARIO B: 'REVOKE ... FROM PUBLIC' rodado pelo OPERADOR (nao-dono, sem grant option) ---"
run_revoke B-func "SET ROLE operador; REVOKE EXECUTE ON FUNCTION net_like.http_post(text) FROM PUBLIC;"
run_revoke B-tab  "SET ROLE operador; REVOKE INSERT, UPDATE, DELETE ON net_like.http_request_queue FROM PUBLIC;"
B_FUNC=$(Pq -c "SELECT has_function_privilege('leitor','net_like.http_post(text)','EXECUTE')")
B_INS=$(Pq  -c "SELECT has_table_privilege('leitor','net_like.http_request_queue','INSERT')")
echo "  => leitor EXECUTE depois: $B_FUNC | INSERT depois: $B_INS"

echo; echo "--- FALSIFICACAO: o MESMO REVOKE pelo DONO tem de virar 'f' (senao o teste e teatro) ---"
run_revoke F "SET ROLE dono; REVOKE EXECUTE ON FUNCTION net_like.http_post(text) FROM PUBLIC; REVOKE ALL ON net_like.http_request_queue FROM PUBLIC;"
F_FUNC=$(Pq -c "SELECT has_function_privilege('leitor','net_like.http_post(text)','EXECUTE')")
F_INS=$(Pq  -c "SELECT has_table_privilege('leitor','net_like.http_request_queue','INSERT')")
F_SEL=$(Pq  -c "SELECT has_table_privilege('leitor','net_like.http_request_queue','SELECT')")
echo "  => EXECUTE: $F_FUNC | INSERT: $F_INS | SELECT: $F_SEL  (SELECT deve seguir 't': pg_read_all_data)"

echo
FAIL=0
[ "$A_FUNC" = t ] && [ "$A_INS" = t ] || { echo "XX A: revoke por nome mudou algo (inesperado)"; FAIL=1; }
[ "$B_FUNC" = t ] && [ "$B_INS" = t ] || { echo "XX B: revoke de PUBLIC por nao-dono surtiu efeito (inesperado)"; FAIL=1; }
[ "$F_FUNC" = f ] && [ "$F_INS" = f ] || { echo "XX FALSIFICACAO FALHOU -> teste e teatro"; FAIL=1; }
[ "$F_SEL"  = t ] || { echo "XX pg_read_all_data NAO sobreviveu ao revoke -> leitura da canaria quebraria"; FAIL=1; }
[ "$FAIL" = 0 ] && echo "== VEREDITO: REVOKE por NAO-DONO e NO-OP SILENCIOSO (exit 0). So o DONO fecha. SELECT do pg_read_all_data sobrevive. ==" \
                || echo "== VEREDITO: INCONCLUSIVO =="
exit $FAIL
