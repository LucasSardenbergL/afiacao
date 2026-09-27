#!/usr/bin/env bash
# ╔═════════════════════════════════════════════════════════════════════════════════════════╗
# ║   PROVA PG17 — o passo seguinte da sonda SOBREVIVE ao `db:aplicar`                        ║
# ║   Rode:  bash db/test-sonda-passo-pelo-db-aplicar.sh > /tmp/t.log 2>&1; echo $?           ║
# ║          bash db/test-sonda-passo-pelo-db-aplicar.sh --falsificar                         ║
# ║   Exit:  0 verde · 1 asserção vermelha · 3 CONTROLE podre na falsificação (nada a julgar) ║
# ╚═════════════════════════════════════════════════════════════════════════════════════════╝
#
# O DEFEITO — medido duas vezes, no #2578 e no #2593 (docs/historico/ledger-diverge-com-deploy-no-
# trace.md, Lição 3). O PASSO 1 do `sonda:sql` dispara e DEVOLVE o passo 2 já escrito, com o mapa
# `edge → request_id` embutido, numa célula de SELECT. O caminho da sessão para esse disparo é o
# `db:aplicar`, e ele roda o arquivo DENTRO de `public.aplicar_sql()`, por `EXECUTE` — que descarta
# o resultado do SELECT. O disparo acontecia, o log trazia só BEGIN/SET/SET/FIM_APLICACAO_OK/COMMIT,
# e o cabeçalho mandava copiar o passo 2 "do log que o db:aplicar aponta no fim". As sessões
# contornaram com o passo 2 por ECO do slug (`--so-leitura`), que não alcança justamente os casos em
# que o mapa é insubstituível — bundle pré-sensor, 401, resposta sem eco — nem o modo CANÁRIA, que não
# ecoa nunca.
#
# A CORREÇÃO: o texto do passo seguinte sai TAMBÉM por NOTICE — o canal que o EXECUTE não engole —,
# entre marcadores, e o cabeçalho diz o canal de cada via. Esta prova roda o `scripts/db-aplicar.sh`
# REAL, com o `db/claude-rw-bootstrap.sql` REAL, contra stubs de `net.http_post`/`vault`, e prova:
#   E1 cada bloco de disparo (sonda e canária, passos 2 e 4) diz o COMANDO que extrai o passo do log;
#   E2 como o SQL Editor roda (um bloco, UMA transação): a célula e o NOTICE são o MESMO texto;
#   E3 pelo db:aplicar: o passo chega ao log, o comando do CABEÇALHO o extrai, o mapa é o DESTE
#      disparo, e o passo 2 julga PRE-SENSOR — veredito que só o mapa alcança (a resposta não ecoa o
#      slug); o passo 4 (trava fechada) julga INDETERMINADO;
#   E4 pelo `--ensaio`: o log TAMBÉM traz o passo, mas nada foi disparado e ele fica em AGUARDE para
#      sempre — é o aviso que o cabeçalho dá (use o log do apply de VERDADE);
#   E5 canária: os passos 2 e 4 chegam ao log com o id do disparo. Sem eco, é a ÚNICA via.
#
# Falsifica (`--falsificar`) sabotando os ARTEFATOS gerados — uma camada por vez, cada sabotagem com
# a MARCA esperada —, depois de um CONTROLE verde na MESMA invocação, nos dois idiomas do servidor: a
# palavra da severidade do NOTICE muda com o `lc_messages`, e a extração não pode depender dela.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091  # o gate roda sem -x; o helper é versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/pg-harness.sh"
PORT_BASE="${PGPORT_TEST:-5501}"
BOOT="$REPO_ROOT/db/claude-rw-bootstrap.sql"
APLICAR="$REPO_ROOT/scripts/db-aplicar.sh"
GERADOR="$REPO_ROOT/db/lib/gerar-sonda-disparo-prova.ts"
WORK="$(mktemp -d "/tmp/pgtest-sonda-passo-log.XXXXXX")"
mkdir -p "$WORK/tmp"

# O shell roda em C (o `pg_ctl` do macOS morre com "became multithreaded during startup" sob locale
# inválido). O idioma sob teste entra pelo `lc_messages` do cluster e pelo LC_ALL da chamada do
# `db-aplicar.sh` — nunca pelo shell. `LANGUAGE` sai: o gettext o prefere ao LC_ALL.
export LC_ALL=C LANG=C
unset LANGUAGE

FALSIFICAR=0
[ "${1:-}" = "--falsificar" ] && FALSIFICAR=1

PASS=0; FAIL=0; MARCAS=""; SILENCIO=0
ok()  { PASS=$((PASS + 1)); [ "$SILENCIO" -eq 1 ] || printf '  ✅ %s\n' "$1"; }
nok() { # <asserção> <MARCA> <detalhe>
  FAIL=$((FAIL + 1)); MARCAS="$MARCAS $2"
  [ "$SILENCIO" -eq 1 ] || printf '  ❌ %s — [%s] %s\n' "$1" "$2" "$3"
}

# SONDAS com resposta POSITIVA das duas dependências de fora do Postgres. `command -v` não basta:
# presente-porém-quebrada esvazia o guard igual (docs/historico/sonda-ausente-em-script-que-apaga.md).
SHA_VAZIO="e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
[ "$(printf '' | shasum -a 256 2>/dev/null | awk '{print $1}')" = "$SHA_VAZIO" ] || {
  echo "ERRO: 'shasum -a 256' não respondeu o hash conhecido da entrada vazia — o db-aplicar.sh"
  echo "  depende dele. Debian/Ubuntu: apt-get install -y perl"; exit 1; }
[ "$(bun -e 'process.stdout.write(String(6 * 7))' 2>/dev/null)" = "42" ] || {
  echo "ERRO: o bun não respondeu — é ele que roda o GERADOR deste disco."; exit 1; }

cleanup() {
  local d
  for d in "$WORK"/cluster-*/data; do
    [ -d "$d" ] || continue
    "$PGBIN/pg_ctl" -D "$d" -m immediate stop >/dev/null 2>&1 || true
  done
  rm -rf "$WORK"
}
trap cleanup EXIT

# ─── cluster ──────────────────────────────────────────────────────────────────────────────────
# `n` é o do modo normal (idioma do `LC_TESTE`, default C); a falsificação usa `c` e `pt`.
seleciona_cluster() { # <n|c|pt> — define CLUSTER, PORT, LOC_SRV, LOC_CLI, CDIR, DATA e SHIM
  case "$1" in
    n)  PORT="$PORT_BASE";       LOC_SRV="${LC_TESTE:-C}" ;;
    c)  PORT="$PORT_BASE";       LOC_SRV=C ;;
    pt) PORT=$((PORT_BASE + 1)); LOC_SRV=pt_BR.UTF-8 ;;
    *)  echo "ERRO interno: cluster desconhecido '$1'"; exit 1 ;;
  esac
  LOC_CLI="$LOC_SRV"
  CLUSTER="$1"; CDIR="$WORK/cluster-$1"; DATA="$CDIR/data"; SHIM="$CDIR/psql-rw"
}

adm() { "$PGBIN/psql" -X -q -v ON_ERROR_STOP=1 -h localhost -p "$PORT" -U postgres -d postgres "$@"; }
# escalar devolve o STATUS do psql: leitura que falhou não pode virar valor vazio que "confere".
escalar() { adm -A -t -c "$1" 2>/dev/null; }

# Por TCP, com `-k` num diretório do cluster: sem ele o postmaster tenta o socket no default
# COMPILADO (/var/run/postgresql no PGDG) e não sobe no runner — a lição do db/test-db-aplicar.sh.
sobe_cluster() {
  mkdir -p "$CDIR"
  if ! "$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C > "$CDIR/initdb.log" 2>&1; then
    echo "ERRO: initdb falhou (cluster $CLUSTER, PGBIN=$PGBIN)"; tail -c 800 "$CDIR/initdb.log"; exit 1
  fi
  if ! "$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k $CDIR -c listen_addresses=localhost -c lc_messages=$LOC_SRV" \
         -l "$CDIR/pg.log" -w start > "$CDIR/pgctl.log" 2>&1; then
    echo "ERRO: o cluster $CLUSTER não subiu na porta $PORT com lc_messages=$LOC_SRV (PGBIN=$PGBIN)"
    echo "── pg_ctl ──"; tail -c 400 "$CDIR/pgctl.log"
    echo "── postmaster ──"; tail -c 800 "$CDIR/pg.log" 2>/dev/null
    exit 1
  fi
  # O mínimo do Supabase que o bootstrap referencia — a MESMA fixture do db/test-db-aplicar.sh.
  if ! adm > "$CDIR/fixture.log" 2>&1 <<'SQL'
CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULL::uuid $$;
CREATE TYPE public.app_role AS ENUM ('master','employee','customer');
CREATE TABLE public.user_roles (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id uuid NOT NULL,
  role public.app_role NOT NULL
);
SQL
  then
    echo "ERRO: a fixture do Supabase falhou no cluster $CLUSTER"; tail -c 600 "$CDIR/fixture.log"; exit 1
  fi
  if ! { adm -f "$BOOT" > "$CDIR/boot.log" 2>&1 && grep -q 'BOOTSTRAP_OK' "$CDIR/boot.log"; }; then
    echo "ERRO: o db/claude-rw-bootstrap.sql não devolveu BOOTSTRAP_OK"; tail -c 600 "$CDIR/boot.log"; exit 1
  fi
  # STUBS de pg_net e vault. O `http_post` enfileira numa tabela e devolve o id de uma SEQUÊNCIA —
  # como o de verdade, o id não volta no ROLLBACK (é isso que o E4 mede), e cada disparo tem o seu.
  if ! adm > "$CDIR/stubs.log" 2>&1 <<'SQL'
CREATE SCHEMA net;
CREATE TABLE net._http_response (
  id bigint PRIMARY KEY,
  status_code integer,
  content_type text,
  headers jsonb,
  content text,
  timed_out boolean,
  error_msg text,
  created timestamptz NOT NULL DEFAULT now()
);
CREATE SEQUENCE net.fila_de_mentira_seq START 5001;
CREATE TABLE net.fila_de_mentira (id bigint PRIMARY KEY, url text NOT NULL, headers jsonb, body jsonb);
CREATE FUNCTION net.http_post(
  url text,
  headers jsonb DEFAULT '{}'::jsonb,
  body jsonb DEFAULT '{}'::jsonb,
  timeout_milliseconds integer DEFAULT 5000
) RETURNS bigint LANGUAGE sql AS $$
  INSERT INTO net.fila_de_mentira (id, url, headers, body)
  VALUES (nextval('net.fila_de_mentira_seq'), url, headers, body)
  RETURNING id
$$;
CREATE SCHEMA vault;
CREATE TABLE vault.decrypted_secrets (name text, decrypted_secret text);
INSERT INTO vault.decrypted_secrets VALUES ('CRON_SECRET', 'segredo-de-mentira');
SQL
  then
    echo "ERRO: os stubs de net/vault falharam no cluster $CLUSTER"; tail -c 600 "$CDIR/stubs.log"; exit 1
  fi
  # o "psql-rw" que aponta para o cluster, como claude_rw — o canal que o db-aplicar.sh usa
  { echo '#!/usr/bin/env bash'
    echo "exec env PSQLRC=/dev/null $PGBIN/psql -h localhost -p $PORT -U claude_rw -d postgres \"\$@\""
  } > "$SHIM"
  chmod +x "$SHIM"
}

derruba_cluster() { "$PGBIN/pg_ctl" -D "$DATA" -m immediate stop >/dev/null 2>&1 || true; }

# ─── artefatos ────────────────────────────────────────────────────────────────────────────────
# Gerados PELO GERADOR DESTE DISCO (não por um retrato commitado): a prova envelhece junto com ele.
gera_artefatos() { # <dir>
  if ! bun "$GERADOR" "$1" > "$WORK/gerador.log" 2>&1; then
    echo "ERRO: o gerador não emitiu os artefatos"; tail -c 800 "$WORK/gerador.log"; exit 1
  fi
  local f
  for f in sonda.sql canaria.sql meta.env; do
    [ -s "$1/$f" ] || { echo "ERRO: o gerador não escreveu $1/$f"; exit 1; }
  done
}

# O `db-aplicar.sh` exige o arquivo COMMITADO no repo do diretório corrente (o ledger guarda sha +
# commit). A prova não suja o repo de verdade: commita os artefatos num repo DESCARTÁVEL e roda o
# executor REAL de dentro dele.
REPO_TMP="$WORK/repo"
git_tmp() {
  git -C "$REPO_TMP" -c core.hooksPath=/dev/null -c commit.gpgsign=false \
    -c user.name=prova -c user.email=prova@prova.invalid "$@"
}
commita_artefatos() { # <dir> <rótulo>
  mkdir -p "$REPO_TMP/db"
  [ -d "$REPO_TMP/.git" ] || git init -q "$REPO_TMP"
  cp "$1/sonda.sql" "$1/canaria.sql" "$REPO_TMP/db/"
  git_tmp add db/sonda.sql db/canaria.sql
  git_tmp commit -q --allow-empty -m "artefatos $2"
}

# aplica <arquivo> [--ensaio] — o executor REAL. Define APLICA_RC, APLICA_OUT e APLICA_LOG (o
# caminho que ele anuncia em `log: …`, que é o que o cabeçalho manda o operador ler).
aplica() {
  local r=0
  APLICA_OUT="$WORK/aplica.out"
  ( cd "$REPO_TMP" && LC_ALL="$LOC_CLI" LANG="$LOC_CLI" TMPDIR="$WORK/tmp" AFIACAO_PSQL_RW="$SHIM" \
      bash "$APLICAR" "$@" ) > "$APLICA_OUT" 2>&1 || r=$?
  APLICA_RC="$r"
  APLICA_LOG="$(sed -n 's/^[[:space:]]*log: //p' "$APLICA_OUT" | tail -n 1)"
}

# comando_do_cabecalho <passo> <arquivo> — a parte `awk '…'` do comando que o CABEÇALHO do bloco manda
# rodar sobre o log. A prova executa ESTE texto, e não uma cópia dele: o que se prova é que a
# instrução que o operador lê funciona.
comando_do_cabecalho() {
  grep -m1 -E "^--[[:space:]]+awk '.*SONDA_PASSO_$1_INICIO" "$2" \
    | sed -E 's/^--[[:space:]]+//; s/[[:space:]]+<log>[[:space:]]*\|.*$//'
}
extrai() { # <passo> <arquivo_com_cabecalho> <log> — roda o comando do cabeçalho sobre o log
  local cmd
  cmd="$(comando_do_cabecalho "$1" "$2")" || return 2
  [ -n "$cmd" ] || return 2
  bash -c "$cmd \"\$1\"" _ "$3"
}

# O founder cola UM bloco por Run, e o SQL Editor roda o lote numa transação só (medido — deploy.md).
# Um bloco por vez é também o que deixa a célula recortável: o `psql -A -t` separa RESULTADOS com
# `\n`, e a célula é multilinha (medido 2026-09-27: duas células viram um texto só).
separa_blocos() { # <arquivo> <prefixo> — o bloco do PASSO 1 e o do PASSO 3, cada um no seu arquivo
  awk -v p1="$2.bloco1.sql" -v p3="$2.bloco3.sql" '
    /^-- PASSO 3 / { alvo = p3 }
    { print > (alvo == "" ? p1 : alvo) }' "$1"
}
editor() { # <bloco> <prefixo> — a célula em <prefixo>.out, o NOTICE em <prefixo>.err
  "$PGBIN/psql" -X -q -1 -v ON_ERROR_STOP=1 -A -t -h localhost -p "$PORT" -U postgres -d postgres \
    -f "$1" > "$2.out" 2> "$2.err"
}

# julgamento do passo extraído: devolve as linhas `chave|request_id|…|veredito` (o SELECT final dos
# dois modos tem a chave na 1ª coluna, o id na 2ª e o veredito na última).
roda_passo() { adm -A -t -F'|' -f "$1" > "$2" 2>&1; }
campo_da_linha() { # <arquivo_de_linhas> <chave> <campo: id|veredito>
  awk -F'|' -v k="$2" -v c="$3" '$1 == k { print (c == "id" ? $2 : $NF); exit }' "$1"
}
tem() { grep -qF -- "$2" <<<"$1"; }

# ─── o julgamento ─────────────────────────────────────────────────────────────────────────────
julga() { # <dir_artefatos> <rótulo> — E1…E5; cada falha soma a sua MARCA em MARCAS
  local d="$1" rot="$2" arq p cmd antes id_a id_b n v l
  # shellcheck source=/dev/null  # meta.env é escrito pelo gerador nesta execução
  . "$d/meta.env"

  # E1 ─ o cabeçalho de cada bloco de disparo diz o comando que extrai o passo do log
  for arq in sonda canaria; do
    for p in 2 4; do
      if cmd="$(comando_do_cabecalho "$p" "$d/$arq.sql")" && [ -n "$cmd" ]; then
        ok "E1 [$arq] o cabeçalho manda extrair o PASSO $p do log do db:aplicar"
      else
        nok "E1 [$arq] o cabeçalho manda extrair o PASSO $p" CABECALHO_SEM_COMANDO \
          "nenhuma linha \`-- awk '…SONDA_PASSO_${p}_INICIO…' <log> | …\`"
      fi
    done
  done

  # E2 ─ como o SQL Editor roda: a CÉLULA e o NOTICE são o MESMO texto, na MESMA execução
  for arq in sonda canaria; do
    separa_blocos "$d/$arq.sql" "$d/$arq"
    for p in 2 4; do
      l="$d/$arq.ed$p"
      if ! editor "$d/$arq.bloco$((p - 1)).sql" "$l"; then
        nok "E2 [$arq] o bloco do passo $((p - 1)) roda numa transação" EDITOR_FALHOU "$(head -c 300 "$l.err")"
        continue
      fi
      if ! extrai "$p" "$d/$arq.sql" "$l.err" > "$l.notice" 2> "$l.xerr" || [ ! -s "$l.notice" ]; then
        nok "E2 [$arq] o NOTICE do passo $p sai na execução do bloco" SEM_NOTICE_NO_EDITOR "$(head -c 200 "$l.xerr")"
        continue
      fi
      # `$(cat …)` tira só as quebras do FIM: o psql fecha cada resultado com `\n`. O miolo é
      # comparado byte a byte.
      if [ -s "$l.out" ] && [ "$(cat "$l.out")" = "$(cat "$l.notice")" ]; then
        ok "E2 [$arq] a célula do passo $p e o NOTICE são o MESMO texto ($(wc -c < "$l.notice" | tr -d ' ') bytes)"
      else
        nok "E2 [$arq] a célula do passo $p é o texto do NOTICE" CELULA_DIFERE_DO_NOTICE \
          "célula $(wc -c < "$l.out" | tr -d ' ') bytes × NOTICE $(wc -c < "$l.notice" | tr -d ' ') bytes"
      fi
    done
  done

  # Os bytes de uma rodada podem repetir os da anterior (sabotagem que só toca um arquivo): o
  # ledger descartável é zerado para "já aplicado" (exit 3) não se passar por veredito.
  escalar "DELETE FROM public.db_aplicacoes" > /dev/null || { echo "ERRO: não consegui zerar o ledger"; exit 1; }
  commita_artefatos "$d" "$rot"

  # E3 ─ pelo db:aplicar REAL
  antes="$(escalar "SELECT coalesce(max(id), 0) FROM net.fila_de_mentira")" || antes="ERRO"
  aplica db/sonda.sql
  if [ "$APLICA_RC" = 0 ] && grep -q 'APLICADO' "$APLICA_OUT"; then
    ok "E3 o db:aplicar aplica o PASSO 1+3 (exit 0, APLICADO)"
  else
    nok "E3 o db:aplicar aplica o PASSO 1+3" APPLY_FALHOU "rc=$APLICA_RC: $(tail -c 300 "$APLICA_OUT")"
  fi
  if [ -n "$APLICA_LOG" ] && [ -f "$APLICA_LOG" ]; then
    ok "E3 o db:aplicar anuncia o log (\`log: …\`)"
  else
    nok "E3 o db:aplicar anuncia o log" SEM_LOG "$(tail -c 300 "$APLICA_OUT")"
    APLICA_LOG="/dev/null"
  fi
  # O defeito em si, medido SEM passar pelo cabeçalho: o texto do passo embutido está no log?
  n="$(grep -c 'EMBUTIDO aqui' "$APLICA_LOG" || true)"
  if [ "$n" -ge 2 ]; then
    ok "E3 o texto dos passos 2 e 4 CHEGA ao log do db:aplicar"
  else
    nok "E3 o texto dos passos 2 e 4 chega ao log" SEM_PASSO_NO_LOG \
      "$n de 2 — o log tem: $(tr '\n' '|' < "$APLICA_LOG" | head -c 200)"
  fi
  for p in 2 4; do
    if extrai "$p" "$d/sonda.sql" "$APLICA_LOG" > "$d/log.p$p.sql" 2> "$d/log.p$p.err" && [ -s "$d/log.p$p.sql" ]; then
      ok "E3 o comando do CABEÇALHO extrai o passo $p do log"
    else
      nok "E3 o comando do cabeçalho extrai o passo $p do log" EXTRACAO_FALHOU "$(head -c 200 "$d/log.p$p.err")"
    fi
  done
  id_a="$(escalar "SELECT id FROM net.fila_de_mentira WHERE id > $antes AND url LIKE '%/sonda-a'")" || id_a=""
  id_b="$(escalar "SELECT id FROM net.fila_de_mentira WHERE id > $antes AND url LIKE '%/sonda-b'")" || id_b=""
  n="$(escalar "SELECT count(*) FROM net.fila_de_mentira WHERE id > $antes AND url LIKE '%/sonda-c'")" || n="ERRO"
  if [ -n "$id_a" ] && [ -n "$id_b" ] && [ "$n" = 0 ]; then
    ok "E3 disparou as baratas ($id_a, $id_b) e a trava segurou a cara"
  else
    nok "E3 disparou as baratas e a trava segurou a cara" DISPARO_ERRADO "a=$id_a b=$id_b c=$n"
  fi
  if [ -n "$id_a" ] && [ -n "$id_b" ]; then
    # sonda-a responde a sonda de VERDADE (eco completo); sonda-b é um bundle PRÉ-SENSOR: 200 com o
    # fluxo real e SEM eco nenhum — invisível para o caminho do eco, alcançável só pelo id do mapa.
    escalar "INSERT INTO net._http_response (id, status_code, content) VALUES
      ($id_a, 200, '{\"probe\":true,\"edge\":\"sonda-a\",\"versao\":\"$VERSAO_A\",\"fonte\":\"$FONTE_A\"}'),
      ($id_b, 200, '{\"ok\":true,\"processados\":3}')" > /dev/null || true
  fi
  roda_passo "$d/log.p2.sql" "$d/log.p2.linhas" || true
  roda_passo "$d/log.p4.sql" "$d/log.p4.linhas" || true
  v="$(campo_da_linha "$d/log.p2.linhas" sonda-a id)"
  if [ -n "$id_a" ] && [ "$v" = "$id_a" ] && [ "$(campo_da_linha "$d/log.p2.linhas" sonda-b id)" = "$id_b" ]; then
    ok "E3 o mapa que o log traz é o DESTE disparo (sonda-a → $id_a, sonda-b → $id_b)"
  else
    nok "E3 o mapa do log é o deste disparo" MAPA_AUSENTE "passo 2 julgou sonda-a com id='$v' (disparo: '$id_a')"
  fi
  v="$(campo_da_linha "$d/log.p2.linhas" sonda-a veredito)"
  if tem "$v" 'DEPLOY CONFIRMADO'; then
    ok "E3 o passo 2 do log julga sonda-a: DEPLOY CONFIRMADO"
  else
    nok "E3 o passo 2 do log julga sonda-a" VEREDITO_ERRADO "veio: $(head -c 160 <<<"$v")"
  fi
  v="$(campo_da_linha "$d/log.p2.linhas" sonda-b veredito)"
  if tem "$v" 'PRE-SENSOR'; then
    ok "E3 o passo 2 do log julga sonda-b: PRE-SENSOR — o veredito que só o MAPA alcança"
  else
    nok "E3 o passo 2 do log julga sonda-b (sem eco)" VEREDITO_ERRADO "veio: $(head -c 160 <<<"$v")"
  fi
  v="$(campo_da_linha "$d/log.p4.linhas" sonda-c veredito)"
  if tem "$v" 'INDETERMINADO' && [ -z "$(campo_da_linha "$d/log.p4.linhas" sonda-c id)" ]; then
    ok "E3 o passo 4 do log julga sonda-c: INDETERMINADO (trava fechada, id nulo)"
  else
    nok "E3 o passo 4 do log julga sonda-c" TRAVA_SEM_INDETERMINADO "veio: $(head -c 160 <<<"$v")"
  fi

  # E4 ─ o --ensaio: o NOTICE sai antes do ROLLBACK, o disparo não
  antes="$(escalar "SELECT coalesce(max(id), 0) FROM net.fila_de_mentira")" || antes="ERRO"
  aplica db/sonda.sql --ensaio
  if [ "$APLICA_RC" = 0 ] && grep -q 'ENSAIO ok' "$APLICA_OUT"; then
    ok "E4 o --ensaio roda inteiro (exit 0, ENSAIO ok)"
  else
    nok "E4 o --ensaio roda inteiro" ENSAIO_FALHOU "rc=$APLICA_RC: $(tail -c 300 "$APLICA_OUT")"
  fi
  n="$(escalar "SELECT count(*) FROM net.fila_de_mentira WHERE id > $antes")" || n="ERRO"
  if [ "$n" = 0 ]; then
    ok "E4 o --ensaio não disparou nada (a fila voltou no ROLLBACK)"
  else
    nok "E4 o --ensaio não dispara" ENSAIO_DISPAROU "$n linha(s) na fila"
  fi
  [ -n "$APLICA_LOG" ] && [ -f "$APLICA_LOG" ] || APLICA_LOG="/dev/null"
  if extrai 2 "$d/sonda.sql" "$APLICA_LOG" > "$d/ens.p2.sql" 2> "$d/ens.p2.err" && [ -s "$d/ens.p2.sql" ] \
     && roda_passo "$d/ens.p2.sql" "$d/ens.p2.linhas"; then
    v="$(campo_da_linha "$d/ens.p2.linhas" sonda-a veredito)"
    if tem "$v" 'AGUARDE' && tem "$(campo_da_linha "$d/ens.p2.linhas" sonda-b veredito)" 'AGUARDE'; then
      ok "E4 o log do --ensaio TAMBÉM traz o passo 2 — e ele fica em AGUARDE para sempre"
    else
      nok "E4 o passo 2 do --ensaio fica em AGUARDE" ENSAIO_NAO_AGUARDA "veio: $(head -c 160 <<<"$v")"
    fi
  else
    nok "E4 o log do --ensaio traz o passo 2" ENSAIO_SEM_PASSO "$(head -c 200 "$d/ens.p2.err")"
  fi

  # E5 ─ a canária pelo db:aplicar: sem eco de slug, o mapa do log é a ÚNICA via
  antes="$(escalar "SELECT coalesce(max(id), 0) FROM net.fila_de_mentira")" || antes="ERRO"
  aplica db/canaria.sql
  if [ "$APLICA_RC" = 0 ] && grep -q 'APLICADO' "$APLICA_OUT"; then
    ok "E5 o db:aplicar aplica o disparo das canárias (exit 0, APLICADO)"
  else
    nok "E5 o db:aplicar aplica o disparo das canárias" CANARIA_APPLY_FALHOU "rc=$APLICA_RC: $(tail -c 300 "$APLICA_OUT")"
  fi
  [ -n "$APLICA_LOG" ] && [ -f "$APLICA_LOG" ] || APLICA_LOG="/dev/null"
  n="$(grep -c 'EMBUTIDO aqui' "$APLICA_LOG" || true)"
  if [ "$n" -ge 2 ]; then
    ok "E5 o texto dos passos 2 e 4 da canária CHEGA ao log"
  else
    nok "E5 o texto dos passos da canária chega ao log" CANARIA_SEM_PASSO_NO_LOG "$n de 2"
  fi
  for p in 2 4; do
    if extrai "$p" "$d/canaria.sql" "$APLICA_LOG" > "$d/can.p$p.sql" 2> "$d/can.p$p.err" && [ -s "$d/can.p$p.sql" ]; then
      ok "E5 o comando do CABEÇALHO extrai o passo $p da canária"
    else
      nok "E5 o comando do cabeçalho extrai o passo $p da canária" CANARIA_EXTRACAO_FALHOU "$(head -c 200 "$d/can.p$p.err")"
    fi
    roda_passo "$d/can.p$p.sql" "$d/can.p$p.linhas" || true
  done
  v="$(campo_da_linha "$d/can.p2.linhas" "$CANARIA_BARATA" id)"
  n="$(escalar "SELECT count(*) FROM net.fila_de_mentira WHERE id > $antes AND id = ${v:-0}")" || n="ERRO"
  if [ -n "$v" ] && [ "$n" = 1 ] && tem "$(campo_da_linha "$d/can.p2.linhas" "$CANARIA_BARATA" veredito)" 'AGUARDE'; then
    ok "E5 o passo 2 da canária traz o id DESTE disparo ($CANARIA_BARATA → $v) e aguarda a resposta"
  else
    nok "E5 o passo 2 da canária traz o id deste disparo" CANARIA_MAPA_AUSENTE "id='$v', na fila=$n"
  fi
  v="$(campo_da_linha "$d/can.p4.linhas" "$CANARIA_CARA" veredito)"
  if tem "$v" 'INDETERMINADO' && [ -z "$(campo_da_linha "$d/can.p4.linhas" "$CANARIA_CARA" id)" ]; then
    ok "E5 o passo 4 da canária julga $CANARIA_CARA: INDETERMINADO (trava fechada)"
  else
    nok "E5 o passo 4 da canária julga a cara" CANARIA_TRAVA_SEM_INDETERMINADO "veio: $(head -c 160 <<<"$v")"
  fi
}

# ═════════════════════════════════════════════════════════════════════════════════════════════
if [ "$FALSIFICAR" -eq 0 ]; then
  seleciona_cluster n
  sobe_cluster
  gera_artefatos "$WORK/pristino"
  echo "▶ cluster lc_messages=$LOC_SRV · artefatos do gerador deste disco"
  julga "$WORK/pristino" normal
  echo
  echo "RESULTADO: $PASS ok / $FAIL fail"
  [ "$FAIL" -eq 0 ]
  exit $?
fi

# ─── falsificação ─────────────────────────────────────────────────────────────────────────────
# Cada sabotagem: <id> | <arquivo(s): sonda, canaria ou ambos> | <MARCA esperada> | <expressão sed -E>
# O sed atua sobre uma CÓPIA dos artefatos; sabotagem que não muda byte nenhum é FALHA (não
# "vermelha"): mediria o próprio harness. Uma camada por vez — a que fica VERDE é redundante ou
# inalcançada.
SABOTAGENS=(
  "s1|ambos|SEM_PASSO_NO_LOG|s/RAISE NOTICE/RAISE DEBUG/"
  "s2|ambos|SEM_PASSO_NO_LOG|s/^([[:space:]]*)RAISE NOTICE .*$/\\1NULL;/"
  "s3|ambos|CELULA_DIFERE_DO_NOTICE|s/RETURN p_texto;/RETURN left(p_texto, 200);/"
  "s4|sonda|MAPA_AUSENTE|s/^\\\$sonda\\\$, m\\.ids\\)\$/\$sonda\$, '{}')/"
  "s5|sonda|EXTRACAO_FALHOU|s/'SONDA_PASSO_2_FIM'/'SONDA_PASSO_2_FIX'/"
  "s6|ambos|CABECALHO_SEM_COMANDO|/^--[[:space:]]+awk '/d"
  "s7|canaria|CANARIA_SEM_PASSO_NO_LOG|s/RAISE NOTICE/RAISE DEBUG/"
)
DESCRICAO=(
  "o NOTICE rebaixado a DEBUG — abaixo do client_min_messages, não sai da sessão"
  "a função não levanta nada — a forma do defeito original: só a célula, que o EXECUTE descarta"
  "a célula deixa de ser o texto do NOTICE (a função devolve outro)"
  "o mapa não entra no texto (format recebe {}) — o passo chega, mas sem o que o faz insubstituível"
  "o marcador de FIM que a função emite não é o que o cabeçalho procura"
  "o cabeçalho deixa de dizer o comando que extrai o passo"
  "só a CANÁRIA perde o NOTICE — a marca dela não pode pegar carona na da sonda"
)

gera_artefatos "$WORK/pristino"
SILENCIO=1
VERM=0; FALHAS=0
for cl in c pt; do
  seleciona_cluster "$cl"
  sobe_cluster
  PASS=0; FAIL=0; MARCAS=""
  julga "$WORK/pristino" "controle-$cl"
  if [ "$FAIL" -ne 0 ] || [ "$PASS" -lt 20 ]; then
    echo "CONTROLE PODRE (lc_messages=$LOC_SRV): $PASS ok / $FAIL fail —$MARCAS"
    echo "Sem controle verde, vermelho de sabotagem não prova nada. Nada a julgar."
    exit 3
  fi
  echo "  ✅ controle verde (lc_messages=$LOC_SRV): $PASS asserts, 0 falhas"
  for i in "${!SABOTAGENS[@]}"; do
    IFS='|' read -r sid alvo marca expr <<<"${SABOTAGENS[$i]}"
    dir="$WORK/sab-$sid-$cl"
    rm -rf "$dir"; cp -R "$WORK/pristino" "$dir"
    mudou=0
    for arq in sonda canaria; do
      case "$alvo" in ambos|"$arq") ;; *) continue ;; esac
      sed -E "$expr" "$dir/$arq.sql" > "$dir/$arq.sab"
      cmp -s "$dir/$arq.sql" "$dir/$arq.sab" || mudou=1
      mv "$dir/$arq.sab" "$dir/$arq.sql"
    done
    if [ "$mudou" -eq 0 ]; then
      FALHAS=$((FALHAS + 1))
      echo "  ⚠️  $sid ($LOC_SRV) NÃO APLICOU — a expressão não casou nada: ${DESCRICAO[$i]}"
      continue
    fi
    PASS=0; FAIL=0; MARCAS=""
    julga "$dir" "$sid-$cl"
    if [[ " $MARCAS " == *" $marca "* ]]; then
      VERM=$((VERM + 1))
      echo "  🔴 $sid ($LOC_SRV) VERMELHA [$marca] — ${DESCRICAO[$i]}"
    else
      FALHAS=$((FALHAS + 1))
      echo "  ⚠️  $sid ($LOC_SRV) sem a marca [$marca] (veio:${MARCAS:- nenhuma}) — ${DESCRICAO[$i]}"
    fi
  done
  derruba_cluster
done
echo
echo "SABOTAGENS: $VERM vermelhas / $FALHAS falhas"
[ "$FALHAS" -eq 0 ]
