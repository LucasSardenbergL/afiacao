#!/usr/bin/env bash
# pos-compact-ptbr.sh — SessionStart(compact): reinjeta as regras vivas que
# comprovadamente degradam após compactação (medido em 240 sessões, 2026-07:
# regressão ao inglês, releitura integral de arquivos, roadmap sumido).
# Saída: additionalContext (informativo — nunca bloqueia).
set -u

ctx="Pós-compact — regras que costumam degradar (reforço do CLAUDE.md): "
ctx="${ctx}(1) responda SEMPRE em pt-BR, inclusive em subagentes; "
ctx="${ctx}(2) re-renderize o roadmap vivo no chat na próxima mensagem; "
ctx="${ctx}(3) NÃO releia arquivos inteiros já trabalhados — releia só o trecho que vai editar; "
ctx="${ctx}(4) se este já é o 2º compact desta sessão, proponha split com a skill handoff-sessao (1 entrega = 1 sessão)."

if command -v jq >/dev/null 2>&1; then
  jq -n --arg c "$ctx" '{hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:$c}}'
else
  # sem jq: o texto acima não contém aspas/escapes problemáticos
  printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"}}\n' "$ctx"
fi
