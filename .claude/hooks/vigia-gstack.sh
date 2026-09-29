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
# Upgrade (2026-09-29, docs/historico/gstack-upgrade-fora-da-sessao.md): com o gstack instalado no
# Mac, o vigia também lê o status do preparo semanal (scripts/gstack-auto-upgrade.sh, no launchd).
# Status ausente ou ultimo_ok ilegível NÃO é "em dia" (ausente ≠ zero). FALHOU, PARADO (nenhuma
# rodada completa em 10 dias; o job é semanal) e SEM-STATUS são anomalias e falam a cada boot.
# PENDENTE é rotina: o founder vê UMA vez por dia, e o modelo recebe sempre, calado, como aplicar.
#
# Nunca bloqueia (SessionStart nem pode: exit 2 não tem efeito) e nunca emite permissionDecision.
# JSON por printf de texto FIXO, sem jq: um sensor que caísse calado em '{}' por falta de jq
# transformaria ausência de dado em "está instalado". O que vem do arquivo de status passa por
# `limpa` antes de entrar no JSON. Os marcadores GSTACK-AUSENTE, GSTACK-NUVEM, BIN-VAZIO,
# SKILL-AUSENTE e GSTACK-UPGRADE-* são ASCII de caixa fixa: é o que scripts/test-vigia-gstack.sh casa.
set -u

G="${HOME:-}/.claude/skills/gstack"
CANONICAS="review investigate browse qa"
INSTALAR='git clone --depth 1 https://github.com/garrytan/gstack.git ~/.claude/skills/gstack && cd ~/.claude/skills/gstack && ./setup --team'
AUTO="${HOME:-}/.gstack/auto-upgrade"
ST="$AUTO/status"

limpa() {
  LC_ALL=C tr -cd 'A-Za-z0-9 ._:/@=+,;()>-'
}
campo() { sed -n "s/^$1=//p" "$ST" 2>/dev/null | sed -n 1p | limpa; }

up_sys=""   # o que o founder VÊ (systemMessage)
up_ctx=""   # o que o modelo lê (additionalContext)
verificar_upgrade() {
  local estado ok det ver nova alvo agora marca hoje mostrar=1
  if [ ! -r "$ST" ]; then
    up_sys="GSTACK-UPGRADE-SEM-STATUS: o preparo semanal do upgrade do gstack nunca rodou nesta máquina (não instalado?). Instale com: bash scripts/gstack-auto-upgrade-instalar.sh"
    up_ctx="Vigia do gstack: $up_sys. Avise o Lucas em 1 linha."
    return
  fi
  estado="$(campo estado)"; ok="$(campo ultimo_ok)"; det="$(campo detalhe)"; ver="$(campo versao)"
  agora="$(date +%s)"
  case "$ok" in ''|*[!0-9]*) ok=0 ;; esac   # ausente ou ilegível = nunca, não "agora"
  if [ "$estado" = FALHOU ]; then
    up_sys="GSTACK-UPGRADE-FALHOU: o último upgrade do gstack falhou ($det). O gstack segue na v$ver. Log: ~/.gstack/auto-upgrade/log"
    up_ctx="Vigia do gstack: $up_sys. Avise o Lucas em 1 linha; se ele pedir, diagnostique pelo log e rode o /gstack-upgrade (com o pedido dele, o classificador libera)."
  elif [ $((agora - ok)) -gt 864000 ]; then
    up_sys="GSTACK-UPGRADE-PARADO: nenhuma rodada do preparo semanal do upgrade do gstack terminou nos últimos 10 dias (último estado: ${estado:-ilegível}). Confira: launchctl print gui/\$(id -u)/com.lucas.gstack-upgrade e ~/.gstack/auto-upgrade/log"
    up_ctx="Vigia do gstack: $up_sys. Avise o Lucas em 1 linha."
  elif [ "$estado" = PENDENTE ]; then
    nova="$(campo nova)"; alvo="$(campo alvo)"
    marca="$AUTO/avisado"; hoje="$(date +%Y-%m-%d) $alvo"
    if [ "$(cat "$marca" 2>/dev/null)" = "$hoje" ]; then
      mostrar=0
    else
      printf '%s\n' "$hoje" > "$marca" 2>/dev/null
    fi
    # gate ausente (status de versão antiga do script) conta como INCOMPLETO: ausente ≠ completo
    if [ "$(campo gate)" = COMPLETO ]; then
      [ "$mostrar" -eq 1 ] && up_sys="GSTACK-UPGRADE-PENDENTE: gstack v$nova pronto para revisar (instalado: v$ver). Para aplicar, diga: aplica o upgrade do gstack"
      up_ctx="Vigia do gstack: GSTACK-UPGRADE-PENDENTE, v$ver para v$nova (alvo $alvo). Não mencione se o Lucas não perguntar. Se ele pedir para aplicar: leia ~/.gstack/auto-upgrade/revisao.md, aplique o gate de supply chain de docs/agent/skills.md (zero achado novo no que dispara sozinho; leia o diff de setup, bin e hooks), diga o veredito e rode EM BACKGROUND: bash ~/.gstack/auto-upgrade/atualizar-gstack.sh --aplicar $alvo"
    else
      [ "$mostrar" -eq 1 ] && up_sys="GSTACK-UPGRADE-PENDENTE: gstack v$nova disponível, mas a revisão saiu com GATE INCOMPLETO (o scanner não rodou). O preparo tenta de novo no próximo domingo; para agora, diga: refaz o preparo do upgrade do gstack"
      up_ctx="Vigia do gstack: GSTACK-UPGRADE-PENDENTE com GATE INCOMPLETO, v$ver para v$nova (alvo $alvo). Não mencione se o Lucas não perguntar. NÃO aplique: se ele pedir, rode EM BACKGROUND o preparo de novo (bash ~/.gstack/auto-upgrade/atualizar-gstack.sh) e leia o log (~/.gstack/auto-upgrade/log)."
    fi
  fi
}

tem_exec=0
for f in "$G"/bin/*; do
  if [ -f "$f" ] && [ -x "$f" ]; then tem_exec=1; break; fi
done

faltam=""
for s in $CANONICAS; do
  [ -r "${HOME:-}/.claude/skills/$s/SKILL.md" ] || faltam="${faltam:+$faltam,}$s"
done

if [ "$tem_exec" -eq 1 ] && [ -z "$faltam" ]; then
  # Nuvem: sem launchd nem job de upgrade; um status que houvesse ali não seria desta máquina.
  if [ "${CLAUDE_CODE_REMOTE:-}" = "true" ]; then echo '{}'; exit 0; fi
  verificar_upgrade
  if [ -z "$up_ctx" ]; then echo '{}'; exit 0; fi
  if [ -n "$up_sys" ]; then
    printf '{"systemMessage":"%s","hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"}}\n' "$up_sys" "$up_ctx"
  else
    printf '{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"%s"}}\n' "$up_ctx"
  fi
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
