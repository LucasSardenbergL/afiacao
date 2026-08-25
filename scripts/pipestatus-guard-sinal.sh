#!/usr/bin/env bash
# pipestatus-guard-sinal.sh — LÊ o sensor de campo do .claude/hooks/pipestatus-zsh-guard.sh.
#
# POR QUÊ ESTE SCRIPT EXISTE: o hook nasceu como AVISO, e o cabeçalho dele diz que endurecer para
# `deny` é decisão de fase N+1 "com sinal desta fase". Sem uma QUERY, essa frase é promessa vazia —
# "quando medir" tem de ser comando, não recado (docs/historico/fase-sem-sinal.md). Isto é o comando.
#
# ⚠️ AUSÊNCIA DE DADO NÃO É APROVAÇÃO. Log inexistente/vazio NÃO significa "nunca dispara, pode
# endurecer": significa que o guard pode nem ter rodado (sessões abertas antes do merge não releem
# settings.json). O veredito abaixo trata os dois casos como coisas DIFERENTES, de propósito.
#
# Datas passam por `jq` (fromdateiso8601), nunca por `date -d`/`date -j`: as flags de data divergem
# entre BSD e GNU sem falhar — fazem OUTRA coisa em silêncio (evidencia-positiva-shell.md §6).
#
# Uso:  bash scripts/pipestatus-guard-sinal.sh [caminho-do-log]
set -u

LOG="${1:-${PIPESTATUS_GUARD_LOG:-$HOME/.claude/afiacao-pipestatus-guard.jsonl}}"
command -v jq >/dev/null 2>&1 || { echo "jq é necessário" >&2; exit 64; }

echo "== SINAL DE CAMPO: pipestatus-zsh-guard =="
echo "log: $LOG"

if [ ! -f "$LOG" ]; then
  cat <<'FIM'

SEM-LOG: o arquivo não existe.

Isto é AUSÊNCIA DE DADO, não "zero disparos". Confira nesta ordem:
  1. o hook está registrado?   jq '.hooks.PreToolUse[]|select(.matcher=="Bash")' .claude/settings.json
  2. a sessão foi aberta DEPOIS do merge? settings.json só é lido na inicialização — sessão antiga
     roda sem o guard, e um worktree antigo nunca vai escrever aqui;
  3. force um disparo:  true | true; echo "${PIPESTATUS[0]}"

VEREDITO: não dá para decidir nada sobre endurecer. Instale o sinal antes.
FIM
  exit 3
fi

# `grep -c ''` e nao `jq -s`: uma UNICA linha picotada fazia o `jq -s` abortar e o relatorio
# inteiro morria com exit 65 — perdia-se 100% do sinal por causa de 1 linha. O log e append de
# ~30 worktrees; picote e acidente esperado, nao motivo para descartar meses de dado.
total="$(command grep -c '' "$LOG" 2>/dev/null)" || total=0
if [ "${total:-0}" -eq 0 ]; then
  echo
  echo "LOG-VAZIO: o arquivo existe mas não tem nenhum disparo."
  echo "Diferente de SEM-LOG: aqui o hook provavelmente rodou e simplesmente não achou nada."
  echo "Ainda assim é fraco como prova — sem saber quantas chamadas Bash passaram pelo guard, o"
  echo "denominador é desconhecido, e 0/desconhecido não é uma taxa."
  echo
  echo "VEREDITO: sinal insuficiente. Siga avisando."
  exit 0
fi

# Parse OK nao e schema OK. Um JSONL de linhas validas porem SEM os campos do sensor produzia
# relatorio de "null" com exit 0 — ou seja, ausencia de dado servida como medicao, exatamente o
# vicio que este sensor existe para nao cometer. Daqui para baixo tudo le a fatia VALIDADA.
VALIDO="$(mktemp "${TMPDIR:-/tmp}/pipestatus-sinal.XXXXXX")" || { echo "não consegui criar arquivo temporário" >&2; exit 70; }
trap 'rm -f "$VALIDO"' EXIT
# `try…catch empty` porque o `ts` tem de sobreviver ao `fromdateiso8601` usado nas agregacoes:
# validar so o TIPO deixaria passar "ontem" e a query morreria la na frente.
# `-R` + `fromjson?` le linha a linha como TEXTO: linha picotada vira `empty`, nao aborto.
jq -Rc 'fromjson? // empty
       | select((.ramo|type)=="string" and (.trecho|type)=="string" and (.wt|type)=="string")
       | select(try ((.ts|fromdateiso8601)|type) catch "" | . == "number")' "$LOG" > "$VALIDO" 2>/dev/null
validas="$(wc -l < "$VALIDO" | tr -d ' ')"
if [ "${validas:-0}" -eq 0 ]; then
  echo
  # marcador ASCII de caixa fixa: a suite casa por ele com `command grep` SEM -i, e prosa acentuada
  # casaria diferente sob LC_ALL=C e pt_BR.UTF-8 (#1483).
  echo "LOG-ILEGIVEL: nenhuma das $total linha(s) do log e um disparo deste sensor (ts/ramo/trecho/wt)."
  echo "Isto NÃO é 'zero disparos' — é log de outra coisa, ou corrompido de ponta a ponta."
  echo "Confira se PIPESTATUS_GUARD_LOG não está apontando para o arquivo errado:"
  echo "  head -c 300 $LOG"
  exit 65
fi
if [ "$validas" -lt "$total" ]; then
  echo
  echo "AVISO: $((total - validas)) de $total linha(s) ignorada(s) — picotadas, ou de outro schema."
  echo "Os números abaixo contam só as $validas válida(s)."
fi

jq -rs '
  (map(.ts | fromdateiso8601) | sort) as $t
  | ($t[0]) as $ini | ($t[-1]) as $fim
  | (($fim - $ini) / 86400) as $dias
  | "
Janela observada: \($ini|todateiso8601[0:10]) -> \($fim|todateiso8601[0:10])  (\($dias|floor) dia(s))
Disparos: \(length)   " + (group_by(.ramo) | map("\(.[0].ramo)=\(length)") | join("   "))
' "$VALIDO"

echo
echo "Por dia:"
jq -rs 'group_by(.ts[0:10]) | .[] | "  \(.[0].ts[0:10])  \("#" * (length | if . > 40 then 40 else . end)) \(length)"' "$VALIDO"

echo
echo "Worktrees que dispararam:"
jq -rs 'group_by(.wt) | sort_by(-length) | .[:8][] | "  \(length)x  \(.[0].wt)"' "$VALIDO"
sobrawt="$(jq -rs '(group_by(.wt) | length) - 8 | if . > 0 then . else 0 end' "$VALIDO")"
[ "${sobrawt:-0}" -gt 0 ] && echo "  … e mais $sobrawt worktree(s) não exibida(s)."

echo
echo "Padrões DISTINTOS — é isto que só VOCÊ pode classificar (VP = bug real / FP = alarme falso):"
# Agrupa por PADRAO, nao por instancia. MEDIDO: 4 disparos do mesmo erro, diferindo so no nome
# do arquivo de log, contavam como 4 "padroes distintos" — e o veredito manda o humano classificar
# um por um. Caminhos e numeros viram placeholder; o exemplo exibido continua sendo REAL.
jq -rs 'def norma: gsub("[^ ]*/[^ ]*"; "<PATH>") | gsub("[0-9]+"; "N");
        group_by([.ramo, (.trecho | norma)]) | sort_by(-length) | .[:15][]
        | "  \(length)x  [\(.[0].ramo)]  \(.[0].trecho)"' "$VALIDO"
# Corte declarado: top-N silencioso se le como "e tudo o que existe" (CLAUDE.md, no silent caps).
sobra="$(jq -rs 'def norma: gsub("[^ ]*/[^ ]*"; "<PATH>") | gsub("[0-9]+"; "N");
                 (group_by([.ramo, (.trecho | norma)]) | length) - 15 | if . > 0 then . else 0 end' "$VALIDO")"
[ "${sobra:-0}" -gt 0 ] && echo "  … e mais $sobra padrão(ões) NÃO exibido(s) — o critério abaixo conta TODOS."

distintos="$(jq -rs 'def norma: gsub("[^ ]*/[^ ]*"; "<PATH>") | gsub("[0-9]+"; "N");
                     group_by([.ramo, (.trecho | norma)]) | length' "$VALIDO")"
dias="$(jq -rs '(map(.ts|fromdateiso8601)|sort) as $t | (($t[-1]-$t[0])/86400) | floor' "$VALIDO")"
ativos="$(jq -rs '[.[].ts[0:10]] | unique | length' "$VALIDO")"

echo
echo "O QUE ESTE SENSOR NÃO MEDE (leia antes de concluir qualquer coisa):"
echo "  - o DENOMINADOR: quantas chamadas Bash passaram pelo guard sem disparar. Registrar isso"
echo "    exigiria gravar em TODA chamada (dezenas por turno, ~30 worktrees) — caro e ruidoso."
echo "    Consequência: 'N disparos' é contagem, nunca taxa. Não diga 'dispara pouco'."
echo "  - a data de INSTALAÇÃO: os dias abaixo vêm do min/max do próprio log, então a janela só"
echo "    começa a contar no PRIMEIRO disparo. Log recente pode significar guard recente, não"
echo "    guard silencioso."
echo "  - as outras máquinas: o log é local. Outro Mac tem outro arquivo."
echo "  - os FALSOS NEGATIVOS: o sensor só vê o que o detector pegou. Construção que ele não"
echo "    reconhece nunca vira linha aqui — 'zero FP nos registros' não fala de recall."
echo "  - o que foi SILENCIADO: PIPESTATUS_INTENCIONAL=1 e qualquer falha de escrita somem sem"
echo "    marcador. Esta contagem é PISO, nunca total."
echo "  - o EFEITO: nada distingue aviso que evitou um erro de aviso simplesmente ignorado."
echo
echo "VEREDITO (critério para endurecer o hook de AVISO para deny):"
marca() { [ "$1" -ge "$2" ] && printf '  [x]' || printf '  [ ]'; }
# `validas`, NUNCA `total`: `total` conta linhas BRUTAS. Medido — 2 eventos reais + 18 linhas de
# outro schema imprimiam "Disparos: 2", "18 ignoradas" e "[x] >= 20 disparos" na mesma tela. O
# sensor que existe para nao fabricar veredito fabricava o proprio.
marca "$ativos" 14;    echo " >= 14 DIAS ATIVOS (com disparo) -> hoje: $ativos  (calendário: ${dias}d entre 1o e último)"
marca "$validas" 20;   echo " >= 20 disparos validos          -> hoje: $validas"
echo "  [?] ZERO falso positivo       -> exige você classificar os $distintos padrão(ões) acima"
echo
if [ "${ativos:-0}" -ge 14 ] && [ "${validas:-0}" -ge 20 ]; then
  echo "  => Volume e janela OK. Se os $distintos padrões acima forem TODOS bug real, endurecer é"
  echo "     defensável. Se QUALQUER um for alarme falso, conserte o detector antes — bloquear com"
  echo "     falso positivo conhecido é trocar veredito fabricado por trabalho travado."
else
  echo "  => Sinal ainda insuficiente para endurecer. Siga avisando e volte aqui depois."
fi
