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
PORT=5441
export LC_ALL=C LANG=C  # sem isto o postmaster morre com "became multithreaded during startup"
export PGVER=17   # consumido pelo db/lib/pg-harness.sh via source
# Resolve o PGBIN do PG17 pelo harness (laptop, PGDG, `PGBIN_OVERRIDE`) em vez de cravar o
# caminho do Homebrew: prova que só roda numa máquina é prova que ninguém repete.
# shellcheck disable=SC1091  # o gate roda sem -x; o helper e versionado ao lado, em db/lib/
. "$RAIZ/db/lib/pg-harness.sh"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/pgtest-canaria.XXXXXX")"
DATA="$TMP/data"; SOCK="$TMP"
# shellcheck disable=SC2329  # invocada pelo `trap` abaixo
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMP"; }
trap cleanup EXIT

# ------------------------------------------------- o SQL REAL, gerado pelo script ---
# As três canárias BARATAS cobrem os três formatos de resposta que existem: topo (`copilot-analyze`),
# envelope `data` (`omie-analytics-sync`) e topo com `success` (`omie-financeiro`). A CARA
# (`generate-tactical-plan`) entra porque é a única cujo marcador mora no campo `versao` — e a única
# que responde 500 numa canária vermelha.
BARATAS="copilot-analyze omie-analytics-sync:doc_ambiguo_probe omie-financeiro"
CARA="generate-tactical-plan"
GERADO="$TMP/gerado.sql"
# shellcheck disable=SC2086  # a lista de nomes é intencionalmente dividida em argumentos
if ! (cd "$RAIZ" && bun scripts/sonda-versao-sql.ts --canaria $BARATAS "$CARA" --sem-rede) > "$GERADO" 2>"$TMP/gen.err"; then
  echo "VERMELHO — o gerador falhou:"; cut -c1-400 "$TMP/gen.err"; exit 1
fi
# Sonda POSITIVA: geração vazia/silenciosa viraria suíte verde sobre SQL nenhum.
grep -q 'AS veredito' "$GERADO" || { echo "VERMELHO — SQL gerado não tem CASE de veredito"; exit 1; }
grep -q 'net.http_post' "$GERADO" || { echo "VERMELHO — SQL gerado não dispara nada"; exit 1; }

# extrai_leitura <ordinal> <arquivo_sql> — o corpo do n-ésimo `format($sonda$…$sonda$`, que é o
# bloco de LEITURA que o passo de disparo devolve. O `%1$L` (placeholder do mapa) e o `%%` (escape
# do format) são desfeitos aqui, exatamente como o Postgres faria ao executar o passo 1 — que este
# banco não pode rodar, porque não tem `net.http_post`.
extrai_leitura() {
  local n="$1" arq="$2"
  awk -v alvo="$n" '
    /^SELECT format\(\$sonda\$$/ { blocos++; if (blocos == alvo) { dentro = 1; next } }
    /^\$sonda\$, m\.ids\)/      { if (dentro) exit }
    dentro { print }
  ' "$arq"
}

MAPA_BARATAS='{"copilot-analyze": 1001, "omie-analytics-sync:doc_ambiguo_probe": 1002, "omie-financeiro": 1003}'
MAPA_CARA='{"generate-tactical-plan": 2001}'

monta_leitura() { # <ordinal> <mapa-json> <arquivo_sql> -> stdout
  extrai_leitura "$1" "$3" \
    | sed "s|%1\$L|'$2'|" \
    | sed 's|%%|%|g'
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
CREATE TABLE net._http_response (
  id bigint PRIMARY KEY, status_code int, content text, created timestamptz NOT NULL
);
SQL

# ------------------------------------------------------------------- asserções ---
fail=0
ok()  { printf '  \033[32mok\033[0m   %s\n' "$1"; }
bad() { printf '  \033[31mFALHA\033[0m %s\n' "$1"; fail=1; }

# veredito <id-da-canaria> <arquivo-de-leitura> -> imprime o veredito daquela linha
veredito() {
  P -t -A -F'|' -f "$2" 2>/dev/null | awk -F'|' -v n="$1" '$1 == n { print $8 }'
}

# espera <descricao> <nome> <arquivo> <marca-esperada>
# Casa a MARCA do ramo (ASCII, caixa fixa, sem -i), não "deu erro": um veredito que mudasse de
# INDETERMINADO para CANARIA VERMELHA passaria num teste que só exigisse "não é verde".
espera() {
  local desc="$1" nome="$2" arq="$3" marca="$4" v
  v="$(veredito "$nome" "$arq")"
  case "$v" in
    "$marca"*) ok "$desc" ;;
    "")        bad "$desc — nenhuma linha para '$nome' (a leitura não parte de \`esperado\`?)" ;;
    *)         bad "$desc — esperava '$marca…', veio '${v:0:90}'" ;;
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

  P -q -c "TRUNCATE net._http_response;" >/dev/null
  P -q >/dev/null <<'SQL'
INSERT INTO net._http_response (id, status_code, content, created) VALUES
  (1001, 401, '{"code":401,"message":"Unauthorized"}', now());
INSERT INTO net._http_response (id, status_code, content, created)
  SELECT 9000 + g, 200, '{"ok":true}', now() - (g || ' minutes')::interval FROM generate_series(1, 40) g;
SQL
  espera "401 com CRON_SECRET provado bom = SEM CANARIA NO AR" \
    'copilot-analyze' "$LB" 'SEM CANARIA NO AR'

  P -q -c "TRUNCATE net._http_response;" >/dev/null
  P -q >/dev/null <<'SQL'
INSERT INTO net._http_response (id, status_code, content, created) VALUES
  (1001, 401, '{"code":401}', now());
SQL
  espera "401 SEM controle de credencial é INDETERMINADO, nunca veredito" \
    'copilot-analyze' "$LB" 'INDETERMINADO'

  P -q -c "TRUNCATE net._http_response;" >/dev/null
  P -q >/dev/null <<'SQL'
INSERT INTO net._http_response (id, status_code, content, created) VALUES
  (1001, 404, '{"code":404}', now());
SQL
  espera "4xx sem eco = recusou o request, NADA executou" \
    'copilot-analyze' "$LB" 'SEM CANARIA NO AR'

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
  if [ "$fail" -eq 0 ]; then printf '\nVEREDITO DE CANARIA OK\n'; exit 0; fi
  printf '\nVERMELHO\n'; exit 1
fi

# ---------------------------------------------------------------- falsificação ---
printf '== falsificacao (sabota o SQL e EXIGE vermelho) ==\n'
falhou=0
utf8=""
for cand in pt_BR.UTF-8 pt_BR.utf8 en_US.UTF-8 en_US.utf8 C.UTF-8 C.utf8; do
  if [ "$(LC_ALL="$cand" locale charmap 2>/dev/null)" = "UTF-8" ]; then utf8="$cand"; break; fi
done
[ -n "$utf8" ] || { printf '  \033[31mFALHA\033[0m nenhum locale UTF-8 — metade da cobertura fingindo ser inteira\n'; exit 1; }

# CONTROLE VERDE na MESMA invocação do laço, ANTES do primeiro sed — e pelo MESMO caminho que as
# sabotagens usam (cópia em $TMP, os dois locales, `ALVO` sobrescrito). Sem ele, uma suíte
# sempre-vermelha (por locale, por psql morto, por recorte quebrado) aprovaria TODA sabotagem, e a
# suíte crua do modo normal é OUTRA invocação — não prova nada sobre este laço.
CONTROLE="$TMP/controle.sql"
cp "$GERADO" "$CONTROLE"
controle_verde=0
# shellcheck disable=SC2030  # o LC_ALL local ao subshell e o DESENHO: cada rodada da suite ve um
#                              locale, e o pai continua em C. Idem SC2031 no laco de sabotagem.
for loc in C "$utf8"; do
  if ( export LC_ALL="$loc"; ALVO="$CONTROLE"; fail=0; suite >/dev/null 2>&1; [ "$fail" -eq 0 ] ); then
    controle_verde=$((controle_verde + 1))
  fi
done
if [ "$controle_verde" -ne 2 ]; then
  printf '  \033[31mFALHA\033[0m controle NAO ficou verde (%d/2) — laco sempre-vermelho aprovaria toda sabotagem\n' "$controle_verde"
  exit 1
fi
printf '  \033[32mok\033[0m   controle verde nos 2 locales (o laco distingue verde de vermelho)\n'

sabota() { # <descricao> <expressao-sed>
  local desc="$1" expr="$2" copia="$TMP/sabotado.sql" erro
  erro="$(sed -E "$expr" "$GERADO" 2>&1 >"$copia")"
  if [ -n "$erro" ]; then
    printf '  \033[31mFALHA\033[0m "%s": sed invalido (%s) — falsificacao vazia\n' "$desc" "${erro:0:60}"; falhou=1; return
  fi
  if cmp -s "$GERADO" "$copia"; then
    printf '  \033[31mFALHA\033[0m "%s": padrao nao casou, SQL intacto — falsificacao vazia\n' "$desc"; falhou=1; return
  fi
  local viu_vermelho=0 loc
  # shellcheck disable=SC2031  # ver a nota do laco de controle: o escopo por subshell e o desenho
  for loc in C "$utf8"; do
    if ! ( export LC_ALL="$loc"; ALVO="$copia"; fail=0; suite >/dev/null 2>&1; [ "$fail" -eq 0 ] ); then
      viu_vermelho=$((viu_vermelho + 1))
    fi
  done
  if [ "$viu_vermelho" -eq 2 ]; then
    printf '  \033[32mok\033[0m   "%s" -> suite vermelha nos 2 locales\n' "$desc"
  else
    printf '  \033[31mFALHA\033[0m "%s": suite ficou VERDE (%d/2 vermelhos) — assercao frouxa\n' "$desc" "$viu_vermelho"; falhou=1
  fi
}

# ⚠️ Sabota-se UMA CAMADA POR VEZ, e a ordem abaixo é a lição: a primeira tentativa mirou as
#    conjunções do ramo VERDE (`AND ... ok = 'true'`, `AND ... marcador = esperado`) e a suíte ficou
#    VERDE nas duas — porque os ramos ESPECÍFICOS acima já interceptam esses casos. Não era asserção
#    frouxa, era conjunção INALCANÇÁVEL pelos fixtures que existiam. Duas correções, ambas honestas:
#    o fixture de `ok` não-booleano (acima) tornou a primeira alcançável, e a segunda é atacada onde
#    ela decide de verdade — no ramo que NOMEIA a divergência.

# (a1) O ramo que dá sentido ao arquivo: sem ele, "está no ar" vira "está correto".
sabota "sem o ramo de ok:false (a vermelha perde o nome)" \
  "s/WHEN ca\.corpo ->> 'ok' = 'false'/WHEN false/"
# (a2) A conjunção do ramo verde, agora ALCANÇÁVEL pelo fixture de \`ok\` não-booleano.
sabota "verde deixa de exigir ok:true (ok nao-booleano vira verde)" \
  "s/AND ca\.corpo ->> 'ok' = 'true'//"
# (b1) O ramo que nomeia a divergência de marcador.
sabota "sem o ramo de marcador divergente (a outra fatia perde o nome)" \
  "s/WHEN ca\.corpo ->> ca\.campo_marcador IS DISTINCT FROM ca\.marcador_esperado/WHEN false/"
# (b2) A armadilha 2 do deploy.md RECONSTRUÍDA: nada no CASE julga o marcador. O bundle velho
#      compara velho x velho, responde ok:true, e o veredito sai CANARIA VERDE — mentindo verde.
sabota "o CASE inteiro deixa de julgar o marcador (bundle velho MENTE VERDE)" \
  "s/WHEN ca\.corpo ->> ca\.campo_marcador IS DISTINCT FROM ca\.marcador_esperado/WHEN false/; s/AND ca\.corpo ->> ca\.campo_marcador = ca\.marcador_esperado//"
# (b3) O marcador esperado que sai do REPO vira um digitado qualquer: a canária no ar deixa de bater.
sabota "marcador esperado fabricado no VALUES (repo deixa de mandar)" \
  "s/(\('copilot-analyze', 'contrato', ')[^']*/\1marcador-fabricado-v0/"
# (b4) O campo do marcador deixa de ser POR CANÁRIA: quem serve em \`versao\` some.
sabota "marcador lido sempre de 'contrato' (a generate-tactical-plan some)" \
  "s/ca\.corpo ->> ca\.campo_marcador/ca.corpo ->> 'contrato'/g"
# (c) A ORDEM dos ramos: julgar o status ANTES do eco faz a vermelha de HTTP 500 da
#     generate-tactical-plan sair como 'recusou o request'.
sabota "status julgado antes do eco (500 vermelha vira bundle velho)" \
  "s/WHEN ca\.corpo ->> 'canary' IS DISTINCT FROM 'true' AND ca\.status_code >= 400/WHEN ca.status_code >= 400/"
# (d) O envelope \`data\`: sem descer nele, as canárias da omie-analytics-sync somem para
#     'sem eco' — um bundle correto classificado como velho.
sabota "sem o COALESCE do envelope data (analytics vira 'sem eco')" \
  "s/COALESCE\(resp\.content::jsonb -> 'data', resp\.content::jsonb\)/resp.content::jsonb/"
# (e) NULL-blind: trocar IS DISTINCT FROM por <> faz a chave AUSENTE devolver NULL, o ramo do
#     eco não casa, e a resposta sem `canary` cai adiante no CASE.
sabota "eco testado por <> (NULL-blind: chave ausente devolve NULL)" \
  "s/ca\.corpo ->> 'canary' IS DISTINCT FROM 'true'/l.corpo ->> 'canary' <> 'true'/g"
# (f) A janela: sem ela, uma resposta de outra sessão vira veredito de agora.
sabota "sem o guard de janela (resposta velha vira veredito de agora)" \
  "/WHEN ca\.created <= now\(\) - interval/,+3d"

if [ "$falhou" -eq 0 ]; then printf '\nFALSIFICACAO OK — todo verde tem vermelho alcancavel\n'; exit 0; fi
printf '\nVERMELHO\n'; exit 1
