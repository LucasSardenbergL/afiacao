#!/usr/bin/env bash
# test-bash-contexto-nudge.sh — prova do hook .claude/hooks/bash-contexto-nudge.sh
#
# Roda em DOIS locales (C e pt_BR.UTF-8) de propósito: no #1483 uma asserção
# passou por acidente de ambiente porque `grep -i` sob pt_BR.UTF-8 dobra Ã↔ã e
# casava o ramo errado. Aqui todo casamento é por marcador ASCII exclusivo, caixa
# fixa, com `command grep` e SEM -i — e o teste é executado nos dois locales para
# provar que a asserção não depende disso.
#
# Inclui FALSIFICAÇÃO: no fim, sabota o limiar do hook e exige que o teste do
# silêncio fique VERMELHO. Um teste que passa com o código sabotado não prova nada.
set -u

HOOK="$(cd "$(dirname "$0")/.." && pwd)/.claude/hooks/bash-contexto-nudge.sh"
[ -x "$HOOK" ] || { echo "hook não encontrado/executável: $HOOK" >&2; exit 1; }
command -v jq >/dev/null || { echo "jq é necessário" >&2; exit 1; }

falhas=0

# Monta o JSON de entrada do PostToolUse com uma saída de N chars.
entrada() { # <n_chars> <comando> [tool_name]
  jq -n -c --arg cmd "$2" --arg tool "${3:-Bash}" --argjson n "$1" \
    '{tool_name:$tool, tool_input:{command:$cmd},
      tool_response:( "x" * $n )}'
}

# roda o hook e devolve stdout
executa() { printf '%s' "$1" | bash "$HOOK" 2>/dev/null; }

checa() { # <titulo> <esperado: MARCADOR|VAZIO> <json>
  local titulo="$1" esperado="$2" json="$3" saida
  saida="$(executa "$json")"
  if [ "$esperado" = "VAZIO" ]; then
    if [ -z "$saida" ]; then printf '  ok   %s\n' "$titulo"; return 0; fi
    printf '  FALHA %s — esperava silêncio, veio: %s\n' "$titulo" "$(printf '%s' "$saida" | head -c 120)"
    falhas=$((falhas + 1)); return 1
  fi
  # marcador tem de estar no additionalContext, não em qualquer lugar do JSON
  if printf '%s' "$saida" | jq -r '.hookSpecificOutput.additionalContext // ""' 2>/dev/null \
       | command grep -q "$esperado"; then
    printf '  ok   %s\n' "$titulo"; return 0
  fi
  printf '  FALHA %s — esperava %s, veio: %s\n' "$titulo" "$esperado" "$(printf '%s' "$saida" | head -c 160)"
  falhas=$((falhas + 1)); return 1
}

rodada() {
  echo "--- locale: ${LC_ALL:-(herdado)} ---"

  # (1) POSITIVO: saída grande sem limite -> BASH-SAIDA-GRANDE
  checa "saida 5k sem head" "BASH-SAIDA-GRANDE" "$(entrada 5000 'psql -c "select * from t"')"

  # (2) POSITIVO: saída grande QUE JÁ USAVA head -> o outro ramo
  checa "saida 5k com head -120" "BASH-LIMITE-POR-LINHA" "$(entrada 5000 'cat arq.sql | head -120')"

  # (3) POSITIVO: saída enorme -> ainda o ramo SAIDA-GRANDE (e o 🔴 na msg)
  checa "saida 20k sem head" "BASH-SAIDA-GRANDE" "$(entrada 20000 'git diff')"

  # (4) NEGATIVO: abaixo do limiar -> SILÊNCIO (o caso que a falsificação quebra)
  checa "saida 500 (abaixo do limiar)" "VAZIO" "$(entrada 500 'ls')"

  # (5) NEGATIVO: exatamente 3999 -> silêncio (fronteira)
  checa "saida 3999 (fronteira)" "VAZIO" "$(entrada 3999 'ls')"

  # (6) NEGATIVO: outra ferramenta -> silêncio
  checa "tool_name=Read" "VAZIO" "$(entrada 9000 'irrelevante' 'Read')"

  # (7) ROBUSTEZ: JSON inválido não pode quebrar nem falar
  local saida
  saida="$(printf '%s' 'isto não é json' | bash "$HOOK" 2>/dev/null)"
  if [ -z "$saida" ]; then printf '  ok   entrada invalida -> silencio\n'
  else printf '  FALHA entrada invalida falou: %s\n' "$saida"; falhas=$((falhas + 1)); fi

  # (8) ROBUSTEZ: tool_response como OBJETO (formato alternativo) ainda mede
  local j
  j="$(jq -n -c '{tool_name:"Bash", tool_input:{command:"git log"},
                  tool_response:{stdout:("y" * 9000), stderr:"", exitCode:0}}')"
  checa "tool_response objeto 9k" "BASH-SAIDA-GRANDE" "$j"

  # (9) o JSON emitido é válido e tem o hookEventName certo
  local ev
  ev="$(executa "$(entrada 5000 'ls')" | jq -r '.hookSpecificOutput.hookEventName' 2>/dev/null)"
  if [ "$ev" = "PostToolUse" ]; then printf '  ok   hookEventName=PostToolUse\n'
  else printf '  FALHA hookEventName veio "%s"\n' "$ev"; falhas=$((falhas + 1)); fi
}

echo "== bash-contexto-nudge =="
LC_ALL=C rodada
if locale -a 2>/dev/null | command grep -qi '^pt_BR.UTF-*8$'; then
  LC_ALL=pt_BR.UTF-8 rodada
else
  echo "--- locale pt_BR.UTF-8 indisponível nesta máquina: pulado ---"
fi

# ---------------------------------------------------------------- falsificação
# Sabota o limiar (4000 -> 1) e exige que o teste do SILÊNCIO fique vermelho.
# Se continuar verde, a asserção (4) não estava provando nada.
echo "--- falsificação (sabota o limiar; o silêncio TEM de quebrar) ---"
sabotado="$(mktemp)"; trap 'rm -f "$sabotado"' EXIT
# shellcheck disable=SC2016  # o $chars é literal de propósito: casa o TEXTO do hook, não expande
sed 's/\[ "\$chars" -ge 4000 \]/[ "$chars" -ge 1 ]/' "$HOOK" > "$sabotado"
if command grep -q '\-ge 1 \]' "$sabotado"; then
  saida_sab="$(printf '%s' "$(entrada 500 'ls')" | bash "$sabotado" 2>/dev/null)"
  if [ -n "$saida_sab" ]; then
    echo "  ok   sabotagem detectada (o silêncio quebrou como esperado)"
  else
    echo "  FALHA a sabotagem NÃO quebrou o teste — a asserção do silêncio é teatro"
    falhas=$((falhas + 1))
  fi
else
  echo "  FALHA não consegui sabotar o hook (o padrão do limiar mudou?)"
  falhas=$((falhas + 1))
fi

echo
if [ "$falhas" -eq 0 ]; then echo "TODOS OS TESTES PASSARAM"; exit 0; fi
echo "FALHAS: $falhas"; exit 1
