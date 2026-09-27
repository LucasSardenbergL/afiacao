#!/usr/bin/env bash
# vigia-nuvem.sh — SessionStart(startup): esta sessão roda na NUVEM, e não no Mac?
#
# Por quê: em 2026-09-27 "o Codex parou de funcionar" era troca de máquina. Sessões abertas como
# Cloud no app desktop rodavam num container da Anthropic, sem codex, psql-ro, heavy e gstack, e o
# founder não percebeu (docs/historico/codex-em-sessao-cloud.md). Decisão do mesmo dia: o Codex
# roda só no Mac, e sessão que precisa dele abre como Local. Registro deste sensor:
# docs/historico/aviso-sessao-nuvem.md.
#
# Separado do vigia-gstack.sh de propósito. Lá, na nuvem, a ausência do gstack é por DESENHO e fala
# só com o modelo (docs/historico/gate-gstack-fail-open.md), e continua assim. Aqui o assunto é a
# MÁQUINA e o destinatário é o founder, então o aviso não depende do gstack: se um dia ele existir
# na nuvem, o vigia-gstack cala, e codex, psql-ro e heavy seguem faltando.
#
# Saída — o envelope que o harness honra (hookSpecificOutput + hookEventName):
#   • Mac (CLAUDE_CODE_REMOTE diferente de "true") → '{}'. Nada muda: nem aviso, nem contexto;
#   • nuvem (CLAUDE_CODE_REMOTE=true, o MESMO predicado do vigia-gstack.sh e do codex-async.sh) →
#     systemMessage (o founder VÊ; curto) + additionalContext (o modelo lê, com a instrução).
#   Medido no harness do app (2.1.281): sem o hookEventName, ele grava hook_non_blocking_error e
#   descarta a saída INTEIRA, o systemMessage de topo junto. O envelope não é detalhe do contexto.
#
# Nunca bloqueia (SessionStart nem pode) e nunca emite permissionDecision. JSON por printf de texto
# FIXO, sem jq: se o container não tiver jq, um sensor montado com ele cairia calado justamente na
# nuvem, o único lugar onde ele fala. A marca SESSAO-NUVEM é ASCII de caixa fixa: é o que
# scripts/test-vigia-nuvem.sh casa.
set -u

if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  echo '{}'
  exit 0
fi

msg="Sessão na NUVEM, não no Mac: sem Codex, psql-ro, heavy e gstack. Para money-path ou 2ª opinião, abra como Local no app desktop."
ctx="Vigia da nuvem: SESSAO-NUVEM — esta sessão roda num container cloud da Anthropic (CLAUDE_CODE_REMOTE=true), não no Mac, e o founder foi avisado na tela (systemMessage). Por decisão de 2026-09-27 não existem aqui: codex (o Codex roda só no Mac), psql-ro (mora em ~/.config/afiacao, no Mac), heavy (o semáforo de RAM da M2) e gstack. Não tente instalá-los nem contorná-los daqui. Se a tarefa for money-path, pedir 2ª opinião ou ler o banco, diga isso no início da resposta e peça para reabrir a sessão como Local no app desktop; sem Local, money-path segue pelo Caminho B (docs/agent/money-path.md). Histórico: docs/historico/codex-em-sessao-cloud.md."
printf '{"systemMessage":"%s","hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"}}\n' "$msg" "$ctx"
exit 0
