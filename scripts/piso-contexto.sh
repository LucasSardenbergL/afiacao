#!/usr/bin/env bash
# piso-contexto.sh — mede o PISO DE CONTEXTO de uma configuração do Claude Code.
#
# POR QUÊ: o piso (system prompt + schemas de tools + lista de skills + CLAUDE.md
# + hooks) é relido em TODO request de TODA sessão — 82% do custo de token é
# ENTRADA de contexto. Cortar 1 token de piso rende em 100% dos requests. Mas
# "parece que vai cortar" não é evidência: já houve DUAS premissas plausíveis e
# FALSAS sobre este piso (ver docs/historico/piso-de-contexto.md). Este script é
# o oráculo — roda um prompt trivial e lê o consumo REAL do 1º request.
#
# Precisão medida: ±6 tokens em repetições da mesma config (43.964 / 43.958 /
# 43.962). Qualquer delta acima de ~50 tokens é sinal; abaixo disso é ruído.
#
# Uso:
#   scripts/piso-contexto.sh                        # piso da config atual
#   scripts/piso-contexto.sh -n 3                   # 3 repetições (ver ruído)
#   scripts/piso-contexto.sh --sem-plugin claude-mem@thedotmack
#   scripts/piso-contexto.sh --flags --disable-slash-commands
#   MODELO=claude-opus-5 scripts/piso-contexto.sh   # troca o modelo da sonda
#
# CUSTO: cada sonda é 1 request curto (~44k de contexto, resposta de 1 token).
# Em plano de assinatura não é desembolso; ainda assim não rode em laço.
#
# ATENÇÃO — o CLI não reproduz o app: uma sessão do app desktop carrega MAIS
# (MCPs próprios, plugins da conta claude.ai) e tem piso maior. Use este script
# para comparar CONFIGURAÇÕES entre si (o delta é válido); para o piso absoluto
# das sessões reais use scripts/tokens-report.sh.
set -euo pipefail

REPS=1
MODELO="${MODELO:-claude-opus-4-8}"
EXTRA=()
SEM_PLUGIN=()

while [ $# -gt 0 ]; do
  case "$1" in
    -n|--repeticoes) REPS="${2:?-n exige um número}"; shift 2 ;;
    --sem-plugin)    SEM_PLUGIN+=("${2:?--sem-plugin exige nome@marketplace}"); shift 2 ;;
    --flags)         shift; EXTRA=("$@"); break ;;
    -h|--help)       sed -n '2,28p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "opção desconhecida: $1 (use --help)" >&2; exit 2 ;;
  esac
done

command -v claude >/dev/null || { echo "claude CLI não encontrado" >&2; exit 1; }
command -v jq     >/dev/null || { echo "jq é necessário (brew install jq)" >&2; exit 1; }
command -v uuidgen >/dev/null || { echo "uuidgen é necessário" >&2; exit 1; }

# --sem-plugin A --sem-plugin B  ->  --settings '{"enabledPlugins":{"A":false,"B":false}}'
if [ "${#SEM_PLUGIN[@]}" -gt 0 ]; then
  json=$(printf '%s\n' "${SEM_PLUGIN[@]}" \
    | jq -R . | jq -s '{enabledPlugins: (map({(.): false}) | add)}' -c)
  EXTRA+=(--settings "$json")
fi

echo "modelo: $MODELO   repetições: $REPS" >&2
[ "${#EXTRA[@]}" -gt 0 ] && echo "flags extras: ${EXTRA[*]}" >&2
echo >&2

soma=0
for i in $(seq 1 "$REPS"); do
  uuid=$(uuidgen | tr '[:upper:]' '[:lower:]')
  saida=$(mktemp)
  # O prompt é trivial de propósito: queremos medir o PISO, não o trabalho.
  if ! timeout 300 claude -p "responda exatamente: ok" \
        --model "$MODELO" --session-id "$uuid" --output-format json \
        ${EXTRA[@]+"${EXTRA[@]}"} > "$saida" 2>/dev/null; then
    echo "sonda $i FALHOU (timeout ou erro do CLI)" >&2
    rm -f "$saida"; exit 1
  fi
  # piso = tudo que entrou como contexto no 1º request, cacheado ou não.
  total=$(jq -r '.usage | .input_tokens + .cache_creation_input_tokens + .cache_read_input_tokens' "$saida")
  printf "  sonda %d: %8d tokens\n" "$i" "$total"
  soma=$((soma + total))
  rm -f "$saida"
done

printf "\nPISO (média de %d): %d tokens\n" "$REPS" "$((soma / REPS))"
