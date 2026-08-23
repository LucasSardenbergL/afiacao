#!/usr/bin/env bash
# codex-prompt-paginacao.sh — monta o prompt do ritual /codex sobre a família de PAGINAÇÃO
# (#1856 keyset · #1889 EOF por página vazia · #1877/#1882 gate da sonda de versão do
# `recommend`) LENDO O CÓDIGO VIVO do repo, e escreve em stdout.
#
# Por que um gerador e não um .md guardado: o prompt guardado de 2026-08-21 foi reenviado em
# 2026-08-22 descrevendo `if (rows.length < PAGE) break` — critério que o #1889 já tinha
# substituído por `rows.length === 0`. Uma das quatro perguntas dele pedia parecer sobre um
# defeito JÁ CONSERTADO. Prompt que cita código por CÓPIA envelhece em silêncio, e o silêncio
# custa cota: a janela do ChatGPT Plus é rolante de 7 dias e esgota.
#
# Uso:
#   scripts/codex-prompt-paginacao.sh | scripts/codex-async.sh -r xhigh -t 1200 -
#
# Fail-closed: recorte que sai VAZIO aborta com exit 65 em vez de emitir um prompt que
# revisaria o nada. Sonda de extração é a mesma regra dos scripts que apagam — ausência de
# resposta não é resposta.
set -euo pipefail

raiz="$(git rev-parse --show-toplevel)"
cd "$raiz"

# Recorta de uma linha que casa `inicio` até a primeira linha que é exatamente `}` (fim de
# declaração em coluna 0). Marcador SIMBÓLICO, não número de linha: o número muda a cada PR.
#
# ⚠️ Devolve 65 e NÃO chama `exit`: este helper é sempre consumido por `$( )`, e `exit` dentro
# de substituição de comando encerra o SUBSHELL, não o script. A 1ª versão fazia isso e a
# falsificação pegou: com o marcador sabotado, o script imprimiu o erro no stderr, saiu 0 e
# emitiu o prompt COM UM BURACO no lugar da função. Um prompt que revisa o nada, com cara de
# prompt bom, gastando cota de janela rolante de 7 dias. A morte tem de ser do SCRIPT — por
# isso a captura lá embaixo é `|| exit 65`, explícita, e não confia no `set -e` (que é
# suspenso justamente pelo contexto de chamada).
recortar() {
  local arquivo="$1" inicio="$2" rotulo="$3" saida
  saida="$(awk -v re="$inicio" '$0 ~ re {dentro=1} dentro {print} dentro && /^}$/ {exit}' "$arquivo")"
  if [ -z "$saida" ]; then
    echo "ERRO: recorte VAZIO para '$rotulo' em $arquivo (o marcador '$inicio' não casou — o símbolo foi renomeado?)" >&2
    return 65
  fi
  printf '%s\n' "$saida"
}

sha_de() { git log origin/main --format=%h --grep "(#$1)" -1 -- 2>/dev/null || true; }

# Extração ANTES do heredoc, cada uma com a sua morte explícita. Se qualquer recorte falhar, o
# script morre aqui e nenhum prompt é emitido — em vez de emitir um prompt mutilado.
SRC_PAGINATE="supabase/functions/_shared/paginate.ts"
FETCH_ALL="$(recortar "$SRC_PAGINATE" '^export async function fetchAll<' 'fetchAll')" || exit 65
FETCH_KEYSET="$(recortar "$SRC_PAGINATE" '^export async function fetchAllKeyset<' 'fetchAllKeyset')" || exit 65
CODIGOS="$(sed -n '/^const SQLSTATE = /,/^}$/p' supabase/functions/_shared/leitura-critica.ts)"
[ -n "$CODIGOS" ] || { echo "ERRO: recorte VAZIO para 'codigoDoErro/allowlist'" >&2; exit 65; }
SONDA="$(cat supabase/functions/recommend/versao.ts)"
[ -n "$SONDA" ] || { echo "ERRO: recorte VAZIO para 'versao.ts'" >&2; exit 65; }

cat <<CABECALHO
Revisão independente RETROATIVA da família de paginação das edges (Deno/TypeScript, Supabase
PostgREST). Os quatro PRs abaixo já estão MERGEADOS em produção — o ritual não rodou antes do
merge porque a cota estava esgotada, e o repo os marcou como REVISÃO INDEPENDENTE PENDENTE.
Isto é money-path: estas leituras alimentam recomendação de compra e agregação de valor.

Seja adversário. Sem elogio. O que interessa é o caminho que RESOLVE com dado errado — truncar,
pular, duplicar ou fabricar — sem lançar. Erro que grita já está resolvido.

PRs sob revisão (HEAD de origin/main em $(date -u +%Y-%m-%d)):
  #1856 $(sha_de 1856) — paginação keyset em _shared/paginate.ts + call-sites do recommend
  #1877 $(sha_de 1877) — sonda de versão do recommend com gate PRÓPRIO
  #1882 $(sha_de 1882) — sonda ANTES do gate de Bearer
  #1889 $(sha_de 1889) — fim de tabela por página VAZIA, desacoplando do max-rows do PostgREST

CONTEXTO DE PRODUÇÃO (medido, não suposto):
  - PostgREST com max-rows = 1000; PAGE do helper = 1000.
  - 21 call-sites de leitura paginada; DOIS migraram para keyset (order_items, omie_products),
    escolhidos por serem os que sofrem DELETE entre páginas. Os outros 19 seguem em offset.
  - sales_orders: 30.979 linhas, 536 deletes hard — NÃO migrou.

CÓDIGO VIVO (extraído do repo agora, não de cópia):

--- supabase/functions/_shared/paginate.ts :: fetchAll ---
${FETCH_ALL}

--- supabase/functions/_shared/paginate.ts :: fetchAllKeyset ---
${FETCH_KEYSET}

--- supabase/functions/_shared/leitura-critica.ts :: codigoDoErro + allowlist ---
${CODIGOS}

--- supabase/functions/recommend/versao.ts (sonda de versão — #1877/#1882) ---
${SONDA}

PERGUNTAS DIRIGIDAS

(1) fetchAllKeyset — sobrou algum caminho em que ele PULA, DUPLICA ou entra em laço sem
    lançar? A varredura de página agora começa em \`anterior = cursor\` (era \`null\`), o que
    fechou a sobreposição pontual. Ficou algum vão entre a varredura interna e a checagem de
    cursor do fim do laço?

(2) #1889 trocou o critério de parada de \`rows.length < PAGE\` para \`rows.length === 0\`.
    Isso custa uma requisição vazia por leitura e desacopla do max-rows. Em fetchAll o offset
    passou a avançar pelo número REAL de linhas. Existe combinação de max-rows, PAGE e
    escrita concorrente em que o novo critério lê a MESMA linha duas vezes, ou nunca para?

(3) #1877/#1882 — a sonda de versão responde ANTES do gate de \`Bearer \` do handler e usa
    gate próprio (\`authorizeCronOrStaff\`). O corpo do request é consumido pela sonda e
    \`req.json()\` só pode ser lido uma vez. Um request malformado, ou um que NÃO é sonda,
    pode sair daqui com o corpo já drenado e virar erro/vazio silencioso mais adiante?

(4) A decisão de migrar 2 de 21 call-sites se sustenta, ou sales_orders (536 deletes hard,
    30.979 linhas) também deveria ter entrado?

(5) O que estas medições NÃO provam?
CABECALHO
