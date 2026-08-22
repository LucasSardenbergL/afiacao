#!/usr/bin/env bash
# instrucoes-carregadas.sh — SENSOR: o que REALMENTE entra no contexto, e quando.
# ==============================================================================
#
# Fase 0 do split do CLAUDE.md (2026-08-22). Antes de mover regra para
# `.claude/rules/` com `paths:`, precisamos MEDIR — porque a doc não responde a
# pergunta que decide o desenho:
#
#   1. regra `paths:` chega no SUBAGENTE? (o orçamento do claude:size se
#      justifica com "carregado em TODA sessão + subagente")
#   2. o que sobrevive ao /compact? (regra path-scoped recarrega só quando um
#      arquivo que casa o glob é lido de novo — pode ficar AUSENTE)
#
# Sem esse dado, mover regra fail-open é aposta. Com ele, é decisão.
# "Fase N+1 exige SINAL da fase N" — este hook É o sensor da fase N.
#
# Onde grava: ~/.config/afiacao/ (NÃO /private/tmp — aquele morre no reboot e o
# log ausente deixa de distinguir "não carregou" de "foi limpo").
#
# Degradar aqui é CERTO (é sensor, não script que apaga) — mas degradar CALADO
# não é: sem jq, gravamos um marcador de erro, para que log vazio signifique
# "nada carregou" e nunca "o sensor estava quebrado".
#
# Não bloqueia nada: o InstructionsLoaded ignora exit code por contrato.
set -uo pipefail

LOG="${AFIACAO_INSTR_LOG:-$HOME/.config/afiacao/instrucoes-carregadas.jsonl}"
mkdir -p "$(dirname "$LOG")" 2>/dev/null || exit 0
ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)

entrada=$(cat)

if ! command -v jq >/dev/null 2>&1; then
  printf '{"ts":"%s","erro":"jq-ausente"}\n' "$ts" >>"$LOG"
  exit 0
fi

# printf '%s' — nunca `echo "$json" | jq`: o echo do zsh interpreta escapes e corrompe o JSON.
if ! printf '%s' "$entrada" | jq -c --arg ts "$ts" '{
      ts: $ts,
      motivo: (.load_reason // "?"),
      arquivo: (.file_path // "?"),
      chars: ((.file_content // "") | length),
      agente: (.agent_type // "principal"),
      agent_id: (.agent_id // null),
      sessao: (.session_id // "?"),
      cwd: (.cwd // "?")
    }' >>"$LOG" 2>/dev/null; then
  printf '{"ts":"%s","erro":"jq-falhou"}\n' "$ts" >>"$LOG"
fi

exit 0
