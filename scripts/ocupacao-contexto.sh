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
# Uso:
#   scripts/ocupacao-contexto.sh <arquivo.jsonl> [outro.jsonl ...]
#   scripts/ocupacao-contexto.sh --sessao <uuid>   # procura em ~/.claude/projects
#   scripts/ocupacao-contexto.sh --top 5           # as N sessões mais pesadas (7d)
#
# Nada sai da máquina; nenhum arquivo do projeto é alterado.
set -euo pipefail

RAIZ="${CLAUDE_PROJECTS_DIR:-$HOME/.claude/projects}"
CHARS_POR_TOKEN=3.5   # aproximação p/ mistura pt-BR + código
ALVOS=()
TOP=0

while [ $# -gt 0 ]; do
  case "$1" in
    --sessao)
      alvo=$(find "$RAIZ" -name "${2:?--sessao exige um uuid}.jsonl" -type f 2>/dev/null | head -1)
      [ -n "$alvo" ] || { echo "sessão ${2} não encontrada em $RAIZ" >&2; exit 1; }
      ALVOS+=("$alvo"); shift 2 ;;
    --top)     TOP="${2:?--top exige um número}"; shift 2 ;;
    -h|--help) sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) ALVOS+=("$1"); shift ;;
  esac
done

command -v jq >/dev/null || { echo "jq é necessário (brew install jq)" >&2; exit 1; }

# --top N: as N sessões maiores em bytes. O custo cresce ~quadraticamente com o
# nº de requests, então as maiores dominam — é um proxy barato de "sessão cara".
if [ "$TOP" -gt 0 ]; then
  while IFS= read -r linha; do
    ALVOS+=("$linha")
  done < <(find "$RAIZ" -name '*.jsonl' -type f -mtime -7 2>/dev/null \
      | while IFS= read -r f; do printf '%s\t%s\n' "$(wc -c < "$f" | tr -d ' ')" "$f"; done \
      | sort -rn | head -"$TOP" | cut -f2)
fi

[ "${#ALVOS[@]}" -gt 0 ] || { echo "informe ao menos um .jsonl (use --help)" >&2; exit 2; }
echo "sessões analisadas: ${#ALVOS[@]}" >&2

# Fluxo ordenado de eventos; o awk faz a contabilidade:
#   REQ              -> passou um request faturável (marca o tempo)
#   USE <id> <nome>  -> amarra tool_use_id ao nome da ferramenta
#   RES <id> <chars> -> um resultado entrou no histórico
for f in "${ALVOS[@]}"; do
  jq -rc '
    (if (.message.usage != null) then "REQ" else empty end),
    ( .message.content? | if type=="array" then .[] else empty end
      | if .type=="tool_use" then "USE\t\(.id // "?")\t\(.name // "?")"
        elif .type=="tool_result" then "RES\t\(.tool_use_id // "?")\t\((.content|tostring)|length)"
        else empty end )
  ' "$f" 2>/dev/null
done | awk -F'\t' -v cpt="$CHARS_POR_TOKEN" '
$1=="REQ" { req++; next }
$1=="USE" { nome[$2] = $3; next }
# a posição importa: só se sabe quantos requests vêm DEPOIS no fim do arquivo
$1=="RES" { n++; rid[n]=$2; rtam[n]=$3; rpos[n]=req; next }
END {
  if (n == 0) { print "  (nenhum tool_result encontrado)"; exit }
  for (i = 1; i <= n; i++) {
    k = (rid[i] in nome) ? nome[rid[i]] : "?"
    restantes = req - rpos[i]; if (restantes < 0) restantes = 0
    o = (rtam[i] / cpt) * restantes
    ocup[k] += o; chars[k] += rtam[i]; cnt[k]++; soma += o
    if (rtam[i] > maior[k]) maior[k] = rtam[i]
  }
  if (soma <= 0) soma = 1
  # zero-padding no 1º campo p/ ordenar numericamente com sort(1) sem perder a chave
  for (k in ocup)
    printf "%018.3f\t%s\t%d\t%d\t%d\t%.1f\n", ocup[k], k, cnt[k], chars[k], maior[k], 100*ocup[k]/soma
}' | sort -rn | head -14 | awk -F'\t' '
BEGIN { printf "\n%-30s %6s %12s %9s %13s %7s\n", "ferramenta", "n", "chars tot", "maior", "tok*req(M)", "%" }
{ printf "%-30s %6d %12d %9d %13.1f %6.1f%%\n", $2, $3, $4, $5, ($1+0)/1e6, $6 }'

echo
echo "regra: o que pesa não é o tamanho da saída, é tamanho x quanto tempo ela ainda" >&2
echo "fica no contexto. Saída grande CEDO na sessão é a mais cara de todas." >&2
