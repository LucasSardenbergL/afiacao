#!/usr/bin/env bash
# test-sonda-processo-guard.sh — prova do hook .claude/hooks/sonda-processo-guard.sh
#
# Roda em DOIS locales (C e pt_BR.UTF-8) de propósito: no #1483 uma asserção passou por acidente de
# ambiente porque `grep -i` sob pt_BR.UTF-8 dobra Ã↔ã e casava o ramo errado. Aqui todo casamento é
# por marcador ASCII exclusivo, caixa fixa, com `command grep` e SEM -i.
#
# O eixo dos NEGATIVOS é o precedente de 2026-06-24: um guard do repo bloqueou o commit que
# DOCUMENTAVA o padrão que ele detectava. Menção != execução — e este hook nasce numa sessão que
# escreve `until ! pgrep …` em doc, em mensagem de commit e no corpo do PR.
#
# Inclui FALSIFICAÇÃO das sete regras de precisão, cada uma com CONTROLE VERDE na MESMA invocação:
# antes de sabotar, a fixture é exercitada contra o hook ÍNTEGRO e tem de estar SILENCIOSA. Sem
# esse controle, uma fixture sempre-vermelha aprovaria qualquer sabotagem
# (docs/historico/falsificacao-sem-linha-de-base.md).
# shellcheck disable=SC2016  # ARQUIVO INTEIRO: os comandos de teste sao strings LITERAIS de
# proposito — expandir "$pid"/"$(pgrep …)" aqui destruiria justamente o que o guard tem de ver.
set -u

RAIZ="$(cd "$(dirname "$0")/.." && pwd)"
HOOK="$RAIZ/.claude/hooks/sonda-processo-guard.sh"
[ -x "$HOOK" ] || { echo "hook não encontrado/executável: $HOOK" >&2; exit 1; }
command -v jq >/dev/null || { echo "jq é necessário" >&2; exit 1; }

falhas=0

entrada() { # <comando> [tool_name]
  jq -n -c --arg cmd "$1" --arg tool "${2:-Bash}" '{tool_name:$tool, tool_input:{command:$cmd}}'
}

# O log do SENSOR vai para um temporario: sem isto cada rodada da suite injeta disparos SINTETICOS
# no log real e a query de campo passa a medir teste como se fosse uso. Sensor que mede a propria
# suite nao mede nada.
LOGTESTE="$(mktemp "${TMPDIR:-/tmp}/sonda-processo-guard-suite.XXXXXX")"
trap 'rm -f "$LOGTESTE"' EXIT

executa() { printf '%s' "$1" | SONDA_PROCESSO_GUARD_LOG="$LOGTESTE" bash "$HOOK" 2>/dev/null; }

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
    # e NAO pode bloquear: este hook avisa, e nunca vai bloquear (veja o cabecalho do hook)
    local dec
    dec="$(printf '%s' "$saida" | jq -r '.hookSpecificOutput.permissionDecision // "-"' 2>/dev/null)"
    if [ "$dec" = "-" ]; then printf '  ok   %s\n' "$titulo"; return 0; fi
    printf '  FALHA %s — deveria AVISAR, mas emitiu permissionDecision="%s"\n' "$titulo" "$dec"
    falhas=$((falhas + 1)); return 1
  fi
  printf '  FALHA %s — esperava %s, veio: %s\n' "$titulo" "$esperado" "$(printf '%s' "$saida" | head -c 160)"
  falhas=$((falhas + 1)); return 1
}

P="SONDA-PGREP-MEDE-A-MAQUINA"
S="SONDA-PS-GREP-MEDE-A-MAQUINA"

rodada() {
  echo "--- locale: ${LC_ALL:-(herdado)} ---"

  # ── POSITIVOS: laco espera por processo identificado por TEXTO ──────────────────────────────
  checa "P1 o caso medido do doc (until ! pgrep -f)" "$P" \
    "$(entrada 'until ! pgrep -f "mutcheck.sh scripts/sonda-versao-sql" > /dev/null; do sleep 20; done')"
  checa "P2 while + pgrep (espera SUMIR)" "$P" \
    "$(entrada 'while pgrep -f vitest >/dev/null; do sleep 10; done; echo terminou')"
  checa "P3 until + pgrep (espera APARECER — mesmo defeito de sujeito)" "$P" \
    "$(entrada 'until pgrep -f "vite --port" >/dev/null; do sleep 1; done')"
  checa "P4 sonda INDIRETA dentro de \$( ) — [ -z ]" "$P" \
    "$(entrada 'until [ -z "$(pgrep -f mutcheck)" ]; do sleep 5; done')"
  checa "P5 pgrep SEM -f (o nome tambem mede a maquina)" "$P" \
    "$(entrada 'while pgrep vitest >/dev/null 2>&1; do sleep 5; done')"
  checa "P6 ps aux | grep" "$S" \
    "$(entrada 'while ps aux | command grep -q "[m]utcheck"; do sleep 5; done')"
  checa "P7 multi-linha (do/done em linhas separadas)" "$P" \
    "$(entrada "$(printf 'while pgrep -f "bun run test" > /dev/null; do\n  sleep 20\ndone\necho fim\n')")"
  checa "P8 continuacao de linha partindo o laco" "$P" \
    "$(entrada "$(printf 'until ! pgrep -f alvo; \\\n  do sleep 9; done\n')")"
  checa "P10 corpo com mais coisas alem do sleep" "$P" \
    "$(entrada 'while pgrep -f alvo >/dev/null; do sleep 5; echo esperando; done')"
  checa "P11 laco aninhado: o done de dentro nao fecha o de fora" "$P" \
    "$(entrada 'while pgrep -f alvo; do for i in 1 2; do :; done; sleep 3; done')"

  # ── NEGATIVOS: uso legitimo, ou MENCAO (o precedente de 2026-06-24) ─────────────────────────
  checa "N1 contagem pontual — vigia-worktree.sh esta CERTO" "VAZIO" \
    "$(entrada 'sleep 1; pgrep -f "claude.app/Contents/MacOS/claude" | wc -l | tr -d " "')"
  checa "N2 idioma CERTO: kill -0 no MEU pid" "VAZIO" \
    "$(entrada 'bash x.sh & pid=$!; while kill -0 "$pid" 2>/dev/null; do sleep 1; done')"
  checa "N3 idioma CERTO: ps -p no MEU pid (ps SEM grep)" "VAZIO" \
    "$(entrada 'while ps -p "$pid" >/dev/null; do sleep 1; done')"
  checa "N4 marcador POSITIVO de fim (o idioma que o hook recomenda)" "VAZIO" \
    "$(entrada 'until command grep -q "^RC=" .mut1.txt; do sleep 20; done')"
  checa "N5 MENCAO em aspas simples (git commit do proprio doc)" "VAZIO" \
    "$(entrada "git commit -m 'docs(shell): until ! pgrep -f X; do sleep 20; done mede a maquina'")"
  checa "N6 MENCAO em heredoc quoted (escrever o doc)" "VAZIO" \
    "$(entrada "$(printf "cat > doc.md <<'EOF'\nuntil ! pgrep -f X; do sleep 20; done\nEOF\n")")"
  checa "N7 MENCAO em heredoc NAO-quoted (corpo tambem e DADO)" "VAZIO" \
    "$(entrada "$(printf 'cat > doc.md <<EOF\nwhile pgrep -f X; do sleep 20; done\nEOF\n')")"
  checa "N8 MENCAO em comentario" "VAZIO" \
    "$(entrada "$(printf 'sleep 1\n# while pgrep -f X; do sleep 20; done  <- nao faca isto\n')")"
  checa "N9 MENCAO em \$'...'" "VAZIO" \
    "$(entrada "printf '%s' \$'while pgrep -f X; do sleep 20; done'; sleep 1")"
  checa "N10 pgrep DEPOIS do laco (nao esta na condicao)" "VAZIO" \
    "$(entrada 'while read -r l; do sleep 1; done < lista.txt; pgrep -f vitest')"
  checa "N11 laco sem sleep nao e espera" "VAZIO" \
    "$(entrada 'sleep 1; while pgrep -f alvo >/dev/null; do kill -TERM 1; done')"
  checa "N12 sonda pontual, sem laco" "VAZIO" \
    "$(entrada 'sleep 5; pgrep -f vitest && echo "ainda rodando"')"
  checa "N13 grep no doc que descreve a armadilha" "VAZIO" \
    "$(entrada 'command grep -n "pgrep" docs/historico/evidencia-positiva-shell.md; sleep 1')"
  checa "N14 tool_name != Bash" "VAZIO" \
    "$(entrada 'while pgrep -f alvo; do sleep 5; done' 'Read')"
  checa "N15 silenciador declarado no inicio" "VAZIO" \
    "$(entrada 'SONDA_PROCESSO_INTENCIONAL=1 while pgrep -f Docker; do sleep 1; done')"

  # ── REGRESSAO: achados da revisao adversaria do Codex (2026-09-06) ─────────────────────────
  # FALSOS NEGATIVOS que a v1 liberava — todos reproduzidos e corrigidos.
  checa "X1 caminho absoluto no pgrep" "$P" \
    "$(entrada 'until ! /usr/bin/pgrep -f "mutcheck.sh" >/dev/null; do sleep 20; done')"
  checa "X2 caminho absoluto no sleep" "$P" \
    "$(entrada 'until ! pgrep -f "mutcheck.sh" >/dev/null; do /bin/sleep 20; done')"
  checa "X3 barra anti-alias (\\pgrep)" "$P" \
    "$(entrada 'while \pgrep -f "mutcheck.sh" >/dev/null; do sleep 20; done')"
  checa "X4 herestring <<< nao abre heredoc" "$P" \
    "$(entrada "$(printf 'cat <<<EOF\nwhile pgrep -f m.sh >/dev/null; do sleep 20; done\n')")"
  checa "X5 shift aritmetico (( 1 << 2 )) nao abre heredoc" "$P" \
    "$(entrada "$(printf '(( x = 1 << 2 ))\nwhile pgrep -f m.sh >/dev/null; do sleep 20; done\n')")"
  checa "X6 delimitador com hifen fecha (<<DOC-FIM)" "$P" \
    "$(entrada "$(printf 'cat <<DOC-FIM\ntexto\nDOC-FIM\nwhile pgrep -f m.sh >/dev/null; do sleep 20; done\n')")"
  # FALSOS POSITIVOS que a v1 marcava — o repo documenta as proprias armadilhas, e ESTE PR
  # escreve o padrao literal em doc, commit e descricao.
  checa "X7 commit -m em aspas DUPLAS" "VAZIO" \
    "$(entrada 'git commit --allow-empty -m "docs: until ! pgrep -f X; do sleep 20; done"')"
  checa "X8 echo de documentacao" "VAZIO" \
    "$(entrada 'echo "until ! pgrep -f X; do sleep 20; done"')"
  checa "X9 grep -nF no proprio catalogo" "VAZIO" \
    "$(entrada 'command grep -nF "until ! pgrep -f X; do sleep 20; done" docs/historico/evidencia-positiva-shell.md')"
  checa "X10 heredoc quoted dentro de \$( )" "VAZIO" \
    "$(entrada "$(printf 'git commit -m "\$(cat <<%sEOF%s\ndocs: until ! pgrep -f X; do sleep 20; done\nEOF\n)"\n' "'" "'")")"
  checa "X11 pgrep -P \$\$ e IDENTIDADE (filhos do MEU shell)" "VAZIO" \
    "$(entrada 'sleep 1 & while pgrep -P "$$" >/dev/null; do sleep 0.1; done')"
  checa "X12 ps -p \$pid | grep e IDENTIDADE" "VAZIO" \
    "$(entrada 'sleep 1 & pid=$!; while ps -p "$pid" -o pid= | grep -q "[0-9]"; do sleep 0.1; done')"
  checa "X13 sem HOME o hook nao morre (fail-open)" "$P" \
    "$(entrada 'while pgrep -f alvo; do sleep 5; done')"

  # LIMITES ASSUMIDOS do parecer, travados por teste: se um dia forem cobertos, estes ficam
  # VERMELHOS e a decisao volta a mesa. Todos sao patologicos ou indirecao — cobri-los custaria
  # a precisao que protege o FP documental.
  checa "L1 pgrep entre aspas simples (FN)" "VAZIO" \
    "$(entrada "while 'pgrep' -f alvo >/dev/null; do sleep 20; done")"
  checa "L2 sonda dentro de funcao (FN)" "VAZIO" \
    "$(entrada "$(printf 'ativo() { pgrep -f m.sh >/dev/null; }\nwhile ativo; do sleep 20; done\n')")"
  checa "L3 laco zsh sem do — while c; { … } (FN)" "VAZIO" \
    "$(entrada 'while pgrep -f m.sh >/dev/null; { sleep 20; }')"
  checa "L4 bash -c com aspas duplas (FN — aspas duplas sao MENCAO)" "VAZIO" \
    "$(entrada 'bash -c "while pgrep -f alvo >/dev/null; do sleep 5; done"')"
  checa "L5 sleep como ARGUMENTO literal (FP)" "$P" \
    "$(entrada 'while pgrep -f m.sh >/dev/null; do printf "%s" sleep; break; done')"

  # LIMITE ASSUMIDO, travado por teste: heredoc alimentando um SHELL e executado, mas o corpo e
  # descartado como dado. Cobrir exigiria distinguir `bash <<EOF` de `cat <<EOF`, e o FP de punir
  # todo heredoc que documenta o padrao e pior. Se um dia mudar de ideia, este teste fica VERMELHO.
  checa "C1 bash <<EOF (FN conhecido)" "VAZIO" \
    "$(entrada "$(printf 'bash <<EOF\nwhile pgrep -f X; do sleep 20; done\nEOF\n')")"

  # ── ROBUSTEZ ───────────────────────────────────────────────────────────────────────────────
  local saida
  saida="$(printf '%s' 'isto nao e json' | SONDA_PROCESSO_GUARD_LOG="$LOGTESTE" bash "$HOOK" 2>/dev/null)"
  if [ -z "$saida" ]; then printf '  ok   R1 entrada invalida -> silencio\n'
  else printf '  FALHA R1 entrada invalida falou: %s\n' "$saida"; falhas=$((falhas + 1)); fi

  local ev
  ev="$(executa "$(entrada 'while pgrep -f alvo; do sleep 5; done')" \
        | jq -r '.hookSpecificOutput.hookEventName' 2>/dev/null)"
  if [ "$ev" = "PreToolUse" ]; then printf '  ok   R2 hookEventName=PreToolUse\n'
  else printf '  FALHA R2 hookEventName veio "%s"\n' "$ev"; falhas=$((falhas + 1)); fi

  # O sensor de campo tem de GRAVAR — sem linha no log, a pergunta "quantas vezes disparou" fica
  # sem resposta por construcao (docs/historico/fase-sem-sinal.md).
  local antes depois
  antes="$(command grep -c '' "$LOGTESTE" 2>/dev/null || echo 0)"
  executa "$(entrada 'while pgrep -f sensor-teste; do sleep 5; done')" >/dev/null
  depois="$(command grep -c '' "$LOGTESTE" 2>/dev/null || echo 0)"
  if [ "$depois" -gt "$antes" ] \
     && command grep -q '"ramo":"SONDA-PGREP-MEDE-A-MAQUINA"' "$LOGTESTE"; then
    printf '  ok   R3 sensor de campo gravou a linha\n'
  else printf '  FALHA R3 sensor nao gravou (antes=%s depois=%s)\n' "$antes" "$depois"
    falhas=$((falhas + 1)); fi
}

echo "== sonda-processo-guard =="
LC_ALL=C rodada
if locale -a 2>/dev/null | command grep -qi '^pt_BR.UTF-8$'; then
  LC_ALL=pt_BR.UTF-8 rodada
else
  echo "--- locale pt_BR.UTF-8 indisponível: pulado ---"
fi

# ── FALSIFICAÇÃO ────────────────────────────────────────────────────────────────────────────
# Cada regra de PRECISAO e sabotada uma por vez, e as fixtures escolhidas passam em TODAS as
# outras regras — assim so a regra sabotada decide o resultado. As tres exigencias:
#   (1) CONTROLE VERDE na MESMA invocacao (a fixture tem de estar silenciosa ANTES da sabotagem);
#   (2) a sabotagem tem de MUDAR o arquivo (sabotagem que nao sabota e teatro);
#   (3) depois da sabotagem, a fixture tem de ficar VERMELHA (o hook passa a disparar nela).
BKP="$(mktemp)"; cp "$HOOK" "$BKP"
restaura() { cp "$BKP" "$HOOK"; }
trap 'restaura; rm -f "$BKP" "$LOGTESTE"' EXIT

falsifica() { # <titulo> <perl-de-sabotagem> <fixture...>
  local titulo="$1" sabotagem="$2"; shift 2
  local verdes=0 vermelhos=0 total=$#

  for caso in "$@"; do                       # (1) CONTROLE VERDE, com o hook INTEGRO
    [ -z "$(executa "$(entrada "$caso")")" ] && verdes=$((verdes + 1))
  done
  if [ "$verdes" -ne "$total" ]; then
    printf '  FALHA %s — CONTROLE: %s de %s fixtures ja disparavam ANTES da sabotagem; a\n' \
      "$titulo" "$((total - verdes))" "$total"
    printf '        falsificacao aprovaria qualquer coisa\n'
    falhas=$((falhas + 1)); return 1
  fi

  perl -0pi -e "$sabotagem" "$HOOK"          # (2) a sabotagem tem de MUDAR o arquivo
  if cmp -s "$BKP" "$HOOK"; then
    printf '  FALHA %s — a sabotagem NAO alterou o hook (regex nao casou): seria teatro\n' "$titulo"
    falhas=$((falhas + 1)); restaura; return 1
  fi

  for caso in "$@"; do                       # (3) tem de ficar VERMELHO
    [ -n "$(executa "$(entrada "$caso")")" ] && vermelhos=$((vermelhos + 1))
  done
  restaura
  if [ "$vermelhos" -eq "$total" ]; then
    printf '  ok   %s — %s/%s fixtures VERMELHAS com a regra sabotada\n' "$titulo" "$vermelhos" "$total"
    return 0
  fi
  printf '  FALHA %s — %s de %s fixtures seguiram caladas: a regra nao e o que as protege\n' \
    "$titulo" "$((total - vermelhos))" "$total"
  falhas=$((falhas + 1)); return 1
}

echo "-- falsificacao das 7 regras de precisao --"

# F1 — `sleep` no CORPO e o que separa ESPERA de outra coisa. Fixtures: laco com pgrep na condicao
# e sleep FORA do corpo (contem "sleep" para atravessar o portao barato — sem isso a sabotagem do
# awk seria irrelevante e o verde viria por motivo alheio).
falsifica "F1 exigencia de sleep no CORPO" 's/if \(!temSleep\) continue/if (0) continue/' \
  'sleep 1; while pgrep -f alvo >/dev/null; do kill -TERM 1; done' \
  'while pgrep -f alvo >/dev/null; do echo x; done; sleep 2'

# F2 — a sonda tem de estar na CONDICAO, nao em qualquer lugar do comando. A sabotagem troca a
# leitura da condicao por uma varredura GLOBAL do texto visivel.
falsifica "F2 sonda restrita a CONDICAO do laco" \
  's/temPgrep = 0; temPs = 0/temPgrep = (linhaf ~ \/pgrep\/); temPs = 0/' \
  'while read -r l; do sleep 1; done < lista.txt; pgrep -f vitest' \
  'pgrep -f alvo > /tmp/pids.txt; while read -r p; do sleep 1; done < /tmp/pids.txt'

# F3 — o scanner de aspas simples: MENCAO != execucao. E a regra que impede o precedente de
# 2026-06-24 (guard barrando o commit que DOCUMENTA o padrao) de se repetir.
falsifica "F3 scanner de aspas simples (mencao)" 's/if \(st == 1\)/if (st == 91)/' \
  "git commit -m 'docs: until ! pgrep -f X; do sleep 20; done mede a maquina'" \
  "echo 'while pgrep -f alvo; do sleep 5; done'"

# F4 — corpo de heredoc e DADO. A sabotagem faz o scanner tratar o corpo como texto executavel.
falsifica "F4 descarte do corpo de heredoc" 's/if \(t == hd\) \{ inhd = 0; hd = "" \}\n      next/if (t == hd) { inhd = 0; hd = "" }\n      vis = vis linha "\\n"; next/' \
  "$(printf "cat > doc.md <<'EOF'\nuntil ! pgrep -f X; do sleep 20; done\nEOF\n")" \
  "$(printf 'cat > doc.md <<EOF\nwhile pgrep -f X; do sleep 20; done\nEOF\n')"

# F5 — `ps` so conta ACOMPANHADO de grep: `while ps -p "$pid"` e o idioma CERTO e nao pode ser
# punido. A sabotagem derruba a exigencia do grep.
falsifica "F5 ps exige grep junto" 's/if \(temPs && temGrep\)/if (temPs || temGrep)/' \
  'while ps aux > /tmp/snap.txt; do sleep 1; done' \
  'while command grep -q "^RC=" /tmp/ps-run.log; do sleep 5; done'

# F6 — `-P`/`-p` recebem um PID: isso e IDENTIDADE REAL, nao padrao de texto. Sem esta regra o
# hook puniria `while pgrep -P "$$"` e `while ps -p "$pid" | grep`, que estao CERTOS.
falsifica "F6 -P/-p sao identidade, nao padrao" 's/if \(porPid\) continue/if (0) continue/' \
  'sleep 1 & while pgrep -P "$$" >/dev/null; do sleep 0.1; done' \
  'sleep 1 & pid=$!; while ps -p "$pid" -o pid= | grep -q "[0-9]"; do sleep 0.1; done'

# F7 — aspas DUPLAS sao MENCAO. E a regra que protege o falso positivo mais provavel deste repo:
# a mensagem de commit e o `echo` que DOCUMENTAM a armadilha (precedente de 2026-06-24).
falsifica "F7 aspas duplas sao mencao" 's/if \(st == 2\)/if (st == 92)/' \
  'git commit --allow-empty -m "docs: until ! pgrep -f X; do sleep 20; done"' \
  'echo "until ! pgrep -f X; do sleep 20; done"' 

restaura; rm -f "$BKP"; trap 'rm -f "$LOGTESTE"' EXIT

# A restauracao tem de ser VERIFICADA: a suite reescreve o hook 5 vezes, e sair com um hook
# sabotado em disco seria pior que qualquer falha de teste.
if command grep -q 'if (!temSleep) continue' "$HOOK" && command grep -q 'if (temPs && temGrep)' "$HOOK" \
   && command grep -q 'if (porPid) continue' "$HOOK" && command grep -qF 'st = 2; vis = vis " "' "$HOOK"; then
  echo "  ok   hook restaurado integro"
else
  echo "  FALHA hook NAO foi restaurado — ha sabotagem em disco"; falhas=$((falhas + 1))
fi

echo
if [ "$falhas" -eq 0 ]; then echo "SONDA-PROCESSO-GUARD: TODOS OS TESTES PASSARAM"; exit 0; fi
echo "SONDA-PROCESSO-GUARD: $falhas FALHA(S)"; exit 1
