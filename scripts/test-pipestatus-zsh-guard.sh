#!/usr/bin/env bash
# test-pipestatus-zsh-guard.sh — prova do hook .claude/hooks/pipestatus-zsh-guard.sh
#
# Roda em DOIS locales (C e pt_BR.UTF-8) de propósito: no #1483 uma asserção passou por acidente de
# ambiente porque `grep -i` sob pt_BR.UTF-8 dobra Ã↔ã e casava o ramo errado. Aqui todo casamento é
# por marcador ASCII exclusivo, caixa fixa, com `command grep` e SEM -i.
#
# O eixo dos NEGATIVOS é o precedente de 2026-06-24: um guard do repo bloqueou o commit que
# DOCUMENTAVA o padrão que ele detectava. Menção != execução — os casos (N1..N9) são exatamente as
# formas em que um agente escreve `PIPESTATUS` sem executá-lo.
#
# Inclui FALSIFICAÇÃO: no fim, sabota o scanner de quoting e exige que os negativos fiquem
# VERMELHOS. Um teste que passa com o código sabotado não prova nada.
# shellcheck disable=SC2016  # ARQUIVO INTEIRO: os comandos de teste sao strings LITERAIS de
# proposito — expandir ${PIPESTATUS[0]} aqui destruiria justamente o que o guard tem de ver.
set -u

RAIZ="$(cd "$(dirname "$0")/.." && pwd)"
HOOK="$RAIZ/.claude/hooks/pipestatus-zsh-guard.sh"
[ -x "$HOOK" ] || { echo "hook não encontrado/executável: $HOOK" >&2; exit 1; }
command -v jq >/dev/null || { echo "jq é necessário" >&2; exit 1; }

falhas=0

entrada() { # <comando> [tool_name]
  jq -n -c --arg cmd "$1" --arg tool "${2:-Bash}" '{tool_name:$tool, tool_input:{command:$cmd}}'
}

executa() { printf '%s' "$1" | bash "$HOOK" 2>/dev/null; }

checa() { # <titulo> <esperado: MARCADOR|VAZIO> <json>
  local titulo="$1" esperado="$2" json="$3" saida
  saida="$(executa "$json")"
  if [ "$esperado" = "VAZIO" ]; then
    if [ -z "$saida" ]; then printf '  ok   %s\n' "$titulo"; return 0; fi
    printf '  FALHA %s — esperava silêncio, veio: %s\n' "$titulo" "$(printf '%s' "$saida" | head -c 140)"
    falhas=$((falhas + 1)); return 1
  fi
  # o marcador tem de estar no additionalContext, nao em qualquer lugar do JSON
  if printf '%s' "$saida" | jq -r '.hookSpecificOutput.additionalContext // ""' 2>/dev/null \
       | command grep -q "$esperado"; then
    # e NAO pode bloquear: este hook avisa (veja o cabecalho do hook)
    local dec
    dec="$(printf '%s' "$saida" | jq -r '.hookSpecificOutput.permissionDecision // "-"' 2>/dev/null)"
    if [ "$dec" = "-" ]; then printf '  ok   %s\n' "$titulo"; return 0; fi
    printf '  FALHA %s — deveria AVISAR, mas emitiu permissionDecision="%s"\n' "$titulo" "$dec"
    falhas=$((falhas + 1)); return 1
  fi
  printf '  FALHA %s — esperava %s, veio: %s\n' "$titulo" "$esperado" "$(printf '%s' "$saida" | head -c 160)"
  falhas=$((falhas + 1)); return 1
}

A="PIPESTATUS-BASHISM-NO-ZSH"
Z="PIPESTATUS-INDICE-ZERO"

rodada() {
  echo "--- locale: ${LC_ALL:-(herdado)} ---"

  # ── POSITIVOS: o zsh EXPANDE -> vazio -> veredito fabricado ────────────────────────────────
  checa "P1 o caso do doc (if com -eq 0)" "$A" \
    "$(entrada 'false | true; if [ "${PIPESTATUS[0]}" -eq 0 ]; then echo OK; fi')"
  checa "P2 echo em aspas duplas" "$A" "$(entrada 'git push | tail -3; echo "EXIT=${PIPESTATUS[0]}"')"
  checa "P3 sem chaves" "$A" "$(entrada 'cmd | tail; rc=$PIPESTATUS')"
  checa "P4 subscript zsh sem chaves" "$A" "$(entrada 'cmd | tail; rc=$PIPESTATUS[0]')"
  checa 'P5 tamanho do array (${#..[@]})' "$A" "$(entrada 'cmd | tail; echo ${#PIPESTATUS[@]}')"
  checa "P6 fora de aspas, em teste" "$A" "$(entrada 'x | y; [ ${PIPESTATUS[0]} -ne 0 ] && exit 1')"
  # aspas DUPLAS em bash -c: o zsh de fora expande ANTES do bash ver -> bloquear esta CERTO
  checa "P7 bash -c com aspas DUPLAS" "$A" "$(entrada 'bash -c "x | y; echo ${PIPESTATUS[0]}"')"
  # heredoc NAO-quoted expande de verdade (o doc sairia corrompido) -> bloquear esta certo
  checa "P8 heredoc NAO-quoted" "$A" "$(entrada "$(printf 'cat > d.md <<EOF\nvale ${PIPESTATUS[0]}\nEOF\n')")"
  checa "P9 indice zero minusculo" "$Z" "$(entrada 'cmd | tail; rc=${pipestatus[0]}')"
  checa "P10 indice zero sem chaves" "$Z" "$(entrada 'cmd | tail; echo $pipestatus[0]')"

  # ── NEGATIVOS: MENCAO, nao execucao (o precedente 2026-06-24) ──────────────────────────────
  checa "N1 commit -m mencionando" "VAZIO" \
    "$(entrada 'git commit -m "docs: PIPESTATUS e bash-ism e no zsh vale vazio"')"
  checa "N2 grep pelo nome" "VAZIO" "$(entrada 'grep -rn PIPESTATUS docs/historico/')"
  checa "N3 aspas SIMPLES (literal)" "VAZIO" "$(entrada "echo 'use \${PIPESTATUS[0]} nunca'")"
  # ESTE e o precedente exato: escrever a documentacao do padrao
  checa "N4 heredoc QUOTED (documentar)" "VAZIO" \
    "$(entrada "$(printf "cat > doc.md <<'EOF'\nno zsh \${PIPESTATUS[0]} e vazio\nEOF\n")")"
  checa "N5 heredoc <<\"EOF\" quoted" "VAZIO" \
    "$(entrada "$(printf 'cat <<"EOF"\n${PIPESTATUS[0]}\nEOF\n')")"
  checa "N6 heredoc <<-'EOF' indentado" "VAZIO" \
    "$(entrada "$(printf "cat <<-'EOF'\n\t\${PIPESTATUS[0]}\n\tEOF\n")")"
  # aspas SIMPLES em bash -c: chega literal no bash, onde FUNCIONA -> legitimo
  checa "N7 bash -c com aspas SIMPLES" "VAZIO" "$(entrada "bash -c 'x | y; echo \${PIPESTATUS[0]}'")"
  checa "N8 escapado com barra" "VAZIO" "$(entrada 'echo "\${PIPESTATUS[0]}"')"
  checa "N9 ANSI-C quoting \$'...'" "VAZIO" "$(entrada "echo \$'\${PIPESTATUS[0]}'")"
  # o idioma CORRETO nao pode ser punido
  checa "N10 pipestatus[1] (correto)" "VAZIO" "$(entrada 'cmd | tail; rc=${pipestatus[1]}')"
  checa "N11 captura pelada (correto)" "VAZIO" "$(entrada 'cmd > /tmp/x.log 2>&1; rc=$?')"
  # prefixo de nome parecido nao pode casar
  checa "N12 \$MEU_PIPESTATUS" "VAZIO" "$(entrada 'echo "$MEU_PIPESTATUS"')"
  checa "N13 \$PIPESTATUSX" "VAZIO" "$(entrada 'echo "$PIPESTATUSX"')"
  # valvula de escape
  checa "N14 valvula PIPESTATUS_INTENCIONAL" "VAZIO" \
    "$(entrada 'PIPESTATUS_INTENCIONAL=1 zsh -c "x|y; echo ${PIPESTATUS[0]}"')"
  checa "N15 outra ferramenta" "VAZIO" "$(entrada 'echo "${PIPESTATUS[0]}"' 'Read')"
  checa "N16 comando trivial" "VAZIO" "$(entrada 'ls -la')"

  # ── REGRESSAO: achados da revisao adversaria do Codex (2026-08-23) ────────────────────────
  # POSITIVOS que a v1 liberava — reproduzidos em `zsh -f`, todos fabricam veredito.
  checa "C1 aritmetica (( )) SEM cifrao" "$A" "$(entrada 'false | true; (( PIPESTATUS[0] == 0 )) && echo OK')"
  checa "C2 [[ ]] minusculo SEM cifrao" "$Z" "$(entrada 'false | true; [[ pipestatus[0] -eq 0 ]] && echo OK')"
  checa "C3 flag de parametro (e)" "$A" "$(entrada 'x | y; [ "${(e)PIPESTATUS[0]}" -eq 0 ]')"
  checa "C4 indice calculado [0+0]" "$Z" "$(entrada 'x | y; [ "${pipestatus[0+0]}" -eq 0 ]')"
  # LIMITE ASSUMIDO, travado por teste: indirecao `${(P)nome}` escapa. O nome nu so conta em
  # contexto aritmetico, e aqui o teste e `[ ]` simples — cobrir exigiria punir `git commit -m
  # "…PIPESTATUS…"`, que e rotina neste repo. Se um dia mudar de ideia, este teste fica VERMELHO.
  checa "C5 indirecao (P)nome (FN conhecido)" "VAZIO" "$(entrada 'nome=PIPESTATUS; x | y; [ "${(P)nome}" -eq 0 ]')"
  checa "C6 continuacao de linha no meio do nome" "$A" \
    "$(entrada "$(printf 'x | y\nif [ "${PIPE\\\nSTATUS[0]}" -eq 0 ]; then echo OK; fi\n')")"
  checa "C7 heredoc multiplo (vale o PRIMEIRO)" "$A" \
    "$(entrada "$(printf "cat <<EOF <<'A'\n\${PIPESTATUS[0]}\nEOF\nliteral\nA\n")")"
  # NEGATIVOS que a v1 BLOQUEAVA — o zsh nao expande nenhum deles.
  checa "C8 comentario (# ate fim da linha)" "VAZIO" "$(entrada 'echo inicio # ${PIPESTATUS[0]}')"
  checa "C9 ' EOF' com espaco NAO fecha heredoc" "VAZIO" \
    "$(entrada "$(printf "cat <<'EOF'\nliteral\n EOF\n\${PIPESTATUS[0]}\nEOF\n")")"

  # ── ROBUSTEZ ───────────────────────────────────────────────────────────────────────────────
  local saida
  saida="$(printf '%s' 'isto nao e json' | bash "$HOOK" 2>/dev/null)"
  if [ -z "$saida" ]; then printf '  ok   R1 entrada invalida -> silencio\n'
  else printf '  FALHA R1 entrada invalida falou: %s\n' "$saida"; falhas=$((falhas + 1)); fi

  local ev
  ev="$(executa "$(entrada 'echo "${PIPESTATUS[0]}"')" | jq -r '.hookSpecificOutput.hookEventName' 2>/dev/null)"
  if [ "$ev" = "PreToolUse" ]; then printf '  ok   R2 hookEventName=PreToolUse\n'
  else printf '  FALHA R2 hookEventName veio "%s"\n' "$ev"; falhas=$((falhas + 1)); fi
}

echo "== pipestatus-zsh-guard =="
LC_ALL=C rodada
if locale -a 2>/dev/null | command grep -qi '^pt_BR.UTF-8$'; then
  LC_ALL=pt_BR.UTF-8 rodada
else
  echo "--- locale pt_BR.UTF-8 indisponível: pulado ---"
fi

# ── FALSIFICAÇÃO ────────────────────────────────────────────────────────────────────────────
# Sabota o scanner para NUNCA entrar em estado de aspas simples. Se os NEGATIVOS que dependem
# disso continuarem verdes, é porque nunca dependeram do scanner — e a suíte não provava nada.
# A sabotagem é ela própria verificada (arquivo tem de MUDAR): sabotagem que não sabota é teatro.
echo "-- falsificacao: scanner deixa de reconhecer aspas simples --"
BKP="$(mktemp)"; cp "$HOOK" "$BKP"
restaura() { cp "$BKP" "$HOOK"; rm -f "$BKP"; }
trap restaura EXIT

perl -0pi -e 's/\{ st = 1; i\+\+; continue \}/{ st = 0; i++; continue }/' "$HOOK"
if cmp -s "$BKP" "$HOOK"; then
  echo "  FALHA a sabotagem NAO alterou o hook — a falsificacao seria teatro"
  falhas=$((falhas + 1))
else
  sabotado_pegou=0
  # exatamente os negativos cuja unica defesa e o estado de aspas simples
  for caso in "echo 'use \${PIPESTATUS[0]} nunca'" "bash -c 'x | y; echo \${PIPESTATUS[0]}'"; do
    [ -n "$(executa "$(entrada "$caso")")" ] && sabotado_pegou=$((sabotado_pegou + 1))
  done
  if [ "$sabotado_pegou" -eq 2 ]; then
    echo "  ok   sabotagem ficou VERMELHA nos 2 negativos (o scanner e mesmo o que os protege)"
  else
    echo "  FALHA sabotagem passou despercebida em $((2 - sabotado_pegou)) caso(s)"
    falhas=$((falhas + 1))
  fi
fi
restaura; trap - EXIT

echo
if [ "$falhas" -eq 0 ]; then echo "PIPESTATUS-GUARD: TODOS OS TESTES PASSARAM"; exit 0; fi
echo "PIPESTATUS-GUARD: $falhas FALHA(S)"; exit 1
