#!/usr/bin/env bash
# Prova, num PG17 descartável, as asserções que decidem o bloco de REVOKE do schema `net`
# enviado ao suporte do Lovable (docs/historico/revoke-que-nao-revoga.md).
#
# O que prova (executando, não criando — PL/pgSQL e ACL são late-bound):
#   A) `INSERT ... RETURNING id` exige SELECT além de INSERT  → 42501 sem SELECT.
#   B) Com SELECT re-concedido, o caminho do http_post passa (nextval + INSERT + RETURNING).
#   C) `REVOKE INSERT,UPDATE,DELETE,TRUNCATE ... FROM PUBLIC` (o bloco COMO ENVIADO) deixa
#      SELECT/TRIGGER/REFERENCES de pé para PUBLIC — o REVOKE parcial não fecha a tabela.
#   D) `REVOKE ALL ... FROM PUBLIC` fecha as quatro.
#   E) O worker do pg_net roda como `postgres` (GUC `pg_net.username=postgres`, medido em prod)
#      e hoje só tem INSERT em `_http_response` VIA PUBLIC ⇒ o bloco como enviado o quebra.
# Cada asserção negativa casa a SQLSTATE esperada e re-lança o resto (teste negativo com
# `WHEN OTHERS THEN 'OK'` é teatro). No fim, FALSIFICA: sabota e exige vermelho.
set -euo pipefail

PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT=5449
DATA="$(mktemp -d /tmp/pgtest-netrevoke.XXXXXX)/data"
export LC_ALL=C LANG=C

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER}"; exit 1; }
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U dono_admin -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l /tmp/pg-netrevoke.log -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U dono_admin netverify
P() { "$PGBIN/psql" -v ON_ERROR_STOP=1 -p "$PORT" -h /tmp -U dono_admin -d netverify "$@"; }

# ── Réplica da estrutura e do ACL de PROD (pg_net 0.19.5, medido 2026-08-27) ────────────
P -q <<'SQL'
CREATE ROLE chamador LOGIN;          -- ≈ postgres (não-dono, NÃO superuser) = cron E worker
CREATE ROLE hostil   LOGIN;          -- ≈ anon / authenticated / claude_ro
CREATE SCHEMA net;
GRANT USAGE ON SCHEMA net TO PUBLIC;

CREATE TABLE net.http_request_queue (
  id bigserial PRIMARY KEY, method text, url text, headers jsonb, body bytea,
  timeout_milliseconds integer);
CREATE TABLE net._http_response (
  id bigint PRIMARY KEY, status_code integer, content_type text, headers jsonb,
  content text, timed_out boolean, error_msg text, created timestamptz DEFAULT now());

-- ACL de prod: PUBLIC com ALL nas duas tabelas; PUBLIC com r/w/U na sequence.
GRANT ALL ON net.http_request_queue, net._http_response TO PUBLIC;
GRANT ALL ON SEQUENCE net.http_request_queue_id_seq TO PUBLIC;
SQL

falha=0
esperar_sqlstate() { # $1=papel $2=sql $3=sqlstate esperada $4=rotulo
  local got
  got="$("$PGBIN/psql" -qtAX -p "$PORT" -h /tmp -U "$1" -d netverify \
        -c "DO \$\$ BEGIN $2 ; RAISE EXCEPTION 'SEM_ERRO_INESPERADO'; EXCEPTION
              WHEN sqlstate '$3' THEN RAISE NOTICE 'MARCA_OK'; END \$\$;" 2>&1 || true)"
  case "$got" in
    *MARCA_OK*) echo "  OK   [$4] barrou com SQLSTATE $3" ;;
    *) echo "  FALHA[$4] esperava SQLSTATE $3; veio: $(printf '%s' "$got" | head -2 | tr '\n' ' ')"; falha=1 ;;
  esac
}
esperar_ok() { # $1=papel $2=sql $3=rotulo
  if "$PGBIN/psql" -qtAX -v ON_ERROR_STOP=1 -p "$PORT" -h /tmp -U "$1" -d netverify -c "$2" >/dev/null 2>&1
  then echo "  OK   [$3] passou"; else echo "  FALHA[$3] deveria passar e falhou"; falha=1; fi
}
acl() { "$PGBIN/psql" -qtAX -p "$PORT" -h /tmp -U dono_admin -d netverify \
        -c "SELECT coalesce(relacl::text,'NULL') FROM pg_class WHERE oid='net.http_request_queue'::regclass"; }
priv() { "$PGBIN/psql" -qtAX -p "$PORT" -h /tmp -U dono_admin -d netverify \
         -c "SELECT has_table_privilege('$1','$2','$3')"; }

echo "== BASELINE (PUBLIC com tudo, como prod hoje) =="
esperar_ok chamador "INSERT INTO net.http_request_queue(method,url) VALUES ('POST','x') RETURNING id" "baseline: caminho do http_post"
esperar_ok hostil   "SELECT count(*) FROM net.http_request_queue" "baseline: hostil LE a fila (x-cron-secret)"

echo
echo "== C) O BLOCO COMO ENVIADO AO SUPORTE (REVOKE parcial) =="
P -q <<'SQL'
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON net.http_request_queue FROM PUBLIC;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON net._http_response     FROM PUBLIC;
REVOKE ALL ON SEQUENCE net.http_request_queue_id_seq              FROM PUBLIC;
GRANT INSERT, UPDATE, DELETE ON net.http_request_queue            TO chamador;
GRANT USAGE, SELECT, UPDATE ON SEQUENCE net.http_request_queue_id_seq TO chamador;
SQL
for p in SELECT TRIGGER REFERENCES; do
  v="$(priv hostil net.http_request_queue $p)"
  if [ "$v" = "t" ]; then echo "  OK   [C:$p] REVOKE parcial DEIXOU $p com PUBLIC (t) - achado confirmado"
  else echo "  FALHA[C:$p] esperava t, veio $v"; falha=1; fi
done

echo
echo "== A) INSERT ... RETURNING id exige SELECT (o bloco corrigido quebraria sem isto) =="
P -q -c "REVOKE SELECT ON net.http_request_queue FROM PUBLIC;"
esperar_sqlstate chamador \
  "DECLARE v bigint; BEGIN INSERT INTO net.http_request_queue(method,url) VALUES ('POST','x') RETURNING id INTO v; END" \
  42501 "A: RETURNING sem SELECT"
esperar_ok chamador "INSERT INTO net.http_request_queue(method,url) VALUES ('POST','x')" "A: INSERT puro (sem RETURNING) passa"

echo
echo "== B) com SELECT re-concedido, o caminho do http_post volta a passar =="
P -q -c "GRANT SELECT ON net.http_request_queue TO chamador;"
esperar_ok chamador "INSERT INTO net.http_request_queue(method,url) VALUES ('POST','x') RETURNING id" "B: INSERT+RETURNING com SELECT"

echo
echo "== E) o worker (roda como 'postgres' = chamador) perde a gravacao da resposta =="
esperar_sqlstate chamador "INSERT INTO net._http_response(id,status_code) VALUES (1,200)" \
  42501 "E: worker INSERT em _http_response"
esperar_sqlstate chamador "DELETE FROM net._http_response WHERE id=1" \
  42501 "E: worker DELETE (reaping do TTL de 6h)"

echo
echo "-- relacl ANTES do REVOKE ALL: $(acl) --"
echo "== D) REVOKE ALL fecha as quatro (o conserto) =="
P -q -c "REVOKE ALL ON net.http_request_queue FROM PUBLIC;"
for p in SELECT TRIGGER REFERENCES INSERT; do
  v="$(priv hostil net.http_request_queue $p)"
  if [ "$v" = "f" ]; then echo "  OK   [D:$p] fechado para PUBLIC (f)"
  else echo "  FALHA[D:$p] esperava f, veio $v"; falha=1; fi
done

echo
echo "== FALSIFICACAO: devolver SELECT a PUBLIC tem de deixar C VERMELHO =="
P -q -c "GRANT SELECT ON net.http_request_queue TO PUBLIC;"
v="$(priv hostil net.http_request_queue SELECT)"
if [ "$v" = "t" ]; then echo "  OK   [falsif] sabotagem detectada (voltou a t) - a assercao MEDE algo"
else echo "  FALHA[falsif] sabotei e o teste nao viu"; falha=1; fi

echo
[ "$falha" -eq 0 ] && echo "RESULTADO: TODAS AS ASSERCOES PASSARAM" || echo "RESULTADO: HOUVE FALHA"
exit "$falha"
