#!/usr/bin/env bash
# shellcheck disable=SC2329  # `cleanup` e invocada indiretamente, pelo `trap` (o shellcheck nao ve).
# PROVA PG17: o transporte da nuvem (`scripts/lib/transporte-nuvem.ts`) entrega ao juizo as MESMAS
# linhas que o `psql -A -F '|' -t` daria — e recusa o que nao pode ser leitura de verdade.
#
# O contexto: a sessao da NUVEM nao tem `psql-ro`; le prod pelo `query_database` do conector
# Lovable, que entra como `postgres` sem modo leitura. O CLI emite UM SQL (`--sql-nuvem`), o modelo
# o roda VERBATIM e o CLI valida a resposta (`--dados-nuvem`). Esta prova roda o SQL do jeito que o
# MCP roda — uma string so, uma transacao implicita — e mede:
#   T1-T3  o SQL e a resposta existem na forma esperada (sem isso o resto nao julga nada);
#   T4     a resposta valida passa pelo leitor;
#   T5     FIDELIDADE: cada consulta, byte a byte (`cmp`), igual ao psql — inclusive boolean,
#          timestamp, array, jsonb, NULL x vazio, quebra de linha dentro do campo e SQL nao-ASCII;
#   T6     o prefixo emitido BLOQUEIA escrita no lote (SQLSTATE 25006) e nada persiste;
#   T7-T8  sem a trava (ou com os statements mandados separados) a resposta diz `off` e e RECUSADA;
#   T9     SQL alterado no caminho e recusado (`sql_md5` via `current_query()`);
#   T10    payload adulterado na transcricao e recusado (md5).
#
#   bash db/test-transporte-nuvem.sh               # a prova
#   bash db/test-transporte-nuvem.sh --falsificar  # controle verde + sabota a lib e EXIGE vermelho
#
# Como root (container da nuvem), o initdb/pg_ctl rodam como `postgres` via runuser; no CI e no
# laptop, como o proprio usuario.
set -uo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${PGPORT_TEST:-5447}"
export LC_ALL=C LANG=C  # sem isto o postmaster morre com "became multithreaded during startup"
export PGVER="${PGVER:-17}"   # consumido pelo db/lib/pg-harness.sh via source
# shellcheck disable=SC1091  # o gate roda sem -x; o helper e versionado ao lado, em db/lib/
. "$RAIZ/db/lib/pg-harness.sh"
command -v bun >/dev/null 2>&1 || { echo "VERMELHO — bun ausente: a prova gera o SQL pela lib real"; exit 1; }

TMP="$(mktemp -d "${TMPDIR:-/tmp}/pgtest-transporte.XXXXXX")"
DATA="$TMP/data"; SOCK="$TMP"; DIR="$TMP/saidas"
WT_SABOTADO="$TMP/wt-sabotado"   # so no --falsificar
PGRUN=()
if [ "$(id -u)" = 0 ]; then
  command -v runuser >/dev/null 2>&1 || { echo "VERMELHO — root sem runuser: o initdb recusa root"; exit 1; }
  chown -R postgres "$TMP"
  PGRUN=(runuser -u postgres --)
fi
cleanup() {
  ${PGRUN[@]+"${PGRUN[@]}"} "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true
  git -C "$RAIZ" worktree remove --force "$WT_SABOTADO" >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT

PROVA=(bun "$RAIZ/db/lib/transporte-nuvem-prova.ts")

# ---------------------------------------------------------------- falsificacao ---
# A sabotagem e na LIB, num worktree descartavel do HEAD — mutar o arquivo da sessao e como um
# hook ficou mutado em 2026-09-08 (#2410). Cada sabotagem roda a ENTRADA NORMAL do worktree (o
# comando que o CI roda) e exige vermelho COM a marca do assert certo; o controle sem sabotagem,
# na MESMA invocacao, tem de sair verde antes de qualquer sabotagem valer.
if [ "${1:-}" = "--falsificar" ]; then
  printf '== falsificacao (sabota a lib e EXIGE vermelho PELO MOTIVO CERTO) ==\n'
  SAB_VERMELHAS=0; SAB_FALHAS=0
  if ! git -C "$RAIZ" worktree add --detach "$WT_SABOTADO" HEAD >"$TMP/wt.err" 2>&1; then
    echo "  FALHA nao consegui criar o worktree do HEAD — $(head -c 300 "$TMP/wt.err")"
    echo "SABOTAGENS: 0 vermelhas / 1 falhas"; exit 1
  fi
  ALVO="$WT_SABOTADO/scripts/lib/transporte-nuvem.ts"
  entrada_normal() { PGPORT_TEST=$((PORT + 1)) bash "$WT_SABOTADO/db/test-transporte-nuvem.sh" >"$1" 2>&1; }

  if ! entrada_normal "$TMP/controle.log" || ! grep -qE '^RESULTADO: [0-9]+ ok / 0 fail$' "$TMP/controle.log"; then
    echo "  FALHA controle: a entrada normal do worktree nao ficou verde sem sabotagem"
    echo "        (roda sobre o HEAD COMMITADO: commite antes de falsificar)"
    tail -c 1500 "$TMP/controle.log"
    echo "SABOTAGENS: 0 vermelhas / 1 falhas"; exit 1
  fi
  echo "  ok   controle: entrada normal do worktree verde"

  # sabota <id> <marca-esperada> <expressao sed>
  sabota() {
    local id="$1" marca="$2" expr="$3" log="$TMP/sab-$1.log"
    git -C "$WT_SABOTADO" checkout -q -- .
    sed -i.bak "$expr" "$ALVO" && rm -f "$ALVO.bak"
    if git -C "$WT_SABOTADO" diff --quiet -- scripts/lib/transporte-nuvem.ts; then
      echo "  FALHA $id: a sabotagem nao aplicou (o texto-alvo mudou?)"; SAB_FALHAS=$((SAB_FALHAS + 1)); return
    fi
    if entrada_normal "$log"; then
      echo "  FALHA $id: continuou VERDE"; SAB_FALHAS=$((SAB_FALHAS + 1)); return
    fi
    if grep -qF -- "$marca" "$log"; then
      echo "  ok   $id: vermelho pela marca '$marca'"; SAB_VERMELHAS=$((SAB_VERMELHAS + 1))
    else
      echo "  FALHA $id: vermelho SEM a marca '$marca' (motivo errado)"; tail -c 800 "$log"
      SAB_FALHAS=$((SAB_FALHAS + 1))
    fi
  }
  sabota sem-trava        'FALHA [T4]'       "s/'SET TRANSACTION READ ONLY;',/'',/"
  sabota linha-por-json   'FALHA [T4]'       's/SELECT q::text AS l FROM/SELECT row_to_json(q)::text AS l FROM/'
  sabota aspas-dobradas   'FALHA [T5:tipos]' "s/if (registro\[i + 1\] === '\"') {/if (false) {/"
  sabota barra-invertida  'FALHA [T5:tipos]' "s/      if (ch === '\\\\\\\\') {/      if (false) {/"
  sabota sem-leitura-guard 'FALHA [T7]'      "s/if (s.somente_leitura !== 'on') {/if (false) {/"
  sabota sem-sql-md5      'FALHA [T9]'       's/if (md5(trechoMarcado(emitido)) !== s.sql_md5) {/if (false) {/'
  sabota sem-md5          'FALHA [T10]'      "s/if (md5(canonico.join('\\\\n')) !== s.md5) {/if (false) {/"
  git -C "$WT_SABOTADO" checkout -q -- .
  echo "SABOTAGENS: $SAB_VERMELHAS vermelhas / $SAB_FALHAS falhas"
  [ "$SAB_FALHAS" -eq 0 ]; exit $?
fi

# ------------------------------------------------------------------ a prova ---
${PGRUN[@]+"${PGRUN[@]}"} "$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null 2>&1 \
  || { echo "VERMELHO — initdb falhou"; exit 1; }
${PGRUN[@]+"${PGRUN[@]}"} "$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k $SOCK -c listen_addresses=" -l "$TMP/pg.log" -w start >/dev/null \
  || { echo "VERMELHO — pg_ctl start falhou"; tail -c 800 "$TMP/pg.log"; exit 1; }
P() { "$PGBIN/psql" -X -p "$PORT" -h "$SOCK" -U postgres -d postgres "$@"; }

P -v ON_ERROR_STOP=1 -q <<'SQL' || { echo "VERMELHO — fixture nao montou"; exit 1; }
CREATE TABLE prova_tipos (id int PRIMARY KEY, t text, n numeric, b boolean, ts timestamptz, arr int[], j jsonb, bi bigint);
INSERT INTO prova_tipos VALUES
  (1, E'a"b\\c (x), y', 1.50, true, '2026-09-26 12:00:00+00', '{1,2,NULL}', '{"k": [1, "v"]}', 9007199254740993),
  (2, '', NULL, false, NULL, '{}', 'null', NULL),
  (3, NULL, 0, NULL, '2026-01-01 00:00:00.123456+00', NULL, '"s"', -5),
  (4, 'á  b|c', -0.000, true, 'infinity', ARRAY[3], '[]', 0),
  (5, E'linha1\nlinha2', 1e-7, false, '1999-12-31 23:59:59+00', '{{1,2},{3,4}}', '{"a": null}', -9223372036854775808);
CREATE TABLE prova_ledger (edge text, versao text, observado_em timestamptz);
INSERT INTO prova_ledger VALUES
  ('edge-a', 'v1', '2026-09-27 10:00:00+00'),
  ('edge-a', 'v2', '2026-09-27 11:00:00+00'),
  ('edge-b', 'v1.0-sensor-inicial', '2026-09-20 08:30:00+00');
CREATE TABLE prova_escrita (x int);
SQL

# RESULTADO: <pass> ok / <fail> fail — sem ela, exit 0 nao prova que asseriu algo.
PASS=0; FAIL=0
ok()  { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  FALHA %s\n' "$1"; }

# roda o SQL como o MCP roda (UMA string, transacao implicita) e extrai a linha do JSON
roda_transporte() { # <arquivo-sql> <saida-json> -> 0 se veio exatamente uma linha de JSON
  local out
  out="$(P -v ON_ERROR_STOP=1 -A -t -c "$(cat "$1")" 2>"$2.err")" || return 1
  printf '%s\n' "$out" | grep '^{' > "$2" || return 1
  [ "$(wc -l < "$2")" -eq 1 ]
}
# ler <json> <dir> <arquivo-stderr> -> exit do leitor
ler() { "${PROVA[@]}" ler "$1" "$2" 2>"$3"; }

printf '== transporte da nuvem x psql ==\n'
if "${PROVA[@]}" consultas "$TMP/consultas" && [ "$(find "$TMP/consultas" -name '*.sql' | wc -l)" -eq 5 ]; then
  ok "[T1] 5 consultas de prova gravadas"
else
  bad "[T1] consultas de prova nao gravadas"
fi

"${PROVA[@]}" sql > "$TMP/transporte.sql" 2>"$TMP/sql.err"
if head -c 26 "$TMP/transporte.sql" | grep -qxF 'SET TRANSACTION READ ONLY;' && grep -qF 'á' "$TMP/transporte.sql"; then
  ok "[T2] SQL do transporte abre com a trava e carrega o texto nao-ASCII"
else
  bad "[T2] SQL do transporte fora da forma: $(head -c 200 "$TMP/transporte.sql") $(head -c 200 "$TMP/sql.err")"
fi

if roda_transporte "$TMP/transporte.sql" "$TMP/resposta.json"; then
  ok "[T3] o banco devolveu exatamente uma linha de JSON"
else
  bad "[T3] o transporte nao rodou: $(head -c 400 "$TMP/resposta.json.err")"
fi

if ler "$TMP/resposta.json" "$DIR" "$TMP/ler.err"; then
  ok "[T4] resposta valida aceita pelo leitor"
else
  bad "[T4] leitor recusou a resposta valida: $(head -c 300 "$TMP/ler.err")"
fi

for sqlf in "$TMP"/consultas/*.sql; do
  nome="$(basename "$sqlf" .sql)"
  P -v ON_ERROR_STOP=1 -A -F '|' -t -c "$(cat "$sqlf")" > "$DIR/$nome.psql" 2>"$DIR/$nome.err" || true
  if [ -f "$DIR/$nome.nuvem" ] && cmp -s "$DIR/$nome.psql" "$DIR/$nome.nuvem"; then
    ok "[T5:$nome] igual ao psql byte a byte"
  else
    bad "[T5:$nome] DIFERENTE do psql"
    printf '        psql : %s\n' "$(od -c "$DIR/$nome.psql" 2>/dev/null | head -c 300)"
    printf '        nuvem: %s\n' "$(od -c "$DIR/$nome.nuvem" 2>/dev/null | head -c 300)"
  fi
done

# T6: o prefixo EMITIDO trava escrita no lote inteiro — SQLSTATE, nao mensagem (idioma do servidor)
prefixo="$(sed 's/ WITH marca AS .*//' "$TMP/transporte.sql")"
saida6="$(P -v VERBOSITY=sqlstate -c "$prefixo INSERT INTO prova_escrita VALUES (1);" 2>&1)"
if printf '%s' "$saida6" | grep -qF '25006' && [ "$(P -A -t -c 'SELECT count(*) FROM prova_escrita')" = "0" ]; then
  ok "[T6] o prefixo emitido bloqueia a escrita (25006) e nada persiste"
else
  bad "[T6] escrita NAO bloqueada pelo prefixo: $(printf '%s' "$saida6" | head -c 300)"
fi

# T7: sem a trava, o banco diz `off` — e o leitor recusa em vez de aceitar leitura destravada
sed 's/^SET TRANSACTION READ ONLY; //' "$TMP/transporte.sql" > "$TMP/sem-trava.sql"
if roda_transporte "$TMP/sem-trava.sql" "$TMP/sem-trava.json" \
  && ! ler "$TMP/sem-trava.json" "$TMP/x7" "$TMP/ler7.err" && grep -qF 'TRANSPORTE_SOMENTE_LEITURA' "$TMP/ler7.err"; then
  ok "[T7] resposta sem a trava recusada (TRANSPORTE_SOMENTE_LEITURA)"
else
  bad "[T7] resposta sem a trava NAO foi recusada pelo motivo certo: $(head -c 300 "$TMP/ler7.err" 2>/dev/null)"
fi

# T8: um transporte que mandasse os statements SEPARADOS na mesma sessão. O `psql -f` faz isso:
# fatia no `;` e envia um por vez — o SET TRANSACTION sai com WARNING e não trava o SELECT.
separado="$(P -v ON_ERROR_STOP=1 -A -t -f "$TMP/transporte.sql" 2>"$TMP/separado.err")"
printf '%s\n' "$separado" | grep '^{' > "$TMP/separado.json"
if grep -qF 'WARNING' "$TMP/separado.err" && [ "$(wc -l < "$TMP/separado.json")" -eq 1 ] \
  && ! ler "$TMP/separado.json" "$TMP/x8" "$TMP/ler8.err" && grep -qF 'TRANSPORTE_SOMENTE_LEITURA' "$TMP/ler8.err"; then
  ok "[T8] statements separados: trava inerte detectada e recusada"
else
  bad "[T8] statements separados NAO foram recusados: $(head -c 300 "$TMP/ler8.err" 2>/dev/null)"
fi

# T9: um caractere a mais DENTRO do trecho marcado (SQL ainda valido) — o sql_md5 nao fecha
sed 's/ AS q)/ AS q )/' "$TMP/transporte.sql" > "$TMP/alterado.sql"
if ! cmp -s "$TMP/alterado.sql" "$TMP/transporte.sql" && roda_transporte "$TMP/alterado.sql" "$TMP/alterado.json" \
  && ! ler "$TMP/alterado.json" "$TMP/x9" "$TMP/ler9.err" && grep -qF 'TRANSPORTE_SQL_DIVERGENTE' "$TMP/ler9.err"; then
  ok "[T9] SQL alterado no caminho recusado (TRANSPORTE_SQL_DIVERGENTE)"
else
  bad "[T9] SQL alterado NAO foi recusado: $(head -c 300 "$TMP/ler9.err" 2>/dev/null)"
fi

# T10: um digito trocado na transcricao — o md5 do payload nao fecha
sed 's/1\.50/1.51/' "$TMP/resposta.json" > "$TMP/adulterada.json"
if ! cmp -s "$TMP/adulterada.json" "$TMP/resposta.json" \
  && ! ler "$TMP/adulterada.json" "$TMP/x10" "$TMP/ler10.err" && grep -qF 'TRANSPORTE_MD5' "$TMP/ler10.err"; then
  ok "[T10] payload adulterado recusado (TRANSPORTE_MD5)"
else
  bad "[T10] payload adulterado NAO foi recusado: $(head -c 300 "$TMP/ler10.err" 2>/dev/null)"
fi

echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" -eq 0 ] && [ "$PASS" -gt 0 ]
