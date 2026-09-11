#!/usr/bin/env bash
# test-canaria-veredito.sh — prova, EXECUTANDO, que o veredito do modo canária
# (`bun run sonda:sql --canaria`) separa BUNDLE VELHO de CANÁRIA VERMELHA.
#
# POR QUE EXISTE: as duas classes têm desfechos OPOSTOS — bundle velho pede DEPLOY, canária
# vermelha pede investigar a regressão — e o SQL que as separava era escrito à mão a cada
# verificação (fecho do #2367: o bloco saiu do `sonda:sql` trocando `'probe'` por `'canary'` e
# reescrevendo o CASE). Um CASE reescrito à mão erra a ORDEM dos ramos com facilidade, e o erro
# mais caro é silencioso: a `generate-tactical-plan` responde HTTP **500** quando a canária dela
# REPROVA, então julgar pelo status antes do eco `canary` lê regressão como bundle velho e manda
# redeployar. Doc não ordena ramo de CASE: só teste que RODA a query prova a ordem.
#
# O SQL não é copiado — é GERADO pelo `scripts/sonda-versao-sql.ts` do repo, e o marcador esperado
# é lido de volta DO PRÓPRIO SQL emitido. Assim um bump legítimo de `contrato` não quebra o teste,
# e o teste continua provando o julgamento, não a constante.
#
# Uso:
#   bash db/test-canaria-veredito.sh              # verde = os ramos discriminam
#   bash db/test-canaria-veredito.sh --falsificar # controle verde + sabota o SQL e EXIGE vermelho
set -uo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Sobrescrevível como nas outras provas do núcleo: o `--falsificar` sobe a ENTRADA NORMAL de um
# worktree com o PG desta execução ainda no ar, e as duas não podem disputar a mesma porta.
PORT="${PGPORT_TEST:-5441}"
export LC_ALL=C LANG=C  # sem isto o postmaster morre com "became multithreaded during startup"
export PGVER=17   # consumido pelo db/lib/pg-harness.sh via source
# Resolve o PGBIN do PG17 pelo harness (laptop, PGDG, `PGBIN_OVERRIDE`) em vez de cravar o
# caminho do Homebrew: prova que só roda numa máquina é prova que ninguém repete.
# shellcheck disable=SC1091  # o gate roda sem -x; o helper e versionado ao lado, em db/lib/
. "$RAIZ/db/lib/pg-harness.sh"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/pgtest-canaria.XXXXXX")"
DATA="$TMP/data"; SOCK="$TMP"
WT_SABOTADO="$TMP/wt-sabotado"   # só no --falsificar; ver a seção de falsificação
# shellcheck disable=SC2329  # invocada pelo `trap` abaixo
cleanup() {
  "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true
  git -C "$RAIZ" worktree remove --force "$WT_SABOTADO" >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT

# ------------------------------------------------- o SQL REAL, gerado pelo script ---
# As três canárias BARATAS cobrem os três formatos de resposta que existem: topo (`copilot-analyze`),
# envelope `data` (`omie-analytics-sync`) e topo com `success` (`omie-financeiro`). A CARA
# (`generate-tactical-plan`) entra porque é a única cujo marcador mora no campo `versao` — e a única
# que responde 500 numa canária vermelha.
BARATAS="copilot-analyze omie-analytics-sync:doc_ambiguo_probe omie-financeiro"
CARA="generate-tactical-plan"
GERADO="$TMP/gerado.sql"

# ── ONDE o gerador roda: o DISCO desta sessão, por um caminho que não emite SQL operacional ──
# A CLI (`bun scripts/sonda-versao-sql.ts --canaria`) tem guard de sincronia fail-CLOSED: ela RECUSA
# emitir se a "fatia da verdade" (`<edge>/versao.ts` + `_shared/sonda-fingerprints.ts`) diferir de
# `origin/main`. No uso OPERACIONAL isso é a proteção inteira — marcador bumpado e não mergeado
# produziria um "BUNDLE VELHO SERVINDO" falso sobre edge que está no ar (incidente de 2026-09-05).
#
# Só que num PR essa fatia diverge POR CONSTRUÇÃO: `sonda:bump` obriga a bumpar o `versao.ts` e
# `sonda:fingerprint` obriga a regravar o mapa. Quando esta prova entrou no núcleo do CI (#2403), os
# três gates viraram mutuamente impossíveis e todo PR de edge reprovou em `provas-sql` (#2414).
#
# A primeira saída (#2405) foi rodar a CLI num worktree de `origin/main`. Destravou, e custou a prova
# INTEIRA: medido em 2026-09-09, com o gerador do disco sabotado (`WHEN ca.corpo ->> 'ok' = 'false'`
# → `WHEN false`, o ramo que dá nome à CANARIA VERMELHA) esta suíte saiu **19 ok / 0 fail** — ela
# julgava o gerador da main, então nenhuma mudança do PR podia reprová-la. Verde por CEGUEIRA, na
# única classe de PR que ela existe para pegar.
#
# Agora o SQL sai do gerador DESTE disco por `db/lib/gerar-canaria-fixture.ts`, que não passa pela
# CLI e não emite SQL operacional: o que ele emite é INERTE (o SQL inteiro vira o valor de uma
# variável dentro de um `DO` que só faz RAISE — ver a sonda de inércia logo abaixo). O guard segue
# intocado no caminho que importa, e as cinco recusas dele continuam provadas onde já estavam, em
# `scripts/sonda-versao-sql.test.ts` (código 1 **e** stdout de zero bytes), no job `testes`.
# shellcheck disable=SC2086  # a lista de nomes é intencionalmente dividida em argumentos
if ! (cd "$RAIZ" && bun db/lib/gerar-canaria-fixture.ts $BARATAS "$CARA") > "$GERADO" 2>"$TMP/gen.err"; then
  echo "VERMELHO — o gerador falhou:"; cut -c1-400 "$TMP/gen.err"; exit 1
fi
# Sonda POSITIVA: geração vazia/silenciosa viraria suíte verde sobre SQL nenhum.
grep -q 'AS veredito' "$GERADO" || { echo "VERMELHO — SQL gerado não tem CASE de veredito"; exit 1; }
grep -q 'net.http_post' "$GERADO" || { echo "VERMELHO — SQL gerado não dispara nada"; exit 1; }
# ARIDADE: a suíte recorta os blocos 1 (baratas) e 2 (cara) por ORDINAL. Se o gerador passar a
# emitir um número diferente de blocos, cada `extrai_leitura` continua achando "um" bloco e a suíte
# julgaria o SQL errado em silêncio — ordinal não é identidade. Aqui a contagem é conferida uma vez.
# shellcheck disable=SC2016  # `$sonda$` e a TAG do dollar-quoting, nao uma variavel a expandir
blocos_format="$(grep -cFx 'SELECT format($sonda$' "$GERADO")"
[ "$blocos_format" = 2 ] || { echo "VERMELHO — esperava 2 blocos \`format(\$sonda\$\`, achei $blocos_format"; exit 1; }

# extrai_leitura <ordinal> <arquivo_sql> — recorta o 1º ARGUMENTO do n-ésimo `format($sonda$…$sonda$`,
# que é o texto do bloco de LEITURA. Recorte BYTE-EXATO: o argumento começa no LF que fecha a linha
# de abertura (daí o `buf = "\n"`), e até 2026-09-09 esse LF era descartado — 8037 B recortados
# contra 8038 B reais, medido. Inócuo no SQL, mas "byte a byte" só vale se for byte a byte.
#
# FAIL-CLOSED, com o nome do que faltou, e por medição: abertura sem fechamento fazia o awk seguir
# até o EOF e engolir 220 B de FORA do bloco (o `RAISE` do envelope inerte entrava no recorte), e um
# fechamento plantado no meio truncava o bloco — as DUAS passavam pela sonda `grep -q 'AS veredito'`
# do chamador, que só olha se o miolo ficou lá. Por isso o buffer só é impresso no END, depois de
# abertura E fechamento confirmados: recorte que falha emite ZERO byte, como a CLI faz nas recusas.
extrai_leitura() {
  local n="$1" arq="$2"
  awk -v alvo="$n" '
    !dentro && /^SELECT format\(\$sonda\$$/ { if (++blocos == alvo) { dentro = 1; buf = "\n" } ; next }
    dentro && /^\$sonda\$, m\.ids\)/        { fechou = 1; exit }
    dentro { buf = buf $0 "\n" }
    END {
      if (!dentro) { print "recorte: nao achei a abertura do bloco " alvo > "/dev/stderr"; exit 3 }
      if (!fechou) { print "recorte: bloco " alvo " sem o fechamento `$sonda$, m.ids)`" > "/dev/stderr"; exit 4 }
      printf "%s", buf
    }
  ' "$arq"
}

MAPA_BARATAS='{"copilot-analyze": 1001, "omie-analytics-sync:doc_ambiguo_probe": 1002, "omie-financeiro": 1003}'
MAPA_CARA='{"generate-tactical-plan": 2001}'

# monta_leitura <ordinal> <mapa-json> <arquivo_sql> — o bloco de leitura COMO O POSTGRES O
# ESCREVERIA, e não como dois `sed` imitariam. O passo 1 monta o passo 2 por `format(…, m.ids)`, e
# até 2026-09-09 esta função reimplementava esse `format()` com `sed "s|%1$L|'$mapa'|"` + `sed
# 's|%%|%|g'`. Medido contra o PG17 nos mesmos insumos: das 11 classes, 8 DIVERGEM — dois `%1$L` na
# mesma linha (o `sed` não tem `/g`), aspa simples no mapa (`%L` duplica, o `sed` não), mapa NULL
# (`%L` emite `NULL` cru, o `sed` emite `''`), backslash, `%%1$L`, `%%` dentro do mapa, `&` e `|`
# (metacaracteres do `sed`, e o `|` MATA o comando). Coincidiam só porque o corpus de hoje tem `%1$L`
# 1× e `%%` 0× — correto por acidente do conteúdo, não por desenho.
#
# Quem executa o `format()` agora é o PG17 que esta prova já sobe: o oráculo é o próprio Postgres,
# então não sobra imitação para divergir. Corpo e mapa vão por ARQUIVO (`pg_read_file`, superuser
# local) porque interpolá-los na linha de comando devolveria o problema de quoting pela outra porta.
#
# Não há caminho de mapa SQL `NULL` aqui de propósito: ele exigiria `disparos` com ZERO linhas, e o
# gerador RECUSA leva vazia (medido: exit 1, zero bytes). Testá-lo seria caminho morto. O que a
# trava fechada produz é OUTRA coisa — `{"nome": null}`, um par com valor nulo, não agregado nulo.
monta_leitura() {
  local corpo="$TMP/corpo-$1.txt" mapa="$TMP/mapa-$1.json"
  extrai_leitura "$1" "$3" > "$corpo" || return 1
  printf '%s' "$2" > "$mapa"
  P -At -v ON_ERROR_STOP=1 -c "SELECT format(pg_read_file('$corpo'), pg_read_file('$mapa'))"
}

# ------------------------------------------ marcadores lidos DE VOLTA do SQL emitido ---
# Digitá-los aqui recriaria, no teste, exatamente o defeito que a ferramenta fecha.
marcador_de() { # <nome-da-canaria>
  grep -o "('$1', '[a-z]*', '[^']*'" "$GERADO" | head -1 | sed "s/.*, '\([^']*\)'\$/\1/"
}
M_COPILOT="$(marcador_de 'copilot-analyze')"
M_ANALYTICS="$(marcador_de 'omie-analytics-sync:doc_ambiguo_probe')"
M_FINANCEIRO="$(marcador_de 'omie-financeiro')"
M_TACTICAL="$(marcador_de 'generate-tactical-plan')"
for par in "copilot:$M_COPILOT" "analytics:$M_ANALYTICS" "financeiro:$M_FINANCEIRO" "tactical:$M_TACTICAL"; do
  [ -n "${par#*:}" ] || { echo "VERMELHO — não li o marcador de ${par%%:*} no SQL emitido"; exit 1; }
done

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null 2>&1
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k $SOCK -c listen_addresses=" -l "$TMP/pg.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h "$SOCK" -U postgres canaria_verify
P() { "$PGBIN/psql" -p "$PORT" -h "$SOCK" -U postgres -d canaria_verify "$@"; }

P -v ON_ERROR_STOP=1 -q <<'SQL'
CREATE SCHEMA net;
-- `error_msg`/`timed_out` existem na tabela REAL do pg_net (0.19.5) e faltavam neste fake. Não é
-- detalhe: quando o transporte morre, o pg_net grava `error_msg` e deixa o `status_code` NULL —
-- indistinguível de "resposta a caminho" para quem só olha o status. Um fake sem a coluna torna
-- esse ramo INEXPRIMÍVEL no teste, que é como ele passou tanto tempo sem existir.
CREATE TABLE net._http_response (
  id bigint PRIMARY KEY, status_code int, content text, created timestamptz NOT NULL,
  timed_out boolean, error_msg text
);

-- ── a armadilha da sonda de inércia ────────────────────────────────────────────────────────────
-- Este banco ganha DE PROPÓSITO tudo o que o passo de disparo precisaria para funcionar: um
-- `vault.decrypted_secrets` e um `net.http_post` que, em vez de sair na rede, REGISTRA a chamada.
-- Sem isso a prova de inércia seria vazia — o SQL morreria em "função não existe" e ficaria
-- impossível distinguir "não disparou porque está inerte" de "não disparou porque este banco é
-- pobre". Com a armadilha armada, `fixture_sentinela` vazia é evidência POSITIVA de que o artefato
-- não executa. O segredo é uma string de mentira: nada aqui sai da máquina.
CREATE SCHEMA vault;
CREATE TABLE vault.decrypted_secrets (name text, decrypted_secret text);
INSERT INTO vault.decrypted_secrets VALUES ('CRON_SECRET', 'nao-e-segredo-e-fixture');
CREATE TABLE public.fixture_sentinela (url text);
CREATE FUNCTION net.http_post(
  url text, headers jsonb DEFAULT '{}'::jsonb, body jsonb DEFAULT '{}'::jsonb,
  timeout_milliseconds int DEFAULT 5000
) RETURNS bigint LANGUAGE sql AS $fake$
  INSERT INTO public.fixture_sentinela(url) VALUES (url) RETURNING 7777::bigint;
$fake$;
SQL

# ------------------------------------------------------------------- asserções ---
fail=0
# Contadores para o recibo do nucleo-ci (db/roda-nucleo-ci.sh exige a linha
# RESULTADO: <pass> ok / <fail> fail — sem ela, exit 0 nao prova que asseriu algo).
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf '  \033[32mok\033[0m   %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  \033[31mFALHA\033[0m %s\n' "$1"; fail=1; }

# veredito <id-da-canaria> <arquivo-de-leitura> -> imprime o veredito daquela linha; sai 3 se a
# LEITURA nem executou. Até 2026-09-10 o stderr do psql ia para /dev/null e SQL que não compila
# virava "nenhuma linha" — indistinguível de "a leitura não devolveu a canária". Foi assim que
# duas sabotagens com SQL INVÁLIDO passaram por captura: vermelho em toda asserção, pelo motivo
# errado. Com ON_ERROR_STOP o psql sai 3 no erro, e a asserção diz [SQL-INVALIDO].
veredito() {
  local saida
  saida="$(P -v ON_ERROR_STOP=1 -t -A -F'|' -f "$2" 2>"$TMP/veredito.err")" || return 3
  printf '%s\n' "$saida" | awk -F'|' -v n="$1" '$1 == n { print $8 }'
}

# espera <descricao> <nome> <arquivo> <marca-esperada>
# Casa a MARCA do ramo (ASCII, caixa fixa, sem -i), não "deu erro": um veredito que mudasse de
# INDETERMINADO para CANARIA VERMELHA passaria num teste que só exigisse "não é verde".
espera() {
  local desc="$1" nome="$2" arq="$3" marca="$4" v
  if ! v="$(veredito "$nome" "$arq")"; then
    bad "$desc — [SQL-INVALIDO] a leitura nem executou: $(head -c 120 "$TMP/veredito.err" | tr '\n' ' ')"
    return
  fi
  # `${marca}` COM chaves, e não é estilo: o `…` que vem depois é multibyte, e em locale UTF-8 no
  # macOS o bash lê o 1º byte dele como parte do NOME — `${marca\xE2}`, "unbound variable" sob
  # `set -u`, e a suíte MORRE na primeira asserção que discorda. Medido em 2026-09-10: no 2º locale
  # do `--falsificar` toda sabotagem ficava "vermelha" por esse crash, sem julgar nada.
  case "$v" in
    "$marca"*) ok "$desc" ;;
    "")        bad "$desc — nenhuma linha para '$nome' (a leitura não parte de \`esperado\`?)" ;;
    *)         bad "$desc — esperava '${marca}…', veio '${v:0:90}'" ;;
  esac
}

suite() {
  local LB LC_ARQ
  LB="$TMP/leitura-baratas.sql"; LC_ARQ="$TMP/leitura-cara.sql"
  monta_leitura 1 "$MAPA_BARATAS" "$ALVO" > "$LB"
  monta_leitura 2 "$MAPA_CARA"    "$ALVO" > "$LC_ARQ"
  # Sonda POSITIVA do recorte: awk que não casa devolveria arquivo vazio e TODA asserção sairia
  # "nenhuma linha" — que é vermelho, mas pelo motivo errado. Aqui ele é nomeado.
  grep -q 'AS veredito' "$LB" || { bad "recorte do PASSO 2 saiu sem CASE de veredito"; return; }
  grep -q 'AS veredito' "$LC_ARQ" || { bad "recorte do PASSO 4 saiu sem CASE de veredito"; return; }

  # ------------------------------------------------ (Z) o artefato é INERTE ---
  # O SQL desta suíte NÃO passa pelo guard de sincronia da CLI (ele é impossível de satisfazer num
  # PR — #2414). O que substitui o guard AQUI é a inércia: o artefato inteiro é um literal dentro de
  # um `DO`, então colá-lo em produção não dispara canária nenhuma. Isso não é comentário: é medido,
  # e nas DUAS pontas, porque cada uma sozinha aprova a outra sabotada.
  local saida_inercia rc_inercia disparos
  P -q -c "TRUNCATE public.fixture_sentinela;" >/dev/null
  # Ponta 1 — o arquivo ABORTA, e com a marca do RAISE. Só "deu erro" aprovaria o envelope removido:
  # sem ele o SQL morre em `vault`/`net` de mentira e o rc é != 0 do mesmo jeito.
  saida_inercia="$(P -v ON_ERROR_STOP=1 -f "$ALVO" 2>&1)"; rc_inercia=$?
  if [ "$rc_inercia" -eq 0 ]; then
    bad "artefato de fixture rodou LIMPO — o envelope inerte sumiu, e colar isto dispararia"
  elif printf '%s' "$saida_inercia" | grep -q 'ARTEFATO DE FIXTURE'; then
    ok "artefato aborta com a marca do RAISE (não é 'deu erro' genérico)"
  else
    bad "artefato abortou SEM a marca do RAISE — veio '$(printf '%s' "${saida_inercia:0:90}")'"
  fi
  # Ponta 2 — e não disparou NADA. A armadilha (`net.http_post` que registra) está armada, então
  # sentinela vazia é evidência POSITIVA, não ausência de dado. Sem `ON_ERROR_STOP` de propósito:
  # é assim que o SQL Editor e o `psql -f` do dia a dia rodam, seguindo APÓS o erro.
  P -q -f "$ALVO" >/dev/null 2>&1
  disparos="$(P -t -A -c 'SELECT count(*) FROM public.fixture_sentinela;')"
  if [ "$disparos" = "0" ]; then
    ok "artefato não dispara nada nem sem ON_ERROR_STOP (sentinela vazia com a armadilha armada)"
  else
    bad "o artefato DISPAROU $disparos vez(es) — o SQL de fixture está executável"
  fi

  # ---------------------------------------------------------- (A) o caso VERDE ---
  P -q -c "TRUNCATE net._http_response;" >/dev/null
  P -q >/dev/null <<SQL
INSERT INTO net._http_response (id, status_code, content, created) VALUES
  (1001, 200, '{"canary":true,"contrato":"$M_COPILOT","ok":true,"casos":{}}', now()),
  -- envelope \`data\`: é assim que a omie-analytics-sync responde, e sem descer nele a canária
  -- dela sairia como "sem eco" — bundle velho fabricado a partir de um bundle correto.
  (1002, 200, '{"success":true,"data":{"canary":true,"contrato":"$M_ANALYTICS","ok":true}}', now()),
  (1003, 200, '{"success":true,"action":"paginacao_probe","canary":true,"contrato":"$M_FINANCEIRO","ok":true}', now());
INSERT INTO net._http_response (id, status_code, content, created)
  SELECT 9000 + g, 200, '{"ok":true}', now() - (g || ' minutes')::interval FROM generate_series(1, 40) g;
SQL
  espera "verde: canary+contrato+ok os TRÊS presentes" 'copilot-analyze' "$LB" 'CANARIA VERDE'
  espera "verde ATRAVÉS do envelope \`data\` (omie-analytics-sync)" 'omie-analytics-sync:doc_ambiguo_probe' "$LB" 'CANARIA VERDE'
  espera "verde no topo com \`success\` (omie-financeiro)" 'omie-financeiro' "$LB" 'CANARIA VERDE'

  # ------------------------------------------------------- (B) canária VERMELHA ---
  P -q -c "TRUNCATE net._http_response;" >/dev/null
  P -q >/dev/null <<SQL
INSERT INTO net._http_response (id, status_code, content, created) VALUES
  (1001, 200, '{"canary":true,"contrato":"$M_COPILOT","ok":false,"casos":{}}', now());
SQL
  espera "ok:false COM marcador batendo = CANARIA VERMELHA (regressão, não deploy)" \
    'copilot-analyze' "$LB" 'CANARIA VERMELHA'

  # A cara, no PASSO 4, com o marcador no campo \`versao\` E HTTP 500 — o par que a ordem dos
  # ramos existe para separar. Status 500 antes do eco leria isto como recusa de bundle velho.
  P -q -c "TRUNCATE net._http_response;" >/dev/null
  P -q >/dev/null <<SQL
INSERT INTO net._http_response (id, status_code, content, created) VALUES
  (2001, 500, '{"canary":true,"versao":"$M_TACTICAL","ok":false,"resultados":[]}', now());
SQL
  espera "HTTP 500 COM eco canary é VERMELHA, não 'recusou o request'" \
    'generate-tactical-plan' "$LC_ARQ" 'CANARIA VERMELHA'

  P -q -c "TRUNCATE net._http_response;" >/dev/null
  P -q >/dev/null <<SQL
INSERT INTO net._http_response (id, status_code, content, created) VALUES
  (2001, 200, '{"canary":true,"versao":"$M_TACTICAL","ok":true,"resultados":[]}', now());
SQL
  espera "marcador no campo \`versao\` (generate-tactical-plan) fecha VERDE" \
    'generate-tactical-plan' "$LC_ARQ" 'CANARIA VERDE'

  # ------------------------------------------------ (C) contrato DIVERGENTE ---
  # A armadilha 2 do deploy.md: o bundle velho carrega o expected VELHO e compara velho×velho,
  # então responde ok:true. Julgar pelo `ok` sem o marcador leria isto como VERDE.
  P -q -c "TRUNCATE net._http_response;" >/dev/null
  P -q >/dev/null <<SQL
INSERT INTO net._http_response (id, status_code, content, created) VALUES
  (1001, 200, '{"canary":true,"contrato":"fatia-anterior-v0","ok":true,"casos":{}}', now());
SQL
  espera "contrato de OUTRA fatia com ok:true NÃO é verde" \
    'copilot-analyze' "$LB" 'CANARIA DE OUTRA FATIA'

  P -q -c "TRUNCATE net._http_response;" >/dev/null
  P -q >/dev/null <<SQL
INSERT INTO net._http_response (id, status_code, content, created) VALUES
  (1001, 200, '{"canary":true,"ok":true,"casos":{}}', now());
SQL
  espera "canary:true SEM o campo do marcador = SEM MARCADOR (pré-versionamento)" \
    'copilot-analyze' "$LB" 'CANARIA SEM MARCADOR'

  P -q -c "TRUNCATE net._http_response;" >/dev/null
  P -q >/dev/null <<SQL
INSERT INTO net._http_response (id, status_code, content, created) VALUES
  (1001, 200, '{"canary":true,"contrato":"$M_COPILOT"}', now());
SQL
  espera "marcador batendo e SEM \`ok\` é fail-closed, não verde" \
    'copilot-analyze' "$LB" 'CANARIA SEM VEREDITO'

  # `ok` que não é booleano: os ramos de `IS NULL` e de `'false'` não o pegam, então é AQUI que a
  # exigência de `ok = 'true'` no ramo verde vira carga. Sem esta linha essa conjunção seria
  # inalcançável e a sabotagem que a remove ficaria VERDE — falsificação vazia disfarçada de teste.
  P -q -c "TRUNCATE net._http_response;" >/dev/null
  P -q >/dev/null <<SQL
INSERT INTO net._http_response (id, status_code, content, created) VALUES
  (1001, 200, '{"canary":true,"contrato":"$M_COPILOT","ok":"sim"}', now());
SQL
  espera "\`ok\` não-booleano não vira verde por omissão" \
    'copilot-analyze' "$LB" 'INDETERMINADO'

  # ------------------------------------------------------ (D) BUNDLE VELHO ---
  # Nenhum destes é "canária vermelha": é canária AUSENTE, e o desfecho é deploy.
  P -q -c "TRUNCATE net._http_response;" >/dev/null
  P -q >/dev/null <<'SQL'
INSERT INTO net._http_response (id, status_code, content, created) VALUES
  (1001, 200, '{"analysis":{"intent":"orcamento"},"tokens":812}', now());
SQL
  espera "200 SEM eco canary = rodou o FLUXO REAL (não é vermelha)" \
    'copilot-analyze' "$LB" 'SEM CANARIA NO AR'

  # ── O CONTROLE ATIVO: quem DETERMINA o 401 e' a testemunha DESTA leva ─────────────────────────
  # Ate 2026-09-09 quem determinava era o controle HISTORICO (2xx de fora da leva em 6h). Ele nao
  # sabe QUAL credencial autenticou o que contou, e por isso avalizava um transporte quebrado.
  # Agora a prova tem de ser ATIVA: uma resposta DESTA leva com IDENTIDADE verificada.
  P -q -c "TRUNCATE net._http_response;" >/dev/null
  P -q >/dev/null <<SQL
INSERT INTO net._http_response (id, status_code, content, created) VALUES
  (1001, 401, '{"code":401,"message":"Unauthorized"}', now()),
  -- TESTEMUNHA ATIVA: outra canaria DESTA leva voltou com o MARCADOR esperado. So um bundle que
  -- autenticou chega a executar a fixture, entao o x-cron-secret deste disparo foi ACEITO agora.
  (1002, 200, '{"success":true,"data":{"canary":true,"contrato":"$M_ANALYTICS","ok":true}}', now());
SQL
  espera "401 com TESTEMUNHA ATIVA na leva = SEM CANARIA NO AR" \
    'copilot-analyze' "$LB" 'SEM CANARIA NO AR'

  # ⚠️ O CASO QUE ESTA CORRECAO EXISTE PARA PEGAR — manifestacao (b) da limitacao do #2424: o
  # disparo mandou o header ERRADO, a leva INTEIRA tomou 401, e o controle historico segue VERDE
  # justamente porque os ids desta leva ficam FORA da contagem dele (pelo NOT EXISTS). Antes do
  # controle ativo isto saia 'SEM CANARIA NO AR' CONFIANTE, e o desfecho era redeploy a toa de uma
  # edge que ja estava no ar. Esta manifestacao NAO se corrige sozinha na proxima execucao.
  P -q -c "TRUNCATE net._http_response;" >/dev/null
  P -q >/dev/null <<'SQL'
INSERT INTO net._http_response (id, status_code, content, created) VALUES
  (1001, 401, '{"code":401}', now()),
  (1002, 401, '{"code":401}', now()),
  (1003, 401, '{"code":401}', now());
-- Historico VERDE de proposito: 40 respostas 2xx alheias e ZERO recusa fora da leva. Se o
-- historico ainda decidisse, esta linha sairia determinada — e errada.
INSERT INTO net._http_response (id, status_code, content, created)
  SELECT 9000 + g, 200, '{"ok":true}', now() - (g || ' minutes')::interval FROM generate_series(1, 40) g;
SQL
  espera "leva INTEIRA 401 com historico VERDE = INDETERMINADO (historico nao determina)" \
    'copilot-analyze' "$LB" 'INDETERMINADO'

  # A testemunha e' IDENTIDADE, nao status: um 2xx que NAO ecoa o marcador esperado pode vir de um
  # bundle historico que ignora a credencial e roda o fluxo real (o `monthly-report@ef08dddd2` do
  # parecer Codex). Contar esse 200 como prova seria fail-OPEN.
  P -q -c "TRUNCATE net._http_response;" >/dev/null
  P -q >/dev/null <<'SQL'
INSERT INTO net._http_response (id, status_code, content, created) VALUES
  (1001, 401, '{"code":401}', now()),
  -- 200 ANONIMO: sem eco de canary, sem marcador. Nao prova credencial nenhuma.
  (1002, 200, '{"resultado":"ok","linhas":42}', now());
SQL
  espera "2xx ANONIMO na leva NAO e testemunha (bundle que ignora a credencial)" \
    'copilot-analyze' "$LB" 'INDETERMINADO'

  # Marcador de OUTRA fatia tambem nao testemunha: o bundle velho carrega o `expected` velho, e o
  # que ele prova e' que ele e' velho — nao que a credencial de agora foi aceita.
  P -q -c "TRUNCATE net._http_response;" >/dev/null
  P -q >/dev/null <<'SQL'
INSERT INTO net._http_response (id, status_code, content, created) VALUES
  (1001, 401, '{"code":401}', now()),
  (1002, 200, '{"success":true,"data":{"canary":true,"contrato":"fatia-anterior-v0","ok":true}}', now());
SQL
  espera "2xx com marcador de OUTRA fatia NAO e testemunha" \
    'copilot-analyze' "$LB" 'INDETERMINADO'

  P -q -c "TRUNCATE net._http_response;" >/dev/null
  P -q >/dev/null <<'SQL'
INSERT INTO net._http_response (id, status_code, content, created) VALUES
  (1001, 401, '{"code":401}', now());
SQL
  espera "401 SEM controle de credencial é INDETERMINADO, nunca veredito" \
    'copilot-analyze' "$LB" 'INDETERMINADO'

  # `error_msg` preenchido com status NULL e' requisicao MORTA — no pg_net 0.19.5 e' assim que a
  # falha de transporte aparece. Lido como "resposta a caminho", o AGUARDE mandaria repetir para
  # sempre: laco de espera fail-OPEN, que este ramo fecha nomeando a causa.
  P -q -c "TRUNCATE net._http_response;" >/dev/null
  P -q >/dev/null <<'SQL'
INSERT INTO net._http_response (id, status_code, content, created, error_msg) VALUES
  (1001, NULL, NULL, now(), 'Timeout was reached');
SQL
  espera "erro de transporte NAO e AGUARDE — repetir nao resolve" \
    'copilot-analyze' "$LB" 'FALHA DE TRANSPORTE'

  P -q -c "TRUNCATE net._http_response;" >/dev/null
  P -q >/dev/null <<'SQL'
INSERT INTO net._http_response (id, status_code, content, created) VALUES
  (1001, 404, '{"code":404}', now());
SQL
  # O prefixo TEM de nomear o RAMO. O `>= 400` e o ELSE comecam os dois com
  # 'SEM CANARIA NO AR — ' e dizem coisas OPOSTAS: aqui NADA executou (o bundle recusou
  # o request), la o fluxo real RODOU e o efeito JA ACONTECEU. Casar so o prefixo comum
  # aprova os dois — era assim que a mutacao `>= 400` -> `= 401` sobrevivia: o 404 caia
  # no ELSE e o teste continuava verde julgando o oposto.
  espera "4xx sem eco = recusou o request, NADA executou" \
    'copilot-analyze' "$LB" 'SEM CANARIA NO AR — o bundle recusou o request (HTTP 404)'

  # ------------------------------------------------- (E) ausência de dado ---
  P -q -c "TRUNCATE net._http_response;" >/dev/null
  P -q >/dev/null <<'SQL'
INSERT INTO net._http_response (id, status_code, content, created) VALUES
  (1001, NULL, NULL, now());
SQL
  espera "resposta ainda a caminho (status NULL) = AGUARDE" 'copilot-analyze' "$LB" 'AGUARDE'

  P -q -c "TRUNCATE net._http_response;" >/dev/null
  espera "id no mapa sem linha nenhuma = AGUARDE (não veredito negativo)" \
    'copilot-analyze' "$LB" 'AGUARDE'

  P -q -c "TRUNCATE net._http_response;" >/dev/null
  P -q >/dev/null <<SQL
INSERT INTO net._http_response (id, status_code, content, created) VALUES
  (1001, 200, '{"canary":true,"contrato":"$M_COPILOT","ok":true}', now() - interval '95 minutes');
SQL
  espera "resposta FORA da janela não vira veredito de agora" \
    'copilot-analyze' "$LB" 'INDETERMINADO'

  # A linha que NÃO está no mapa: parte de `esperado`, então existe e diz o que falta.
  local LSEM="$TMP/leitura-sem-mapa.sql"
  monta_leitura 1 '{"copilot-analyze": 1001}' "$ALVO" > "$LSEM"
  P -q -c "TRUNCATE net._http_response;" >/dev/null
  P -q >/dev/null <<SQL
INSERT INTO net._http_response (id, status_code, content, created) VALUES
  (1001, 200, '{"canary":true,"contrato":"$M_COPILOT","ok":true}', now());
SQL
  espera "canária fora do mapa embutido = INDETERMINADO nomeando o passo" \
    'omie-financeiro' "$LSEM" 'INDETERMINADO'
}

# ------------------------------------------------------------------- execução ---
if [ "${1:-}" != "--falsificar" ]; then
  printf '== canaria: BUNDLE VELHO x CANARIA VERMELHA ==\n'
  ALVO="$GERADO"; suite
  echo "RESULTADO: $PASS ok / $FAIL fail"
  if [ "$fail" -eq 0 ]; then printf '\nVEREDITO DE CANARIA OK\n'; exit 0; fi
  printf '\nVERMELHO\n'; exit 1
fi

# ---------------------------------------------------------------- falsificação ---
# Roda no CAMINHO OBRIGATÓRIO desde 2026-09-10: `db/roda-nucleo-ci.sh` executa este modo pela
# linha `falsificar=<n>` do `db/nucleo-ci.txt`. Antes só rodava à mão — e, sem ninguém rodar,
# duas sabotagens apodreceram em "captura" de SQL que nem compilava (ver `tem_marca`).
printf '== falsificacao (sabota e EXIGE vermelho PELO MOTIVO CERTO) ==\n'
falhou=0
# RECIBO para o runner. O exit 0 sozinho não basta a ele: um `--falsificar` que a guarda deixasse
# de reconhecer rodaria o modo NORMAL e sairia 0 do mesmo jeito. Por isso a linha
# `SABOTAGENS: <v> vermelhas / <f> falhas` só existe AQUI — o modo normal nunca a emite —, e o
# runner exige f = 0 e v ≥ n: remover sabotagem reprova até alguém baixar o n no diff.
SAB_VERMELHAS=0; SAB_FALHAS=0; SAB_IDS=" "; SAB_EXPRS=""
sab_vermelha() { SAB_VERMELHAS=$((SAB_VERMELHAS + 1)); }
sab_falha()    { SAB_FALHAS=$((SAB_FALHAS + 1)); falhou=1; }
LOGS_F="$TMP/logs-falsificacao"; mkdir -p "$LOGS_F"
ESC="$(printf '\033')"

utf8=""
for cand in pt_BR.UTF-8 pt_BR.utf8 en_US.UTF-8 en_US.utf8 C.UTF-8 C.utf8; do
  if [ "$(LC_ALL="$cand" locale charmap 2>/dev/null)" = "UTF-8" ]; then utf8="$cand"; break; fi
done
[ -n "$utf8" ] || { printf '  \033[31mFALHA\033[0m nenhum locale UTF-8 — metade da cobertura fingindo ser inteira\n'; exit 1; }

# roda_suite <alvo-sql> <locale> <log> -> 0 se a suíte ficou VERDE. A saída vai para o log e não
# para /dev/null: sem ela não há como conferir POR QUE a suíte ficou vermelha — e, até 2026-09-10,
# ninguém conferia.
roda_suite() {
  # shellcheck disable=SC2030  # o LC_ALL local ao subshell e o DESENHO: cada rodada da suite ve um
  #                              locale, e o pai continua em C.
  ( export LC_ALL="$2"; ALVO="$1"; fail=0; suite; [ "$fail" -eq 0 ] ) > "$3" 2>&1
}

# tem_marca <log> <marca> -> 0 se UMA linha FALHA do log contém TODAS as partes da marca (separadas
# por `|`). A marca é o que transforma o vermelho em informação: um trecho ASCII da asserção que a
# sabotagem existe para derrubar e, quando a asserção é de veredito, o veredito ERRADO que veio
# (`veio '...`). "A suíte ficou vermelha" sozinho aceitava QUALQUER vermelho: as sabotagens (e) e
# (f) viveram de 2026-09-08 a 2026-09-10 como "captura" de um SQL que nem compilava — a (e) com o
# alias `l` que o gerador já tinha renomeado para `ca`, a (f) apagando 4 linhas de um guard de 2 e
# deixando um THEN órfão. Vermelho em TODA asserção, e o laço dizia `ok`.
tem_marca() (
  set -f   # a marca é TEXTO: a divisão por `|` não pode expandir glob
  linhas="$(grep -F 'FALHA' "$1" || true)"
  IFS='|'
  for parte in $2; do linhas="$(printf '%s\n' "$linhas" | grep -F -- "$parte" || true)"; done
  [ -n "$linhas" ]
)

# julga_log <log> <marca> -> ecoa "" se o vermelho é o CERTO; senão, o que está errado nele.
julga_log() {
  if grep -qF '[SQL-INVALIDO]' "$1"; then printf 'a sabotagem QUEBROU o SQL (nao mudou o julgamento)'; return; fi
  # Erro do próprio bash (`<script>: line N: ...`): a suíte MORREU em vez de julgar. Foi a forma do
  # `${marca}…` sem chaves, que só mata em locale UTF-8 — e por isso só aparece no 2º locale.
  if grep -qE '\.sh: line [0-9]+: ' "$1"; then
    printf 'a suite MORREU com erro de shell (%s)' "$(grep -oE 'line [0-9]+: .{0,50}' "$1" | head -1)"; return
  fi
  tem_marca "$1" "$2" || printf "vermelho SEM a marca '%s'" "$2"
}

mostra_falhas() { # <log> — as linhas FALHA, sem cor: é o que o runner mostra quando isto reprova
  sed "s/${ESC}\[[0-9;]*m//g" "$1" | grep -a 'FALHA' | head -4 | cut -c1-160 | sed 's/^/            /'
}

# injeta <id> <marca> <alvo-sql> -> ecoa "" se a suíte fica vermelha COM a marca nos 2 locales
injeta() {
  local id="$1" marca="$2" alvo="$3" loc log m motivo=""
  for loc in C "$utf8"; do
    log="$LOGS_F/$id.$loc.log"
    if roda_suite "$alvo" "$loc" "$log"; then motivo="$motivo [$loc: suite VERDE]"; continue; fi
    m="$(julga_log "$log" "$marca")"
    [ -z "$m" ] || motivo="$motivo [$loc: $m]"
  done
  printf '%s' "$motivo"
}

invalida() { # <id> <descricao> <motivo>
  sab_falha; printf '  \033[31mFALHA\033[0m [%s] "%s": %s — falsificacao vazia\n' "$1" "$2" "$3"
}

# registra <id> <eixo:expressao> -> 1 se o id, ou a mesma expressão no mesmo eixo, já apareceu. A
# contagem do recibo não distingue "17 sabotagens" de "16 e uma repetida": sem isto, duplicar uma
# compensaria retirar outra, e o runner seguiria verde.
registra() {
  case "$SAB_IDS" in *" $1 "*) invalida "$1" "(id repetido)" "id DUPLICADO"; return 1 ;; esac
  if [ -n "$SAB_EXPRS" ] && printf '%s\n' "$SAB_EXPRS" | grep -qxF -- "$2"; then
    invalida "$1" "(expressao repetida)" "a MESMA sabotagem ja rodou com outro id"; return 1
  fi
  SAB_IDS="$SAB_IDS$1 "
  SAB_EXPRS="${SAB_EXPRS:+$SAB_EXPRS
}$2"
}

# CONTROLE VERDE na MESMA invocação do laço, ANTES do primeiro sed — e pelo MESMO caminho que as
# sabotagens usam (cópia em $TMP, os dois locales, `ALVO` sobrescrito). Sem ele, uma suíte
# sempre-vermelha (por locale, por psql morto, por recorte quebrado) aprovaria TODA sabotagem, e a
# suíte crua do modo normal é OUTRA invocação — não prova nada sobre este laço.
CONTROLE="$TMP/controle.sql"
cp "$GERADO" "$CONTROLE"
controle_verde=0
for loc in C "$utf8"; do
  if roda_suite "$CONTROLE" "$loc" "$LOGS_F/controle.$loc.log"; then
    controle_verde=$((controle_verde + 1))
  else
    mostra_falhas "$LOGS_F/controle.$loc.log"
  fi
done
if [ "$controle_verde" -ne 2 ]; then
  printf '  \033[31mFALHA\033[0m controle NAO ficou verde (%d/2) — laco sempre-vermelho aprovaria toda sabotagem\n' "$controle_verde"
  exit 1
fi
printf '  \033[32mok\033[0m   controle verde nos 2 locales (o laco distingue verde de vermelho)\n'

# CONTROLE NEGATIVO DO JUIZ, também antes do primeiro sed que conta. O controle acima prova que o
# laço sabe dizer VERDE; este prova que o juiz sabe dizer "vermelho ERRADO". Sem ele, um
# `tem_marca` que sempre dissesse sim aprovaria toda sabotagem — o sempre-vermelho de novo, um
# nível acima. Os dois casos são as duas formas que viveram aqui como captura.
sed -E "s/ca\.corpo ->> 'canary' IS DISTINCT FROM 'true'/l.corpo ->> 'canary' <> 'true'/g" "$GERADO" > "$TMP/juiz-sql.sql"
m="$(injeta juiz-sql "200 SEM eco canary = rodou o FLUXO REAL|veio 'CANARIA SEM MARCADOR" "$TMP/juiz-sql.sql")"
case "$m" in
  *"C: a sabotagem QUEBROU o SQL"*"$utf8: a sabotagem QUEBROU o SQL"*) ;;
  *) printf '  \033[31mFALHA\033[0m o juiz NAO recusou SQL que nao compila (%s)\n' "${m:-aprovou}"; exit 1 ;;
esac
sed -E "s/AND ca\.corpo ->> 'ok' = 'true'//" "$GERADO" > "$TMP/juiz-marca.sql"
m="$(injeta juiz-marca "ok:false COM marcador batendo = CANARIA VERMELHA|veio 'INDETERMINADO" "$TMP/juiz-marca.sql")"
case "$m" in
  *"C: vermelho SEM a marca"*"$utf8: vermelho SEM a marca"*) ;;
  *) printf '  \033[31mFALHA\033[0m o juiz NAO recusou vermelho de OUTRA assercao (%s)\n' "${m:-aprovou}"; exit 1 ;;
esac
printf '  \033[32mok\033[0m   juiz recusa os 2 vermelhos errados (SQL que nao compila; marca de outra assercao)\n'

sabota() { # <id> <descricao> <marca> <expressao-sed>
  local id="$1" desc="$2" marca="$3" expr="$4" copia="$TMP/sabotado-$1.sql" erro motivo
  registra "$id" "sql:$expr" || return 0
  erro="$(sed -E "$expr" "$GERADO" 2>&1 >"$copia")"
  if [ -n "$erro" ]; then invalida "$id" "$desc" "sed invalido (${erro:0:60})"; return 0; fi
  if cmp -s "$GERADO" "$copia"; then invalida "$id" "$desc" "padrao nao casou, SQL intacto"; return 0; fi
  motivo="$(injeta "$id" "$marca" "$copia")"
  if [ -z "$motivo" ]; then
    sab_vermelha
    printf '  \033[32mok\033[0m   [%s] "%s" -> vermelha pelo motivo certo nos 2 locales\n' "$id" "$desc"
  else
    sab_falha
    printf '  \033[31mFALHA\033[0m [%s] "%s":%s\n' "$id" "$desc" "$motivo"
    mostra_falhas "$LOGS_F/$id.C.log"
  fi
}

# ⚠️ Sabota-se UMA CAMADA POR VEZ, e a ordem abaixo é a lição: a primeira tentativa mirou as
#    conjunções do ramo VERDE (`AND ... ok = 'true'`, `AND ... marcador = esperado`) e a suíte ficou
#    VERDE nas duas — porque os ramos ESPECÍFICOS acima já interceptam esses casos. Não era asserção
#    frouxa, era conjunção INALCANÇÁVEL pelos fixtures que existiam. Duas correções, ambas honestas:
#    o fixture de `ok` não-booleano (acima) tornou a primeira alcançável, e a segunda é atacada onde
#    ela decide de verdade — no ramo que NOMEIA a divergência.
# A MARCA de cada uma (3º argumento) foi LIDA da saída real da suíte sabotada, não deduzida.

# (a1) O ramo que dá sentido ao arquivo: sem ele, "está no ar" vira "está correto".
sabota a1 "sem o ramo de ok:false (a vermelha perde o nome)" \
  "ok:false COM marcador batendo = CANARIA VERMELHA|veio 'INDETERMINADO" \
  "s/WHEN ca\.corpo ->> 'ok' = 'false'/WHEN false/"
# (a2) A conjunção do ramo verde, agora ALCANÇÁVEL pelo fixture de \`ok\` não-booleano.
sabota a2 "verde deixa de exigir ok:true (ok nao-booleano vira verde)" \
  "vira verde por omiss|veio 'CANARIA VERDE'" \
  "s/AND ca\.corpo ->> 'ok' = 'true'//"
# (b1) O ramo que nomeia a divergência de marcador.
sabota b1 "sem o ramo de marcador divergente (a outra fatia perde o nome)" \
  "contrato de OUTRA fatia com ok:true|veio 'INDETERMINADO" \
  "s/WHEN ca\.corpo ->> ca\.campo_marcador IS DISTINCT FROM ca\.marcador_esperado/WHEN false/"
# (b2) A armadilha 2 do deploy.md RECONSTRUÍDA: nada no CASE julga o marcador. O bundle velho
#      compara velho x velho, responde ok:true, e o veredito sai CANARIA VERDE — mentindo verde.
sabota b2 "o CASE inteiro deixa de julgar o marcador (bundle velho MENTE VERDE)" \
  "contrato de OUTRA fatia com ok:true|veio 'CANARIA VERDE'" \
  "s/WHEN ca\.corpo ->> ca\.campo_marcador IS DISTINCT FROM ca\.marcador_esperado/WHEN false/; s/AND ca\.corpo ->> ca\.campo_marcador = ca\.marcador_esperado//"
# (b3) O marcador esperado que sai do REPO vira um digitado qualquer: a canária no ar deixa de bater.
sabota b3 "marcador esperado fabricado no VALUES (repo deixa de mandar)" \
  "verde: canary+contrato+ok os TR|veio 'CANARIA DE OUTRA FATIA" \
  "s/(\('copilot-analyze', 'contrato', ')[^']*/\1marcador-fabricado-v0/"
# (b4) O campo do marcador deixa de ser POR CANÁRIA: quem serve em \`versao\` some.
sabota b4 "marcador lido sempre de 'contrato' (a generate-tactical-plan some)" \
  "marcador no campo \`versao\` (generate-tactical-plan) fecha VERDE|veio 'CANARIA SEM MARCADOR" \
  "s/ca\.corpo ->> ca\.campo_marcador/ca.corpo ->> 'contrato'/g"
# (c) A ORDEM dos ramos: julgar o status ANTES do eco faz a vermelha de HTTP 500 da
#     generate-tactical-plan sair como 'recusou o request'.
sabota c "status julgado antes do eco (500 vermelha vira bundle velho)" \
  "HTTP 500 COM eco canary|veio 'SEM CANARIA NO AR" \
  "s/WHEN ca\.corpo ->> 'canary' IS DISTINCT FROM 'true' AND ca\.status_code >= 400/WHEN ca.status_code >= 400/"
# (d) O envelope \`data\`: sem descer nele, as canárias da omie-analytics-sync somem para
#     'sem eco' — um bundle correto classificado como velho.
sabota d "sem o COALESCE do envelope data (analytics vira 'sem eco')" \
  "do envelope \`data\` (omie-analytics-sync)|veio 'SEM CANARIA NO AR" \
  "s/COALESCE\(resp\.content::jsonb -> 'data', resp\.content::jsonb\)/resp.content::jsonb/"
# (e) NULL-blind: trocar IS DISTINCT FROM por <> faz a chave AUSENTE devolver NULL, o ramo do
#     eco não casa, e a resposta sem `canary` cai adiante no CASE. O alias TEM de ser o do CASE
#     (`ca`): com o `l` antigo o SQL nem compila — é o 1º caso do controle negativo do juiz.
sabota e "eco testado por <> (NULL-blind: chave ausente devolve NULL)" \
  "200 SEM eco canary = rodou o FLUXO REAL|veio 'CANARIA SEM MARCADOR" \
  "s/ca\.corpo ->> 'canary' IS DISTINCT FROM 'true'/ca.corpo ->> 'canary' <> 'true'/g"
# (f) A janela: sem ela, uma resposta de outra sessão vira veredito de agora. Neutraliza a CONDIÇÃO
#     (`WHEN false`) em vez de apagar linhas: o `,+3d` antigo contava linhas de um guard que tem 2
#     e levava junto o WHEN do ramo seguinte — sabotagem que depende da contagem de linhas envelhece
#     com qualquer mudança de layout do gerador.
sabota f "sem o guard de janela (resposta velha vira veredito de agora)" \
  "resposta FORA da janela|veio 'CANARIA VERDE'" \
  "s/WHEN ca\.created <= now\(\) - interval '[^']*'/WHEN false/"

# ── (g) O ENVELOPE INERTE — o que substitui, AQUI, o guard de sincronia da CLI ─────────────────
# As duas pontas da sonda (Z) precisam de dente próprio: cada uma sozinha aprova a outra sabotada.
# (g1) Sem o RAISE, o arquivo roda LIMPO — e continua sem disparar, porque o payload segue literal:
#      é exatamente o caso que a ponta 2 aprovaria sozinha.
sabota g1 "sem o RAISE do envelope (artefato roda limpo)" \
  "artefato de fixture rodou LIMPO" \
  "/^  RAISE EXCEPTION 'ARTEFATO DE FIXTURE/d"
# (g2) A moldura inteira some e o payload volta a ser COMANDO. O rc continua != 0 (este banco não
#      tem tudo o que o SQL pede), então a ponta 1 sozinha aprovaria — quem pega é a sentinela.
sabota g2 "sem o envelope inteiro (o SQL de fixture volta a DISPARAR)" \
  "o artefato DISPAROU" \
  "/^DO \\\$fixture_inerte\\\$$/d; /^DECLARE$/d; /^  sql_da_canaria CONSTANT text/d; /^\\\$fixture_payload\\\$;$/d; /^BEGIN$/d; /^  RAISE EXCEPTION 'ARTEFATO DE FIXTURE/d; /^END$/d; /^\\\$fixture_inerte\\\$;$/d"

# ── (i) O RECORTE — a fronteira entre o artefato e o que a suíte julga ───────────────────────
# Todas as sabotagens acima mexem no CONTEÚDO do SQL. Esta mexe em ONDE ele começa e termina, que
# até 2026-09-09 não tinha dente nenhum: com a tag de fechamento trocada, o `awk` seguia até o EOF
# e devolvia 8257 B onde o bloco legítimo tem 8037 — 220 B de FORA, incluindo o `RAISE` do envelope
# inerte. E passava pela sonda `grep -q 'AS veredito'` do chamador, porque o miolo continuava lá:
# a sonda pergunta se o recorte tem o CASE, não se ele é o RECORTE CERTO.
# shellcheck disable=SC2016  # `$sonda$`/`$OUTRA$` sao TAGS de dollar-quoting, nao variaveis
sabota i "fechamento do bloco com outra tag (recorte vaza ate o EOF)" \
  "recorte do PASSO 2 saiu sem CASE de veredito" \
  's/^\$sonda\$, m\.ids\)/$OUTRA$, m.ids)/'

# ── (h) O EIXO QUE ESTAVA CEGO: o modo normal julga o GERADOR deste disco ─────────────────────────
# Todas as sabotagens acima mexem no SQL JÁ EMITIDO. Nenhuma delas nota se o modo normal parou de
# julgar o gerador deste disco — foi assim que o #2405 a deixou VERDE (19 ok / 0 fail) com o
# gerador sabotado, ao gerar o SQL num worktree de `origin/main`. Aqui a sabotagem é no GERADOR, num
# worktree descartável do HEAD: mutar o arquivo no disco da sessão é como um hook de segurança
# ficou mutado em 2026-09-08 (#2410) quando o trap restaurou e o processo seguiu vivo.
#
# Cada sabotagem de gerador passa por DOIS juízes, e os dois têm de dar o vermelho certo:
#  · a ENTRADA NORMAL do worktree (`bash db/test-canaria-veredito.sh`, o comando que o CI roda) —
#    é ela que prova o eixo, porque passa pela linha que GERA o SQL do modo normal. Até 2026-09-10
#    este bloco só injetava na suíte o SQL gerado à parte, contornando justamente essa linha: uma
#    regressão como a do #2405 (gerar num worktree da main) seguiria vermelha aqui e verde no CI
#    (achado do parecer Codex desta data). Roda em C, porque a entrada exporta LC_ALL=C (o
#    postmaster exige);
#  · a INJEÇÃO na suíte nos 2 locales, que cobre o julgamento em UTF-8.
if ! git -C "$RAIZ" worktree add --detach "$WT_SABOTADO" HEAD >"$TMP/wt.err" 2>&1; then
  printf '  \033[31mFALHA\033[0m nao consegui criar o worktree do HEAD (%s) — o eixo do GERADOR ficaria sem prova\n' \
    "$(cut -c1-80 "$TMP/wt.err")"
  exit 1
fi
GER_WT="$WT_SABOTADO/scripts/sonda-versao-sql.ts"
GER_INTACTO="$TMP/sonda-versao-sql.ts.intacto"
ENTRADA_WT="$WT_SABOTADO/db/test-canaria-veredito.sh"
cp "$GER_WT" "$GER_INTACTO" || { printf '  \033[31mFALHA\033[0m nao guardei a copia intacta do gerador\n'; exit 1; }

gera_do_worktree() { # <arquivo-de-saida> -> 0 se gerou
  # shellcheck disable=SC2086  # a lista de nomes é intencionalmente dividida em argumentos
  (cd "$WT_SABOTADO" && bun db/lib/gerar-canaria-fixture.ts $BARATAS "$CARA") >"$1" 2>"$TMP/wt-gen.err"
}

# A restauração é por CÓPIA e se prova por CONTEÚDO (docs/historico/falsificacao-sem-linha-de-base.md):
# `git checkout --` restaura do ÍNDICE, e um exit ignorado deixaria a sabotagem anterior viva para a
# seguinte levar o crédito. Se não confere, ABORTA — nada depois disto significaria alguma coisa.
restaura_gerador() {
  if cp "$GER_INTACTO" "$GER_WT" && cmp -s "$GER_INTACTO" "$GER_WT" \
     && git -C "$WT_SABOTADO" diff --quiet -- scripts/sonda-versao-sql.ts; then
    return 0
  fi
  printf '  \033[31mFALHA\033[0m a restauracao do gerador NAO conferiu — as sabotagens seguintes herdariam a anterior\n'
  exit 1
}

# entrada_normal <id> <marca> -> ecoa "" se a ENTRADA NORMAL do worktree sai vermelha COM a marca
entrada_normal() {
  local log="$LOGS_F/$1.entrada.log" m
  if PGPORT_TEST=$((PORT + 1)) bash "$ENTRADA_WT" > "$log" 2>&1; then printf ' [entrada normal: VERDE]'; return; fi
  m="$(julga_log "$log" "$2")"
  [ -z "$m" ] || printf ' [entrada normal: %s]' "$m"
}

# CONTROLES do eixo, na MESMA invocação: sem eles, um worktree que nem gera SQL — ou uma entrada que
# nem sobe — aprovaria toda sabotagem de gerador: a sempre-vermelha outra vez, um nível acima.
CTRL_WT="$TMP/controle-wt.sql"
if ! gera_do_worktree "$CTRL_WT"; then
  printf '  \033[31mFALHA\033[0m o gerador do HEAD nem emite SQL (%s)\n' "$(cut -c1-80 "$TMP/wt-gen.err")"
  exit 1
fi
ctrl_wt_verde=0
for loc in C "$utf8"; do
  if roda_suite "$CTRL_WT" "$loc" "$LOGS_F/controle-wt.$loc.log"; then
    ctrl_wt_verde=$((ctrl_wt_verde + 1))
  else
    mostra_falhas "$LOGS_F/controle-wt.$loc.log"
  fi
done
if [ "$ctrl_wt_verde" -ne 2 ]; then
  printf '  \033[31mFALHA\033[0m controle do GERADOR nao ficou verde (%d/2) — o HEAD diverge do disco?\n' "$ctrl_wt_verde"
  printf '            (esta parte roda sobre o HEAD COMMITADO: commite antes de falsificar)\n'
  exit 1
fi
if ! PGPORT_TEST=$((PORT + 1)) bash "$ENTRADA_WT" > "$LOGS_F/controle-entrada.log" 2>&1 \
   || ! grep -qx 'VEREDITO DE CANARIA OK' "$LOGS_F/controle-entrada.log"; then
  printf '  \033[31mFALHA\033[0m a ENTRADA NORMAL do worktree nao ficou verde sem sabotagem\n'
  mostra_falhas "$LOGS_F/controle-entrada.log"
  printf '            (esta parte roda sobre o HEAD COMMITADO: commite antes de falsificar)\n'
  exit 1
fi
printf '  \033[32mok\033[0m   controle do gerador verde: injecao nos 2 locales e entrada normal do worktree\n'

sabota_gerador() { # <id> <descricao> <marca> <expressao-sed-no-gerador>
  local id="$1" desc="$2" marca="$3" expr="$4" copia="$TMP/sabotado-por-gerador-$1.sql" erro motivo
  registra "$id" "gerador:$expr" || return 0
  erro="$(sed -E -i.orig "$expr" "$GER_WT" 2>&1)"
  if [ -n "$erro" ]; then
    rm -f "$GER_WT.orig"; restaura_gerador; invalida "$id" "$desc" "sed invalido (${erro:0:60})"; return 0
  fi
  if cmp -s "$GER_WT.orig" "$GER_WT"; then
    rm -f "$GER_WT.orig"; restaura_gerador; invalida "$id" "$desc" "padrao nao casou, gerador intacto"; return 0
  fi
  rm -f "$GER_WT.orig"
  if ! gera_do_worktree "$copia"; then
    # Gerador que NEM EMITE é mecânica quebrada, não captura: a sabotagem mudou a SINTAXE, não a
    # semântica, e a asserção que ela anuncia ninguém mediu. Até 2026-09-10 isto contava como `ok`.
    restaura_gerador
    invalida "$id" "$desc" "o gerador sabotado nem emite SQL ($(cut -c1-60 "$TMP/wt-gen.err"))"; return 0
  fi
  motivo="$(injeta "$id" "$marca" "$copia")$(entrada_normal "$id" "$marca")"
  restaura_gerador
  if [ -z "$motivo" ]; then
    sab_vermelha
    printf '  \033[32mok\033[0m   [%s] "%s" -> vermelha pelo motivo certo (entrada normal + 2 locales)\n' "$id" "$desc"
  else
    sab_falha
    printf '  \033[31mFALHA\033[0m [%s] "%s":%s\n' "$id" "$desc" "$motivo"
    mostra_falhas "$LOGS_F/$id.entrada.log"
  fi
}

# A MESMA mutação que ficou verde sob o #2405, agora no gerador: se o modo normal voltar a julgar um
# retrato (da main, de um commit, de um arquivo commitado), a ENTRADA NORMAL fica VERDE e isto reprova.
sabota_gerador h1 "GERADOR sem o ramo de ok:false (o #2405 aprovava isto)" \
  "ok:false COM marcador batendo = CANARIA VERMELHA|veio 'INDETERMINADO" \
  "s/WHEN ca\\.corpo ->> 'ok' = 'false'/WHEN false/"
# E a ORDEM dos ramos, que é o que só um teste EXECUTADO prova: julgar o status antes do eco.
sabota_gerador h2 "GERADOR julga o status antes do eco (500 vermelha vira bundle velho)" \
  "HTTP 500 COM eco canary|veio 'SEM CANARIA NO AR" \
  "s/WHEN ca\\.corpo ->> 'canary' IS DISTINCT FROM 'true' AND ca\\.status_code >= 400/WHEN ca.status_code >= 400/"
# ── o CONTROLE ATIVO (2026-09-09) ──────────────────────────────────────────────────────────────
# Os casos novos desta suíte (testemunha ativa, leva inteira 401, 2xx anônimo) precisam de vermelho
# ALCANÇÁVEL aqui também: o `.mut` prova o dente da suíte VITEST, que é outra invocação e outro
# corpus. Sem estas duas, os casos novos poderiam ser sempre-verdes nesta suíte e ninguém veria.
# A 1ª é o fail-OPEN que a correção fecha: sem exigir testemunha, o 401 volta a sair determinado
# pelo histórico — e é exatamente o cenário "leva INTEIRA 401 com historico VERDE".
sabota_gerador h3 "GERADOR determina o 401 SEM testemunha ativa (fail-open)" \
  "leva INTEIRA 401 com historico VERDE|veio 'SEM CANARIA NO AR" \
  "s/AND ativo\\.aceitas_na_leva >= 1/AND true/"
# A 2ª é a armadilha do parecer Codex: testemunha por STATUS em vez de IDENTIDADE. Sem o marcador,
# um 2xx anônimo (bundle histórico que ignora a credencial) passa a "provar" o secret.
sabota_gerador h4 "GERADOR aceita 2xx ANONIMO como testemunha (sem o marcador)" \
  "2xx ANONIMO na leva NAO e testemunha|veio 'SEM CANARIA NO AR" \
  "s/AND ca\\.corpo ->> ca\\.campo_marcador = ca\\.marcador_esperado\`,/AND true\`,/"

printf 'SABOTAGENS: %d vermelhas / %d falhas\n' "$SAB_VERMELHAS" "$SAB_FALHAS"
if [ "$falhou" -eq 0 ]; then printf '\nFALSIFICACAO OK — todo verde tem vermelho alcancavel, e pelo motivo certo\n'; exit 0; fi
printf '\nVERMELHO\n'; exit 1
