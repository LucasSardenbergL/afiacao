#!/usr/bin/env bash
# edges-pendentes.sh — Passo 3 do /fecho: das edges que mergearam na janela, quais AINDA
# precisam de chip?
#
# O QUE ELE RESOLVE. O gatilho do Passo 3 era `git log ... -- supabase/functions/` puro: commit na
# janela ⇒ chip. Num repo com dezenas de worktrees e ~4–11 merges de edge por dia, esse gatilho é
# quase sempre verdadeiro, e a MESMA edge vira chip em toda sessão que fecha na mesma janela. Chip
# redundante não é grátis: o founder é quem clica, e uma fila de chips iguais some com o chip que
# importava. Este script troca "commit no git" por "o que está NO AR", usando a única evidência
# que já existe de graça: o campo `fonte` que `criarRespostaSonda` serve (SHA-256 do fecho
# transitivo dos imports locais) comparado com `_shared/sonda-fingerprints.ts` da main.
#
# 🔴 A DIREÇÃO É UMA SÓ: presença PROVA, ausência NÃO reprova (a lição do #2086/#2095). Este
# script só sabe SUPRIMIR chip com evidência POSITIVA — `fonte` servido == `fonte` da main. Tudo
# o mais (sem linha na janela, edge fora do mapa, `nao-mapeada`, banco mudo) sai como pendência.
# Ele é o lado que APAGA a pendência, então é fail-CLOSED por desenho: na dúvida, chip.
#
# ⚠️ Mas "na dúvida, chip" não autoriza INVENTAR a dúvida. A 1ª versão filtrava as respostas por
# `content ? 'fonte'` ANTES de classificar, e um bundle anterior ao #1998 — que responde 200 com
# `{ok,probe,versao,edge}` e SEM `fonte` — sumia do resultado e caía em "nenhuma sonda na janela:
# INDETERMINADO". Medido em prod (2026-09-05, request_ids 69305-69314): 7 das 10 edges sondadas
# responderam assim, e as 7 saíram como ausência de dado. Não é ausência: um 200 que ecoa `probe`
# e não traz `fonte` PROVA que o bundle no ar é anterior ao #1998, e o veredito certo é pendência
# PROVADA (ramo PRE_SONDA_FONTE). Ausência fabricada não é fail-closed — é ruído com o mesmo
# desfecho do sinal, e some com o chip que importava (o mesmo custo que este script existe para
# cortar). O que continua INDETERMINADO: 401, resposta sem eco de `probe` e ausência de linha.
#
# Por que a comparação é imune ao guard temporal do #2079: o `fonte` é função do CONTEÚDO, não do
# relógio. Uma resposta gravada ANTES do merge carrega o fingerprint do bundle velho e não casa com
# a main. Não há "tick pré-merge lido como prova" aqui — o que o `versao` não veria (mesma string
# nas duas pontas), o `fonte` vê (foi assim que o `omie-vendas-sync` foi pego com bundle velho).
#
# COBERTURA, dita em voz alta: o mapa cobre ~40 das ~95 edges. As outras ~55 saem SEM_PROVA e
# viram chip como hoje — o gate não regride nada, só corta o redundante onde há prova.
#
# 🪦 INERTE — a 2ª evidência positiva, e a única que NÃO vem do banco (2026-09-05, `tint-import`).
# Edge APOSENTADA (o handler responde 410 logo após a auth e não executa nada) continua sendo
# TOCADA por PR: a `tint-import` carrega o espelho VERBATIM de `parse-decimal-br.ts` que o
# `edge-parse-parity.test.ts` exige, então toda mudança no parser (#2184) a coloca na janela — e
# ela saía SEM_PROVA, chip para o founder, por um deploy que NÃO MUDA COMPORTAMENTO: bundle novo e
# velho respondem o mesmo 410. Prova passiva é impossível (fora do mapa) e prova ativa seria
# teatro (o 410 vem antes de qualquer lógica). O que existe é uma DECLARAÇÃO: o marcador
# `// EDGE-APOSENTADA: <motivo>` no `index.ts` da REF (`origin/main`, nunca o working tree — o
# closure lê a REF, lovable-deploy-verify §Passo 3). Marcador presente ⇒ INERTE, sem chip; ausente
# ⇒ o ramo de sempre (SEM_PROVA). É um marcador DECLARADO de propósito, não inferência por
# `status: 410` no texto: `omie-analytics-sync` tem uma FUNÇÃO aposentada e a edge viva — inferir
# pelo texto classificaria errado. E o contrato do marcador é duplo: (1) o handler é no-op e (2) a
# aposentadoria JÁ ESTÁ NO AR — só coloque o marcador depois de confirmar o 410 em prod, porque
# o único deploy que importaria numa edge aposentada é o que INSTALA a aposentadoria, e este
# script deixaria de pedi-lo. O gate `_shared/edge-aposentada-marcador_test.ts` trava a metade
# (1): marcador sem `status: 410` no mesmo arquivo é vermelho no CI.
#
# ⚠️ E o eco de `fonte` não era o único campo que faltava. O casamento resposta↔edge depende do
# ECO DO SLUG (`content->>'edge'`), que só nasceu no #1789 — e há bundle no ar ANTERIOR a ele, que
# responde `{ok,probe,versao}` e mais nada. Medido em prod 2026-09-05 (request_ids 69377-69381):
# das 5 edges sondadas, só as 2 que ecoam `edge` saíram PRE_SONDA_FONTE; as outras 3 saíram
# "nenhuma sonda em 6 hours" — pendência PROVADA virando ausência de dado, o MESMO erro do #2156
# uma geração de campo atrás. Não enganou porque quem sondou tinha os `request_id` em mãos; o
# caminho normal do /fecho não tem.
#   O que NÃO dá para fazer: presumir a identidade. Sem o eco do slug a resposta não diz de qual
#   edge é, e `net.http_request_queue` — a única tabela do pg_net que guarda a URL — é APAGADA
#   quando a resposta chega (conferido em prod no mesmo dia: fila com os ids em voo, nenhum dos
#   respondidos). Ausência de identidade não pode virar identidade presumida.
#   O que dá, e é o conserto: (a) `--request-ids slug=<id>` traz o ÚNICO vínculo determinístico que
#   existe, como o `ids` do `sonda:sql`; (b) sem ele, a saída para de dizer "nenhuma sonda" quando
#   HÁ sonda anônima na janela — conta quantas são e manda determinar pelo request_id. Nos dois
#   casos o desfecho segue chip; o que muda é o diagnóstico deixar de mentir.
#
# Uso:
#   edges-pendentes.sh <slug> [<slug> ...]      # classifica os slugs dados
#   edges-pendentes.sh --desde "<data-ou-SHA>"  # deriva os slugs da janela (UNIÃO de 2 fontes)
#   ... [--request-ids "slug=<request_id>,…"]   # OPCIONAL: casa a resposta SEM eco de slug
#
# `--desde` enumera pela UNIÃO, porque cada fonte sozinha tem furo (mesmo princípio do Passo 4 da
# lovable-deploy-verify): (a) o DIFF do mapa de fingerprints entre o início da janela e a main —
# única via que enxerga mudança em `_shared/`, que muda o bundle de N edges sem tocar na pasta de
# nenhuma; (b) o `git log --name-only` das pastas — única via que enxerga edge FORA do mapa.
#
# Exit: 0 = nada pendente (todas provadas no ar) · 1 = há pendência → abra chip para a lista
#       2 = a MECÂNICA não é confiável (sem banco, mapa ilegível, janela inválida) → trate TUDO
#           como pendente; o script já imprime todos os alvos como SEM_PROVA
#       3 = uso inválido
#
# Env: AFIACAO_PSQL (default ~/.config/afiacao/psql-ro) · FECHO_JANELA_TTL (default '6 hours',
#      = pg_net.ttl) · FECHO_MAPA_FONTE (arquivo de mapa alternativo; default = o da REF) ·
#      FECHO_REQUEST_IDS (mesmo formato do `--request-ids`, que tem precedência) ·
#      FECHO_REF (a REF mergeada que o script lê; default `origin/main` — SÓ para teste/falsificação,
#      apontar para branch local em uso real faria o "desatualizada" mentir).
# Testes: scripts/test-fecho-edges-pendentes.sh (com --falsificar) — e o SQL roda de VERDADE em
#         .claude/skills/lovable-deploy-verify/evals/edges-pendentes-sql-eval.sh.
set -uo pipefail

JANELA="${FECHO_JANELA_TTL:-6 hours}"
PSQL="${AFIACAO_PSQL:-$HOME/.config/afiacao/psql-ro}"
MAPA_REL="supabase/functions/_shared/sonda-fingerprints.ts"
# A REF mergeada. Tudo o que o script lê do git (mapa, log, grafo, marcador de aposentadoria) vem
# DAQUI, nunca do working tree — a pergunta é sempre "o ar bate com o que ESTÁ MERGEADO?".
REF="${FECHO_REF:-origin/main}"
# Marcador DECLARADO de edge aposentada (ver cabeçalho §INERTE). Literal, caixa fixa, com os `//`
# e o `:` — um comentário que apenas CITE a palavra não casa.
MARCADOR_APOSENTADA='// EDGE-APOSENTADA:'
RAIZ="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../../../.." 2>/dev/null && pwd)}"
# Onde mora o BINÁRIO auxiliar. Deriva de `$0`, nunca de `$RAIZ`: a suíte aponta `$RAIZ` para um
# repo git de fixture, e o `edges-afetadas.ts` tem de continuar vindo do repo que hospeda o script.
BIN_RAIZ="$(cd "$(dirname "$0")/../../../.." 2>/dev/null && pwd)"
AFETADAS_TS="$BIN_RAIZ/scripts/edges-afetadas.ts"

tmp="$(mktemp -d)" || { echo "edges-pendentes: mktemp falhou"; exit 2; }
trap 'rm -rf "$tmp"' EXIT

# --------------------------------------------------------------------- uso ---
# `--request-ids` sai da linha de comando ANTES de tudo: o resto do script trata `$@` como lista de
# slugs, e um flag esquecido ali viraria "slug" e depois "edge fora do mapa" — chip fantasma.
REQ_IDS="${FECHO_REQUEST_IDS:-}"
_args=()
while [ "$#" -gt 0 ]; do
  case "$1" in
    --request-ids)   REQ_IDS="${2:-}"; shift; [ "$#" -gt 0 ] && shift ;;
    --request-ids=*) REQ_IDS="${1#--request-ids=}"; shift ;;
    *)               _args+=("$1"); shift ;;
  esac
done
set -- ${_args[@]+"${_args[@]}"}

[ "$#" -ge 1 ] || {
  echo "uso: edges-pendentes.sh <slug> [slug...]   |   edges-pendentes.sh --desde \"<git-since>\""
  echo "     [--request-ids \"slug=<request_id>,…\"]  (opcional; casa resposta sem eco de slug)"
  exit 3
}

# ------------------------------------------------------- alvos (quem medir) ---
# Modo --desde: a UNIÃO das duas fontes. Sem ela o gate herda o furo da fonte escolhida.
if [ "$1" = "--desde" ]; then
  desde="${2:-}"
  [ -n "$desde" ] || { echo "uso: edges-pendentes.sh --desde \"<git-since>\""; exit 3; }

  # aceita DATA ("3 hours ago", "2026-08-28 14:00") ou REVISÃO (o SHA do início da sessão, que é
  # o dado mais preciso que o /fecho tem à mão). Revisão primeiro: um SHA nunca é data válida.
  base="$(git -C "$RAIZ" rev-parse --verify --quiet "${desde}^{commit}" 2>/dev/null)"
  [ -n "$base" ] || base="$(git -C "$RAIZ" rev-list -1 --before="$desde" "$REF" 2>/dev/null)"
  if [ -z "$base" ]; then
    echo "⚠️ edges-pendentes: não achei o commit-base de $REF antes de \"$desde\""
    echo "   (git fetch feito? a data é parseável pelo git, ou o SHA existe?) — exit 2"
    exit 2
  fi

  # (a) diff do mapa de fingerprints: pega mudança vinda de _shared/, cega para edge fora do mapa
  git -C "$RAIZ" show "$base:$MAPA_REL" 2>/dev/null \
    | sed -nE 's/.*"([a-z0-9_-]+)": *"([0-9a-f]{64})".*/\1 \2/p' > "$tmp/mapa_base" || true
  git -C "$RAIZ" show "$REF:$MAPA_REL" 2>/dev/null \
    | sed -nE 's/.*"([a-z0-9_-]+)": *"([0-9a-f]{64})".*/\1 \2/p' > "$tmp/mapa_agora" || true
  # slug cujo par (slug sha) existe no mapa de agora e NÃO existe igual no mapa base ⇒ fonte mudou
  # (inclui edge NOVA, que não tem linha no base).
  if [ -s "$tmp/mapa_agora" ]; then
    while read -r slug sha; do
      command grep -Fxq -- "$slug $sha" "$tmp/mapa_base" 2>/dev/null || printf '%s\n' "$slug"
    done < "$tmp/mapa_agora" >> "$tmp/alvos"
  fi

  # (b) pastas tocadas no git log: pega edge FORA do mapa, cega para _shared/
  git -C "$RAIZ" log "$base..$REF" --name-only --format="" -- supabase/functions/ 2>/dev/null \
    | sort -u > "$tmp/paths"
  sed -n 's#^supabase/functions/\([a-z0-9][a-z0-9_-]*\)/.*#\1#p' "$tmp/paths" >> "$tmp/alvos"
  # o `[a-z0-9]` inicial exclui `_shared/` de propósito: não é edge, não se deploya sozinha,
  # e o efeito dela nas edges que a importam já entra pela via (a), o diff dos fingerprints.

  # 🔴 O furo que a UNIÃO ainda deixaria: `_shared/` tocado é a ÚNICA classe cujas edges afetadas
  # NENHUMA das duas vias enxerga sem o mapa — a (b) não conhece o grafo de imports e a (a) precisa
  # do arquivo. Sem essa trava, mudança só em `_shared/` sairia como "nenhuma edge na janela": chip
  # suprimido por AUSÊNCIA DE DADO, que é o modo de falha caro de um script que APAGA pendência.
  if command grep -q '^supabase/functions/_shared/' "$tmp/paths" 2>/dev/null; then
    # (c) GRAFO DE IMPORTS: a única via que enxerga edge FORA do mapa afetada só por `_shared/`.
    # A (a) só conhece quem está no mapa e a (b) só quem teve a própria pasta tocada; a interseção
    # dos dois furos são 41 edges reais (medidas em 2026-09-05 sobre origin/main) — entre elas a
    # `visit-score-recalc-client`, afetada de fato na janela 21/08→05/09 e que escapou inteira.
    # Universo = toda pasta com `index.ts`, no mapa ou fora ⇒ fecha a CLASSE, não os 41 casos.
    # São as MESMAS 41 que o bloco abaixo cita: lá elas explicam por que `mapa_base` ausente
    # amplia em vez de cegar; aqui elas são o universo que nenhuma das duas vias enumerava.
    #
    # Fail-CLOSED e exigindo resposta POSITIVA: `command -v bun` não basta — bun presente-porém-
    # quebrado esvaziaria o alvo do mesmo jeito (`docs/historico/sonda-ausente-em-script-que-apaga.md`).
    # Aqui a resposta positiva é o EXIT 0 do próprio auxiliar, que já é fail-closed por edge.
    if [ ! -f "$AFETADAS_TS" ] || ! command -v bun >/dev/null 2>&1; then
      echo "⚠️ edges-pendentes: \`_shared/\` mudou na janela e não consigo rodar o grafo de imports"
      echo "   ($AFETADAS_TS / bun) — não sei QUAIS edges fora do mapa isso afetou. exit 2."
      exit 2
    fi
    if ! bun "$AFETADAS_TS" --repo "$RAIZ" --base "$base" --head "$REF" \
         > "$tmp/afetadas" 2> "$tmp/afetadas.err"; then
      sed 's/^/   /' "$tmp/afetadas.err" >&2
      echo "⚠️ edges-pendentes: o grafo de imports não pôde ser calculado — lista vazia por ERRO é"
      echo "   indistinguível de lista vazia por mérito. MECÂNICA NÃO CONFIÁVEL, exit 2."
      exit 2
    fi
    [ -s "$tmp/afetadas.err" ] && sed 's/^/   /' "$tmp/afetadas.err" >&2
    cat "$tmp/afetadas" >> "$tmp/alvos"

    # ⚠️ As duas pontas do mapa NÃO têm o mesmo papel, e juntá-las num `||` só é o que travava o
    # Passo 3 em exit 2 na janela de MAIOR risco. Medido 2026-09-05, `--desde "2026-08-21 20:00"`:
    # 26 arquivos de `_shared/` tocados, 41 das 95 edges afetadas por transitividade — e veredito
    # nenhum, porque o commit-base é anterior ao #1998, que CRIOU o mapa. A ponta que faltava era
    # a inútil para a decisão.
    #   · `mapa_agora` (origin/main) é INDISPENSÁVEL: é a fonte do `esperado` de toda edge e a
    #     única via que enxerga o efeito de `_shared/`. Sem ele não há o que enumerar nem com o
    #     que comparar — cegueira de verdade, exit 2.
    #   · `mapa_base` só ESTREITA: o diff existe para TIRAR da lista quem não mudou. Sem ele
    #     nenhum par casa e a via (a) já emitiu o mapa INTEIRO como alvo — o superconjunto
    #     SEGURO. Degradar aqui AMPLIA a lista, e cada alvo segue classificado um a um por prova
    #     positiva. Desistir jogaria fora o NO_AR de quem TEM prova, e "trate as 95 como
    #     pendentes" é ingerível: vira chip para tudo, e fila de chip igual enterra o chip que
    #     importa — exatamente o custo que este script existe para cortar.
    if [ ! -s "$tmp/mapa_agora" ]; then
      echo "⚠️ edges-pendentes: \`_shared/\` mudou na janela e o mapa de fingerprints da MAIN não"
      echo "   pôde ser lido — não sei QUAIS edges isso afetou. MECÂNICA NÃO CONFIÁVEL, exit 2."
      exit 2
    fi
    if [ ! -s "$tmp/mapa_base" ]; then
      echo "ℹ️  mapa_base ausente — a janela começa antes de \`$MAPA_REL\` existir."
      echo "   O diff não estreitou nada: a via (a) emitiu o mapa INTEIRO como alvo. Enumeração"
      echo "   AMPLIADA (superconjunto seguro), não cega — cada alvo segue classificado abaixo."
    fi
    if [ ! -s "$tmp/alvos" ]; then
      echo "⚠️ \`_shared/\` mudou na janela e NENHUMA edge saiu — nem pelo fingerprint (via a) nem"
      echo "   pelo grafo de imports (via c), que enxerga TODA pasta com \`index.ts\`. Ou a mudança"
      echo "   não entra em bundle nenhum (arquivo só de teste, órfão), ou o mapa não foi regenerado"
      echo "   no merge (\`bun run sonda:fingerprint\`)."
      echo "   Confira antes de concluir que não há deploy pendente."
    fi
  fi

  sort -u -o "$tmp/alvos" "$tmp/alvos" 2>/dev/null || true
else
  printf '%s\n' "$@" | sort -u > "$tmp/alvos"
fi

if [ ! -s "$tmp/alvos" ]; then
  echo "✅ nenhuma edge na janela — nada a deployar, nenhum chip."
  exit 0
fi

# ------------------------------------------------ vínculo explícito por request_id ---
# O ÚNICO vínculo determinístico entre uma resposta sem eco de slug e a edge que a serviu. Vale
# `<slug>=<request_id>` separado por vírgula, e NADA além disso: cada metade é interpolada no SQL,
# e o slug só passa se for `[a-z0-9_-]` (nenhuma aspa cabe aí) e o id se for só dígito.
#
# Toda recusa aqui é exit 3 — RUÍDO DE USO, nunca veredito sobre deploy. Aceitar um par malformado
# em silêncio é o modo de falha caro: o operador acha que colou, a edge segue sem vínculo, e a
# saída diz "sem sonda" com a mesma cara de sempre. Slug FORA da leva também é recusado, pelo
# mesmo motivo que o `--caro` do `sonda:sql` recusa forasteira: um "s" a menos no nome deixaria a
# edge que interessa sem o vínculo que o operador acha que deu.
vinculo_values=""
if [ -n "$REQ_IDS" ]; then
  IFS=',' read -r -a _pares <<< "$REQ_IDS"
  for _par in ${_pares[@]+"${_pares[@]}"}; do
    _slug="${_par%%=*}"; _id="${_par#*=}"
    case "$_par" in *=*) ;; *) echo "edges-pendentes: --request-ids espera 'slug=id', recebi '$_par'"; exit 3 ;; esac
    case "$_slug" in ""|*[!a-z0-9_-]*) echo "edges-pendentes: slug inválido em --request-ids: '$_slug'"; exit 3 ;; esac
    case "$_id"   in ""|*[!0-9]*)      echo "edges-pendentes: request_id não numérico: '$_id'"; exit 3 ;; esac
    if ! command grep -Fxq -- "$_slug" "$tmp/alvos"; then
      echo "edges-pendentes: SLUG_FORA_DA_LEVA — --request-ids nomeia '$_slug', fora da leva medida."
      echo "   Um nome que não casa deixaria a edge de verdade SEM o vínculo, e a saída diria"
      echo "   'sem sonda' como se nada tivesse sido colado. Nada foi consultado — exit 3."
      exit 3
    fi
    vinculo_values="${vinculo_values:+$vinculo_values, }('$_slug', $_id::bigint)"
  done
fi

# --------------------------------------------------- mapa de fingerprints ---
# Da origin/main de propósito: a pergunta é "o ar bate com o que ESTÁ MERGEADO?", não com o
# worktree local (que pode ter fatia ainda não mergeada, e aí o "desatualizada" seria mentira).
if [ -n "${FECHO_MAPA_FONTE:-}" ]; then
  cat "$FECHO_MAPA_FONTE" 2>/dev/null > "$tmp/mapa_bruto"
else
  git -C "$RAIZ" show "$REF:$MAPA_REL" 2>/dev/null > "$tmp/mapa_bruto"
fi
sed -nE 's/.*"([a-z0-9_-]+)": *"([0-9a-f]{64})".*/\1 \2/p' "$tmp/mapa_bruto" \
  2>/dev/null > "$tmp/mapa" || true

mecanica_ok=1
motivo=""
if [ ! -s "$tmp/mapa" ]; then
  mecanica_ok=0
  motivo="mapa de fingerprints ilegível ou vazio ($MAPA_REL na $REF)"
fi

# ------------------------------------------------------- sonda do BANCO ---
# `command -v` NÃO basta: wrapper presente-porém-quebrado esvaziaria o gate igual, e este é o
# script que APAGA pendência. Exige-se RESPOSTA POSITIVA ('1') antes de confiar em qualquer
# ausência lida do banco.
# shellcheck disable=SC2016  # aspas simples sao TEXTO aqui; a string externa e dupla
case "$JANELA" in
  [0-9]*' hours' | [0-9]*' hour' | [0-9]*' minutes' | [0-9]*' days') ;;
  *) mecanica_ok=0; motivo="${motivo:-janela inválida: '$JANELA' (use '6 hours')}" ;;
esac

if [ "$mecanica_ok" = 1 ]; then
  if [ ! -x "$PSQL" ]; then
    mecanica_ok=0; motivo="psql-ro ausente ou sem permissão de execução ($PSQL)"
  elif ! "$PSQL" -Atc 'SELECT 1' 2>/dev/null | command grep -Fxq -- '1'; then
    # LINHA exatamente "1", não a saída inteira: o wrapper emite os `SET` da sessão read-only
    # antes do resultado (`docs/historico/evidencia-positiva-shell.md` §11 — o PREÂMBULO do wrapper
    # vira "dado"). Exigir a FORMA, não a presença: vazio, só `SET`, ou erro não passam daqui.
    mecanica_ok=0; motivo="psql-ro não respondeu 1 ao SELECT 1 (presente porém mudo/quebrado)"
  fi
fi

if [ "$mecanica_ok" = 1 ]; then
  # DISTINCT ON pega a resposta MAIS RECENTE por edge: dentro da janela cabe o deploy no meio dela
  # (bundle velho às 21:48, novo às 22:04) e "alguma resposta bateu" leria o velho como prova.
  # O `OFFSET 0` é barreira de otimização: sem ela o planner pode empurrar o `content::jsonb` para
  # antes do filtro de forma e estourar em linha que não é JSON.
  #
  # A CTE `sondas` é a UNIÃO de duas classes de resposta, e a 2ª existe porque filtrar por
  # `? 'fonte'` sozinho DESCARTAVA prova. Um bundle anterior ao #1998 responde 200 com
  # `{ok,probe,versao,edge}` — sem `fonte` —, sumia daqui, e a edge caía no ramo "nenhuma sonda na
  # janela: INDETERMINADO". O `sem-campo-fonte` é sentinela, não valor servido: nenhum `fonte` real
  # pode colidir com ele (o mapa só aceita `[0-9a-f]{64}`, e a única outra resposta possível é
  # `nao-mapeada`), então ele nunca casa com `esperado` e nunca absolve ninguém.
  #
  # ⚠️ Nada aqui afrouxa o fail-closed: a 2ª classe exige eco POSITIVO de `probe` E de `versao`.
  # 401, resposta sem eco (pré-sensor) e ausência de linha continuam fora — INDETERMINADOS.
  # A CTE `vinculo` carrega os pares `--request-ids`. Quando nao ha nenhum ela nasce VAZIA por
  # `WHERE false` (e nao por ausencia da CTE) de proposito: a FORMA do SQL fica a mesma nos dois
  # caminhos, entao o guardrail textual da suite mede sempre a consulta que roda de verdade.
  vinculo_sql="SELECT NULL::text, NULL::bigint WHERE false"
  [ -n "$vinculo_values" ] && vinculo_sql="VALUES $vinculo_values"

  sql="WITH bruto AS (
         SELECT id, created, content FROM net._http_response
         WHERE status_code = 200 AND content IS NOT NULL
           AND left(ltrim(content), 1) = '{'
           AND created > now() - interval '$JANELA'
         OFFSET 0
       ), vinculo(edge, request_id) AS (
         $vinculo_sql
       ), sondas AS (
         SELECT created,
                (content::jsonb) ->> 'edge'  AS edge,
                (content::jsonb) ->> 'fonte' AS fonte
         FROM bruto WHERE (content::jsonb) ? 'fonte'
         UNION ALL
         -- bundle anterior ao #1998: responde a sonda e nao conhece o campo fonte (ver acima).
         -- O eco de probe+versao e o que separa resposta de SONDA de qualquer outro JSON com um
         -- campo edge; sem ele a linha nao entra, e a edge segue INDETERMINADA (fail-closed).
         SELECT created,
                (content::jsonb) ->> 'edge' AS edge,
                'sem-campo-fonte'           AS fonte
         FROM bruto
         WHERE NOT ((content::jsonb) ? 'fonte')
           AND (content::jsonb) ->> 'probe'  = 'true'
           AND (content::jsonb) ->> 'versao' IS NOT NULL
         UNION ALL
         -- 3a classe: casada pelo request_id COLADO, o unico vinculo que alcanca o bundle anterior
         -- ao #1789 (responde {ok,probe,versao} e nao diz de quem e). O eco de probe+versao segue
         -- exigido: um id que aponte para resposta de CRON nao pode virar prova de sonda. E se a
         -- linha ECOA um slug, ele tem de ser o do vinculo — colagem trocada seria a fabricacao de
         -- identidade que este ramo existe para evitar, com o agravante de vir com cara de prova.
         SELECT b.created, v.edge,
                CASE WHEN (b.content::jsonb) ? 'fonte'
                     THEN (b.content::jsonb) ->> 'fonte'
                     ELSE 'sem-campo-fonte' END AS fonte
         FROM bruto b JOIN vinculo v ON v.request_id = b.id
         WHERE (b.content::jsonb) ->> 'probe'  = 'true'
           AND (b.content::jsonb) ->> 'versao' IS NOT NULL
           AND COALESCE((b.content::jsonb) ->> 'edge', v.edge) = v.edge
       ), recentes AS (
         SELECT DISTINCT ON (edge) edge, fonte
         FROM sondas WHERE edge IS NOT NULL AND fonte IS NOT NULL
         ORDER BY edge, created DESC
       ), anonimas AS (
         -- Resposta de SONDA que nao diz de quem e: 200 + probe + versao e SEM o campo edge, e sem
         -- vinculo colado. Nao da para atribuir a ninguem — mas a CONTAGEM e o que separa
         -- \"ninguem sondou\" de \"sondaram e o ar respondeu como bundle pre-#1789\". Sem ela, a
         -- edge sem eco saia como ausencia de dado, que e o defeito medido em 2026-09-05.
         SELECT count(*) AS n FROM bruto b
         WHERE (b.content::jsonb) ->> 'probe'  = 'true'
           AND (b.content::jsonb) ->> 'versao' IS NOT NULL
           AND NOT ((b.content::jsonb) ? 'edge')
           AND NOT EXISTS (SELECT 1 FROM vinculo v WHERE v.request_id = b.id)
       )
       SELECT edge || ' ' || fonte FROM recentes
       UNION ALL
       SELECT '#anonimas ' || n FROM anonimas;"
  if ! "$PSQL" -Atc "$sql" > "$tmp/ar" 2>"$tmp/erro"; then
    mecanica_ok=0
    motivo="a consulta a net._http_response falhou: $(head -c 160 "$tmp/erro" | tr '\n' ' ')"
  fi
fi

# quantas respostas de sonda ANONIMAS (sem eco de slug, sem vinculo) ha na janela.
n_anonimas=0
if [ "$mecanica_ok" = 1 ]; then
  n_anonimas="$(sed -n 's/^#anonimas //p' "$tmp/ar" | head -1)"
  # A linha existe SEMPRE (`count(*)` devolve uma linha até em tabela vazia). Se ela nao veio, a
  # consulta que rodou nao e a que este classificador le — DERIVA entre as duas pontas, a mesma
  # classe de falha que a suite falsifica no sentinela `sem-campo-fonte`. Nao da para degradar
  # para zero: zero e justamente a leitura que devolve a mensagem MENTIROSA de antes.
  case "$n_anonimas" in
    ""|*[!0-9]*) mecanica_ok=0
                 motivo="${motivo:-a consulta nao devolveu a linha \`#anonimas\` (SQL e classificador em versoes diferentes)}" ;;
  esac
fi

# ------------------------------------------------------------ veredito ---
: > "$tmp/chips"
: > "$tmp/sem_sonda"
echo "== edges da janela: precisa de chip? =="
if [ "$mecanica_ok" = 0 ]; then
  echo "⚠️ MECÂNICA NÃO CONFIÁVEL — $motivo"
  echo "   Fail-closed: sem evidência POSITIVA, toda edge da janela segue pendente."
fi

while read -r slug; do
  [ -n "$slug" ] || continue

  # INERTE vem ANTES da mecânica do banco de propósito: a prova é o marcador na REF, e o banco não
  # tem nada a dizer sobre um handler que responde 410 antes de executar qualquer coisa. Lê a REF,
  # não o working tree — o marcador numa fatia ainda não mergeada não vale (fail-closed: `git show`
  # que falha, edge sem `index.ts` na REF ou marcador ausente caem no ramo de sempre).
  if git -C "$RAIZ" show "$REF:supabase/functions/$slug/index.ts" 2>/dev/null \
       | command grep -qF -- "$MARCADOR_APOSENTADA"; then
    printf '  INERTE         %-34s aposentada na REF (%s) — deploy NÃO muda comportamento: bundle novo e velho respondem o mesmo 410. Não pedir ao founder.\n' \
      "$slug" "$MARCADOR_APOSENTADA"
    continue
  fi

  esperado=""; servido=""
  if [ "$mecanica_ok" = 1 ]; then
    esperado="$(command grep -m1 -- "^$slug " "$tmp/mapa"  2>/dev/null | cut -d' ' -f2)"
    servido="$( command grep -m1 -- "^$slug " "$tmp/ar"    2>/dev/null | cut -d' ' -f2)"
  fi

  if [ "$mecanica_ok" = 1 ] && [ -n "$esperado" ] && [ "$servido" = "$esperado" ]; then
    printf '  NO_AR          %-34s fonte %s… bate com a main\n' "$slug" "${servido:0:8}"
    continue
  fi

  printf '%s\n' "$slug" >> "$tmp/chips"
  if [ "$mecanica_ok" = 0 ]; then
    printf '  SEM_PROVA      %-34s mecânica não confiável (ver acima)\n' "$slug"
  elif [ -z "$esperado" ]; then
    printf '  SEM_PROVA      %-34s fora do mapa de sondas — não há prova passiva possível\n' "$slug"
  elif [ -z "$servido" ] && [ "$n_anonimas" -gt 0 ]; then
    # Irmao do PRE_SONDA_FONTE, um degrau ATRAS: la o bundle responde `edge` e nao `fonte`; aqui
    # nao responde nem `edge` (anterior ao #1789), entao a resposta EXISTE e nao diz de quem e.
    # O veredito continua INDETERMINADO — identidade ausente nao vira identidade presumida —, mas
    # dizer "nenhuma sonda" seria inventar a ausencia: sondaram, e o ar respondeu.
    # shellcheck disable=SC2016  # as crases sao TEXTO: `edge` e o campo que falta na resposta
    printf '  SEM_PROVA      %-34s SONDA_ANONIMA: nenhuma resposta ECOANDO este slug, mas %s resposta(s) de sonda sem eco de slug na janela (200 com `probe`+`versao` e SEM `edge` = bundle anterior ao #1789). Uma delas PODE ser desta edge; nenhuma é atribuível sem o disparo → INDETERMINADO. Para determinar: --request-ids %s=<request_id>\n' \
      "$slug" "$n_anonimas" "$slug"
  elif [ -z "$servido" ]; then
    printf '%s\n' "$slug" >> "$tmp/sem_sonda"
    printf '  SEM_PROVA      %-34s nenhuma sonda em %s (ausência ≠ pendência: INDETERMINADO)\n' "$slug" "$JANELA"
  elif [ "$servido" = "sem-campo-fonte" ]; then
    # Irmão do ramo abaixo, e MAIS FORTE que ele: `nao-mapeada` é o bundle novo servindo uma prova
    # cega; este é o bundle VELHO — anterior ao #1998, que ainda não conhecia o campo. A edge está
    # no mapa da main (`esperado` não vazio ⇒ a main serve `fonte`), e o ar não serve ⇒ o ar não é
    # a main. É pendência PROVADA, não indeterminada.
    # shellcheck disable=SC2016  # as crases sao TEXTO: `fonte` e o campo ausente na resposta
    printf '  PRE_SONDA_FONTE %-33s respondeu a sonda SEM o campo `fonte` — bundle anterior ao #1998, PRECISA DEPLOY\n' "$slug"
  elif [ "$servido" = "nao-mapeada" ]; then
    # shellcheck disable=SC2016  # as crases sao TEXTO: `nao-mapeada` e o valor servido
    printf '  SEM_PROVA      %-34s a sonda respondeu `nao-mapeada` — a prova nasceu cega\n' "$slug"
  else
    printf '  DESATUALIZADA  %-34s no ar %s… ≠ main %s… — BUNDLE VELHO SERVINDO\n' \
      "$slug" "${servido:0:8}" "${esperado:0:8}"
  fi
done < "$tmp/alvos"

n_chips="$(wc -l < "$tmp/chips" | tr -d "[:space:]")"
echo
if [ "$n_chips" -eq 0 ]; then
  echo "✅ nenhum chip de deploy por estas edges: provadas no ar pelo \`fonte\` (NO_AR) ou INERTES."
  exit 0
fi
echo "🎫 abra chip para: $(tr '\n' ' ' < "$tmp/chips")"
echo "   (DESATUALIZADA / PRE_SONDA_FONTE = deploy pendente PROVADO · SEM_PROVA = indeterminado,"
echo "    chip por fail-closed · INERTE = aposentada, deploy sem efeito, NÃO entra no chip)"
# ⚠️ "nenhuma sonda na janela" NÃO se resolve esperando, e dizer só "INDETERMINADO" convida o
# leitor a esperar. NÃO HÁ cron de sondagem: `cron.job` tem 93 jobs e ZERO com `probe`. Quem dá
# prova passiva é só a edge cujo fluxo NORMAL já ecoa o envelope (`edge`+`fonte`) E tem cron
# frequente — `analytics-outbox-drain` (5/5min) é o caso típico. Medido 2026-09-05: 24 das 54
# edges do mapa não têm cron NENHUM (webhook, ou invocada sob demanda pelo app), e para essas a
# prova passiva é IMPOSSÍVEL; `net._http_response` ainda expira no TTL do pg_net, então a janela
# só encolhe. O autor deste script leu este ramo como "espere o próximo tick do cron" HORAS depois
# de escrevê-lo, ao verificar dois deploys reais: a espera nunca terminaria, e o `SEM_PROVA`
# persistente passaria por pendência real — chip eterno numa edge que já está no ar.
# ⚠️ E "DISPARE" NÃO É INCONDICIONAL: o bundle PRÉ-sensor não conhece o campo `probe`, então a
# sonda não é lida como sonda — ela entra como REQUISIÇÃO NORMAL e o handler executa o fluxo
# REAL. É a mesma assimetria da triagem de script destrutivo: a sonda é barata na edge que recusa
# cedo (400/401 antes de todo IO) e CARA na que cai no caminho default (`?? "OBEN"`, `dias = 30`)
# ou que sequer LÊ o corpo. Medido 2026-09-05, 12ª leva: das 9 instrumentadas, 3 eram caras —
# `process-recurring-orders` (não lê o corpo: CRIA `orders` e AVANÇA o `next_order_date`, então o
# run legítimo do dia seguinte PULA a data que a sonda consumiu), `omie-nfe-recebimento-sync` e
# `omie-sync-metadados`. Emitir um comando pronto para colar com as 9 juntas convida exatamente
# esse disparo. O `--caro` do `sonda:sql` é a trava (bloco separado com `confirmei_o_deploy`), e
# ele é fail-CLOSED: nome que não casa com a leva ABORTA sem emitir SQL. Por isso a flag sai já
# no comando, com valor SINTATICAMENTE INVÁLIDO — a regra do `deploy.md` de nunca deixar valor de
# EXEMPLO no campo que o operador substitui: o erro ecoa a própria instrução em vez de disparar.
if [ -s "$tmp/sem_sonda" ]; then
  n_ss="$(wc -l < "$tmp/sem_sonda" | tr -d "[:space:]")"
  # A lista vai INTEIRA no comando. Truncar em 6 com `… (+N)` colocava o literal `…` e `(+3)`
  # DENTRO do `bun run sonda:sql`, então o comando só era colável até 6 edges — acima disso quem
  # colasse passaria `…` como nome de edge, e quem não colasse reconstruiria a lista à mão
  # (feito em 2026-09-05, com 9). O resumo pode truncar; o COMANDO, não.
  todas="$(tr '\n' ' ' < "$tmp/sem_sonda")"
  echo
  echo "ℹ️  as $n_ss sem sonda NÃO se resolvem esperando: não há cron de sondagem, e boa parte"
  echo "   destas edges não tem cron nenhum (webhook/sob demanda) — prova passiva é impossível."
  echo
  echo "   ⚠️ TRIE ANTES DE DISPARAR — bundle PRÉ-sensor ignora o \`probe\` e EXECUTA O FLUXO REAL."
  echo "      A triagem barato/caro de cada leva mora em docs/agent/deploy.md; edge CARA não se"
  echo "      sonda às cegas: nela a ordem é DEPLOY ANTES, sonda depois (só para CONFIRMAR)."
  echo "   DISPARE:  bun run sonda:sql ${todas}--caro=trie-antes-veja-deploy-md"
  echo "      (o \`--caro\` acima está inválido DE PROPÓSITO: o sonda:sql aborta sem emitir SQL até"
  echo "       você trocar pelas caras da leva — ou remover a flag se TODAS forem baratas.)"
  echo "   (PASSO 1 é escrita + vault → SQL Editor do Lovable; PASSO 2 julga em SELECT puro,"
  echo "    --so-leitura, roda no psql-ro. Com o id em mãos: --request-ids <slug>=<id>)"
fi

[ "$mecanica_ok" = 1 ] && exit 1
exit 2
