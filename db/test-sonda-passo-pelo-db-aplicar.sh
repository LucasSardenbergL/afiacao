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
# os asserts que TÊM de acusá-la e os que TÊM de seguir verdes (o idioma de
# scripts/falsificar-exige-assert-gate.ts) —, depois de um CONTROLE verde na MESMA invocação, nos dois
# idiomas do servidor: a palavra da severidade do NOTICE muda com o `lc_messages`, e a extração não
# pode depender dela.
set -euo pipefail
# fd 3 = a saída de verdade: o julgamento da falsificação vai para um log por rodada, e erro de
# HARNESS dentro dele não pode morrer calado nesse log.
exec 3>&1

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

# Cada assert tem um ID estável, impresso nas DUAS saídas: é por ele que a falsificação confere que a
# sabotagem foi acusada pelo assert DECLARADO, e não por um vermelho qualquer.
PASS=0; FAIL=0
ok()  { PASS=$((PASS + 1)); printf '  ✓ (%s) %s\n' "$1" "$2"; }           # <ID> <asserção>
nok() { FAIL=$((FAIL + 1)); printf '  ✗ (%s) %s — %s\n' "$1" "$2" "$3"; }  # <ID> <asserção> <detalhe>

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
# Executa SEMPRE os 32 asserts — nenhum `continue` pula assert dependente. A contagem faz parte do
# juízo da falsificação: rodada que executa menos que o controle é vermelho de ABORTO, não de assert.
julga() { # <dir_artefatos> <rótulo>
  local d="$1" rot="$2" arq sigla p cmd antes id_a id_b n v l
  # shellcheck source=/dev/null  # meta.env é escrito pelo gerador nesta execução
  . "$d/meta.env"

  # E1 ─ o cabeçalho de cada bloco de disparo diz o comando que extrai o passo do log
  for arq in sonda canaria; do
    sigla=S; [ "$arq" = sonda ] || sigla=C
    for p in 2 4; do
      if cmd="$(comando_do_cabecalho "$p" "$d/$arq.sql")" && [ -n "$cmd" ]; then
        ok "C_$sigla$p" "E1 [$arq] o cabeçalho manda extrair o PASSO $p do log do db:aplicar"
      else
        nok "C_$sigla$p" "E1 [$arq] o cabeçalho manda extrair o PASSO $p" \
          "nenhuma linha \`-- awk '…SONDA_PASSO_${p}_INICIO…' <log> | …\`"
      fi
    done
  done

  # E2 ─ como o SQL Editor roda: a CÉLULA e o NOTICE são o MESMO texto, na MESMA execução
  for arq in sonda canaria; do
    sigla=S; [ "$arq" = sonda ] || sigla=C
    separa_blocos "$d/$arq.sql" "$d/$arq"
    for p in 2 4; do
      l="$d/$arq.ed$p"
      : > "$l.notice"
      if editor "$d/$arq.bloco$((p - 1)).sql" "$l" \
         && extrai "$p" "$d/$arq.sql" "$l.err" > "$l.notice" 2> "$l.xerr" && [ -s "$l.notice" ]; then
        ok "N_$sigla$p" "E2 [$arq] o bloco do passo $((p - 1)) roda numa transação e o NOTICE do passo $p sai"
      else
        nok "N_$sigla$p" "E2 [$arq] o NOTICE do passo $p sai na execução do bloco" \
          "$(cat "$l.err" "$l.xerr" 2>/dev/null | head -c 200 | tr '\n' ' ')"
      fi
      # `$(cat …)` tira só as quebras do FIM: o psql fecha cada resultado com `\n`. O miolo é
      # comparado byte a byte.
      if [ -s "$l.out" ] && [ -s "$l.notice" ] && [ "$(cat "$l.out")" = "$(cat "$l.notice")" ]; then
        ok "D_$sigla$p" "E2 [$arq] a célula do passo $p e o NOTICE são o MESMO texto ($(wc -c < "$l.notice" | tr -d ' ') bytes)"
      else
        nok "D_$sigla$p" "E2 [$arq] a célula do passo $p é o texto do NOTICE" \
          "célula $(wc -c < "$l.out" 2>/dev/null | tr -d ' ') bytes × NOTICE $(wc -c < "$l.notice" | tr -d ' ') bytes"
      fi
    done
  done

  # Os bytes de uma rodada podem repetir os da anterior (sabotagem que só toca um arquivo): o
  # ledger descartável é zerado para "já aplicado" (exit 3) não se passar por veredito.
  escalar "DELETE FROM public.db_aplicacoes" > /dev/null \
    || { echo "ERRO: não consegui zerar o ledger do cluster $CLUSTER" >&3; exit 1; }
  commita_artefatos "$d" "$rot" \
    || { echo "ERRO: não consegui commitar os artefatos no repo descartável" >&3; exit 1; }

  # E3 ─ pelo db:aplicar REAL
  antes="$(escalar "SELECT coalesce(max(id), 0) FROM net.fila_de_mentira")" || antes="ERRO"
  aplica db/sonda.sql
  if [ "$APLICA_RC" = 0 ] && grep -q 'APLICADO' "$APLICA_OUT"; then
    ok A3_APLICA "E3 o db:aplicar aplica o PASSO 1+3 (exit 0, APLICADO)"
  else
    nok A3_APLICA "E3 o db:aplicar aplica o PASSO 1+3" "rc=$APLICA_RC: $(tail -c 300 "$APLICA_OUT")"
  fi
  if [ -n "$APLICA_LOG" ] && [ -f "$APLICA_LOG" ]; then
    ok A3_LOG "E3 o db:aplicar anuncia o log (\`log: …\`)"
  else
    nok A3_LOG "E3 o db:aplicar anuncia o log" "$(tail -c 300 "$APLICA_OUT")"
    APLICA_LOG="/dev/null"
  fi
  # O defeito em si, medido SEM passar pelo cabeçalho: o texto do passo embutido está no log?
  n="$(grep -c 'EMBUTIDO aqui' "$APLICA_LOG" || true)"
  if [ "$n" -ge 2 ]; then
    ok A3_TEXTO "E3 o texto dos passos 2 e 4 CHEGA ao log do db:aplicar"
  else
    nok A3_TEXTO "E3 o texto dos passos 2 e 4 chega ao log" \
      "$n de 2 — o log tem: $(tr '\n' '|' < "$APLICA_LOG" | head -c 200)"
  fi
  for p in 2 4; do
    if extrai "$p" "$d/sonda.sql" "$APLICA_LOG" > "$d/log.p$p.sql" 2> "$d/log.p$p.err" && [ -s "$d/log.p$p.sql" ]; then
      ok "A3_X$p" "E3 o comando do CABEÇALHO extrai o passo $p do log"
    else
      nok "A3_X$p" "E3 o comando do cabeçalho extrai o passo $p do log" "$(head -c 200 "$d/log.p$p.err")"
    fi
  done
  id_a="$(escalar "SELECT id FROM net.fila_de_mentira WHERE id > $antes AND url LIKE '%/sonda-a'")" || id_a=""
  id_b="$(escalar "SELECT id FROM net.fila_de_mentira WHERE id > $antes AND url LIKE '%/sonda-b'")" || id_b=""
  n="$(escalar "SELECT count(*) FROM net.fila_de_mentira WHERE id > $antes AND url LIKE '%/sonda-c'")" || n="ERRO"
  if [ -n "$id_a" ] && [ -n "$id_b" ] && [ "$n" = 0 ]; then
    ok A3_DISPARO "E3 disparou as baratas ($id_a, $id_b) e a trava segurou a cara"
  else
    nok A3_DISPARO "E3 disparou as baratas e a trava segurou a cara" "a=$id_a b=$id_b c=$n"
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
    ok A3_MAPA "E3 o mapa que o log traz é o DESTE disparo (sonda-a → $id_a, sonda-b → $id_b)"
  else
    nok A3_MAPA "E3 o mapa do log é o deste disparo" "passo 2 julgou sonda-a com id='$v' (disparo: '$id_a')"
  fi
  v="$(campo_da_linha "$d/log.p2.linhas" sonda-a veredito)"
  if tem "$v" 'DEPLOY CONFIRMADO'; then
    ok A3_VA "E3 o passo 2 do log julga sonda-a: DEPLOY CONFIRMADO"
  else
    nok A3_VA "E3 o passo 2 do log julga sonda-a" "veio: $(head -c 160 <<<"$v")"
  fi
  v="$(campo_da_linha "$d/log.p2.linhas" sonda-b veredito)"
  if tem "$v" 'PRE-SENSOR'; then
    ok A3_VB "E3 o passo 2 do log julga sonda-b: PRE-SENSOR — o veredito que só o MAPA alcança"
  else
    nok A3_VB "E3 o passo 2 do log julga sonda-b (sem eco)" "veio: $(head -c 160 <<<"$v")"
  fi
  v="$(campo_da_linha "$d/log.p4.linhas" sonda-c veredito)"
  if tem "$v" 'INDETERMINADO' && [ -z "$(campo_da_linha "$d/log.p4.linhas" sonda-c id)" ]; then
    ok A3_VC "E3 o passo 4 do log julga sonda-c: INDETERMINADO (trava fechada, id nulo)"
  else
    nok A3_VC "E3 o passo 4 do log julga sonda-c" "veio: $(head -c 160 <<<"$v")"
  fi

  # E4 ─ o --ensaio: o NOTICE sai antes do ROLLBACK, o disparo não
  antes="$(escalar "SELECT coalesce(max(id), 0) FROM net.fila_de_mentira")" || antes="ERRO"
  aplica db/sonda.sql --ensaio
  if [ "$APLICA_RC" = 0 ] && grep -q 'ENSAIO ok' "$APLICA_OUT"; then
    ok A4_ENSAIO "E4 o --ensaio roda inteiro (exit 0, ENSAIO ok)"
  else
    nok A4_ENSAIO "E4 o --ensaio roda inteiro" "rc=$APLICA_RC: $(tail -c 300 "$APLICA_OUT")"
  fi
  n="$(escalar "SELECT count(*) FROM net.fila_de_mentira WHERE id > $antes")" || n="ERRO"
  if [ "$n" = 0 ]; then
    ok A4_NADA "E4 o --ensaio não disparou nada (a fila voltou no ROLLBACK)"
  else
    nok A4_NADA "E4 o --ensaio não dispara" "$n linha(s) na fila"
  fi
  [ -n "$APLICA_LOG" ] && [ -f "$APLICA_LOG" ] || APLICA_LOG="/dev/null"
  if extrai 2 "$d/sonda.sql" "$APLICA_LOG" > "$d/ens.p2.sql" 2> "$d/ens.p2.err" && [ -s "$d/ens.p2.sql" ]; then
    ok A4_PASSO "E4 o log do --ensaio TAMBÉM traz o passo 2 (o NOTICE sai antes do ROLLBACK)"
  else
    nok A4_PASSO "E4 o log do --ensaio traz o passo 2" "$(head -c 200 "$d/ens.p2.err")"
  fi
  roda_passo "$d/ens.p2.sql" "$d/ens.p2.linhas" || true
  v="$(campo_da_linha "$d/ens.p2.linhas" sonda-a veredito)"
  if tem "$v" 'AGUARDE' && tem "$(campo_da_linha "$d/ens.p2.linhas" sonda-b veredito)" 'AGUARDE'; then
    ok A4_AGUARDE "E4 e o passo 2 do --ensaio fica em AGUARDE para sempre — o aviso do cabeçalho"
  else
    nok A4_AGUARDE "E4 o passo 2 do --ensaio fica em AGUARDE" "veio: $(head -c 160 <<<"$v")"
  fi

  # E5 ─ a canária pelo db:aplicar: sem eco de slug, o mapa do log é a ÚNICA via
  antes="$(escalar "SELECT coalesce(max(id), 0) FROM net.fila_de_mentira")" || antes="ERRO"
  aplica db/canaria.sql
  if [ "$APLICA_RC" = 0 ] && grep -q 'APLICADO' "$APLICA_OUT"; then
    ok A5_APLICA "E5 o db:aplicar aplica o disparo das canárias (exit 0, APLICADO)"
  else
    nok A5_APLICA "E5 o db:aplicar aplica o disparo das canárias" "rc=$APLICA_RC: $(tail -c 300 "$APLICA_OUT")"
  fi
  [ -n "$APLICA_LOG" ] && [ -f "$APLICA_LOG" ] || APLICA_LOG="/dev/null"
  n="$(grep -c 'EMBUTIDO aqui' "$APLICA_LOG" || true)"
  if [ "$n" -ge 2 ]; then
    ok A5_TEXTO "E5 o texto dos passos 2 e 4 da canária CHEGA ao log"
  else
    nok A5_TEXTO "E5 o texto dos passos da canária chega ao log" "$n de 2"
  fi
  for p in 2 4; do
    if extrai "$p" "$d/canaria.sql" "$APLICA_LOG" > "$d/can.p$p.sql" 2> "$d/can.p$p.err" && [ -s "$d/can.p$p.sql" ]; then
      ok "A5_X$p" "E5 o comando do CABEÇALHO extrai o passo $p da canária"
    else
      nok "A5_X$p" "E5 o comando do cabeçalho extrai o passo $p da canária" "$(head -c 200 "$d/can.p$p.err")"
    fi
    roda_passo "$d/can.p$p.sql" "$d/can.p$p.linhas" || true
  done
  v="$(campo_da_linha "$d/can.p2.linhas" "$CANARIA_BARATA" id)"
  n="$(escalar "SELECT count(*) FROM net.fila_de_mentira WHERE id > $antes AND id = ${v:-0}")" || n="ERRO"
  if [ -n "$v" ] && [ "$n" = 1 ] && tem "$(campo_da_linha "$d/can.p2.linhas" "$CANARIA_BARATA" veredito)" 'AGUARDE'; then
    ok A5_MAPA "E5 o passo 2 da canária traz o id DESTE disparo ($CANARIA_BARATA → $v) e aguarda a resposta"
  else
    nok A5_MAPA "E5 o passo 2 da canária traz o id deste disparo" "id='$v', na fila=$n"
  fi
  v="$(campo_da_linha "$d/can.p4.linhas" "$CANARIA_CARA" veredito)"
  if tem "$v" 'INDETERMINADO' && [ -z "$(campo_da_linha "$d/can.p4.linhas" "$CANARIA_CARA" id)" ]; then
    ok A5_TRAVA "E5 o passo 4 da canária julga $CANARIA_CARA: INDETERMINADO (trava fechada)"
  else
    nok A5_TRAVA "E5 o passo 4 da canária julga a cara" "veio: $(head -c 160 <<<"$v")"
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
# SABOTAGENS: <nome>:<VERMELHOS>[:<VERDES>] — os asserts que TÊM de acusar a sabotagem (`,` = E) e os
# que TÊM de seguir verdes: é o que prova que ela pegou a SUA camada, e não derrubou a rodada. Cada
# uma atua numa CÓPIA dos artefatos (`sabotar`), uma camada por vez — a que fica VERDE é redundante ou
# inalcançada.
SABOTAGENS="notice_debug:A3_TEXTO,A5_TEXTO:A3_APLICA,A3_DISPARO
            sem_raise:A3_TEXTO,A5_TEXTO:A3_APLICA,A3_DISPARO
            celula_outra:D_S2,D_S4,D_C2,D_C4:A3_TEXTO,A3_X2
            mapa_vazio:A3_MAPA:A3_TEXTO,A3_X2
            fim_trocado:A3_X2:A3_X4,A3_TEXTO
            cabecalho_mudo:C_S2,C_S4,C_C2,C_C4:A3_TEXTO
            canaria_debug:A5_TEXTO:A5_APLICA,A3_TEXTO"

descricao() {
  case "$1" in
    notice_debug)   echo "o NOTICE rebaixado a DEBUG — abaixo do client_min_messages, não sai da sessão" ;;
    sem_raise)      echo "a função não levanta nada — a forma do defeito original: só a célula, que o EXECUTE descarta" ;;
    celula_outra)   echo "a célula deixa de ser o texto do NOTICE (a função devolve outro)" ;;
    mapa_vazio)     echo "o mapa não entra no texto (format recebe {}) — o passo chega, sem o que o faz insubstituível" ;;
    fim_trocado)    echo "o marcador de FIM que a função emite não é o que o cabeçalho procura" ;;
    cabecalho_mudo) echo "o cabeçalho deixa de dizer o comando que extrai o passo" ;;
    canaria_debug)  echo "só a CANÁRIA perde o NOTICE — o assert dela não pega carona no da sonda" ;;
    *)              echo "(sem descrição)" ;;
  esac
}

# sabotar <nome> <dir> — aplica a sabotagem na CÓPIA dos artefatos. Status ≠0 = não aplicou: expressão
# que não muda byte nenhum mediria o próprio harness, não a prova.
sabotar() {
  local alvos expr arq mudou=1
  case "$1" in
    notice_debug)   alvos="sonda canaria"; expr='s/RAISE NOTICE/RAISE DEBUG/' ;;
    sem_raise)      alvos="sonda canaria"; expr='s/^([[:space:]]*)RAISE NOTICE .*$/\1NULL;/' ;;
    celula_outra)   alvos="sonda canaria"; expr='s/RETURN p_texto;/RETURN left(p_texto, 200);/' ;;
    mapa_vazio)     alvos="sonda";         expr="s/^\\\$sonda\\\$, m\\.ids\\)\$/\$sonda\$, '{}')/" ;;
    fim_trocado)    alvos="sonda";         expr="s/'SONDA_PASSO_2_FIM'/'SONDA_PASSO_2_FIX'/" ;;
    cabecalho_mudo) alvos="sonda canaria"; expr="/^--[[:space:]]+awk '/d" ;;
    canaria_debug)  alvos="canaria";       expr='s/RAISE NOTICE/RAISE DEBUG/' ;;
    *)              return 2 ;;
  esac
  for arq in $alvos; do
    sed -E "$expr" "$2/$arq.sql" > "$2/$arq.sab" || return 2
    cmp -s "$2/$arq.sql" "$2/$arq.sab" || mudou=0
    mv "$2/$arq.sab" "$2/$arq.sql"
  done
  return "$mudou"
}

gera_artefatos "$WORK/pristino"
VERM=0; FALHAS=0
for cl in c pt; do
  seleciona_cluster "$cl"
  sobe_cluster
  # Sabotar sem CONTROLE verde na MESMA invocação é teatro: uma suíte sempre-vermelha aprovaria todas
  # as sabotagens. O controle roda primeiro, em cada idioma, e vermelho aborta ANTES de sabotar.
  controle="$WORK/controle-$cl.log"
  PASS=0; FAIL=0
  julga "$WORK/pristino" "controle-$cl" > "$controle" 2>&1
  executados_controle=$((PASS + FAIL))
  if [ "$FAIL" -ne 0 ] || [ "$PASS" -lt 30 ]; then
    echo "CONTROLE PODRE (lc_messages=$LOC_SRV): $PASS ok / $FAIL fail — nada a julgar"
    { grep -E '^  ✗ ' "$controle" || true; } | head -8
    exit 3
  fi
  echo "  ✅ controle verde (lc_messages=$LOC_SRV): $PASS asserts, 0 falhas"
  # O vermelho que conta é o do assert DECLARADO — verde no controle, vermelho na rodada —; os verdes
  # declarados seguem verdes; e a rodada executa tantos asserts quanto o controle.
  for item in $SABOTAGENS; do
    sab="${item%%:*}"; resto="${item#*:}"
    verm="${resto%%:*}"; verdes=""
    [ "$resto" = "$verm" ] || verdes="${resto#*:}"
    dir="$WORK/sab-$sab-$cl"; log="$dir.log"
    rm -rf "$dir"; cp -R "$WORK/pristino" "$dir"
    motivo=""
    if ! sabotar "$sab" "$dir"; then
      motivo=" a sabotagem NÃO APLICOU (a expressão não mudou byte nenhum)"
    else
      PASS=0; FAIL=0
      julga "$dir" "$sab-$cl" > "$log" 2>&1
      if [ "$((PASS + FAIL))" -ne "$executados_controle" ]; then
        motivo=" a rodada executou $((PASS + FAIL)) asserts e o controle $executados_controle: vermelho de aborto, não de assert"
      else
        for id in ${verm//,/ }; do
          if ! grep -Eq "^  ✓ \($id\) " "$controle" || ! grep -Eq "^  ✗ \($id\) " "$log"; then
            motivo="$motivo $id não virou (verde no controle → vermelho aqui);"
          fi
        done
        for id in ${verdes//,/ }; do
          grep -Eq "^  ✓ \($id\) " "$log" || motivo="$motivo $id ficou VERMELHO (a sabotagem quebrou outra camada);"
        done
      fi
    fi
    if [ -z "$motivo" ]; then
      VERM=$((VERM + 1))
      echo "  🔴 $sab ($LOC_SRV) — vermelho no assert declarado ($verm): $(descricao "$sab")"
    else
      FALHAS=$((FALHAS + 1))
      echo "  ⚠️  $sab ($LOC_SRV) —$motivo"
      { grep -E '^  ✗ ' "$log" 2>/dev/null || true; } | head -6 | sed 's/^/       /'
    fi
  done
  derruba_cluster
done
echo
echo "SABOTAGENS: $VERM vermelhas / $FALHAS falhas"
[ "$FALHAS" -eq 0 ]
