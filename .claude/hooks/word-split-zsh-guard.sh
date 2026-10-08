#!/usr/bin/env bash
# word-split-zsh-guard.sh — PreToolUse(Bash): AVISA quando o comando conta com o word splitting do
# bash numa expansao de VARIAVEL que o zsh entrega inteira.
#
# POR QUE: o Bash tool desta maquina roda em /bin/zsh, com SH_WORD_SPLIT DESLIGADO. O bash parte em
# palavras toda expansao de parametro sem aspas; o zsh nao. Nada falha: o comando recebe os bytes
# certos — numa palavra, onde o autor contava N. Medido nos dois shells em 2026-09-25/26
# (docs/historico/evidencia-positiva-shell.md §21), bash 3.2.57 x zsh 5.9:
#
#   st="completed success"; set -- $st     bash: $1=completed $2=success | zsh: $1="completed success"
#   l=$(git log --format=%h); for c in $l  bash: N voltas                 | zsh: 1 volta
#   t=$(ls | tr '\n' ' '); vitest run $t   bash: N argumentos             | zsh: 1 argumento
#   vitest run $(ls)                       bash: N                        | zsh: N  (o zsh DIVIDE $(...))
#
# Cinco incidentes em dez semanas, tres deles DEPOIS do mecanismo nomeado por escrito — a meta-regra
# do catalogo (§9 PIPESTATUS, §13 pgrep): contramedida textual reincide, o passo seguinte e guard.
#
# ── AS TRES FORMAS, CADA UMA NA CONJUNCAO QUE A TORNA PRECISA ─────────────────────────────────
#   SET   `set -- $x` / `set $x`, com a lista posicional sendo UMA palavra que e UMA expansao
#         escalar. Nao exige mais nada: ninguem escreve `set -- $x` sem querer partir `$x`.
#   FOR   `for v in $x`, lista de UMA palavra escalar, com `x` atribuida como TEXTO **antes, neste
#         mesmo comando** (`x=...`, `local x=...`, `read ... x`). O laco e o sinal de intencao de
#         lista; a atribuicao prova que o valor e escalar. O estado do shell NAO persiste entre
#         chamadas do Bash tool, entao variavel nao atribuida aqui esta vazia (0 voltas nos dois
#         shells) ou veio do ambiente — e nenhuma das duas e esta armadilha.
#   ARGS  `cmd ... $x`, com `x` atribuida **antes, neste comando**, como LISTA numa string so: de
#         `$(...)` cuja saida foi JUNTADA por espaco/tab (`tr '\n' ' '`, `paste -s`, `xargs` sem
#         comando, `join(" ")`) — a forma dos dois casos do vitest — ou de um LITERAL com espaco
#         (`T="a.ts b.ts"`), cujo valor e CONHECIDO como multi-palavra. Sem um desses sinais a
#         precisao desaba: `x=$(cmd)` qualquer daria +132 disparos no corpus, e em 20 amostrados so
#         4 eram lista — o resto, valor UNICO por construcao (`--jq '.[0].x'`, `head -1`,
#         `git rev-parse`), que o zsh entrega certo.
# Precisao medida (corpus de 88.225 comandos Bash reais, 2026-05..09; cada disparo julgado pelo
# RESULTADO que a chamada devolveu): SET 24/24, ARGS 10/11 (+ literal 11/12, 0 FP), FOR 49/59.
# Os FPs do FOR tem a MESMA forma dos TPs (`X=$(... | sort -u); for v in $X`) — 0 ou 1 item em
# runtime os salvou; o idioma continua errado, so nao mordeu daquela vez.
# Nos tres, cala se `x` e ARRAY no proprio comando (`x=(...)`, `typeset -a`, `read -A`, `set -A`) —
# `for v in $arr` e o idioma CERTO no zsh — ou array especial do zsh (`$path`, `$argv`...).
#
# ── A 4a FORMA: ARRAY DO ZSH E 1-INDEXED, ENTAO `${arr[0]}` E SEMPRE VAZIO ─────────────────────
#   IDX0  `${arr[0]}`, com `arr` sendo array DECLARADO neste mesmo comando. Medido em 2026-10-08,
#         `zsh -f` x bash 3.2.57 — `arr=(a b c)`:
#           ${arr[0]}     zsh: VAZIO   bash: a      ${arr[1]}   zsh: a       bash: b
#           ${arr[0,2]}   zsh: "a b"   bash: c      ${#arr[0]}  zsh: 0       bash: 1
#         O vazio e a §9 generalizada: `[ "" -eq 0 ]` e VERDADEIRO e calado no zsh, entao exit code
#         e contador ausentes viram SUCESSO e ZERO. O ramo `INDICE-ZERO` do pipestatus-zsh-guard.sh
#         ja cobre `pipestatus[0]`, mas ele julga por NOME FIXO (o awk procura a string
#         `pipestatus`): o caso GERAL — `${fila[0]}`, `${queue[0]}` — nao tinha hook nenhum.
#         ESTE hook e o lugar porque o predicado NAO e nome, e DECLARACAO: o `ARR[]` que cala os
#         tres ramos acima ja prova "x e array neste comando", e o tokenizador ja separa uso de
#         mencao. No vizinho seria portar o tokenizador — regra local em vez de compartilhada.
#         ATENCAO: aqui aspas DUPLAS sao USO, nao mencao (`f="${fila[0]}"` expande e da vazio) —
#         semantica oposta a das tres formas acima, e de graca: `${...}` dentro de `"..."` passa
#         por `chaves()`, dentro de `'...'`/heredoc/comentario nao passa.
# Precisao medida (corpus de 112.113 comandos Bash reais, 2026-05..10): 392 chamadas leem
# `${NOME[0]}`; 87 com nome != PIPESTATUS (as outras ja sao do vizinho). Dessas 87, 55 linhas sao
# `${BASH_SOURCE[0]}` — array do BASH, nunca declarado no comando, logo calado pelo predicado — e
# das 32 restantes 16 declaram array aqui. Rodando ESTE hook nas 1.972 chamadas do corpus que tem
# `[0]`: **2 disparos, 2 VP, 0 FP**. Os dois sao os BFS de imports que imprimiram
# `closure_count=0` em 2026-09-05/06 — zero com cara de resultado; dos 4 comandos do corpus que
# imprimem `closure_count`, estes 2 sao exatamente os que rodam no zsh.
# Os outros 14 dos 16 calam, e TODOS por MENCAO: 6 sao `cat > x.sh <<'EOF'` escrevendo um script
# com shebang `#!/bin/bash` (ali `[0]` esta CERTO), 5 sao `ps=("${PIPESTATUS[@]}")` dentro de
# heredoc ou `bash -c`, e 3 sao TS/JS em heredoc. 16/16 julgados certo.
# LICAO DE METODO, da calibracao: o julgamento MANUAL destes 16 — feito pela janela do `grep` em
# volta do `${fila[0]}` — deu 8 VP, o quadruplo. A janela mostrava `fila=(` e `${fila[0]}` e NAO
# mostrava o `cat > x.sh <<'EOF'` seis linhas acima. O tokenizador acertou onde o olho errou:
# precisao aferida por recorte de contexto superestima, porque o recorte esconde o quoting.
#
# ── MENCAO NAO E USO ──────────────────────────────────────────────────────────────────────────
# Um tokenizador reconstroi so o que o zsh de fora EXECUTA. E mencao, e descartado: aspas simples,
# `$'...'`, comentario, corpo de heredoc (quoted OU nao — o corpo e dado para quem le: `bash <<EOF`
# re-divide no bash, que e o certo) e o texto de aspas duplas — `bash -c "..."` roda no bash, e
# `git commit -m "... set -- $st ..."` e o que se faz num repo que documenta as proprias
# armadilhas (precedente 2026-06-24: um guard bloqueou o commit que DOCUMENTAVA o seu padrao). A
# unica excecao e `$(...)`, que e CODIGO mesmo dentro de aspas duplas (medido: `"$(for x in $l; …)"`
# da 1 volta no zsh). A here-string `<<<` e redirecao, nao heredoc: o scanner de
# `pipestatus-zsh-guard.sh` a lia como `<` + `<<`, comia a aspa de abertura de `"$x"` e invertia a
# paridade (ate 2026-09-27, quando ganhou ramo `herestring` proprio) — e `read -r a b <<< "$st"`
# e justamente o idioma que ESTE aviso recomenda.
#
# ── POR QUE AVISA E NUNCA BLOQUEIA ────────────────────────────────────────────────────────────
# "Um detector de padrao de shell nao herda a semantica do shell" (§9): o `pipestatus-zsh-guard.sh`
# nasceu bloqueante e foi rebaixado por falso negativo E falso positivo provados. Aqui ha um FP
# permanente e legitimo — valor que por acaso e uma palavra so (`set -- $x` com x=abc) —, entao nao
# ha precisao para `deny`. Como aviso o FP custa uma linha de contexto; o FN custou meia hora de
# laco de espera e dois vermelhos falsos lidos como prova. Precisao acima de recall: um FP gasta a
# credibilidade de TODOS os avisos, e por isso cada forma dispara so na conjuncao acima.
#
# ── O QUE ELE NAO PEGA (limites assumidos, cada um travado por teste) ─────────────────────────
#   - reinterpretacao posterior num zsh que este hook nao enxerga: `eval 'set -- $x'`,
#     `zsh -c '...'`, script com shebang zsh (nenhum no repo: 495 `.sh` tem bash, 0 tem zsh —
#     remedido em 2026-10-08, eram 448);
#   - a forma curta do zsh `for x ($l)`, e variavel como NOME de comando (`c="git status"; $c` —
#     falha ALTO, exit 127, que nao e a classe silenciosa daqui);
#   - `x` usada ANTES da atribuicao no texto (laco que re-atribui no fim do corpo);
#   - `setopt SH_WORD_SPLIT` em QUALQUER ponto do comando cala tudo, mesmo depois do uso;
#   - `)` de padrao de `case` dentro de `$(...)` fecha a substituicao cedo demais.
#   IDX0 so: palavra que e ALVO DE REDIRECAO — `cat <<< "${arr[0]}"` e `echo x > "${arr[0]}"` — que
#     o `fimpal()` descarta antes de guardar a forma. Medido: no corpus, redirecao `>` para `[0]`
#     tem **0** casos, e os 12 "here-string com [0]" sao `'<<<<<<<'` (marcador de conflito) em
#     codigo Python, com `[0]` indexando LISTA. Cobrir custaria propagar a palavra de redirecao, e
#     o alvo de `>` com nome vazio ja falha ALTO ("no such file"), que nao e a classe silenciosa;
#   IDX0 so: subscript que nao seja o `0` EXATO (`${arr[0,2]}` e range LEGITIMO — da "a b" no zsh,
#     medido; `${arr[0+0]}`, `${arr[$i]}` com i=0 sao calculados), `${#arr[0]}` e flag de parametro
#     (`${(e)arr[0]}` — o `ct` nao comeca por nome), `${arr[0]:-pad}` (o default disfarca o vazio),
#     array declarado DENTRO de aspas/heredoc que o mesmo texto depois roda em bash, e array que
#     vem do AMBIENTE (nao declarado aqui) — inclusive `${BASH_SOURCE[0]}`, que e correto no bash.
#
# ── FORMA MEDIDA E RECUSADA (para ninguem "completar a classe" com um ramo que nunca dispara) ──
# `arr=($escalar)` — array nascendo com UM elemento porque o zsh nao divide a variavel — foi
# medida no MESMO corpus de 77.916 chamadas que calibrou este hook: **0 verdadeiros positivos**.
# Os 3 casos brutos eram `+=(` acrescentando UM item de proposito (`rcs+=($rc)`, um exit code),
# isto e, falso positivo. Ficou fora DE PROPOSITO — nao e lacuna a fechar.
# E prevencao de acidente de boa-fe, nao sandbox contra adversario.
#
# ── ORIGEM ────────────────────────────────────────────────────────────────────────────────────
# O primeiro desenho existiu em 2026-09-10 como 4o ramo do pipestatus-zsh-guard, calibrado num
# corpus de 77.916 chamadas Bash — commit local af80cd1de da worktree brave-antonelli-a9f819, NUNCA
# publicado. Por isso os incidentes de 09-18 e 09-25 aconteceram mesmo assim. Este hook e separado
# de proposito: suite e falsificacao proprias, e nenhum risco de regredir o vizinho.
#
# Fail-open de infra (sem jq/awk -> exit 0): e um SENSOR, nao um script que apaga.
# Testes em scripts/test-word-split-zsh-guard.sh (inclui falsificacao regra a regra).
set -u

entrada="$(cat)"

# PORTAO BARATO, ANTES de qualquer fork: este hook roda em TODA chamada Bash. As tres formas
# exigem uma expansao (`$`) e, alem dela, `set `/`for ` como palavra ou uma atribuicao de `$(`. O
# payload e JSON cru: quebra de linha chega como `\n` (dois caracteres), dai o 2o padrao de cada.
# ATENCAO ao falsificar a suite: este portao e REGRA, nao so performance — ele decide sozinho
# qualquer fixture que nao o atravesse. Limite assumido: tab no lugar do espaco depois de set/for.
case "$entrada" in
  *'$'*) ;;
  *) exit 0 ;;
esac
# `\\n` casa a BARRA literal seguida de n (o escape do JSON); nao `'\n'`, que o shellcheck le mal.
# O 3o gatilho — lista LITERAL com espaco (`T="a b"`, `T='a b'`) — e regex do PROPRIO bash (`=~`,
# sem fork), e so roda para quem nao passou nos padroes baratos. Medido no corpus: o glob ingenuo
# `NOME="` poria +8,4% das chamadas no jq+awk; o regex, que exige o espaco DENTRO do literal, +2,1%.
re_lit_d='[A-Za-z_][A-Za-z0-9_]*=\\"[^\\$]*[ ][^\\$]*\\"'
re_lit_s="[A-Za-z_][A-Za-z0-9_]*='[^']*[ ][^']*'"
# O 4o gatilho — IDX0 — exige os DOIS sinais: um subscript `[0]` E uma declaracao de array no
# texto. Aqui a conjuncao e PERFORMANCE medida, nao regra (ao contrario dos tres de cima): quem
# decide e `regra_idx0`, e afrouxar isto so faria MAIS comando chegar ao awk, que segue calando
# por falta de array declarado. So `[0]` poria 1,76% do corpus no jq+awk (1.972 de 112.113, a
# maioria `.[0]` de jq); com a declaracao exigida sao 0,08% (91). Medido 2026-10-08. O
# `-[-A-Za-z]*[aA]` pede que a flag TERMINE em a/A, entao `typeset -aU arr` (sem outro sinal no
# texto) e FN do portao — o awk o reconheceria, mas nao chega la.
re_idx0_sub='\[[[:space:]]*0[[:space:]]*\]'
re_idx0_dec='(=\(|\+=\(|(typeset|declare|local|readonly|export|integer|float|private)[[:space:]]+-[-A-Za-z]*[aA]|read[[:space:]]+-[-A-Za-z]*[aA]|set[[:space:]]+-A)'
porta_idx0() { [[ "$entrada" =~ $re_idx0_sub ]] && [[ "$entrada" =~ $re_idx0_dec ]]; }
# shellcheck disable=SC2016  # `$(` e crase aqui sao TEXTO do payload a casar, nao expansao
case "$entrada" in
  *[!A-Za-z0-9_]set\ *|*\\nset\ *|*\\tset\ *) ;;
  *[!A-Za-z0-9_]for\ *|*\\nfor\ *|*\\tfor\ *) ;;
  *'=$('*|*'=\"$('*|*'=`'*|*'=\"`'*) ;;
  *) [[ "$entrada" =~ $re_lit_d || "$entrada" =~ $re_lit_s ]] || porta_idx0 || exit 0 ;;
esac

command -v jq >/dev/null 2>&1 || exit 0
command -v awk >/dev/null 2>&1 || exit 0

# Um unico jq: tool_name na 1a linha, comando no resto. O comando PRECISA manter as quebras de
# linha (heredoc, laco multi-linha), e tool_name nunca tem newline, entao o corte na 1a e seguro.
bruto="$(printf '%s' "$entrada" | jq -r '(.tool_name // ""), (.tool_input.command // "")' 2>/dev/null)"
case "$bruto" in
  *$'\n'*) ;;
  *) exit 0 ;;   # sem a 2a linha nao ha comando — e `${bruto#*\n}` devolveria o tool_name
esac
tool="${bruto%%$'\n'*}"
cmd="${bruto#*$'\n'}"
[ -z "$tool" ] || [ "$tool" = "Bash" ] || exit 0   # defesa se o matcher do settings.json mudar
[ -n "$cmd" ] || exit 0

# Silenciador: intencao declarada como env-assignment NO INICIO (nao substring solta). O regex
# vive numa variavel: `;` cru dentro de `[[ =~ ]]` e erro de PARSE no bash.
re_silencio='^[[:space:]]*WORD_SPLIT_INTENCIONAL=(1|true)([[:space:];]|$)'
[[ "$cmd" =~ $re_silencio ]] && exit 0

# Continuacao de linha: o shell remove `\`+newline ANTES de tokenizar.
cmd="${cmd//\\$'\n'/}"

# ── TOKENIZADOR + REGRAS ──────────────────────────────────────────────────────────────────────
# Pilha de contextos: C codigo (topo, $(...), <(...), crase) · R array literal x=(...) · D aspas
# duplas · S aspas simples · Q $'...' · B ${...} · A aritmetica. Cada palavra guarda uma FORMA
# (uma letra por componente: L literal, P expansao ESCALAR, X outra expansao, C substituicao,
# Q/q aspas duplas, S aspas simples, A aritmetica, R array, = atribuicao) — "pura" e a forma "P"
# exata. LC_ALL=C: varredura por BYTE. Nenhum byte de caractere UTF-8 multibyte e ASCII, entao a
# sintaxe e reconhecida igual em qualquer locale, e o substr do gawk nao fica quadratico.
saida="$(printf '%s\n' "$cmd" | LC_ALL=C awk -v SQ="'" '
  function wreset(o) { WR[o] = ""; WSH[o] = ""; WV[o] = ""; WPN[o] = ""; WZ[o] = ""; WPOS[o] = 0; WRHS[o] = 0; WACT[o] = 0 }
  function wtouch(o) { if (!WACT[o]) { WACT[o] = 1; WPOS[o] = NR * 1000000 + I } }
  function wraw(o, s) { wtouch(o); WR[o] = WR[o] s }
  function wshape(o, cod) { wtouch(o); if (INB[D]) return; WSH[o] = WSH[o] cod }
  function wlit(o, ch) {
    wtouch(o); WR[o] = WR[o] ch
    if (INB[D]) return
    WV[o] = WV[o] ch
    if (substr(WSH[o], length(WSH[o]), 1) != "L") WSH[o] = WSH[o] "L"
  }
  function push(t) {
    D++; CT[D] = t
    if (t == "C" || t == "R") { OWN[D] = D; INB[D] = 0; wreset(D); NWC[D] = 0; RP[D] = 0; PD[D] = 0; BT[D] = 0; CID[D] = 0 }
    else { OWN[D] = OWN[D - 1]; INB[D] = (t == "B" || INB[D - 1]) }
  }
  # Fim de palavra: alvo de redirecao nao e argumento; palavra de array literal nao e comando.
  function fimpal(d,   k) {
    if (!WACT[d]) return
    if (RP[d] || CT[d] != "C") { RP[d] = 0; wreset(d); return }
    k = ++NWC[d]
    PR[d, k] = WR[d]; PS[d, k] = WSH[d]; PV[d, k] = WV[d]; PP[d, k] = WPOS[d]
    PZ[d, k] = WZ[d]                        # nomes lidos com `[0]` nesta palavra (ramo IDX0)
    PN[d, k] = (WSH[d] == "P" ? WPN[d] : "")
    PH[d, k] = ((WSH[d] == "L=C" || WSH[d] == "L=QCq") ? WRHS[d] : 0)
    wreset(d)
  }
  function fimcmd(d,   k) {
    fimpal(d)
    if (NWC[d] == 0) return
    NC++; CN[NC] = NWC[d]; CS[NC] = CID[d]
    for (k = 1; k <= NWC[d]; k++) {
      R_[NC, k] = PR[d, k]; S_[NC, k] = PS[d, k]; V_[NC, k] = PV[d, k]
      N_[NC, k] = PN[d, k]; P_[NC, k] = PP[d, k]; H_[NC, k] = PH[d, k]; Z_[NC, k] = PZ[d, k]
    }
    NWC[d] = 0
  }
  # $( ), <( ), >( ) e crase: codigo NOVO. Se a palavra ate aqui e `x=` ou `x="`, a substituicao
  # e o lado direito da atribuicao — guarda o id para a regra ARGS olhar o que ha dentro.
  function abre_sub(bt,   o) {
    o = OWN[D]; NCS++
    wshape(o, "C")
    if (!INB[D] && (WSH[o] == "L=C" || WSH[o] == "L=QC")) WRHS[o] = NCS
    push("C"); CID[D] = NCS; BT[D] = bt
  }
  function dolar(linha, i, n,   o, nx, j, nome, pre) {
    o = OWN[D]; nx = substr(linha, i + 1, 1)
    if (nx == "(") {
      if (substr(linha, i + 2, 1) == "(") { wshape(o, "A"); wraw(o, "$(("); push("A"); APD[D] = 0; return i + 3 }
      wraw(o, "$("); abre_sub(0); return i + 2
    }
    if (nx == "{") { pre = length(WR[o]); wraw(o, "${"); push("B"); BRS[D] = pre; BD[D] = 0; return i + 2 }
    if (nx == SQ) { wshape(o, "S"); wraw(o, "$" SQ); push("Q"); return i + 2 }
    if (nx ~ /[A-Za-z_]/) {
      j = i + 1; nome = ""
      while (j <= n && substr(linha, j, 1) ~ /[A-Za-z0-9_]/) { nome = nome substr(linha, j, 1); j++ }
      wraw(o, "$" nome); wshape(o, "P"); if (!INB[D]) WPN[o] = nome
      return j
    }
    if (nx ~ /[0-9]/) { wraw(o, "$" nx); wshape(o, "P"); if (!INB[D]) WPN[o] = nx; return i + 2 }
    # Todo o resto e `$` LITERAL, e isso basta: `$@` `$*` `$=x` `$#x` `$a[1]` `$"..."` ficam com
    # forma != "P" (o que vem colado vira L, X ou Q), entao nao sao escalar puro — sem ramo proprio.
    wlit(o, "$"); return i + 1
  }
  # ${...}: escalar puro e `${nome}` ou `${nome<op>...}`. Flag `(`, `=`, `~`, `^`, `#` de
  # comprimento, `!`, `+` e subscript `[` NAO sao — ${=x} e ${(f)x} sao o split EXPLICITO do zsh.
  function chaves(o, ct,   nome, z0) {
    # IDX0: `${arr[0]}` com o subscript sendo o `0` EXATO, e nada depois do `]`. Range e indice
    # calculado ficam FORA de proposito: `${arr[0,2]}` da "a b" no zsh (medido), e `${arr[0]:-pad}`
    # entrega o default, nao o vazio. Este e o UNICO ponto da deteccao, e ele da a semantica de
    # mencao de graca: `${...}` dentro de `"..."` chega aqui (expande, logo e USO), dentro de
    # `'...'`, de heredoc e de comentario o tokenizador nunca chama esta funcao.
    if (!INB[D] && ct ~ /^[A-Za-z_][A-Za-z0-9_]*\[[[:space:]]*0[[:space:]]*\]$/) {
      z0 = ct; sub(/\[.*$/, "", z0); WZ[o] = WZ[o] " " z0
    }
    nome = ""
    if (ct ~ /^[A-Za-z_][A-Za-z0-9_]*$/ || ct ~ /^[0-9]+$/) nome = ct
    else if (ct ~ /^[A-Za-z_][A-Za-z0-9_]*[:#%\/^,~?=+-]/ || ct ~ /^[0-9]+[:#%\/^,~?=+-]/) {
      nome = ct; sub(/[^A-Za-z0-9_].*$/, "", nome)
    }
    if (nome == "") { wshape(o, "X"); return }
    wshape(o, "P"); if (!INB[D]) WPN[o] = nome
  }
  function redir(linha, i, n,   c, nx, j, d, q, ch, hyf) {
    c = substr(linha, i, 1); nx = substr(linha, i + 1, 1)
    if (nx == "(") { wraw(OWN[D], c "("); abre_sub(0); return i + 2 }           # <( ) >( )
    if (WACT[D] && WSH[D] == "L" && WR[D] ~ /^[0-9]+$/) wreset(D); else fimpal(D)   # 2>: FD do operador
    # Heredoc: o delimitador entra na FILA. A here-string `<<<` NAO precisa de ramo proprio: o
    # delimitador para no 3o `<` e sai vazio (ignorado), e o 3o `<` vira redirecao comum, cuja
    # palavra e DADO. O vizinho pipestatus-zsh-guard entrava no heredoc pelo 2o `<` e comia a aspa
    # de `"$x"` (ate ganhar ramo `herestring`, 2026-09-27) — a suite trava o comportamento (N26),
    # nao esta implementacao.
    if (c == "<" && nx == "<") {
      j = i + 2; hyf = 0
      if (substr(linha, j, 1) == "-") { hyf = 1; j++ }
      while (substr(linha, j, 1) == " " || substr(linha, j, 1) == "\t") j++
      d = ""; q = 0
      while (j <= n) {
        ch = substr(linha, j, 1)
        if (ch == SQ || ch == "\"") {
          q = 1; j++
          while (j <= n && substr(linha, j, 1) != ch) { d = d substr(linha, j, 1); j++ }
          j++; continue
        }
        if (ch == "\\") { q = 1; d = d substr(linha, j + 1, 1); j += 2; continue }
        if (ch == " " || ch == "\t" || ch == ";" || ch == "&" || ch == "|" || ch == "<" || ch == ">" || ch == "(" || ch == ")") break
        d = d ch; j++
      }
      if (d != "" && (q || substr(d, 1, 1) ~ /[A-Za-z_]/)) { HQN++; HQDEL[HQN] = d; HQDASH[HQN] = hyf }
      return j
    }
    j = i + 1
    if (nx == ">" || nx == "&" || nx == "|" || (c == "<" && nx == ">")) j++
    RP[D] = 1
    return j
  }
  BEGIN {
    split("if then else elif fi while until do done ! { } time coproc esac", L_, " "); for (x in L_) CHAVE[L_[x]] = 1
    split("command builtin exec noglob nocorrect -", L_, " "); for (x in L_) PRECMD[L_[x]] = 1
    split("local typeset declare export readonly integer float private", L_, " "); for (x in L_) DECLARA[L_[x]] = 1
    split("echo print [ test [[ case local typeset declare export readonly integer float private unset read let eval set for select function alias return exit shift trap :", L_, " ")
    for (x in L_) NAOALVO[L_[x]] = 1
    split("argv path fpath cdpath manpath mailpath module_path pipestatus signals match mbegin mend reply funcstack funcfiletrace funcsourcetrace functrace historywords dirstack psvar watch zsh_eval_context precmd_functions preexec_functions chpwd_functions periodic_functions zshexit_functions", L_, " ")
    for (x in L_) ESPECIAL[L_[x]] = 1
    D = 1; CT[1] = "C"; OWN[1] = 1; INB[1] = 0; wreset(1); NWC[1] = 0; RP[1] = 0; PD[1] = 0; BT[1] = 0; CID[1] = 0
    NC = 0; NCS = 0; NA = 0; HQN = 0; HQI = 0; inhd = 0; SPLIT = 0; KSHARR = 0; VR = ""; VP = 0; VC = 0
  }
  {
    linha = $0
    if (inhd) {                                    # corpo de heredoc: DADO, so procura o fechamento
      t = linha; if (HQDASH[HQI]) sub(/^\t+/, "", t)
      if (t == HQDEL[HQI]) { HQI++; if (HQI > HQN) { inhd = 0; HQN = 0; HQI = 0 } }
      next
    }
    n = length(linha); i = 1
    while (i <= n) {
      I = i; c = substr(linha, i, 1); t = CT[D]; o = OWN[D]
      if (t == "S") {
        if (c == SQ) { WR[o] = WR[o] c; D--; i++; continue }
        WR[o] = WR[o] c; if (!INB[D]) WV[o] = WV[o] c; i++; continue
      }
      if (t == "Q") {
        if (c == "\\") { nx = substr(linha, i + 1, 1); WR[o] = WR[o] c nx; if (!INB[D]) WV[o] = WV[o] c nx; i += 2; continue }
        WR[o] = WR[o] c
        if (c == SQ) { D--; i++; continue }
        if (!INB[D]) WV[o] = WV[o] c
        i++; continue
      }
      if (t == "A") {
        WR[o] = WR[o] c
        if (c == "(") APD[D]++
        else if (c == ")") {
          if (APD[D] > 0) APD[D]--
          else if (substr(linha, i + 1, 1) == ")") { WR[o] = WR[o] ")"; D--; i += 2; continue }
        }
        i++; continue
      }
      if (t == "D") {
        if (c == "\\") {
          nx = substr(linha, i + 1, 1); WR[o] = WR[o] c nx
          if (!INB[D]) { if (nx == "$" || nx == "`" || nx == "\"" || nx == "\\") WV[o] = WV[o] nx; else WV[o] = WV[o] c nx }
          i += 2; continue
        }
        if (c == "\"") { WR[o] = WR[o] c; wshape(o, "q"); D--; i++; continue }
        if (c == "$") { i = dolar(linha, i, n); continue }
        if (c == "`") { wraw(o, c); abre_sub(1); i++; continue }
        wlit(o, c); i++; continue
      }
      if (t == "B") {
        if (c == "\\") { WR[o] = WR[o] c substr(linha, i + 1, 1); i += 2; continue }
        if (c == SQ) { WR[o] = WR[o] c; push("S"); i++; continue }
        if (c == "\"") { WR[o] = WR[o] c; push("D"); i++; continue }
        if (c == "$") { i = dolar(linha, i, n); continue }
        if (c == "`") { wraw(o, c); abre_sub(1); i++; continue }
        if (c == "{") { BD[D]++; WR[o] = WR[o] c; i++; continue }
        if (c == "}") {
          WR[o] = WR[o] c
          if (BD[D] > 0) { BD[D]--; i++; continue }
          ct = substr(WR[o], BRS[D] + 3); ct = substr(ct, 1, length(ct) - 1)
          D--; chaves(o, ct); i++; continue
        }
        WR[o] = WR[o] c; i++; continue
      }
      # ── t == "C" (codigo) ou "R" (array literal) ──
      if (c == " " || c == "\t") { fimpal(D); i++; continue }
      if (c == "#" && t == "C" && !WACT[D]) { i = n + 1; continue }   # comentario ate o fim da linha
      if (c == "\\") { nx = substr(linha, i + 1, 1); wraw(o, c); if (nx != "") wlit(o, nx); i += 2; continue }
      if (c == SQ) { wshape(o, "S"); wraw(o, c); push("S"); i++; continue }
      if (c == "\"") { wshape(o, "Q"); wraw(o, c); push("D"); i++; continue }
      if (c == "$") { i = dolar(linha, i, n); continue }
      if (c == "`") {
        if (t == "C" && BT[D]) { fimcmd(D); D--; wraw(OWN[D], c); i++; continue }
        wraw(o, c); abre_sub(1); i++; continue
      }
      if (t == "R") {
        if (c == "(") { PD[D]++; wraw(o, c); i++; continue }
        if (c == ")") {
          if (PD[D] > 0) { PD[D]--; wraw(o, c); i++; continue }
          fimpal(D); D--; wraw(OWN[D], c); i++; continue
        }
        if ((c == "<" || c == ">") && substr(linha, i + 1, 1) == "(") { wraw(o, c "("); abre_sub(0); i += 2; continue }
        wlit(o, c); i++; continue
      }
      if (c == "(") {
        if (WACT[D] && WSH[D] == "L=") { wshape(D, "R"); wraw(D, c); push("R"); i++; continue }       # x=( ... )
        if (!WACT[D] && substr(linha, i + 1, 1) == "(") { wshape(D, "A"); wraw(D, "(("); push("A"); APD[D] = 0; i += 2; continue }
        fimcmd(D); PD[D]++; i++; continue                                                            # subshell / f()
      }
      if (c == ")") {
        if (PD[D] > 0) { PD[D]--; fimcmd(D); i++; continue }
        if (D > 1 && !BT[D]) { fimcmd(D); D--; wraw(OWN[D], c); i++; continue }                     # fecha $( )
        fimcmd(D); i++; continue                                                                     # ) de case
      }
      if (c == ";") { fimcmd(D); i++; continue }
      if (c == "&") {
        nx = substr(linha, i + 1, 1)
        if (nx == ">") { fimpal(D); i += 2; if (substr(linha, i, 1) == ">") i++; RP[D] = 1; continue }  # &> &>>
        fimcmd(D); i += ((nx == "&" || nx == "|" || nx == "!") ? 2 : 1); continue
      }
      if (c == "|") { fimcmd(D); nx = substr(linha, i + 1, 1); i += ((nx == "|" || nx == "&") ? 2 : 1); continue }
      if (c == "<" || c == ">") { i = redir(linha, i, n); continue }
      if (c == "=" && WACT[D] && WSH[D] == "L" && WR[D] ~ /^[A-Za-z_][A-Za-z0-9_]*[+]?$/) {
        WR[D] = WR[D] c; WV[D] = WV[D] c; WSH[D] = WSH[D] "="; i++; continue
      }
      wlit(o, c); i++
    }
    # fim da linha fisica: termina comando em codigo; dentro de aspas e conteudo
    I = n + 1; t = CT[D]; o = OWN[D]
    if (t == "C") fimcmd(D)
    else if (t == "R") fimpal(D)
    else { WR[o] = WR[o] "\n"; if ((t == "D" || t == "S" || t == "Q") && !INB[D]) WV[o] = WV[o] "\n" }
    if (HQN > 0 && !inhd) { inhd = 1; HQI = 1 }
  }

  # ── REGRAS (sobre os comandos simples, em ordem de texto) ──
  function cabeca(c,   k) {   # indice da palavra de COMANDO; AI..AF = atribuicoes de prefixo
    k = 1
    while (k <= CN[c] && S_[c, k] == "L" && (V_[c, k] in CHAVE)) k++
    AI = k
    while (k <= CN[c] && S_[c, k] ~ /^L=/) k++
    AF = k - 1
    while (k <= CN[c] && S_[c, k] == "L" && (V_[c, k] in PRECMD)) k++
    return k
  }
  function atrib(c, a, forca_arr,   nome) {
    nome = R_[c, a]; sub(/[+]?=.*$/, "", nome)
    if (forca_arr || substr(S_[c, a], 3, 1) == "R") { ARR[nome] = 1; return }
    NA++; AN[NA] = nome; AP[NA] = P_[c, a]; AID[NA] = H_[c, a]
    # Lista LITERAL: lado direito so de texto (sem expansao nem substituicao) E com espaco — o valor
    # e CONHECIDO como multi-palavra. Composta (`x="dir $HOME"`) fica de fora: nao foi medida.
    ALIT[NA] = (substr(S_[c, a], 3) !~ /[PXCAR]/ && substr(V_[c, a], index(V_[c, a], "=") + 1) ~ /[ \t\n]/)
  }
  function normaliza(w) { w = tolower(w); gsub(/_/, "", w); return w }
  # Opcao de `setopt`/`set -o` que muda a semantica de um dos ramos. SH_WORD_SPLIT liga o split do
  # bash (cala as tres formas); KSH_ARRAYS e KSH_ZERO_SUBSCRIPT tornam `[0]` LEGITIMO (medido em
  # `zsh -f`: com qualquer das duas, `arr=(a b c); ${arr[0]}` da "a"), e calam so o IDX0. As duas
  # ortogonais: ligar o split nao conserta subscript, e vice-versa.
  function opcao(op) {
    if (op == "shwordsplit") SPLIT = 1
    else if (op == "ksharrays" || op == "kshzerosubscript") KSHARR = 1
  }
  # A substituicao JUNTA a lista numa linha por espaco/tab? (so os comandos DIRETOS dela)
  function junta(c, k,   cmd, a, w, n, p, temS, delim) {
    cmd = V_[c, k]
    for (a = k; a <= CN[c]; a++) if (V_[c, a] ~ /join\(" "\)/ || V_[c, a] ~ /join\("\\t"\)/) return 1
    if (cmd == "tr") {
      n = 0
      for (a = k + 1; a <= CN[c]; a++) {
        w = V_[c, a]
        if (n == 0 && w ~ /^-/) { if (w ~ /d/) return 0; continue }        # tr -d apaga, nao junta
        OP[++n] = w
      }
      return (n >= 2 && OP[1] ~ /^(\\n|\\012|\\r\\n)$/ && OP[2] ~ /^([ \t]|\\t|\\040)+$/)
    }
    if (cmd == "paste") {
      temS = 0; delim = "\t"
      for (a = k + 1; a <= CN[c]; a++) {
        w = V_[c, a]
        if (w !~ /^-./) continue
        if (w ~ /^-[A-Za-z]*s/) temS = 1
        if (w ~ /^-[A-Za-z]*d/) {
          p = index(w, "d"); delim = substr(w, p + 1)
          if (delim == "" && a < CN[c]) { a++; delim = V_[c, a] }
        }
      }
      return (temS && delim ~ /^([ \t]|\\t)+$/)
    }
    if (cmd == "xargs") {
      for (a = k + 1; a <= CN[c]; a++) {
        w = V_[c, a]
        if (w ~ /^-/) { if (w ~ /^-[A-Za-z0-9]*[nLIiJl]/) return 0; if (w ~ /^-[dEsP]$/) a++; continue }
        return (w == "echo" && a == CN[c])
      }
      return 1                                  # xargs sem comando = echo: junta
    }
    return 0
  }
  function ultima(nome, p,   j, m, mp) {        # a atribuicao de `nome` mais recente ANTES de p
    m = 0; mp = -1
    for (j = 1; j <= NA; j++) if (AN[j] == nome && AP[j] < p && AP[j] > mp) { m = j; mp = AP[j] }
    return m
  }
  function viola(r, c, p) { if (VR == "" || p < VP) { VR = r; VC = c; VP = p } }
  function regra_set(c, k,   a, w, nome) {
    a = k + 1
    while (a <= CN[c] && S_[c, a] == "L") {
      w = V_[c, a]
      if (w == "--" || w == "-") { a++; break }
      if (w !~ /^[-+][A-Za-z]+$/) break
      if (w ~ /o$/) a++                         # -o OPCAO leva argumento
      a++
    }
    if (a != CN[c]) return                      # a lista posicional tem de ser UMA palavra
    nome = N_[c, a]
    if (nome != "" && !(nome in ARR) && !(nome in ESPECIAL)) viola("ZSH-NAO-DIVIDE-SET", c, P_[c, a])
  }
  function regra_for(c, k,   a, nome) {
    a = k + 1
    while (a <= CN[c] && S_[c, a] == "L" && V_[c, a] != "in" && V_[c, a] ~ /^[A-Za-z_][A-Za-z0-9_]*$/) a++
    if (a == k + 1 || a > CN[c] || S_[c, a] != "L" || V_[c, a] != "in") return
    if (a + 1 != CN[c]) return                  # lista de UMA palavra (for f in $A $B enumera)
    nome = N_[c, CN[c]]
    if (nome == "" || (nome in ARR) || (nome in ESPECIAL)) return
    if (ultima(nome, P_[c, CN[c]]) == 0) return # atribuida AQUI, antes do laco
    viola("ZSH-NAO-DIVIDE-FOR", c, P_[c, CN[c]])
  }
  function regra_args(c, k,   a, nome, j) {
    for (a = k + 1; a <= CN[c]; a++) {
      nome = N_[c, a]
      if (nome == "" || (nome in ARR)) continue
      j = ultima(nome, P_[c, a])
      if (j == 0) continue
      if ((AID[j] > 0 && JUNTA[AID[j]]) || ALIT[j]) { viola("ZSH-NAO-DIVIDE-ARGS", c, P_[c, a]); return }
    }
  }
  # IDX0: a palavra le `${nome[0]}` e `nome` e array DECLARADO neste comando. O predicado e a
  # DECLARACAO, nunca o nome — por isso `${BASH_SOURCE[0]}` (array do bash, vindo do ambiente, 55
  # das 87 chamadas do corpus) fica calado, e tambem o escalar: `${s[0]}` tambem e vazio no zsh,
  # mas ali o idioma e outro (`${s[1]}` e o 1o CARACTERE, medido) e pediria outra mensagem.
  function regra_idx0(c,   k, m, i, nm) {
    for (k = 1; k <= CN[c]; k++) {
      if (Z_[c, k] == "") continue
      m = split(Z_[c, k], Z0_, " ")
      for (i = 1; i <= m; i++) {
        nm = Z0_[i]
        if (nm in ARR) { viola("ZSH-INDICE-ZERO", c, P_[c, k]); return }
      }
    }
  }
  function trecho(c,   k, s) {
    s = ""
    for (k = 1; k <= CN[c]; k++) s = s (k > 1 ? " " : "") R_[c, k]
    gsub(/[\t\n]/, " ", s)
    return substr(s, 1, 160)
  }
  END {
    while (D > 1) { if (CT[D] == "C") fimcmd(D); else if (CT[D] == "R") fimpal(D); D-- }
    fimcmd(1)
    # passo 1: atribuicoes, arrays declarados, opcoes que LIGAM o split, substituicoes que juntam
    for (c = 1; c <= NC; c++) {
      k = cabeca(c)
      for (a = AI; a <= AF; a++) atrib(c, a, 0)
      if (k > CN[c] || S_[c, k] != "L") continue
      cmd = V_[c, k]
      if (CS[c] > 0 && junta(c, k)) JUNTA[CS[c]] = 1
      if (cmd in DECLARA) {
        arr = 0
        for (a = k + 1; a <= CN[c]; a++) {
          w = V_[c, a]
          if (S_[c, a] == "L" && w ~ /^[-+][A-Za-z]+$/) { if (w ~ /[aA]/) arr = 1; continue }
          if (S_[c, a] ~ /^L=/) atrib(c, a, arr)
          else if (arr && S_[c, a] == "L") ARR[w] = 1
        }
      } else if (cmd == "read") {
        arr = 0; prim = 1
        for (a = k + 1; a <= CN[c]; a++) {
          if (S_[c, a] != "L") continue
          w = V_[c, a]
          if (w ~ /^-/) { if (w ~ /^-[A-Za-z]*[aA]/) arr = 1; if (w ~ /^-[dinNptuk]$/) a++; continue }
          if (arr && prim) ARR[w] = 1
          else { NA++; AN[NA] = w; AP[NA] = P_[c, a]; AID[NA] = 0 }
          prim = 0
        }
      } else if (cmd == "set") {
        for (a = k + 1; a <= CN[c]; a++) {
          w = V_[c, a]
          if (w ~ /^[-+][A-Za-z]*A[A-Za-z]*$/ && a < CN[c]) { ARR[V_[c, a + 1]] = 1; break }
          if (w ~ /^-[A-Za-z]*o$/ && a < CN[c]) opcao(normaliza(V_[c, a + 1]))
        }
      } else if (cmd == "setopt") {
        for (a = k + 1; a <= CN[c]; a++) opcao(normaliza(V_[c, a]))
      } else if (cmd == "emulate") {
        # `emulate sh`/`ksh` liga as DUAS: o split E o indice base 0 (KSH_ARRAYS entra no pacote).
        for (a = k + 1; a <= CN[c]; a++) if (V_[c, a] == "sh" || V_[c, a] == "ksh") { SPLIT = 1; KSHARR = 1 }
      }
    }
    # passo 2a: IDX0. NAO e calado por SPLIT — ligar o word splitting nao muda o indice base do
    # array (as duas opcoes sao ortogonais, medido). Precisa de laco PROPRIO porque a violacao
    # mora em comando que pode nao ter palavra de comando nenhuma: `f="${fila[0]}"` e atribuicao
    # pura, e o `cabeca()` do passo 2b descarta esse comando antes de olhar a palavra.
    if (!KSHARR) for (c = 1; c <= NC; c++) regra_idx0(c)
    # passo 2b: as tres formas do word splitting; vale a PRIMEIRA violacao no texto
    if (!SPLIT) for (c = 1; c <= NC; c++) {
      k = cabeca(c)
      if (k > CN[c] || S_[c, k] != "L") continue
      cmd = V_[c, k]
      if (cmd == "set") regra_set(c, k)
      else if (cmd == "for") regra_for(c, k)
      else if (!(cmd in NAOALVO)) regra_args(c, k)
    }
    if (VR != "") printf "%s\t%s\n", VR, trecho(VC)
  }
' 2>/dev/null)"

[ -n "$saida" ] || exit 0
ramo="${saida%%$'\t'*}"
trecho="${saida#*$'\t'}"
trecho="${trecho%%$'\n'*}"

# ZSH-NAO-DIVIDE-{SET,FOR,ARGS} e ZSH-INDICE-ZERO sao CONTRATO DE TESTE: ASCII, caixa fixa, e o
# PREFIXO do additionalContext (antes do 1o `:`). scripts/test-word-split-zsh-guard.sh compara por
# IGUALDADE — e ZSH-INDICE-ZERO e distinto de PIPESTATUS-INDICE-ZERO (o marcador do hook vizinho)
# nos DOIS sentidos de substring, para que `command grep -F` de uma suite nunca case a da outra.
IFS= read -r -d '' idioma_linha <<'MSG' || true
Idioma certo (vale nos DOIS shells) — partir UMA LINHA em campos:
  read -r status conclusao <<< "$st"
ou nao partir nada: um campo por consulta (--jq '.status', depois --jq '.conclusion').
NAO use ${=st} nem setopt SH_WORD_SPLIT como conserto: sao zsh puro — no bash, ${=st} e "bad
substitution" e ABORTA o script inteiro, e setopt vira "command not found".

Isto e um AVISO, nao um bloqueio. Se o valor e mesmo uma palavra so, ignore.
Para silenciar: WORD_SPLIT_INTENCIONAL=1 <cmd>
MSG
IFS= read -r -d '' idioma_lista <<'MSG' || true
Idioma certo (vale nos DOIS shells) — LISTA como array, um item por linha:
  arr=(); while IFS= read -r l; do arr+=("$l"); done < <(cmd)
  for v in "${arr[@]}"; do ...; done        # ou: comando "${arr[@]}"
Para so iterar, nem precisa do array:  while IFS= read -r v; do ...; done < <(cmd)
Conte o que chegou ANTES de ler o veredito (voltas do laco, ARGC, "Test Files N passed"): array
vazio vira comando SEM argumento — e `vitest run` sem filtro e a suite INTEIRA. Evite `| xargs cmd`
pelo mesmo motivo: com entrada vazia o xargs do macOS nao roda nada e sai 0, e o GNU (o do CI)
roda `cmd` sem argumento.

Isto e um AVISO, nao um bloqueio. Para silenciar: WORD_SPLIT_INTENCIONAL=1 <cmd>
MSG
IFS= read -r -d '' idioma_indice <<'MSG' || true
Idioma certo no zsh — array comeca em 1:
  primeiro="${arr[1]}"                      # e o ULTIMO e "${arr[-1]}"
  for v in "${arr[@]}"; do ...; done        # iterar nao precisa de indice nenhum
Consumindo como FILA, descarte o 1o com "${arr[@]:1}" — esse offset de slice E base 0 nos dois
shells, e por isso `f="${fila[0]}"; fila=("${fila[@]:1}")` mistura as duas bases no mesmo laco.
Portavel nos DOIS shells, sem indice:  set -- "${arr[@]}"; primeiro="$1"
Conte o que chegou ANTES de ler o veredito: "${#arr[@]}". Array vazio e `[0]` ausente dao o MESMO
vazio — e vazio em teste numerico do zsh vale 0, que e sucesso e tambem "nenhum".

Isto e um AVISO, nao um bloqueio. Sob KSH_ARRAYS/KSH_ZERO_SUBSCRIPT o [0] e legitimo: ignore.
Para silenciar: WORD_SPLIT_INTENCIONAL=1 <cmd>
MSG

# shellcheck disable=SC2016  # as mensagens ENSINAM o idioma: $1, $var e ${arr[@]} sao literais
case "$ramo" in
  ZSH-NAO-DIVIDE-SET)
    msg='🔴 `set -- $var` no zsh: $1 recebe a linha INTEIRA e $2 fica vazio — use read -r a b <<< "$var"'
    ctx="ZSH-NAO-DIVIDE-SET: este comando faz \`set -- \$var\` contando com o word splitting do bash (trecho: \`$trecho\`). O Bash tool roda em /bin/zsh, e o zsh NAO divide expansao de variavel sem aspas (SH_WORD_SPLIT desligado, medido): com st=\"completed success\", \`set -- \$st\` da \$1=\"completed success\" e \$2 VAZIO. Nada falha — \`set --\` sempre funciona, \$2 sempre existe, e a comparacao sempre responde, so nunca com a verdade. Aconteceu em 2026-09-18 e 2026-09-25 em laco de espera de CI: o laco foi ate o teto de 30 min com o veredito pronto desde a 1a consulta (docs/historico/evidencia-positiva-shell.md §21).

$idioma_linha" ;;
  ZSH-NAO-DIVIDE-FOR)
    msg='🔴 `for v in $var` no zsh roda UMA volta, com o texto inteiro — itere por linha ou use array'
    ctx="ZSH-NAO-DIVIDE-FOR: este comando itera \`for v in \$var\` sobre uma variavel atribuida AQUI como texto (trecho: \`$trecho\`). No zsh — o shell do Bash tool — variavel sem aspas NAO e dividida em palavras: o laco roda UMA vez, com o texto inteiro (medido: 3 voltas no bash, 1 no zsh). \`\$(cmd)\` direto divide; guardar a mesma saida numa variavel e expandir depois, nao — o defeito nasce no refactor inocente de 'por numa variavel para ficar legivel'. Em 2026-08-25, \`for c in \$fatias\` rodou uma vez com o blob do git log inteiro e fabricou '21 edges limpas' (docs/historico/evidencia-positiva-shell.md §21).

$idioma_lista" ;;
  ZSH-NAO-DIVIDE-ARGS)
    msg='🔴 `cmd $var` no zsh entrega UM argumento com a lista inteira dentro — use array e "${arr[@]}"'
    ctx="ZSH-NAO-DIVIDE-ARGS: este comando passa \`\$var\` sem aspas como argumento (trecho: \`$trecho\`), e \`var\` foi montada AQUI como LISTA numa string so (literal com espaco, ou \`\$(... | tr '\\n' ' ')\`/\`paste -s\`/\`xargs\`). No zsh — o shell do Bash tool — variavel sem aspas NAO e dividida: o comando recebe UM argumento com a lista inteira dentro. Com \`tr '\\n' ' '\` nem UM item escapa: o espaco final vai junto — \"x.test.ts \" nao casa filtro nenhum (o vitest rodou 16 de 17 sem avisar) e \`kill \"79967 \"\` e pid ilegal. Duas vezes foi o vitest (2026-07-16 e 2026-09-25): 'No test files found', exit 1, zero testes — a linha \`filter:\` mostrava UM filtro com todos os caminhos dentro (docs/historico/evidencia-positiva-shell.md §21).

$idioma_lista" ;;
  ZSH-INDICE-ZERO)
    msg='🔴 array do zsh comeca em 1: `${arr[0]}` e SEMPRE vazio — o primeiro e `${arr[1]}`'
    ctx="ZSH-INDICE-ZERO: este comando le \`\${arr[0]}\` de um array DECLARADO aqui mesmo (trecho: \`$trecho\`). O Bash tool roda em /bin/zsh, onde array e 1-INDEXED: com \`arr=(a b c)\`, \${arr[0]} e VAZIO e \${arr[1]} e \"a\" — no bash seriam \"a\" e \"b\" (medido nos dois shells em 2026-10-08). Nada falha: a expansao devolve string vazia, e vazio no \`[\` do zsh vale 0 — que e o exit code de SUCESSO e tambem o contador \"nenhum\". E a §9 do catalogo sem o nome PIPESTATUS: em 2026-09-05/06 um BFS de imports com \`f=\"\${queue[0]}\"\` nunca entrou no laco e imprimiu \`closure_count=0\` — zero com cara de resultado (docs/historico/evidencia-positiva-shell.md §9).

$idioma_indice" ;;
  *) exit 0 ;;   # ramo desconhecido: o awk mudou e este bloco nao — calado e melhor que aviso errado
esac

# ── SENSOR DE CAMPO ───────────────────────────────────────────────────────────────────────────
# Sem isto ninguem responde "quantas vezes disparou, e em que" — e a decisao de manter, afrouxar
# ou aposentar este guard ficaria sem denominador (docs/historico/fase-sem-sinal.md: superficie de
# uso nasce COM o sensor). Formato IGUAL ao dos guards vizinhos, lido pelo mesmo script:
#   bash scripts/pipestatus-guard-sinal.sh ~/.claude/afiacao-word-split-guard.jsonl
# FORA do repo de proposito: ~30 worktrees compartilham este guard, e log versionado viraria ima
# de conflito. Falha de log NUNCA cala o aviso: todo o bloco e best-effort.
TETO_LINHA=511   # 511 + o "\n" = 512 = PIPE_BUF do macOS, o mais estrito das plataformas em jogo
registrar_sinal() {
  local log dir linha wt corte janela ts d seguro
  log="${WORD_SPLIT_GUARD_LOG:-${HOME:-}/.claude/afiacao-word-split-guard.jsonl}"
  [ -n "${WORD_SPLIT_GUARD_LOG:-}" ] || [ -n "${HOME:-}" ] || return 0
  dir="${log%/*}"
  [ -d "$dir" ] || (umask 077; mkdir -p "$dir") 2>/dev/null || return 0
  # Nasce 0600: o arquivo guarda FRAGMENTO DE COMANDO.
  [ -e "$log" ] || (umask 077; : >> "$log") 2>/dev/null || return 0
  chmod 600 "$log" 2>/dev/null || true
  # Redacao: o trecho e um comando simples so, mas se um segredo encostar nele ele NAO vai para o
  # disco (o CLAUDE.md proibe segredo em texto plano em disco, e log tambem e disco). Mesma lista
  # dos guards vizinhos, medida la.
  seguro="$(printf '%s' "$1" | sed -E \
    -e 's/(eyJ[A-Za-z0-9_.-]{8,})/<JWT-REDIGIDO>/g' \
    -e 's/(gh[pousr]_|github_pat_|xox[baprs]-|sk-)[A-Za-z0-9_-]{6,}/\1<REDIGIDO>/g' \
    -e 's/([Aa]uthorization[[:space:]]*:[[:space:]]*[A-Za-z]+[[:space:]]+)[^[:space:]"'"'"']+/\1<REDIGIDO>/g' \
    -e 's|([a-zA-Z][a-zA-Z0-9+.-]*://[^:/[:space:]]+:)[^@[:space:]]+@|\1<REDIGIDO>@|g' \
    -e 's/(-u[[:space:]]+[^:[:space:]]+:)[^[:space:]"'"'"']+/\1<REDIGIDO>/g' \
    -e 's/(--?(password|passwd|pwd|token|secret|api-?key)[[:space:]]+)[^[:space:]"'"'"']+/\1<REDIGIDO>/gI' \
    -e 's/((token|key|secret|senha|password|passwd|pwd|auth|apikey|pat)["'"'"']?[=:][[:space:]]*["'"'"']?)[^[:space:]"'"'"']+/\1<REDIGIDO>/gI' \
    -e 's/([Bb]earer[[:space:]]+)[^[:space:]]+/\1<REDIGIDO>/g' 2>/dev/null)"
  seguro="${seguro:-<REDACAO-FALHOU-TRECHO-DESCARTADO>}"
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null)"
  # Sobe a arvore ate o `.git` em bash puro: `${PWD##*/}` gravaria o basename do CWD.
  d="$PWD"
  wt=""
  while [ -n "$d" ] && [ "$d" != "/" ]; do
    if [ -e "$d/.git" ]; then wt="${d##*/}"; break; fi
    d="${d%/*}"
  done
  wt="$(printf '%.48s' "${wt:-${PWD##*/}}")"
  # `jq -a` forca saida ASCII pura => ${#linha} conta BYTES em QUALQUER locale. O teto e conferido
  # na LINHA PRONTA: o escape do JSON infla DEPOIS do corte (medido no guard vizinho).
  for corte in 160 80 40 0; do
    if [ "$corte" -eq 0 ]; then janela='<TRECHO-OMITIDO-LINHA-LONGA>'
    else janela="$(printf "%.${corte}s" "$seguro")"; fi
    linha="$(jq -n -c -a --arg ts "$ts" --arg ramo "$2" --arg trecho "$janela" --arg wt "$wt" \
      '{ts:$ts, ramo:$ramo, trecho:$trecho, wt:$wt}' 2>/dev/null)" || return 0
    [ -n "$linha" ] || return 0
    [ "${#linha}" -lt "$TETO_LINHA" ] && break
  done
  [ "${#linha}" -lt "$TETO_LINHA" ] || return 0
  printf '%s\n' "$linha" >> "$log" 2>/dev/null || return 0
}
registrar_sinal "$trecho" "$ramo"

jq -n --arg m "$msg" --arg c "$ctx" \
  '{systemMessage:$m, hookSpecificOutput:{hookEventName:"PreToolUse", additionalContext:$c}}'
exit 0
