#!/usr/bin/env bash
# vigia-gstack.sh — SessionStart(startup): o gstack está instalado E funcional?
#
# SENSOR, não bloqueio — decisão do founder em 2026-09-27 (opção D; registro em
# docs/historico/gate-gstack-fail-open.md). Substitui o check-gstack.sh, um PreToolUse
# sobre `Skill` que de 2026-05-14 a 2026-09-27 não negou NADA:
#   • emitia {"permissionDecision":"deny"} no TOPO do JSON. Medido em 2026-09-27 (Claude
#     Code 2.1.281, sonda PreToolUse sobre Skill): o harness só honra a decisão dentro de
#     hookSpecificOutput COM hookEventName — no topo, ou sem o hookEventName, a skill CARREGA;
#   • e mirava o alvo errado: sem gstack, as skills DELE nem existem, então o deny sobre
#     Skill só negaria as que NÃO dependem dele (/fecho, lovable-db-operator, ...).
#
# Sonda POSITIVA — diretório existir não é instalação (bin/ vazio ≠ instalado):
#   (1) ≥1 arquivo executável em ~/.claude/skills/gstack/bin;
#   (2) SKILL.md legível das 4 skills canônicas do roteamento (docs/agent/skills.md).
#
# Saída — o envelope que o harness honra (hookSpecificOutput + hookEventName):
#   • instalado → '{}'. Silêncio é metade do valor: sensor que fala a cada boot o founder
#     aprende a ignorar (a mesma lição do vigia-worktree.sh);
#   • Mac sem gstack → systemMessage (o founder VÊ) + additionalContext (o modelo lê), com a
#     instalação. É anomalia: alto;
#   • nuvem (CLAUDE_CODE_REMOTE=true) sem gstack → só additionalContext. Lá a ausência é por
#     DESENHO (a sessão cloud não carrega ~/.claude/skills), então não é alarme: é o mapa dos
#     substitutos, e o aviso de não tentar instalar dali.
#
# Nunca bloqueia (SessionStart nem pode: exit 2 não tem efeito) e nunca emite permissionDecision.
# JSON por printf de texto FIXO, sem jq: um sensor que caísse calado em '{}' por falta de jq
# transformaria ausência de dado em "está instalado". Os marcadores GSTACK-AUSENTE, GSTACK-NUVEM,
# BIN-VAZIO e SKILL-AUSENTE são ASCII de caixa fixa: é o que scripts/test-vigia-gstack.sh casa.
set -u

G="${HOME:-}/.claude/skills/gstack"
CANONICAS="review investigate browse qa"
INSTALAR='git clone --depth 1 https://github.com/garrytan/gstack.git ~/.claude/skills/gstack && cd ~/.claude/skills/gstack && ./setup --team'

tem_exec=0
for f in "$G"/bin/*; do
  if [ -f "$f" ] && [ -x "$f" ]; then tem_exec=1; break; fi
done

faltam=""
for s in $CANONICAS; do
  [ -r "${HOME:-}/.claude/skills/$s/SKILL.md" ] || faltam="${faltam:+$faltam,}$s"
done

if [ "$tem_exec" -eq 1 ] && [ -z "$faltam" ]; then
  echo '{}'
  exit 0
fi

detalhe=""
[ "$tem_exec" -eq 1 ] || detalhe="nenhum executável em ~/.claude/skills/gstack/bin [BIN-VAZIO]"
[ -z "$faltam" ] || detalhe="${detalhe:+$detalhe; }faltam skills canônicas [SKILL-AUSENTE:$faltam]"

if [ "${CLAUDE_CODE_REMOTE:-}" = "true" ]; then
  ctx="Vigia do gstack: GSTACK-NUVEM — sessão cloud, o gstack NÃO existe aqui por desenho ($detalhe): a nuvem não carrega ~/.claude/skills (decisão 2026-09-27, docs/historico/gate-gstack-fail-open.md). As skills /review /investigate /browse /qa não estão disponíveis: não tente chamá-las nem instalar o gstack daqui. Substitutos: /code-review (nativo) no lugar de /review; WebFetch no lugar de /browse; /investigate e /qa sem substituto, siga o método à mão. As skills do repo (.claude/skills: /fecho, /handoff-sessao, lovable-db-operator...) funcionam normalmente."
  printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"}}\n' "$ctx"
  exit 0
fi

msg="GSTACK-AUSENTE: o gstack não está instalado ou está quebrado nesta máquina ($detalhe). As skills /review /investigate /browse /qa não existem nesta sessão. Instale e reinicie a sessão: $INSTALAR"
ctx="Vigia do gstack: $msg. Avise o Lucas logo no início da resposta, com a instrução acima. Até lá: /code-review no lugar de /review; WebFetch no lugar de /browse."
printf '{"systemMessage":"%s","hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"}}\n' "$msg" "$ctx"
exit 0
