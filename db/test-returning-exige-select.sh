#!/usr/bin/env bash
# `INSERT ... RETURNING` exige SELECT além de INSERT — provado num PG17 descartável.
#
# POR QUE ISTO EXISTE (docs/historico/revoke-que-nao-revoga.md, defeitos D4-D6):
# `net.http_post` termina em `insert into net.http_request_queue(...) returning id into
# request_id`, e as `http_*` do pg_net são SECURITY INVOKER ⇒ quem precisa do privilégio é
# o CHAMADOR (`postgres`, que roda os 52 crons). Um bloco de REVOKE que feche a fila para
# PUBLIC e re-conceda só INSERT derruba os 52 crons — o INSERT passa, o RETURNING não.
# A asserção é sutil o bastante para ninguém notar na revisão e cara o bastante para não
# ser aceita por citação de doc: aqui ela é EXECUTADA.
#
# O par que fecha o argumento é 1a/1b: o MESMO insert, no MESMO papel, com os MESMOS
# privilégios — passa sem `RETURNING` e falha com. Não é o INSERT que exige SELECT, é o
# RETURNING. `USAGE` na sequence é concedido antes, para que a falha não possa ser do
# `nextval` do bigserial.
#
# ⚠️ DUAS ARMADILHAS DE SHELL que este teste já pisou (evidencia-positiva-shell.md):
#   1. `psql -d db "SQL"` SEM `-c` é no-op que retorna exit 0 — o posicional do psql é o
#      *dbname*, não um comando. `set -e` não pega. Toda execução aqui usa `-c`.
#   2. `x="$(cmd)"` PROPAGA o exit code e mata o script sob `set -e`, enquanto
#      `echo "$(cmd)"` o engole. Por isso `psql_como` termina em `|| true` e o veredito
#      vem do TEXTO capturado, nunca da ausência de erro.
# E "saída vazia" não é aprovação: o INSERT puro é conferido por contagem antes/depois.
set -euo pipefail

PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT=5453
DATA="$(mktemp -d /tmp/pgtest-returning.XXXXXX)/data"
export LC_ALL=C LANG=C

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER}"; exit 1; }
# shellcheck disable=SC2329  # invocada pelo `trap EXIT`, que o shellcheck nao enxerga
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U dono -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l /tmp/pg-returning.log -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U dono verifica

# dono: DDL/GRANT (ON_ERROR_STOP para que um GRANT que falhe derrube o teste, não o mascare)
psql_dono() { "$PGBIN/psql" -qtAX -v ON_ERROR_STOP=1 -p "$PORT" -h /tmp -U dono -d verifica -c "$1"; }
# chamador: devolve a saída CRUA (erro incluso); o `|| true` é deliberado — ver armadilha 2
psql_como() { "$PGBIN/psql" -qtAX -p "$PORT" -h /tmp -U chamador -d verifica -c "$1" 2>&1 | head -1 || true; }

falhas=0
ok()    { echo "  OK   [$1] $2"; }
falha() { echo "  FALHA[$1] $2"; falhas=$((falhas+1)); }

# Topologia de prod: chamador NÃO é dono da tabela e NÃO é superuser (= `postgres` no Supabase).
psql_dono "CREATE ROLE chamador LOGIN NOSUPERUSER; CREATE SCHEMA net; GRANT USAGE ON SCHEMA net TO chamador;" >/dev/null
psql_dono "CREATE TABLE net.fila(id bigserial PRIMARY KEY, method text, url text);" >/dev/null
echo "PG $(psql_dono "SHOW server_version") · dono da tabela: $(psql_dono "SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid='net.fila'::regclass") · chamador superuser: $(psql_dono "SELECT rolsuper FROM pg_roles WHERE rolname='chamador'")"

echo
echo "== 1) chamador com INSERT + USAGE na sequence, SEM SELECT =="
psql_dono "GRANT INSERT ON net.fila TO chamador; GRANT USAGE ON SEQUENCE net.fila_id_seq TO chamador;" >/dev/null
acl="$(psql_dono "SELECT relacl::text FROM pg_class WHERE oid='net.fila'::regclass")"
echo "  relacl=$acl · INSERT=$(psql_dono "SELECT has_table_privilege('chamador','net.fila','INSERT')") · SELECT=$(psql_dono "SELECT has_table_privilege('chamador','net.fila','SELECT')")"

antes="$(psql_dono "SELECT count(*) FROM net.fila")"
saida_1a="$(psql_como "INSERT INTO net.fila(method,url) VALUES ('POST','http://x')")"
depois="$(psql_dono "SELECT count(*) FROM net.fila")"
if [ "$antes" != "$depois" ]; then ok 1a "INSERT puro GRAVOU ($antes -> $depois linhas) - evidencia positiva, nao ausencia de erro"
else falha 1a "INSERT puro nao gravou (saida: '$saida_1a')"; fi

saida_1b="$(psql_como "INSERT INTO net.fila(method,url) VALUES ('POST','http://x') RETURNING id")"
case "$saida_1b" in
  *"permission denied"*) ok 1b "MESMO insert com RETURNING foi barrado: $saida_1b" ;;
  *) falha 1b "esperava permission denied; veio: '$saida_1b'" ;;
esac

# o caminho REAL do net.http_post: RETURNING ... INTO, dentro de plpgsql
saida_1c="$(psql_como "DO \$\$ DECLARE v bigint; BEGIN INSERT INTO net.fila(method,url) VALUES ('POST','http://x') RETURNING id INTO v; END \$\$;")"
case "$saida_1c" in
  *"permission denied"*) ok 1c "RETURNING id INTO v (forma do net.http_post) barrado" ;;
  *) falha 1c "esperava permission denied; veio: '$saida_1c'" ;;
esac

# SQLSTATE nomeada: casar a MARCA do ramo, não "lançou algo"
saida_1d="$(psql_como "DO \$\$ DECLARE v bigint; BEGIN INSERT INTO net.fila(method,url) VALUES ('P','u') RETURNING id INTO v; EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'MARCA_42501'; END \$\$;")"
case "$saida_1d" in
  *MARCA_42501*) ok 1d "SQLSTATE 42501 (insufficient_privilege), nao um erro qualquer" ;;
  *) falha 1d "esperava o ramo insufficient_privilege; veio: '$saida_1d'" ;;
esac

echo
echo "== 2) mesmo papel, agora COM SELECT =="
psql_dono "GRANT SELECT ON net.fila TO chamador;" >/dev/null
echo "  relacl=$(psql_dono "SELECT relacl::text FROM pg_class WHERE oid='net.fila'::regclass")"
saida_2a="$(psql_como "DO \$\$ DECLARE v bigint; BEGIN INSERT INTO net.fila(method,url) VALUES ('POST','http://x') RETURNING id INTO v; RAISE NOTICE 'GRAVOU_ID_%', v; END \$\$;")"
case "$saida_2a" in
  *GRAVOU_ID_*) ok 2a "RETURNING passou e devolveu o id: $saida_2a" ;;
  *) falha 2a "deveria passar; veio: '$saida_2a'" ;;
esac

echo
echo "== FALSIFICACAO: tirar o SELECT tem de VOLTAR a barrar =="
psql_dono "REVOKE SELECT ON net.fila FROM chamador;" >/dev/null
saida_f="$(psql_como "DO \$\$ DECLARE v bigint; BEGIN INSERT INTO net.fila(method,url) VALUES ('P','u') RETURNING id INTO v; END \$\$;")"
case "$saida_f" in
  *"permission denied"*) ok falsif "sabotagem detectada - a assercao MEDE o SELECT" ;;
  *) falha falsif "sabotei o SELECT e o teste nao viu: '$saida_f'" ;;
esac

echo
if [ "$falhas" -eq 0 ]; then echo "RESULTADO: TODAS AS ASSERCOES PASSARAM"; else echo "RESULTADO: $falhas FALHA(S)"; fi
exit "$falhas"
