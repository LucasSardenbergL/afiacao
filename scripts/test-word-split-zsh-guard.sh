#!/usr/bin/env bash
# test-word-split-zsh-guard.sh — prova do hook .claude/hooks/word-split-zsh-guard.sh
#
# O veredito de cada caso e o PREFIXO EXATO do additionalContext (o marcador antes do 1o `:`),
# comparado por igualdade de string — nunca `grep -i`. No #1483 uma assercao passou por acidente
# de ambiente porque `grep -i` sob pt_BR.UTF-8 dobra A-til/a-til e casava o ramo errado. Mesmo
# assim a suite roda nos DOIS locales (C e pt_BR.UTF-8): o que se prova e o hook, nao a regua.
#
# O eixo dos NEGATIVOS e o precedente de 2026-06-24 (um guard do repo bloqueou o commit que
# DOCUMENTAVA o padrao que ele detectava): mencao != execucao. Este hook nasce numa sessao que
# escreve `set -- $st` e `for c in $fatias` em doc, em mensagem de commit e no corpo do PR.
#
# Sao QUATRO ramos, e o 4o (`ZSH-INDICE-ZERO`, 2026-10-08) inverte uma das premissas dos outros:
# nele aspas DUPLAS sao USO, nao mencao — `f="${fila[0]}"` expande e da vazio. Por isso os casos
# I*/J*/K*/M* nao reaproveitam as fixtures dos tres primeiros, e cada fixture do IDX0 precisa de
# `[0]` + uma declaracao de array para ATRAVESSAR o portao barato; nos negativos de precisao o
# `[0]` inerte vem de `${BASH_SOURCE[0]}`, que nao esta em `ARR` e por isso nao decide nada.
# shellcheck disable=SC2016  # ARQUIVO INTEIRO: os comandos de teste sao strings LITERAIS de
# proposito — expandir "$st"/"$(git grep …)" aqui destruiria justamente o que o guard tem de ver.
set -u

RAIZ="$(cd "$(dirname "$0")/.." && pwd)"
HOOK="$RAIZ/.claude/hooks/word-split-zsh-guard.sh"
[ -f "$HOOK" ] || { echo "hook nao encontrado: $HOOK" >&2; exit 1; }
command -v jq >/dev/null || { echo "jq e necessario" >&2; exit 1; }

falhas=0

entrada() { # <comando> [tool_name]
  jq -n -c --arg cmd "$1" --arg tool "${2:-Bash}" '{tool_name:$tool, tool_input:{command:$cmd}}'
}

# Junta os argumentos com quebra de linha: comando multi-linha legivel, sem `$'...'` escondendo \n.
linhas() { local IFS=$'\n'; printf '%s' "$*"; }

# O log do SENSOR vai para um temporario: sem isto cada rodada injeta disparos SINTETICOS no log
# real, e a query de campo passa a medir a suite como se fosse uso.
TMPD="$(mktemp -d "${TMPDIR:-/tmp}/word-split-guard-suite.XXXXXX")"
LOGTESTE="$TMPD/sinal.jsonl"
trap 'rm -rf "$TMPD"' EXIT

# veredito <hook> <json> -> SILENCIO | <MARCADOR> | BLOQUEOU:<decisao> | LIXO:<recorte>
# Um aviso que nao comeca por marcador conhecido e LIXO, e um `permissionDecision` presente e
# BLOQUEIO: este hook avisa e nunca bloqueia, e os dois viram falha de teste.
veredito() {
  local saida dec ctx
  saida="$(printf '%s' "$2" | WORD_SPLIT_GUARD_LOG="$LOGTESTE" bash "$1" 2>/dev/null)"
  if [ -z "$saida" ]; then echo "SILENCIO"; return 0; fi
  dec="$(printf '%s' "$saida" | jq -r '.hookSpecificOutput.permissionDecision // "-"' 2>/dev/null)"
  if [ "$dec" != "-" ]; then echo "BLOQUEOU:$dec"; return 0; fi
  ctx="$(printf '%s' "$saida" | jq -r '.hookSpecificOutput.additionalContext // ""' 2>/dev/null)"
  case "${ctx%%:*}" in
    ZSH-NAO-DIVIDE-SET|ZSH-NAO-DIVIDE-FOR|ZSH-NAO-DIVIDE-ARGS|ZSH-INDICE-ZERO) echo "${ctx%%:*}" ;;
    *) echo "LIXO:$(printf '%s' "$saida" | head -c 120)" ;;
  esac
}

checa() { # <titulo> <esperado> <comando> [tool_name]
  local obtido
  obtido="$(veredito "$HOOK" "$(entrada "$3" "${4:-Bash}")")"
  if [ "$obtido" = "$2" ]; then printf '  ok   %s\n' "$1"; return 0; fi
  printf '  FALHA %s — esperava %s, veio %s\n' "$1" "$2" "$obtido"
  falhas=$((falhas + 1)); return 1
}

SET="ZSH-NAO-DIVIDE-SET"
FOR="ZSH-NAO-DIVIDE-FOR"
ARGS="ZSH-NAO-DIVIDE-ARGS"
IDX0="ZSH-INDICE-ZERO"
NADA="SILENCIO"
JUNTA_TR="tr '\\n' ' '"   # o texto `tr '\n' ' '`, sem a danca de '"'"' em cada fixture nova

rodada() {
  echo "--- locale: ${LC_ALL:-(herdado)} ---"

  # ── SET: `set -- $x` conta com o split para partir UMA LINHA em campos ───────────────────────
  checa "S1 a forma dos lacos de 09-18/09-25" "$SET" \
    'st="completed success"; set -- $st; [ "$1" = completed ] && echo ok'
  checa "S2 o laco de espera de CI inteiro, multi-linha" "$SET" "$(linhas \
    'for i in $(seq 1 30); do' \
    '  st=$(gh run view 36209108326 --json status,conclusion --jq '"'"'"\(.status) \(.conclusion)"'"'"')' \
    '  set -- $st' \
    '  [ "$1" = completed ] && break' \
    '  sleep 60' \
    'done')"
  checa "S3 set SEM -- tambem posiciona" "$SET" 'linha="a b"; set $linha; echo "$2"'
  checa "S4 chaves: set -- \${st}" "$SET" 'set -- ${st}; echo "$1"'
  checa "S5 SET nao exige a atribuicao no comando" "$SET" 'set -- $r; echo "$1"'
  checa "S6 o idioma classico do bash (set -f em volta)" "$SET" 'set -f; set -- $st; set +f'
  checa "S7 dentro de \$( ) e codigo" "$SET" 'x=$(set -- $st; echo "$1")'
  checa "S8 dentro de \"\$( )\" tambem e codigo" "$SET" 'echo "1o: $(set -- $st; echo "$1")"'
  checa "S9 depois de palavra-chave (then)" "$SET" 'if true; then set -- $st; fi'
  checa "S10 setopt NO_sh_word_split nao liga o split" "$SET" 'setopt no_sh_word_split; set -- $st'
  checa "S11 opcoes antes do -- (set -e -- \$x)" "$SET" 'set -e -- $st; echo "$1"'

  # ── FOR: `for v in $x` com x atribuida AQUI como texto ───────────────────────────────────────
  checa "F1 a forma de agosto (fatias do git log)" "$FOR" "$(linhas \
    'fatias=$(git log --format=%h -- supabase/functions/x/index.ts)' \
    'for c in $fatias; do echo "$c"; done')"
  checa "F2 lista literal" "$FOR" 'lista="a b c"; for x in $lista; do echo "$x"; done'
  checa "F3 linha do read" "$FOR" \
    'while IFS= read -r linha; do for w in $linha; do echo "$w"; done; done < arq.txt'
  checa "F4 local v=\$( ) numa funcao" "$FOR" 'f() { local l=$(ls); for x in $l; do echo "$x"; done; }; f'
  checa "F5 chaves: for c in \${fatias}" "$FOR" 'fatias=$(git log --format=%h); for c in ${fatias}; do :; done'
  checa "F6 laco dentro de \"\$( )\" (medido: 1 volta no zsh)" "$FOR" \
    'l=$(ls); n="$(for x in $l; do echo "$x"; done | wc -l)"'
  checa "F7 do/done em linhas proprias" "$FOR" "$(linhas 'l=$(ls)' 'for x in $l' 'do' '  echo "$x"' 'done')"

  # ── ARGS: `cmd $x` com x montada AQUI como LISTA juntada ─────────────────────────────────────
  checa "A1 a forma de 09-25 (tr, heavy, multi-linha)" "$ARGS" "$(linhas \
    't=$(git grep -l -e describe -- '"'"'src/lib/omie/__tests__/pedido-*.test.ts'"'"' | tr '"'"'\n'"'"' '"'"' '"'"')' \
    'heavy bunx vitest run $t')"
  checa "A2 mesma linha" "$ARGS" 't=$(git grep -l x | tr '"'"'\n'"'"' '"'"' '"'"'); bunx vitest run $t'
  checa "A3 atribuicao com aspas: t=\"\$( )\"" "$ARGS" \
    't="$(git grep -l x | tr '"'"'\n'"'"' '"'"' '"'"')"; bun run test -- $t'
  checa "A4 tr com aspas duplas" "$ARGS" 'T=$(ls src | tr "\n" " "); bun run test -- $T'
  checa "A5 paste -s" "$ARGS" 't=$(git diff --name-only | paste -sd'"'"' '"'"' -); bunx eslint $t'
  checa "A6 xargs sem comando junta a lista" "$ARGS" 't=$(git ls-files '"'"'*.sh'"'"' | xargs); shellcheck $t'
  checa "A7 chaves: cmd \${t}" "$ARGS" 't=$(ls | tr '"'"'\n'"'"' '"'"' '"'"'); wc -l ${t}'
  checa "A8 local t=\$( ) numa funcao" "$ARGS" 'f() { local t=$(ls | tr '"'"'\n'"'"' '"'"' '"'"'); wc -l $t; }; f'
  checa "A9 printf nao e echo: a saida muda de forma" "$ARGS" \
    't=$(ls | tr '"'"'\n'"'"' '"'"' '"'"'); printf '"'"'%s\n'"'"' $t'
  # Lista LITERAL com espaco: o valor e CONHECIDO como multi-palavra. Calibrado no corpus (88.225
  # comandos): 11 de 12 disparos com defeito real, 0 falso positivo — provavel forma do #1358.
  checa "A10 lista literal com espaco (a forma provavel de julho)" "$ARGS" \
    'T="src/lib/a.test.ts src/lib/b.test.ts"; bun run test -- $T'
  checa "A11 lista literal em aspas simples" "$ARGS" "ARQS='a.ts b.ts'; git log --oneline -- \$ARQS"
  checa "A12 lista literal, multi-linha, sob heavy" "$ARGS" "$(linhas 'ALVOS="x.test.ts y.test.ts"' \
    'heavy bun run test -- --run $ALVOS')"

  # ── NEGATIVOS: mencao (aspas, heredoc, comentario) e reinterpretacao pelo bash ───────────────
  checa "N1 citada" "$NADA" 'set -- "$st"; echo "$1"'
  checa "N2 mencao em aspas simples (commit do proprio doc)" "$NADA" \
    "git commit -m 'docs: set -- \$st engole a linha; for c in \$fatias roda 1 vez'"
  checa "N3 mencao em aspas duplas" "$NADA" 'echo "nao use set -- $st: use read"'
  checa "N4 mencao em heredoc quoted" "$NADA" "$(linhas "cat > doc.md <<'EOF'" \
    'st="a b"; set -- $st' 'fatias=$(git log); for c in $fatias; do :; done' 'EOF')"
  checa "N5 heredoc NAO-quoted alimentando o bash (roda no bash)" "$NADA" "$(linhas 'bash <<EOF' \
    'st="a b"; set -- \$st; echo \$2' 'EOF')"
  checa "N6 mencao em comentario" "$NADA" 'st="a b"  # set -- $st seria o erro'
  checa "N7 mencao em \$'...'" "$NADA" "printf '%s\n' \$'set -- \$st'"
  checa "N8 bash -c com aspas simples (roda no bash)" "$NADA" \
    "bash -c 'st=\"a b\"; set -- \$st; echo \"\$2\"'"
  checa "N9 bash -c com aspas duplas (roda no bash)" "$NADA" \
    'bash -c "st='"'"'a b'"'"'; set -- \$st; echo \$2"'
  checa "N10 heredoc quoted dentro de \"\$( )\" (commit com corpo)" "$NADA" "$(linhas \
    'git commit -m "$(cat <<'"'"'EOF'"'"'' 'docs: set -- $st e for c in $fatias' 'EOF' ')"')"

  # ── NEGATIVOS: formas CERTAS no zsh ──────────────────────────────────────────────────────────
  checa "N11 split explicito \${=st}" "$NADA" 'set -- ${=st}; echo "$2"'
  checa "N12 split explicito \$=st" "$NADA" 'set -- $=st; echo "$2"'
  checa "N13 flag de split \${(s: :)st}" "$NADA" 'set -- ${(s: :)st}'
  checa "N14 \$@ e \"\${arr[@]}\"" "$NADA" 'set -- $@; set -- "${arr[@]}"'
  checa "N15 substituicao DIRETA (o zsh divide \$( ))" "$NADA" 'set -- $(printf "a b"); echo "$2"'
  checa "N16 array especial do zsh (\$path)" "$NADA" 'set -- $path'
  checa "N17 array declarado no comando" "$NADA" 'arr=(a b); set -- $arr'
  checa "N18 set -A declara array" "$NADA" 'set -A arr a b; set -- $arr'
  checa "N19 typeset -a" "$NADA" 'typeset -a l; l=(x y); for x in $l; do :; done'
  checa "N20 for sobre \$( ) direto" "$NADA" 'for c in $(git log --format=%h); do echo "$c"; done'
  checa "N21 glob colado (\$DIR/*.ts e legitimo no zsh)" "$NADA" 'DIR=src; for f in $DIR/*.ts; do :; done'
  checa "N22 enumeracao de valores (for f in \$A \$B)" "$NADA" 'A=x; B=y; for f in $A $B; do :; done'
  checa "N23 for sobre \"\${arr[@]}\"" "$NADA" 'arr=(a b); for x in "${arr[@]}"; do :; done'
  checa "N24 FOR sem atribuicao no comando (estado nao persiste: vazio nos dois)" "$NADA" \
    'for c in $fatias; do :; done'
  checa "N25 o idioma de LINHA que o aviso recomenda" "$NADA" 'read -r a b <<< "$st"; echo "$a"'
  checa "N26 herestring nao inverte a paridade das aspas" "$NADA" \
    "read -r a b <<< \"\$st\"; echo 'set -- \$x'"
  checa "N27 o idioma de LISTA que o aviso recomenda" "$NADA" "$(linhas \
    'arr=(); while IFS= read -r l; do arr+=("$l"); done < <(git grep -l x)' \
    'bunx vitest run "${arr[@]}"')"
  checa "N28 iterar por linha de uma variavel" "$NADA" 'while IFS= read -r c; do echo "$c"; done <<< "$fatias"'
  checa "N29 valor UNICO de \$( ) (sem sinal de lista)" "$NADA" 'sha=$(git rev-parse HEAD); git show $sha'
  checa "N30 echo junta de qualquer jeito" "$NADA" 't=$(ls | tr '"'"'\n'"'"' '"'"' '"'"'); echo $t'
  checa "N31 citada: UM argumento nos dois shells, por escolha" "$NADA" \
    't=$(ls | tr '"'"'\n'"'"' '"'"' '"'"'); bunx vitest run "$t"'
  checa "N32 [ ] [[ ]] e case nao sao alvo" "$NADA" \
    't=$(ls | tr '"'"'\n'"'"' '"'"' '"'"'); [ -n $t ] && [[ -n $t ]]; case $t in *a*) :;; esac'
  checa "N33 uso ANTES da atribuicao" "$NADA" 'bunx vitest run $t; t=$(ls | tr '"'"'\n'"'"' '"'"' '"'"')'
  checa "N34 split explicito no uso" "$NADA" 't=$(ls | tr '"'"'\n'"'"' '"'"' '"'"'); bunx vitest run ${=t}'
  checa "N35 atribuicao nao e argumento" "$NADA" 't=$(ls | tr '"'"'\n'"'"' '"'"' '"'"'); u=$t; export V=$t'
  checa "N36 aritmetica" "$NADA" 'n=$(ls | wc -l | tr -d " "); echo $(( n + 1 )); (( n > 1 << 2 ))'
  checa "N37 tr que junta com VIRGULA nao divide nem no bash" "$NADA" \
    't=$(ls | tr '"'"'\n'"'"' ,); cmd $t'
  checa "N38 paste com delimitador virgula idem" "$NADA" 't=$(ls | paste -sd, -); cmd $t'
  checa "N39 xargs com comando nao junta" "$NADA" 't=$(ls | xargs -n1 basename); cmd $t'
  checa "N40 reatribuicao a valor unico vence a lista" "$NADA" \
    't=$(ls | tr '"'"'\n'"'"' '"'"' '"'"'); t=$(ls | head -1); cmd $t'
  checa "N41 SET com DUAS palavras enumera (set -- \$a \$b)" "$NADA" 'set -- $a $b'
  checa "N42 set -o leva argumento (set -o \$opt)" "$NADA" 'set -o $opt'
  checa "N43 subscript nao e escalar (\${st[@]})" "$NADA" 'set -- ${st[@]}'
  checa "N44 typeset -a sozinho declara array" "$NADA" 'typeset -a l; set -- $l'
  checa "N45 separador DENTRO de aspas duplas e mencao" "$NADA" \
    'echo "o erro: st=x; set -- $st; o conserto: read"'
  checa "N46 separador DENTRO de aspas simples e mencao" "$NADA" \
    "git commit -m 'docs: st=x; set -- \$st; use read'"
  checa "N47 separador DENTRO de comentario e mencao" "$NADA" 'true  # st=x; set -- $st; nao faca'
  checa "N48 \$'...' com aspa escapada segue mencao" "$NADA" "printf '%s\n' \$'nao\\'; set -- \$st; x\\''"
  checa "N49 tr -d apaga, nao junta (mesmo com 2 operandos: -ds)" "$NADA" "t=\$(ls | tr -ds '\\n' ' '); cmd \$t"
  checa "N50 xargs -n1 SEM comando e um por linha, nao junta" "$NADA" 't=$(ls | xargs -n1); cmd $t'
  checa "N51 FOR: re-declarada como array depois do texto" "$NADA" 'l=$(ls); l=(x y); for x in $l; do :; done'
  checa "N52 ARGS: re-declarada como array depois da lista" "$NADA" "t=\$(ls | $JUNTA_TR); t=(a b); cmd \$t"
  checa "N53 literal SEM espaco e uma palavra so (M atravessa o portao)" "$NADA" 'T="src/lib/a.test.ts"; M="nota qualquer"; bun run test -- $T'
  checa "N54 literal com espaco no echo" "$NADA" 'msg="texto com espaco"; echo $msg'
  checa "N55 literal com espaco, citada" "$NADA" 'T="a.ts b.ts"; bun run test -- "$T"'
  checa "N56 composta (literal + expansao) nao foi medida: calada" "$NADA" 'x="dir $HOME"; M="a b"; cmd $x'
  checa "N57 reatribuida a literal de uma palavra" "$NADA" 'x="a b"; x=c; cmd $x'

  # ── ARITMETICA nao abre heredoc: `<<` ali e deslocamento. Se abrisse, as linhas seguintes
  # sumiriam como "corpo" — falso NEGATIVO no que vem depois. ────────────────────────────────
  checa "H1 (( x = y << z )) e a linha seguinte ainda e vista" "$SET" \
    "$(linhas '(( x = y << z ))' 'set -- $st')"
  checa "H2 \$(( y << z )) idem" "$SET" "$(linhas 'n=$(( y << z ))' 'set -- $st')"
  checa "H3 dois heredocs na mesma linha: os DOIS corpos sao dado" "$FOR" "$(linhas \
    "cat <<'A' > um.txt; cat <<'B' > dois.txt" 'texto de A' 'A' 'set -- $st' 'B' \
    'l=$(ls); for x in $l; do :; done')"

  # ── IDX0: array do zsh e 1-indexed, `${arr[0]}` e sempre vazio ───────────────────────────────
  # TODA fixture daqui precisa de `[0]` E de uma declaracao de array no texto para atravessar o
  # portao barato; nos negativos de precisao, o `[0]` inerte vem de `${BASH_SOURCE[0]}` — que nao
  # esta em ARR e por isso nao decide nada.
  checa "I1 o BFS de 2026-09-05/06, que imprimiu closure_count=0" "$IDX0" \
    'fila=("$ENTRY"); while [ ${#fila[@]} -gt 0 ]; do f="${fila[0]}"; fila=("${fila[@]:1}"); done'
  checa "I2 queue=( ) + \${queue[0]}" "$IDX0" 'queue=("$edge/index.ts"); f="${queue[0]}"'
  checa "I3 declare -a" "$IDX0" 'declare -a fila=("$e"); cur="${fila[0]}"'
  checa "I4 typeset -a" "$IDX0" 'typeset -a l; l=(a b); echo "${l[0]}"'
  checa "I5 local -a" "$IDX0" 'local -a l=(a b); echo "${l[0]}"'
  checa "I6 read -A" "$IDX0" 'read -A arr <<< "a b"; echo "${arr[0]}"'
  checa "I7 set -A" "$IDX0" 'set -A arr a b; echo "${arr[0]}"'
  checa "I8 arr+=( ) tambem declara" "$IDX0" 'arr=(); arr+=(x); echo "${arr[0]}"'
  checa "I9 atribuicao PURA, sem palavra de comando" "$IDX0" 'arr=(a b); f="${arr[0]}"'
  checa "I10 espaco dentro do subscript" "$IDX0" 'arr=(a b); echo "${arr[ 0 ]}"'
  checa "I11 dentro de \$( ), que e codigo" "$IDX0" 'arr=(a b); echo "x$(printf %s "${arr[0]}")"'
  checa "I12 SH_WORD_SPLIT NAO cala o IDX0 (as opcoes sao ortogonais)" "$IDX0" \
    'setopt SH_WORD_SPLIT; arr=(a b); echo "${arr[0]}"'

  # precisao do IDX0: cada um cala por um motivo diferente
  checa "J1 \${BASH_SOURCE[0]} e array do BASH, nao declarado aqui" "$NADA" \
    'arr=(a b); echo "${BASH_SOURCE[0]}"'
  checa "J2 indice 1 e o certo no zsh" "$NADA" 'arr=(a b); s="${BASH_SOURCE[0]}"; echo "${arr[1]}"'
  checa "J3 range [0,2] e LEGITIMO (da \"a b\", medido)" "$NADA" \
    'arr=(a b c); s="${BASH_SOURCE[0]}"; echo "${arr[0,2]}"'
  checa "J4 escalar: vazio tambem, mas o idioma e outro" "$NADA" 'arr=(a b); s=abc; echo "${s[0]}"'
  checa "J5 variavel do AMBIENTE, nao declarada aqui" "$NADA" 'arr=(a b); echo "${MEU_ARR[0]}"'
  checa "J6 \${arr[0]:-pad} entrega o default, nao o vazio" "$NADA" 'arr=(a b); echo "${arr[0]:-pad}"'
  checa "J7 \${#arr[@]} e o idioma certo de contar" "$NADA" 'arr=(a b); s="${BASH_SOURCE[0]}"; echo "${#arr[@]}"'
  checa "J8 slice \${arr[@]:1} tem offset base 0 de proposito" "$NADA" \
    'arr=(a b); s="${BASH_SOURCE[0]}"; echo "${arr[@]:1}"'
  checa "J9 bash -c com aspas simples roda no BASH" "$NADA" "bash -c 'arr=(a b); echo \${arr[0]}'"
  checa "J10 corpo de heredoc quoted e dado" "$NADA" \
    "$(linhas "cat > b.sh <<'EOF'" 'arr=(a b); echo "${arr[0]}"' 'EOF')"
  checa "J11 corpo de heredoc nao-quoted tambem" "$NADA" \
    "$(linhas 'cat > b.sh <<EOF' 'arr=(a b); echo "${arr[0]}"' 'EOF')"
  checa "J12 comentario" "$NADA" 'arr=(a b)  # nao use ${arr[0]}, e vazio'
  checa "J13 commit que DOCUMENTA o padrao (precedente 2026-06-24)" "$NADA" \
    'git commit -m "docs: arr=(a b) e ${arr[0]} e vazio no zsh"'
  # A forma que DOMINA o corpus: 6 das 16 chamadas que declaram array e leem `[0]` sao um script
  # BASH escrito em arquivo. O `[0]` ali esta certo, e foi exatamente aqui que o julgamento manual
  # por janela de `grep` errou — ela nao mostrava o `cat > x.sh <<` seis linhas acima.
  checa "J14 heredoc que escreve um script com shebang bash (6 das 16 do corpus)" "$NADA" \
    "$(linhas "cat > /tmp/closure.sh <<'EOF'" '#!/bin/bash' 'set -uo pipefail' \
       'fila=("$ENTRY")' 'while [ ${#fila[@]} -gt 0 ]; do' '  atual="${fila[0]}"' \
       '  fila=("${fila[@]:1}")' 'done' 'EOF')"

  # silenciadores PROPRIOS do IDX0 (os do word splitting nao servem, e vice-versa)
  checa "K1 setopt KSH_ZERO_SUBSCRIPT" "$NADA" 'setopt KSH_ZERO_SUBSCRIPT; arr=(a b); echo "${arr[0]}"'
  checa "K2 setopt KSH_ARRAYS" "$NADA" 'setopt KSH_ARRAYS; arr=(a b); echo "${arr[0]}"'
  checa "K3 setopt ksh_arrays (caixa e _ livres)" "$NADA" 'setopt ksh_arrays; arr=(a b); echo "${arr[0]}"'
  checa "K4 set -o kshzerosubscript" "$NADA" 'set -o kshzerosubscript; arr=(a b); echo "${arr[0]}"'
  checa "K5 emulate -L ksh liga as duas" "$NADA" 'emulate -L ksh; arr=(a b); echo "${arr[0]}"'
  checa "K6 WORD_SPLIT_INTENCIONAL=1 serve para os quatro ramos" "$NADA" \
    'WORD_SPLIT_INTENCIONAL=1 arr=(a b); echo "${arr[0]}"'

  # limites do IDX0, cada um MEDIDO no corpus antes de ficar de fora
  checa "M1 \$arr[0] sem chaves (FN: 14 linhas no corpus, 0 com array — era perl \$F[0] e jq \$t[0])" \
    "$NADA" 'arr=(a b); echo "$arr[0]"'
  checa "M2 aritmetica sem cifrao: (( arr[0] )) (FN)" "$NADA" 'arr=(a b); (( arr[0] == 0 )) && echo z'
  checa "M3 \${#arr[0]} e comprimento de elemento ausente (FN)" "$NADA" 'arr=(a b); echo "${#arr[0]}"'
  checa "M4 flag de parametro: \${(e)arr[0]} (FN)" "$NADA" 'arr=(a b); echo "${(e)arr[0]}"'
  checa "M5 palavra DENTRO de array literal (FN)" "$NADA" 'arr=(a b); nova=("${arr[0]}")'

  # ── SILENCIADORES ─────────────────────────────────────────────────────────────────────────────
  checa "Z1 WORD_SPLIT_INTENCIONAL=1 no inicio" "$NADA" 'WORD_SPLIT_INTENCIONAL=1 set -- $st'
  checa "Z2 setopt SH_WORD_SPLIT liga o split" "$NADA" 'setopt SH_WORD_SPLIT; st="a b"; set -- $st'
  checa "Z3 setopt sh_word_split (caixa e _ livres)" "$NADA" 'setopt sh_word_split; set -- $st'
  checa "Z4 set -o shwordsplit" "$NADA" 'set -o shwordsplit; set -- $st'
  checa "Z5 emulate -L sh" "$NADA" 'emulate -L sh; set -- $st'
  checa "Z6 tool_name != Bash" "$NADA" 'set -- $st' 'Read'
  checa "Z7 silenciador so vale no INICIO" "$SET" 'echo WORD_SPLIT_INTENCIONAL=1; set -- $st'

  # ── LIMITES ASSUMIDOS, travados por teste: se um dia forem cobertos, ficam VERMELHOS e a
  # decisao volta a mesa. Reinterpretacao posterior roda num zsh que este hook nao enxerga. ────
  checa "L1 eval com aspas simples (FN)" "$NADA" "eval 'set -- \$st'"
  checa "L2 zsh -c (FN)" "$NADA" "zsh -c 'set -- \$st'"
  checa "L3 forma curta do zsh: for x (\$l) (FN)" "$NADA" 'l=$(ls); for x ($l) print $x'
  checa "L4 variavel como NOME de comando (FN: falha ALTO, 127)" "$NADA" 'c="git status"; $c'

  # ── ROBUSTEZ ─────────────────────────────────────────────────────────────────────────────────
  local saida
  saida="$(printf '%s' 'isto nao e json' | WORD_SPLIT_GUARD_LOG="$LOGTESTE" bash "$HOOK" 2>/dev/null)"
  if [ -z "$saida" ]; then printf '  ok   R1 entrada invalida -> silencio\n'
  else printf '  FALHA R1 entrada invalida falou: %s\n' "$(printf '%s' "$saida" | head -c 120)"
    falhas=$((falhas + 1)); fi

  local ev
  ev="$(printf '%s' "$(entrada 'set -- $st')" | WORD_SPLIT_GUARD_LOG="$LOGTESTE" bash "$HOOK" 2>/dev/null \
        | jq -r '.hookSpecificOutput.hookEventName' 2>/dev/null)"
  if [ "$ev" = "PreToolUse" ]; then printf '  ok   R2 hookEventName=PreToolUse\n'
  else printf '  FALHA R2 hookEventName veio "%s"\n' "$ev"; falhas=$((falhas + 1)); fi

  # O sensor de campo tem de GRAVAR: sem linha no log, "quantas vezes disparou" fica sem resposta
  # por construcao (docs/historico/fase-sem-sinal.md).
  local antes depois
  antes="$(command grep -c '' "$LOGTESTE" 2>/dev/null || echo 0)"
  veredito "$HOOK" "$(entrada 'fatias=$(git log); for c in $fatias; do :; done')" >/dev/null
  depois="$(command grep -c '' "$LOGTESTE" 2>/dev/null || echo 0)"
  if [ "$depois" -gt "$antes" ] && tail -n 1 "$LOGTESTE" | command grep -q '"ramo":"ZSH-NAO-DIVIDE-FOR"'; then
    printf '  ok   R3 sensor de campo gravou a linha do ramo certo\n'
  else printf '  FALHA R3 sensor nao gravou (antes=%s depois=%s)\n' "$antes" "$depois"
    falhas=$((falhas + 1)); fi

  # Sem HOME o log nao tem para onde ir — e o aviso NAO pode morrer junto (fail-open do sensor).
  local semhome
  semhome="$(printf '%s' "$(entrada 'set -- $st')" | env -u HOME -u WORD_SPLIT_GUARD_LOG bash "$HOOK" 2>/dev/null \
        | jq -r '.hookSpecificOutput.additionalContext // ""' 2>/dev/null)"
  if [ "${semhome%%:*}" = "$SET" ]; then printf '  ok   R4 sem HOME o aviso sai do mesmo jeito\n'
  else printf '  FALHA R4 sem HOME veio: %s\n' "$(printf '%s' "$semhome" | head -c 80)"; falhas=$((falhas + 1)); fi

  # A contramedida certa POR FORMA: LINHA -> read; LISTA -> array. Texto literal, `grep -F`, sem -i.
  local ctx
  ctx="$(printf '%s' "$(entrada 'set -- $st')" | WORD_SPLIT_GUARD_LOG="$LOGTESTE" bash "$HOOK" 2>/dev/null \
        | jq -r '.hookSpecificOutput.additionalContext // ""' 2>/dev/null)"
  if printf '%s' "$ctx" | command grep -qF 'read -r' && printf '%s' "$ctx" | command grep -qF '<<< "$'; then
    printf '  ok   R5 SET ensina read -r ... <<< "$var"\n'
  else printf '  FALHA R5 SET sem a contramedida de LINHA\n'; falhas=$((falhas + 1)); fi
  local forma
  for forma in 'l=$(ls); for x in $l; do :; done' 't=$(ls | tr "\n" " "); cmd $t'; do
    ctx="$(printf '%s' "$(entrada "$forma")" | WORD_SPLIT_GUARD_LOG="$LOGTESTE" bash "$HOOK" 2>/dev/null \
          | jq -r '.hookSpecificOutput.additionalContext // ""' 2>/dev/null)"
    if printf '%s' "$ctx" | command grep -qF 'arr+=("$l")' && printf '%s' "$ctx" | command grep -qF '"${arr[@]}"'; then
      printf '  ok   R6 %s ensina o array\n' "${ctx%%:*}"
    else printf '  FALHA R6 sem a contramedida de LISTA em: %s\n' "$forma"; falhas=$((falhas + 1)); fi
  done
  # IDX0 tem contramedida PROPRIA: o indice 1, nao o `read` nem o array. Se um dia alguem colar a
  # mensagem de LISTA aqui, isto fica vermelho.
  ctx="$(printf '%s' "$(entrada 'arr=(a b); echo "${arr[0]}"')" \
        | WORD_SPLIT_GUARD_LOG="$LOGTESTE" bash "$HOOK" 2>/dev/null \
        | jq -r '.hookSpecificOutput.additionalContext // ""' 2>/dev/null)"
  if printf '%s' "$ctx" | command grep -qF '"${arr[1]}"' \
     && printf '%s' "$ctx" | command grep -qF 'KSH_ZERO_SUBSCRIPT'; then
    printf '  ok   R7 IDX0 ensina o indice 1 e nomeia o silenciador\n'
  else printf '  FALHA R7 IDX0 sem a contramedida de INDICE\n'; falhas=$((falhas + 1)); fi
}

echo "== word-split-zsh-guard =="
LOCALES=(C)
if locale -a 2>/dev/null | command grep -qi '^pt_BR.UTF-8$'; then LOCALES+=(pt_BR.UTF-8)
else echo "--- locale pt_BR.UTF-8 indisponivel: pulado (rodadas E falsificacao) ---"; fi
# `export` explicito, e nao `LC_ALL=x rodada`: a regua (grep/jq/case do arnes) E o hook filho rodam
# sob o locale da rodada, sem depender de como o bash exporta atribuicao-prefixo de FUNCAO.
for loc in "${LOCALES[@]}"; do export LC_ALL="$loc"; rodada; done
unset LC_ALL

# ── FALSIFICACAO ────────────────────────────────────────────────────────────────────────────────
# Cada regra e sabotada SOZINHA, numa COPIA do hook — o arquivo real nunca e escrito, entao nao ha
# restauracao para dar errado nem sabotagem passando pelo indice do git
# (docs/historico/falsificacao-sem-linha-de-base.md). Tres fases na MESMA invocacao:
#   A. CONTROLE: a mesma rotina com a sabotagem NULA (copia identica), a mesma fixture, nos dois
#      locales — cada fixture tem de dar o veredito ANTES. Qualquer falha ABORTA antes da 1a
#      sabotagem: fixture sempre-vermelha aprovaria qualquer coisa.
#   B. SABOTAGEM: o trecho-alvo tem de casar EXATAMENTE uma vez (ambiguo reprova), a copia tem de
#      DIFERIR (sabotagem que nao sabota e teatro), e a fixture tem de virar o veredito DEPOIS — o
#      marcador CERTO, nao "qualquer saida". Como o controle provou o ANTES com todas as outras
#      regras de pe, o flip prova que ESTA regra e a unica que decide a fixture.
#   C. SAIDA: o hook real byte-identico a foto do inicio, e o numero de execucoes igual a
#      regras x locales x 2 — falsificacao rapida demais nao rodou o que diz rodar.
# O trecho vai pelo AMBIENTE (\Q$ENV{DE}\E): `$(`, `$ENV`, `@` no codigo do hook nao interpolam.
FT=(); FDE=(); FPARA=(); FANTES=(); FDEPOIS=(); FFIX=()
regra() { FT+=("$1"); FDE+=("$2"); FPARA+=("$3"); FANTES+=("$4"); FDEPOIS+=("$5"); FFIX+=("$6"); }

# Precisao: a fixture fica CALADA por causa da regra; sabotada, dispara o marcador da forma.
regra "SB1 aspas duplas sao mencao" \
  'if (c == "\"") { wshape(o, "Q"); wraw(o, c); push("D"); i++; continue }' \
  'if (0) { wshape(o, "Q"); wraw(o, c); push("D"); i++; continue }' \
  "$NADA" "$SET" 'echo "o erro: st=x; set -- $st; o conserto: read"'
regra "SB2 aspas simples sao mencao" \
  'if (c == SQ) { wshape(o, "S"); wraw(o, c); push("S"); i++; continue }' \
  'if (0) { wshape(o, "S"); wraw(o, c); push("S"); i++; continue }' \
  "$NADA" "$SET" "git commit -m 'docs: st=x; set -- \$st; use read'"
regra "SB3 \$'...' e mencao, com aspa escapada" \
  'if (nx == SQ) { wshape(o, "S"); wraw(o, "$" SQ); push("Q"); return i + 2 }' \
  'if (0) { wshape(o, "S"); wraw(o, "$" SQ); push("Q"); return i + 2 }' \
  "$NADA" "$SET" "printf '%s\n' \$'nao\\'; set -- \$st; x\\''"
regra "SB4 corpo de heredoc e dado" 'if (inhd) {' 'if (0) {' \
  "$NADA" "$SET" "$(linhas "cat > doc.md <<'EOF'" 'st="a b"; set -- $st' 'EOF')"
regra "SB5 comentario" 'if (c == "#" && t == "C" && !WACT[D]) {' 'if (0) {' \
  "$NADA" "$SET" 'true  # st=x; set -- $st; nao faca'
regra "SB6 x=( ) declara array" \
  'if (forca_arr || substr(S_[c, a], 3, 1) == "R") {' 'if (forca_arr) {' \
  "$NADA" "$SET" 'arr=(a b); set -- $arr'
regra "SB7 typeset -a declara array" 'else if (arr && S_[c, a] == "L") ARR[w] = 1' 'else if (0) ARR[w] = 1' \
  "$NADA" "$SET" 'typeset -a l; set -- $l'
regra "SB8 SET cala em array declarado" \
  'if (nome != "" && !(nome in ARR) && !(nome in ESPECIAL)) viola(' \
  'if (nome != "" && !(nome in ESPECIAL)) viola(' \
  "$NADA" "$SET" 'arr=(a b); set -- $arr'
regra "SB9 SET cala em array especial do zsh" \
  'if (nome != "" && !(nome in ARR) && !(nome in ESPECIAL)) viola(' \
  'if (nome != "" && !(nome in ARR)) viola(' \
  "$NADA" "$SET" 'set -- $path'
regra "SB10 SET exige UMA palavra" 'if (a != CN[c]) return' 'if (a > CN[c]) return' \
  "$NADA" "$SET" 'set -- $a $b'
regra "SB11 set -o leva argumento" 'if (w ~ /o$/) a++' 'if (0) a++' \
  "$NADA" "$SET" 'set -o $opt'
regra "SB12 subscript nao e escalar" \
  'ct ~ /^[A-Za-z_][A-Za-z0-9_]*[:#%\/^,~?=+-]/' 'ct ~ /^[A-Za-z_][A-Za-z0-9_]*[:#%\/^,~?=+[-]/' \
  "$NADA" "$SET" 'set -- ${st[@]}'
regra "SB13 FOR exige a atribuicao no comando" 'if (ultima(nome, P_[c, CN[c]]) == 0) return' 'if (0) return' \
  "$NADA" "$FOR" 'for c in $fatias; do :; done'
regra "SB14 FOR exige UMA palavra" 'if (a + 1 != CN[c]) return' 'if (a + 1 > CN[c]) return' \
  "$NADA" "$FOR" 'A=x; B=y; for f in $A $B; do :; done'
regra "SB15 FOR cala em array declarado" \
  'if (nome == "" || (nome in ARR) || (nome in ESPECIAL)) return' 'if (nome == "" || (nome in ESPECIAL)) return' \
  "$NADA" "$FOR" 'l=$(ls); l=(x y); for x in $l; do :; done'
regra "SB16 ARGS exige a JUNCAO da lista" 'if ((AID[j] > 0 && JUNTA[AID[j]]) || ALIT[j])' 'if ((AID[j] > 0) || ALIT[j])' \
  "$NADA" "$ARGS" 'sha=$(git rev-parse HEAD); git show $sha'
regra "SB17 ARGS exige a atribuicao ANTES do uso" 'if (AN[j] == nome && AP[j] < p && AP[j] > mp)' 'if (AN[j] == nome && AP[j] > mp)' \
  "$NADA" "$ARGS" "bunx vitest run \$t; t=\$(ls | $JUNTA_TR)"
regra "SB18 ARGS ignora echo/[/case" 'else if (!(cmd in NAOALVO)) regra_args(c, k)' 'else regra_args(c, k)' \
  "$NADA" "$ARGS" "t=\$(ls | $JUNTA_TR); echo \$t"
regra "SB19 ARGS cala em array declarado" 'if (nome == "" || (nome in ARR)) continue' 'if (nome == "") continue' \
  "$NADA" "$ARGS" "t=\$(ls | $JUNTA_TR); t=(a b); cmd \$t"
regra "SB20 tr so junta com espaco/tab" 'OP[2] ~ /^([ \t]|\\t|\\040)+$/' 'OP[2] != ""' \
  "$NADA" "$ARGS" "t=\$(ls | tr '\\n' ,); cmd \$t"
regra "SB21 tr -d apaga, nao junta" '{ if (w ~ /d/) return 0; continue }' '{ continue }' \
  "$NADA" "$ARGS" "t=\$(ls | tr -ds '\\n' ' '); cmd \$t"
regra "SB22 xargs -n nao junta" 'if (w ~ /^-[A-Za-z0-9]*[nLIiJl]/) return 0; ' '' \
  "$NADA" "$ARGS" 't=$(ls | xargs -n1); cmd $t'
regra "SB23 paste so junta com espaco/tab" 'return (temS && delim ~ /^([ \t]|\\t)+$/)' 'return (temS)' \
  "$NADA" "$ARGS" 't=$(ls | paste -sd, -); cmd $t'
regra "SB24 setopt SH_WORD_SPLIT cala" 'if (!SPLIT) for (c = 1; c <= NC; c++) {' 'if (1) for (c = 1; c <= NC; c++) {' \
  "$NADA" "$SET" 'setopt SH_WORD_SPLIT; st="a b"; set -- $st'
regra "SB25 silenciador WORD_SPLIT_INTENCIONAL" '[[ "$cmd" =~ $re_silencio ]] && exit 0' 'false && exit 0' \
  "$NADA" "$SET" 'WORD_SPLIT_INTENCIONAL=1 set -- $st'

# Deteccao: a fixture DISPARA por causa da regra; sabotada, cala (ou muda de forma).
regra "SB26 -- encerra as opcoes do set" 'if (w == "--" || w == "-") { a++; break }' 'if (0) { a++; break }' \
  "$SET" "$NADA" 'set -- $r; echo "$1"'
regra "SB27 palavra-chave antes do comando (then)" \
  'while (k <= CN[c] && S_[c, k] == "L" && (V_[c, k] in CHAVE)) k++' 'while (0) k++' \
  "$SET" "$NADA" 'if true; then set -- $st; fi'
regra "SB28 \$( ) e codigo mesmo entre aspas duplas" \
  'wraw(o, "$("); abre_sub(0); return i + 2' 'wlit(o, "$"); return i + 1' \
  "$SET" "$NADA" 'echo "1o: $(set -- $st; echo "$1")"'
regra "SB29 (( )) e aritmetica, nao heredoc" 'if (!WACT[D] && substr(linha, i + 1, 1) == "(") {' 'if (0) {' \
  "$SET" "$NADA" "$(linhas '(( x = y << z ))' 'set -- $st')"
regra "SB30 \$(( )) e aritmetica, nao heredoc" 'if (substr(linha, i + 2, 1) == "(") {' 'if (0) {' \
  "$SET" "$NADA" "$(linhas 'n=$(( y << z ))' 'set -- $st')"
regra "SB31 a fila anda para o 2o heredoc da linha" \
  'if (t == HQDEL[HQI]) { HQI++; if (HQI > HQN) { inhd = 0; HQN = 0; HQI = 0 } }' \
  'if (t == HQDEL[HQI]) { inhd = 0; HQN = 0; HQI = 0 }' \
  "$FOR" "$SET" "$(linhas "cat <<'A' > um.txt; cat <<'B' > dois.txt" 'texto de A' 'A' 'set -- $st' 'B' \
    'l=$(ls); for x in $l; do :; done')"
regra "SB32 tr junta" 'if (cmd == "tr") {' 'if (0) {' \
  "$ARGS" "$NADA" "t=\$(git grep -l x | $JUNTA_TR); bunx vitest run \$t"
regra "SB33 paste -s junta" 'if (cmd == "paste") {' 'if (0) {' \
  "$ARGS" "$NADA" "t=\$(git diff --name-only | paste -sd' ' -); bunx eslint \$t"
regra "SB34 xargs sem comando junta" 'if (cmd == "xargs") {' 'if (0) {' \
  "$ARGS" "$NADA" "t=\$(git ls-files '*.sh' | xargs); shellcheck \$t"
regra "SB35 read atribui" 'else { NA++; AN[NA] = w; AP[NA] = P_[c, a]; AID[NA] = 0 }' 'else { }' \
  "$FOR" "$NADA" 'while IFS= read -r linha; do for w in $linha; do echo "$w"; done; done < arq.txt'
regra "SB36 local/typeset atribui" 'if (S_[c, a] ~ /^L=/) atrib(c, a, arr)' 'if (0) atrib(c, a, arr)' \
  "$FOR" "$NADA" 'f() { local l=$(ls); for x in $l; do echo "$x"; done; }; f'

# Lista LITERAL (ARGS). As fixtures de precisao carregam um `M="a b"` inerte para ATRAVESSAR o
# portao barato: sem ele, quem as cala e o portao (que so deixa passar literal COM espaco), e a
# sabotagem da regra de dentro nao mudaria nada — verde por motivo alheio.
regra "SB37 lista literal exige espaco (precisao)" '=") + 1) ~ /[ \t\n]/)' '=") + 1) ~ /./)' \
  "$NADA" "$ARGS" 'T="src/lib/a.test.ts"; M="nota qualquer"; bun run test -- $T'
regra "SB38 lista literal dispara (deteccao)" '|| ALIT[j])' ')' \
  "$ARGS" "$NADA" 'T="src/lib/a.test.ts src/lib/b.test.ts"; bun run test -- $T'
regra "SB39 lista literal tem de ser PURA (precisao)" 'ALIT[NA] = (substr(S_[c, a], 3) !~ /[PXCAR]/ && ' 'ALIT[NA] = (' \
  "$NADA" "$ARGS" 'x="dir $HOME"; M="a b"; cmd $x'
regra "SB40 o portao deixa a lista literal passar (deteccao)" \
  '*) [[ "$entrada" =~ $re_lit_d || "$entrada" =~ $re_lit_s ]] || porta_idx0 || exit 0 ;;' '*) exit 0 ;;' \
  "$ARGS" "$NADA" 'T="src/lib/a.test.ts src/lib/b.test.ts"; bun run test -- $T'

# ── IDX0: `${arr[0]}` com array declarado no proprio comando ──────────────────────────────────
# Cada fixture atravessa o PORTAO BARATO pelo gatilho do PROPRIO ramo (`[0]` + declaracao) — sem
# `set `/`for `/`=$(`/literal-com-espaco —, entao o verde nao pode vir do caminho dos vizinhos.
# Precisao: cala por causa da regra; sabotada, dispara.
regra "SB41 IDX0 exige array DECLARADO aqui" 'if (nm in ARR) { viola("ZSH-INDICE-ZERO", c, P_[c, k]); return }' \
  'if (1) { viola("ZSH-INDICE-ZERO", c, P_[c, k]); return }' \
  "$NADA" "$IDX0" 'arr=(a b); echo "${BASH_SOURCE[0]}"'
# O `[0]` do BASH_SOURCE existe para a fixture ATRAVESSAR o portao (`[0,2]` sozinho nao casa
# `re_idx0_sub`) e e inerte na regra: BASH_SOURCE nao esta em ARR. Quem decide e o `0` EXATO.
regra "SB42 IDX0 exige o subscript 0 EXATO (range e legitimo)" \
  'ct ~ /^[A-Za-z_][A-Za-z0-9_]*\[[[:space:]]*0[[:space:]]*\]$/' 'ct ~ /^[A-Za-z_][A-Za-z0-9_]*\[/' \
  "$NADA" "$IDX0" 'arr=(a b c); s="${BASH_SOURCE[0]}"; echo "${arr[0,2]}"'
regra "SB43 KSH_ZERO_SUBSCRIPT cala o IDX0" 'if (!KSHARR) for (c = 1; c <= NC; c++) regra_idx0(c)' \
  'if (1) for (c = 1; c <= NC; c++) regra_idx0(c)' \
  "$NADA" "$IDX0" 'setopt KSH_ZERO_SUBSCRIPT; arr=(a b); echo "${arr[0]}"'
# A DECLARACAO fica FORA das aspas simples de proposito: com `arr=(a b)` DENTRO delas, desligar o
# reconhecimento de `'` tambem destroi a atribuicao (a palavra viraria `'arr=(a`), ARR nao e
# populado e a fixture calaria pela OUTRA regra — verde por motivo alheio, que foi o que a 1a
# versao desta SB produziu.
regra "SB44 aspas simples sao mencao tambem no IDX0" \
  'if (c == SQ) { wshape(o, "S"); wraw(o, c); push("S"); i++; continue }' \
  'if (0) { wshape(o, "S"); wraw(o, c); push("S"); i++; continue }' \
  "$NADA" "$IDX0" "arr=(a b); echo 'no zsh \${arr[0]} e vazio'"
# Deteccao: a fixture DISPARA por causa da regra; sabotada, cala.
regra "SB45 a deteccao do IDX0 mora em chaves() (deteccao)" \
  'z0 = ct; sub(/\[.*$/, "", z0); WZ[o] = WZ[o] " " z0' 'z0 = ct' \
  "$IDX0" "$NADA" 'arr=(a b); echo "${arr[0]}"'
regra "SB46 aspas DUPLAS sao USO no IDX0 (deteccao)" \
  'if (c == "$") { i = dolar(linha, i, n); continue }
        if (c == "`") { wraw(o, c); abre_sub(1); i++; continue }
        wlit(o, c); i++; continue' \
  'wlit(o, c); i++; continue' \
  "$IDX0" "$NADA" 'arr=(a b); f="${arr[0]}"'
regra "SB47 o IDX0 corre fora do passo 2b (deteccao)" \
  'if (!KSHARR) for (c = 1; c <= NC; c++) regra_idx0(c)' '' \
  "$IDX0" "$NADA" 'arr=(a b); f="${arr[0]}"'
regra "SB48 o portao deixa o IDX0 passar (deteccao)" \
  'porta_idx0() { [[ "$entrada" =~ $re_idx0_sub ]] && [[ "$entrada" =~ $re_idx0_dec ]]; }' \
  'porta_idx0() { false; }' \
  "$IDX0" "$NADA" 'arr=(a b); echo "${arr[0]}"'
# NAO existe SB de "precisao do portao do IDX0", e a ausencia e deliberada: afrouxar
# `re_idx0_dec` so faz MAIS comando chegar ao awk, que segue calando por falta de array declarado
# — antes e depois iguais, sabotagem inocua. Para o IDX0 a conjuncao do portao e PERFORMANCE
# medida (0,08% do corpus em vez de 1,76%); quem decide e `regra_idx0`, provado por SB41/SB48.

ORIG="$TMPD/hook-foto.sh"; cp "$HOOK" "$ORIG"          # foto: base de toda sabotagem E controle de saida
IDENT="$TMPD/hook-identidade.sh"; cp "$ORIG" "$IDENT"  # a sabotagem NULA do controle
SAB="$TMPD/hook-sabotado.sh"
execs=0
nreg=${#FT[@]}

sabota() { # <origem> <destino> <trecho> <troca> -> exit 0 e a copia sabotada, ou 1 com o motivo
  local n
  n="$(DE="$3" perl -0777 -ne 'my $n = () = /\Q$ENV{DE}\E/g; print $n' "$1" 2>/dev/null)"
  [ "$n" = "1" ] || { echo "o trecho casou ${n:-?} vez(es) no hook — precisa de EXATAMENTE 1"; return 1; }
  DE="$3" PARA="$4" perl -0777 -pe 's/\Q$ENV{DE}\E/$ENV{PARA}/' "$1" > "$2" 2>/dev/null \
    || { echo "o perl falhou"; return 1; }
  if cmp -s "$1" "$2"; then echo "a sabotagem NAO mudou o arquivo: seria teatro"; return 1; fi
  return 0
}

echo "-- falsificacao A: CONTROLE (sabotagem nula, $nreg regras x ${#LOCALES[@]} locales) --"
ctl_falhas=0
i=0
while [ "$i" -lt "$nreg" ]; do
  for loc in "${LOCALES[@]}"; do
    # shellcheck disable=SC2030  # proposital: o locale vale so para ESTE veredito, no subshell do $( )
    obtido="$(export LC_ALL="$loc"; veredito "$IDENT" "$(entrada "${FFIX[$i]}")")"; execs=$((execs + 1))
    if [ "$obtido" != "${FANTES[$i]}" ]; then
      printf '  FALHA %s [%s] — CONTROLE: com o hook INTEGRO veio %s, esperava %s\n' \
        "${FT[$i]}" "$loc" "$obtido" "${FANTES[$i]}"
      ctl_falhas=$((ctl_falhas + 1))
    fi
  done
  i=$((i + 1))
done
if [ "$ctl_falhas" -gt 0 ]; then
  printf '  FALHA controle: %s fixture(s) fora do veredito ANTES — ABORTADO antes da 1a sabotagem\n' "$ctl_falhas"
  falhas=$((falhas + ctl_falhas))
else
  printf '  ok   controle verde: %s fixtures no veredito ANTES nos %s locales\n' "$nreg" "${#LOCALES[@]}"
  echo "-- falsificacao B: SABOTAGEM (uma regra por vez, numa copia) --"
  i=0
  while [ "$i" -lt "$nreg" ]; do
    if ! motivo="$(sabota "$ORIG" "$SAB" "${FDE[$i]}" "${FPARA[$i]}")"; then
      printf '  FALHA %s — %s\n' "${FT[$i]}" "$motivo"; falhas=$((falhas + 1)); i=$((i + 1)); continue
    fi
    vermelhos=0
    for loc in "${LOCALES[@]}"; do
      # shellcheck disable=SC2031  # proposital: cada veredito exporta o PROPRIO locale no subshell
      obtido="$(export LC_ALL="$loc"; veredito "$SAB" "$(entrada "${FFIX[$i]}")")"; execs=$((execs + 1))
      if [ "$obtido" = "${FDEPOIS[$i]}" ]; then vermelhos=$((vermelhos + 1))
      else printf '  FALHA %s [%s] — sabotada, veio %s; esperava %s: a regra NAO e o que decide a fixture\n' \
             "${FT[$i]}" "$loc" "$obtido" "${FDEPOIS[$i]}"; falhas=$((falhas + 1)); fi
    done
    [ "$vermelhos" -eq "${#LOCALES[@]}" ] && printf '  ok   %s — %s -> %s nos %s locales\n' \
      "${FT[$i]}" "${FANTES[$i]}" "${FDEPOIS[$i]}" "${#LOCALES[@]}"
    i=$((i + 1))
  done
fi

echo "-- falsificacao C: SAIDA --"
if cmp -s "$ORIG" "$HOOK"; then echo "  ok   hook real byte-identico a foto do inicio (so copias foram sabotadas)"
else echo "  FALHA o hook real MUDOU durante a suite"; falhas=$((falhas + 1)); fi
esperado=$((nreg * ${#LOCALES[@]} * 2))
if [ "$execs" -eq "$esperado" ]; then printf '  ok   %s execucoes do hook = %s regras x %s locales x 2 fases\n' "$execs" "$nreg" "${#LOCALES[@]}"
else printf '  FALHA %s execucoes, esperava %s — a falsificacao nao rodou o que diz rodar\n' "$execs" "$esperado"
  falhas=$((falhas + 1)); fi

echo
if [ "$falhas" -eq 0 ]; then echo "WORD-SPLIT-ZSH-GUARD: TODOS OS TESTES PASSARAM"; exit 0; fi
echo "WORD-SPLIT-ZSH-GUARD: $falhas FALHA(S)"; exit 1
