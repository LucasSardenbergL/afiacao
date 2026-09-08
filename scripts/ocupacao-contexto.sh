#!/usr/bin/env bash
# ocupacao-contexto.sh — de ONDE vem o contexto acumulado de uma sessão (READ-ONLY).
#
# POR QUÊ: o piso de contexto (scripts/piso-contexto.sh) é só 25,9% do custo de
# entrada — os outros 74,1% são a CONVERSA ACUMULADA (medido em 20.933 requests).
# E um tool_result não se paga uma vez: fica no histórico e é RELIDO em todo
# request seguinte da sessão. Logo o custo real de um resultado é
#
#     tamanho x (nº de requests que ainda virão depois dele)
#
# e NÃO o tamanho. Um Read de 50k tokens no começo de uma sessão de 500 requests
# custa mais que cem Reads de 5k no último terço. Este script mede isso.
#
# Primeira medição (3 sessões mais caras de uma janela de 7 dias, US$1.209):
#   Read 56,4% · Bash 39,5% · Edit 2,7% · todo o resto <1%.
#   Read tinha 75 chamadas contra 769 do Bash — e custou MAIS. O tamanho por
#   chamada é que manda, porque ele é relido para sempre.
#
# DUAS RÉGUAS, UMA FONTE:
#   --por-ferramenta (default) responde "que TIPO de chamada ocupa";
#   --por-arquivo             responde "que ARQUIVO ocupa" — a pergunta que
#                             decide o que destilar primeiro.
# Ambas somam o MESMO total: toda chamada sem `file_path` (Bash, Grep, Task…)
# vira a linha agregada `(<tool> — sem arquivo)` em vez de sumir. Bash sozinho é
# ~40% da ocupação; um ranking que o omitisse sem dizer seria ausência
# apresentada como medida — o defeito de classe que esta régua existe para achar.
#
# O QUE ESTA RÉGUA NÃO MEDE: só o tool_RESULT entra na conta. O INPUT da chamada
# (o corpo de um Write, o texto novo de um Edit) também ocupa contexto e não é
# contado aqui — para um Write grande, o número sai SUBESTIMADO.
#
# Uso:
#   scripts/ocupacao-contexto.sh <arquivo.jsonl> [outro.jsonl ...]
#   scripts/ocupacao-contexto.sh --sessao <uuid>   # procura em ~/.claude/projects
#   scripts/ocupacao-contexto.sh --top 5           # as N sessões mais pesadas (7d)
#   scripts/ocupacao-contexto.sh --por-arquivo     # ranking por ARQUIVO (30d, projetos afiacao)
#   scripts/ocupacao-contexto.sh --por-arquivo --dias 7 --linhas 30
#   scripts/ocupacao-contexto.sh --por-arquivo --todos   # a máquina inteira, não só afiacao
#
# Fail-closed: sem sessão na janela, ou sem NENHUM evento extraído, o script sai
# VERMELHO com a causa. Tabela vazia nunca é resposta — foi um `xargs -a` (que não
# existe no BSD) com 2>/dev/null que quase produziu o veredito "docs/agent nunca é
# lido", o oposto da verdade. Fim bem-sucedido imprime OCUPACAO-CONTEXTO-OK.
#
# Nada sai da máquina; nenhum arquivo do projeto é alterado.
set -euo pipefail

# Números com PONTO decimal, SEMPRE. Sob pt_BR.UTF-8 (o locale desta máquina) o
# `printf` do awk emite "0,2" no lugar de "0.2" — e o estrago não é cosmético:
# a chave de ordenação deste script é um `%018.3f`, então o `sort -rn` do meio do
# pipeline passa a ler "199,000" com a vírgula do locale e pode REORDENAR o
# ranking. Uma régua cuja resposta depende do ambiente de quem a roda não é
# régua. LC_ALL (não LC_NUMERIC) porque LC_ALL do ambiente venceria o mais
# específico. Pego pela falsificação nos dois locales, não por revisão.
export LC_ALL=C

RAIZ="${CLAUDE_PROJECTS_DIR:-$HOME/.claude/projects}"
CHARS_POR_TOKEN=3.5   # aproximação p/ mistura pt-BR + código
# Mesmo token que filtra os projetos e que normaliza o path: um arquivo lido de
# 30 worktrees diferentes é UM arquivo. Sem colapsar, o ranking se pulveriza e o
# doc mais caro do repo não aparece em lugar nenhum. Tratado como ERE pelo awk.
PADRAO_REPO="${OCUPACAO_REPO_PADRAO:-afiacao}"
ALVOS=()
TOP=0
MODO=ferramenta
DIAS=30
TODOS=0
LINHAS=0
AUTO_COLETA=0   # 1 só quando a janela/escopo REALMENTE selecionou os alvos

while [ $# -gt 0 ]; do
  case "$1" in
    --sessao)
      alvo=$(find "$RAIZ" -name "${2:?--sessao exige um uuid}.jsonl" -type f 2>/dev/null | head -1)
      [ -n "$alvo" ] || { echo "sessão ${2} não encontrada em $RAIZ" >&2; exit 1; }
      ALVOS+=("$alvo"); shift 2 ;;
    --top)     TOP="${2:?--top exige um número}"; shift 2 ;;
    --por-arquivo)    MODO=arquivo; shift ;;
    --por-ferramenta) MODO=ferramenta; shift ;;
    --dias)    DIAS="${2:?--dias exige um número}"; shift 2 ;;
    --linhas)  LINHAS="${2:?--linhas exige um número}"; shift 2 ;;
    --todos)   TODOS=1; shift ;;
    -h|--help) sed -n '2,45p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "opção desconhecida: $1 (use --help)" >&2; exit 2 ;;
    *) ALVOS+=("$1"); shift ;;
  esac
done

command -v jq >/dev/null || { echo "jq é necessário (brew install jq)" >&2; exit 1; }

if [ "$LINHAS" -le 0 ]; then
  if [ "$MODO" = arquivo ]; then LINHAS=20; else LINHAS=14; fi
fi

# --top N: as N sessões maiores em bytes. O custo cresce ~quadraticamente com o
# nº de requests, então as maiores dominam — é um proxy barato de "sessão cara".
if [ "$TOP" -gt 0 ]; then
  while IFS= read -r linha; do
    ALVOS+=("$linha")
  done < <(find "$RAIZ" -name '*.jsonl' -type f -mtime -7 2>/dev/null \
      | while IFS= read -r f; do printf '%s\t%s\n' "$(wc -c < "$f" | tr -d ' ')" "$f"; done \
      | sort -rn | head -"$TOP" | cut -f2)
fi

# --por-arquivo sem alvo explícito: a janela inteira. Default são os projetos do
# repo (dir contendo $PADRAO_REPO); --todos abre para a máquina.
if [ "$MODO" = arquivo ] && [ "${#ALVOS[@]}" -eq 0 ]; then
  AUTO_COLETA=1
  DIRS_BUSCA=()
  if [ "$TODOS" -eq 1 ]; then
    DIRS_BUSCA=("$RAIZ")
  else
    while IFS= read -r d; do DIRS_BUSCA+=("$d"); done < <(
      find "$RAIZ" -mindepth 1 -maxdepth 1 -type d -name "*${PADRAO_REPO}*" 2>/dev/null | sort)
    if [ "${#DIRS_BUSCA[@]}" -eq 0 ]; then
      echo "ERRO: nenhum projeto casando '*${PADRAO_REPO}*' em $RAIZ (use --todos)." >&2
      exit 3
    fi
  fi
  while IFS= read -r linha; do
    ALVOS+=("$linha")
  done < <(find "${DIRS_BUSCA[@]}" -name '*.jsonl' -type f -mtime "-${DIAS}" 2>/dev/null | sort)
  if [ "${#ALVOS[@]}" -eq 0 ]; then
    echo "ERRO: nenhuma sessão nos últimos ${DIAS} dias. Aumente --dias ou use --todos." >&2
    echo "      (silêncio aqui seria ausência de dado, não ocupação zero.)" >&2
    exit 3
  fi
fi

[ "${#ALVOS[@]}" -gt 0 ] || { echo "informe ao menos um .jsonl (use --help)" >&2; exit 2; }
echo "sessões analisadas: ${#ALVOS[@]}" >&2
# só declara janela/escopo quando eles de fato SELECIONARAM as sessões: com alvo
# explícito na linha de comando, anunciar "30d · projetos afiacao" seria descrever
# um recorte que não foi aplicado.
if [ "$AUTO_COLETA" -eq 1 ]; then
  if [ "$TODOS" -eq 1 ]; then escopo="máquina inteira"; else escopo="projetos *${PADRAO_REPO}*"; fi
  echo "janela: ${DIAS}d · escopo: ${escopo}" >&2
fi

# Fluxo ordenado de eventos; o awk faz a contabilidade:
#   REQ <sessao> <requestId>          -> passou um request faturável (marca o tempo)
#   USE <sessao> <id> <nome> <path>   -> amarra tool_use_id ao nome e ao arquivo
#   RES <sessao> <id> <chars>         -> um resultado entrou no histórico
# Template explícito, e NUNCA `mktemp -t <prefixo>`: `-t` é flag homônima
# BSD×GNU — no macOS o argumento é um PREFIXO e funciona; no GNU (o CI) é um
# TEMPLATE que exige ≥3 X's, e `mktemp: too few X's` derruba o script inteiro via
# `set -e`. Verde no macOS, vermelho no Linux, pelo mesmo código. É a armadilha #6
# de docs/historico/evidencia-positiva-shell.md, e ela custou uma rodada de CI
# justamente no PR que a documenta.
BRUTO=$(mktemp "${TMPDIR:-/tmp}/ocupacao-contexto.XXXXXX")
trap 'rm -f "$BRUTO"' EXIT

# `if ! jq`, e não `jq` solto: sob `set -e` um único transcript com linha
# ilegível abortaria o script INTEIRO — exit 5, nenhuma mensagem, 684 sessões de
# trabalho no lixo. E linha ilegível é o caso NORMAL aqui: uma sessão viva está
# escrevendo o .jsonl neste instante, e a última linha vem pela metade. `set -e`
# é suspenso pelo contexto de chamada, então o `if !` é o que segura.
# O jq já emitiu tudo que veio ANTES do ponto de quebra, então o dado válido não
# se perde — o que não pode é o descarte ser calado, senão a régua vira o
# `2>/dev/null` que ela existe para denunciar. Por isso conta e declara.
parse_falhou=0
for f in "${ALVOS[@]}"; do
  if ! jq -rc '
    . as $l
    | ($l.sessionId // "?") as $s
    | (if ($l.message.usage != null)
       then "REQ\t\($s)\t\($l.requestId // $l.uuid // "-")" else empty end),
    ( $l.message.content? | if type=="array" then .[] else empty end
      | if .type=="tool_use"
        then "USE\t\($s)\t\(.id // "?")\t\(.name // "?")\t\((.input.file_path // "")|tostring|gsub("\t";" "))"
        elif .type=="tool_result" then "RES\t\($s)\t\(.tool_use_id // "?")\t\((.content|tostring)|length)"
        else empty end )
  ' "$f" 2>/dev/null >>"$BRUTO"; then
    parse_falhou=$((parse_falhou + 1))
  fi
done

if [ "$parse_falhou" -gt 0 ]; then
  echo "AVISO: ${parse_falhou} de ${#ALVOS[@]} sessão(ões) com linha ilegível (transcript" >&2
  echo "       truncado ou sendo escrito agora). Os eventos ANTERIORES ao ponto de" >&2
  echo "       quebra entraram na conta; o que vinha depois, nessas sessões, não." >&2
fi

# Controle POSITIVO: extração vazia sai vermelho. Um `jq` que morreu, um formato
# de transcrição que mudou e um projeto realmente ocioso produzem exatamente a
# mesma saída — nenhuma linha — e só esta checagem os separa de "ocupação zero".
if [ ! -s "$BRUTO" ]; then
  echo "ERRO: ${#ALVOS[@]} sessão(ões) lidas e NENHUM evento extraído." >&2
  echo "      Causas prováveis: jq falhou, ou o formato do transcript mudou." >&2
  echo "      Isto NÃO é 'ocupação zero' — é ausência de dado." >&2
  exit 4
fi

awk -F'\t' -v cpt="$CHARS_POR_TOKEN" -v modo="$MODO" -v padrao="$PADRAO_REPO" \
    -v lar="$HOME" '
function normaliza(p,   q) {
  q = p
  # 1) o repo, em qualquer worktree, colapsa no caminho relativo ao repo
  sub("^.*/" padrao "[^/]*/", "", q)
  sub("^\\.claude/worktrees/[^/]*/", "", q)
  # 2) fora do repo: pelo menos encurta o home, para o ranking caber na tela
  if (q == p && lar != "") sub("^" lar "/", "~/", q)
  return q
}
# dedupe por (sessao, requestId): UMA chamada de API vira VÁRIAS linhas no JSONL
# quando a resposta tem vários blocos, e todas repetem o mesmo usage. Medido
# neste repo: 329 linhas para 144 requests (2,28x). Sem isto, `restantes` — e
# portanto TODA a régua — sai inflado. Herdado de tokens-report.sh (06/08).
# Chave inclui a sessão porque `restantes` é posicional DENTRO da sessão; "-"
# (transcript antigo, sem requestId nem uuid) nunca colapsa.
$1=="REQ" {
  s=$2; k=s SUBSEP $3
  if ($3 != "-" && (k in visto)) next
  visto[k]=1; req[s]++; next }
$1=="USE" { nome[$2 SUBSEP $3]=$4; arq[$2 SUBSEP $3]=$5; next }
# a posição importa: só se sabe quantos requests vêm DEPOIS no fim do arquivo
$1=="RES" { n++; rsess[n]=$2; rid[n]=$3; rtam[n]=$4; rpos[n]=req[$2]; next }
END {
  if (n == 0) { print "  (nenhum tool_result encontrado)"; exit }
  for (i = 1; i <= n; i++) {
    ch = rsess[i] SUBSEP rid[i]
    t = (ch in nome) ? nome[ch] : "?"
    if (modo == "arquivo") {
      # rótulo em ASCII puro: o printf do awk conta BYTES, então um travessão
      # desalinharia a coluna — e o teste casa esta string sem -i e sem locale.
      if ((ch in arq) && arq[ch] != "") { k = normaliza(arq[ch]) } else { k = "(" t " - sem arquivo)" }
    } else { k = t }
    restantes = req[rsess[i]] - rpos[i]; if (restantes < 0) restantes = 0
    o = (rtam[i] / cpt) * restantes
    ocup[k] += o; chars[k] += rtam[i]; cnt[k]++; soma += o
    if (rtam[i] > maior[k]) maior[k] = rtam[i]
  }
  if (soma <= 0) soma = 1
  # zero-padding no 1º campo p/ ordenar numericamente com sort(1) sem perder a chave
  for (k in ocup)
    printf "%018.3f\t%s\t%d\t%d\t%d\t%.1f\n", ocup[k], k, cnt[k], chars[k], maior[k], 100*ocup[k]/soma
}' "$BRUTO" | sort -rn | head -"$LINHAS" | awk -F'\t' -v modo="$MODO" '
BEGIN { w = (modo == "arquivo") ? 56 : 30
        cab = (modo == "arquivo") ? "arquivo" : "ferramenta"
        printf "\n%-*s %6s %12s %9s %13s %7s\n", w, cab, "n", "chars tot", "maior", "tok*req(M)", "%" }
{ printf "%-*s %6d %12d %9d %13.1f %6.1f%%\n", w, $2, $3, $4, $5, ($1+0)/1e6, $6 }'

echo
echo "regra: o que pesa não é o tamanho da saída, é tamanho x quanto tempo ela ainda" >&2
echo "fica no contexto. Saída grande CEDO na sessão é a mais cara de todas." >&2
# Marcador positivo de fim: ASCII, caixa fixa, sem acento — casável com grep sem
# -i e sem depender de locale (lição do #1483).
echo "OCUPACAO-CONTEXTO-OK modo=${MODO} sessoes=${#ALVOS[@]}"
