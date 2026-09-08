#!/usr/bin/env bash
# ocupacao-contexto.sh — de ONDE vem o contexto acumulado de uma sessão (READ-ONLY).
#
# POR QUÊ: o piso de contexto (scripts/piso-contexto.sh) é só 25,9% do custo de
# entrada — os outros 74,1% são a CONVERSA ACUMULADA (medido em 20.933 requests).
# E um tool_result não se paga uma vez: fica no histórico e é RELIDO em todo
# request seguinte da sessão. Logo o custo real de um resultado é
#
#     tamanho x (nº de requests que ainda virão depois dele)
#
# e NÃO o tamanho. Um Read de 50k tokens no começo de uma sessão de 500 requests
# custa mais que cem Reads de 5k no último terço. Este script mede isso.
#
# Primeira medição (3 sessões mais caras de uma janela de 7 dias, US$1.209):
#   Read 56,4% · Bash 39,5% · Edit 2,7% · todo o resto <1%.
#   Read tinha 75 chamadas contra 769 do Bash — e custou MAIS. O tamanho por
#   chamada é que manda, porque ele é relido para sempre.
#
# TRÊS RÉGUAS, UMA FONTE:
#   --por-ferramenta (default) responde "que TIPO de chamada ocupa";
#   --por-arquivo             responde "que ARQUIVO ocupa" — a pergunta que
#                             decide o que destilar primeiro;
#   --por-comando             responde "que COMANDO ocupa" — a pergunta que
#                             sobra depois que --por-arquivo aponta para Bash.
#
# POR QUE --por-comando NÃO CLASSIFICA POR PREFIXO: a primeira palavra do comando
# quase nunca é o produtor da saída. `echo "--- x" && git worktree list | head`
# classificaria como `echo`. Medido: por prefixo, 46,5% das chamadas caem em
# "outros" (piso-de-contexto.md). Aqui o PRODUTOR é o head-word do 1º estágio de
# cada PIPELINE (segmenta em `;` `&&` `||` e newline; dentro do pipeline só o 1º
# estágio produz, o resto é filtro) — o que derruba o não-classificado para 0,3%
# das chamadas. Esse percentual é IMPRESSO: uma taxonomia que não classifica não
# está respondendo, e o número tem de aparecer junto da tabela.
#
# --ver-shell (com --por-arquivo): metade da ocupação de Bash é `sed -n`/`cat`/
# `head`/`tail` sobre um arquivo NOMEADO — leitura de arquivo que cai em
# `(Bash - sem arquivo)` só porque o harness não preenche `file_path`. Com este
# flag esses bytes são atribuídos ao arquivo. É OPT-IN de propósito: a linha de
# base de 2026-09-07 foi medida sem ele e continua reproduzível.
# As três somam o MESMO total: toda chamada sem `file_path` (Bash, Grep, Task…)
# vira a linha agregada `(<tool> — sem arquivo)` em vez de sumir. Bash sozinho é
# 77% da ocupação; um ranking que o omitisse sem dizer seria ausência
# apresentada como medida — o defeito de classe que esta régua existe para achar.
#
# O QUE ESTA RÉGUA NÃO MEDE: só o tool_RESULT entra na conta. O INPUT da chamada
# (o corpo de um Write, o texto novo de um Edit) também ocupa contexto e não é
# contado aqui — para um Write grande, o número sai SUBESTIMADO.
#
# Uso:
#   scripts/ocupacao-contexto.sh <arquivo.jsonl> [outro.jsonl ...]
#   scripts/ocupacao-contexto.sh --sessao <uuid>   # procura em ~/.claude/projects
#   scripts/ocupacao-contexto.sh --top 5           # as N sessões mais pesadas (7d)
#   scripts/ocupacao-contexto.sh --por-arquivo     # ranking por ARQUIVO (30d, projetos afiacao)
#   scripts/ocupacao-contexto.sh --por-arquivo --dias 7 --linhas 30
#   scripts/ocupacao-contexto.sh --por-arquivo --todos   # a máquina inteira, não só afiacao
#   scripts/ocupacao-contexto.sh --por-comando           # ranking por COMANDO produtor
#   scripts/ocupacao-contexto.sh --por-arquivo --ver-shell  # dobra `cat`/`sed` no ranking
#
# Fail-closed: sem sessão na janela, ou sem NENHUM evento extraído, o script sai
# VERMELHO com a causa. Tabela vazia nunca é resposta — foi um `xargs -a` (que não
# existe no BSD) com 2>/dev/null que quase produziu o veredito "docs/agent nunca é
# lido", o oposto da verdade. Fim bem-sucedido imprime OCUPACAO-CONTEXTO-OK.
#
# Nada sai da máquina; nenhum arquivo do projeto é alterado.
set -euo pipefail

# Números com PONTO decimal, SEMPRE. Sob pt_BR.UTF-8 (o locale desta máquina) o
# `printf` do awk emite "0,2" no lugar de "0.2" — e o estrago não é cosmético:
# a chave de ordenação deste script é um `%018.3f`, então o `sort -rn` do meio do
# pipeline passa a ler "199,000" com a vírgula do locale e pode REORDENAR o
# ranking. Uma régua cuja resposta depende do ambiente de quem a roda não é
# régua. LC_ALL (não LC_NUMERIC) porque LC_ALL do ambiente venceria o mais
# específico. Pego pela falsificação nos dois locales, não por revisão.
export LC_ALL=C

RAIZ="${CLAUDE_PROJECTS_DIR:-$HOME/.claude/projects}"
CHARS_POR_TOKEN=3.5   # aproximação p/ mistura pt-BR + código
# Mesmo token que filtra os projetos e que normaliza o path: um arquivo lido de
# 30 worktrees diferentes é UM arquivo. Sem colapsar, o ranking se pulveriza e o
# doc mais caro do repo não aparece em lugar nenhum. Tratado como ERE pelo awk.
PADRAO_REPO="${OCUPACAO_REPO_PADRAO:-afiacao}"
ALVOS=()
TOP=0
MODO=ferramenta
DIAS=30
TODOS=0
LINHAS=0
VER_SHELL=0
AUTO_COLETA=0   # 1 só quando a janela/escopo REALMENTE selecionou os alvos

while [ $# -gt 0 ]; do
  case "$1" in
    --sessao)
      alvo=$(find "$RAIZ" -name "${2:?--sessao exige um uuid}.jsonl" -type f 2>/dev/null | head -1)
      [ -n "$alvo" ] || { echo "sessão ${2} não encontrada em $RAIZ" >&2; exit 1; }
      ALVOS+=("$alvo"); shift 2 ;;
    --top)     TOP="${2:?--top exige um número}"; shift 2 ;;
    --por-arquivo)    MODO=arquivo; shift ;;
    --por-ferramenta) MODO=ferramenta; shift ;;
    --por-comando)    MODO=comando; shift ;;
    --ver-shell)      VER_SHELL=1; shift ;;
    --dias)    DIAS="${2:?--dias exige um número}"; shift 2 ;;
    --linhas)  LINHAS="${2:?--linhas exige um número}"; shift 2 ;;
    --todos)   TODOS=1; shift ;;
    -h|--help) sed -n '2,64p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) echo "opção desconhecida: $1 (use --help)" >&2; exit 2 ;;
    *) ALVOS+=("$1"); shift ;;
  esac
done

command -v jq >/dev/null || { echo "jq é necessário (brew install jq)" >&2; exit 1; }

# Flag ignorado em silêncio é flag que mente sobre o que a tabela mede.
if [ "$VER_SHELL" -eq 1 ] && [ "$MODO" != arquivo ]; then
  echo "ERRO: --ver-shell só se aplica a --por-arquivo (modo atual: ${MODO})." >&2
  exit 2
fi

if [ "$LINHAS" -le 0 ]; then
  case "$MODO" in arquivo) LINHAS=20 ;; comando) LINHAS=22 ;; *) LINHAS=14 ;; esac
fi

# --top N: as N sessões maiores em bytes. O custo cresce ~quadraticamente com o
# nº de requests, então as maiores dominam — é um proxy barato de "sessão cara".
if [ "$TOP" -gt 0 ]; then
  while IFS= read -r linha; do
    ALVOS+=("$linha")
  done < <(find "$RAIZ" -name '*.jsonl' -type f -mtime -7 2>/dev/null \
      | while IFS= read -r f; do printf '%s\t%s\n' "$(wc -c < "$f" | tr -d ' ')" "$f"; done \
      | sort -rn | head -"$TOP" | cut -f2)
fi

# --por-arquivo sem alvo explícito: a janela inteira. Default são os projetos do
# repo (dir contendo $PADRAO_REPO); --todos abre para a máquina.
if { [ "$MODO" = arquivo ] || [ "$MODO" = comando ]; } && [ "${#ALVOS[@]}" -eq 0 ]; then
  AUTO_COLETA=1
  DIRS_BUSCA=()
  if [ "$TODOS" -eq 1 ]; then
    DIRS_BUSCA=("$RAIZ")
  else
    while IFS= read -r d; do DIRS_BUSCA+=("$d"); done < <(
      find "$RAIZ" -mindepth 1 -maxdepth 1 -type d -name "*${PADRAO_REPO}*" 2>/dev/null | sort)
    if [ "${#DIRS_BUSCA[@]}" -eq 0 ]; then
      echo "ERRO: nenhum projeto casando '*${PADRAO_REPO}*' em $RAIZ (use --todos)." >&2
      exit 3
    fi
  fi
  while IFS= read -r linha; do
    ALVOS+=("$linha")
  done < <(find "${DIRS_BUSCA[@]}" -name '*.jsonl' -type f -mtime "-${DIAS}" 2>/dev/null | sort)
  if [ "${#ALVOS[@]}" -eq 0 ]; then
    echo "ERRO: nenhuma sessão nos últimos ${DIAS} dias. Aumente --dias ou use --todos." >&2
    echo "      (silêncio aqui seria ausência de dado, não ocupação zero.)" >&2
    exit 3
  fi
fi

[ "${#ALVOS[@]}" -gt 0 ] || { echo "informe ao menos um .jsonl (use --help)" >&2; exit 2; }
echo "sessões analisadas: ${#ALVOS[@]}" >&2
# só declara janela/escopo quando eles de fato SELECIONARAM as sessões: com alvo
# explícito na linha de comando, anunciar "30d · projetos afiacao" seria descrever
# um recorte que não foi aplicado.
if [ "$AUTO_COLETA" -eq 1 ]; then
  if [ "$TODOS" -eq 1 ]; then escopo="máquina inteira"; else escopo="projetos *${PADRAO_REPO}*"; fi
  echo "janela: ${DIAS}d · escopo: ${escopo}" >&2
fi

# Fluxo ordenado de eventos; o awk faz a contabilidade:
#   REQ <sessao> <requestId>          -> passou um request faturável (marca o tempo)
#   USE <sessao> <id> <nome> <path>   -> amarra tool_use_id ao nome e ao arquivo
#   RES <sessao> <id> <chars>         -> um resultado entrou no histórico
# Template explícito, e NUNCA `mktemp -t <prefixo>`: `-t` é flag homônima
# BSD×GNU — no macOS o argumento é um PREFIXO e funciona; no GNU (o CI) é um
# TEMPLATE que exige ≥3 X's, e `mktemp: too few X's` derruba o script inteiro via
# `set -e`. Verde no macOS, vermelho no Linux, pelo mesmo código. É a armadilha #6
# de docs/historico/evidencia-positiva-shell.md, e ela custou uma rodada de CI
# justamente no PR que a documenta.
BRUTO=$(mktemp "${TMPDIR:-/tmp}/ocupacao-contexto.XXXXXX")
trap 'rm -f "$BRUTO"' EXIT

# `if ! jq`, e não `jq` solto: sob `set -e` um único transcript com linha
# ilegível abortaria o script INTEIRO — exit 5, nenhuma mensagem, 684 sessões de
# trabalho no lixo. E linha ilegível é o caso NORMAL aqui: uma sessão viva está
# escrevendo o .jsonl neste instante, e a última linha vem pela metade. `set -e`
# é suspenso pelo contexto de chamada, então o `if !` é o que segura.
# O jq já emitiu tudo que veio ANTES do ponto de quebra, então o dado válido não
# se perde — o que não pode é o descarte ser calado, senão a régua vira o
# `2>/dev/null` que ela existe para denunciar. Por isso conta e declara.
parse_falhou=0
for f in "${ALVOS[@]}"; do
  if ! jq -rc '
    . as $l
    | ($l.sessionId // "?") as $s
    | (if ($l.message.usage != null)
       then "REQ\t\($s)\t\($l.requestId // $l.uuid // "-")" else empty end),
    ( $l.message.content? | if type=="array" then .[] else empty end
      | if .type=="tool_use"
        then "USE\t\($s)\t\(.id // "?")\t\(.name // "?")\t\((.input.file_path // "")|tostring|gsub("\t";" "))\t\((.input.command // "")|tostring|gsub("[\\t\\r]";" ")|gsub("\\n";";"))"
        elif .type=="tool_result" then "RES\t\($s)\t\(.tool_use_id // "?")\t\((.content|tostring)|length)"
        else empty end )
  ' "$f" 2>/dev/null >>"$BRUTO"; then
    parse_falhou=$((parse_falhou + 1))
  fi
done

if [ "$parse_falhou" -gt 0 ]; then
  echo "AVISO: ${parse_falhou} de ${#ALVOS[@]} sessão(ões) com linha ilegível (transcript" >&2
  echo "       truncado ou sendo escrito agora). Os eventos ANTERIORES ao ponto de" >&2
  echo "       quebra entraram na conta; o que vinha depois, nessas sessões, não." >&2
fi

# Controle POSITIVO: extração vazia sai vermelho. Um `jq` que morreu, um formato
# de transcrição que mudou e um projeto realmente ocioso produzem exatamente a
# mesma saída — nenhuma linha — e só esta checagem os separa de "ocupação zero".
if [ ! -s "$BRUTO" ]; then
  echo "ERRO: ${#ALVOS[@]} sessão(ões) lidas e NENHUM evento extraído." >&2
  echo "      Causas prováveis: jq falhou, ou o formato do transcript mudou." >&2
  echo "      Isto NÃO é 'ocupação zero' — é ausência de dado." >&2
  exit 4
fi

awk -F'\t' -v cpt="$CHARS_POR_TOKEN" -v modo="$MODO" -v padrao="$PADRAO_REPO" \
    -v lar="$HOME" -v ver_shell="$VER_SHELL" '
BEGIN { ASPAS = sprintf("[%c%c]", 34, 39) }   # classe com aspa dupla e simples,
# montada por codigo de caractere: embutir aspa simples na linha do shell fecharia
# o programa awk, e o idioma de escape so vale DENTRO de uma string single-quoted.
# ---- classificador de COMANDO -----------------------------------------------
# O PRODUTOR da saída é o head-word do 1º estágio de cada PIPELINE. Segmenta em
# `;` `&&` `||` (a newline já virou `;` no jq) e, dentro de um pipeline, só o 1º
# estágio produz — `git log | head` é `git log`, não `head`. Sem esta regra a
# classificação vira "primeira palavra", e a primeira palavra costuma ser `echo`
# ou `cd`: por prefixo, 46,5% das chamadas caem em "outros".
function limpa(t) {
  sub(/^[ \t({]+/, "", t)
  # FOO=bar cmd  — prefixo de atribuição não é o comando
  while (t ~ /^[A-Za-z_][A-Za-z0-9_]*=/) sub(/^[A-Za-z_][A-Za-z0-9_]*=[^ ]*[ ]*/, "", t)
  # wrappers que não produzem saída própria
  while (t ~ /^(command|sudo|time|env|nohup|exec|builtin)[ ]+/) sub(/^[^ ]+[ ]+/, "", t)
  sub(/^[ \t]+/, "", t)
  return t }
# DUAS classes, e confundi-las custa a classificação inteira:
#  - `pula_segmento`: comando real que nunca é a causa do volume. Pular só a
#    PALAVRA deixaria o argumento virar rótulo (`echo "--- x"` -> rótulo `x`).
#  - `so_sintaxe`: palavra de estrutura. Aqui é o contrário — pular o segmento
#    perderia o produtor que vem logo atrás (`do cat $f` -> perde o `cat`).
function pula_segmento(w) {
  if (w == "") return 1
  return (w ~ /^(echo|printf|cd|set|export|true|:|\[|test|source|\.|fi|done|esac|for|while|if|until|case)$/) }
function so_sintaxe(w) { return (w ~ /^(then|do|else|elif|\{|\()$/) }
# multiplexer: `git` sozinho não é acionável — `git log` e `git diff` são.
function subcmd(w, resto,   a, i, nn) {
  if (w !~ /^(git|gh|bun|npm|npx|bunx|supabase|docker|deno|cargo|go)$/) return w
  nn = split(resto, a, " ")
  for (i = 1; i <= nn; i++) { if (a[i] != "" && a[i] !~ /^-/) return w " " a[i] }
  return w }
function classifica(cmd,   segs, ns, i, est, seg, w, resto, sp, guarda) {
  gsub(ASPAS, " ", cmd)                 # aspas viram espaço: não mudam o head-word
  ns = split(cmd, segs, /&&|\|\||;/)
  for (i = 1; i <= ns; i++) {
    split(segs[i], est, /\|/)           # dentro do pipeline, só o 1º estágio
    seg = limpa(est[1])
    # descasca palavra de sintaxe até achar o comando de verdade no MESMO segmento
    for (guarda = 0; guarda < 6; guarda++) {
      sp = index(seg, " ")
      if (sp > 0) { w = substr(seg, 1, sp - 1); resto = substr(seg, sp + 1) }
      else        { w = seg; resto = "" }
      if (!so_sintaxe(w)) break
      seg = limpa(resto) }
    if (pula_segmento(w)) continue
    if (w == "") continue
    return subcmd(w, resto) }
  return "(nao classificado)" }
# ---- alvos de leitura via shell (--ver-shell) --------------------------------
# `sed -n 1,120p X`, `cat X`, `head -40 X`, `tail X` leem um arquivo NOMEADO e
# caem em `(Bash - sem arquivo)` só porque o harness não preenche file_path.
function alvos(cmd,   segs, ns, i, est, seg, a, na, j, t, out) {
  gsub(ASPAS, " ", cmd); ns = split(cmd, segs, /&&|\|\||;/)
  for (i = 1; i <= ns; i++) {
    split(segs[i], est, /\|/); seg = limpa(est[1])
    na = split(seg, a, " ")
    if (na == 0) continue
    if (a[1] !~ /^(sed|cat|head|tail)$/) continue
    out = ""
    for (j = 2; j <= na; j++) {
      t = a[j]
      if (t ~ /^-/) continue                 # flag
      if (t ~ /^[0-9,]+[a-z]?$/) continue    # range do sed (1,120p)
      if (t ~ /^(s|y)\//) continue           # script do sed, não arquivo
      if (t ~ /^[0-9]?[<>&]/) continue       # redirecionamento (2>/dev/null)
      if (t ~ /^\$/) continue                # variável não resolvida
      if (t ~ /\\/) continue                 # escape: expressão, não caminho
      if (t ~ /^\/dev\//) continue
      if (t !~ /[\/.]/) continue             # sem barra nem ponto: não é caminho
      if (t !~ /^[A-Za-z0-9_.~@\/-]+$/) continue
      out = out (out == "" ? "" : " ") t }
    if (out != "") return out }
  return "" }
function normaliza(p,   q) {
  q = p
  # 1) o repo, em qualquer worktree, colapsa no caminho relativo ao repo
  sub("^.*/" padrao "[^/]*/", "", q)
  sub("^\\.claude/worktrees/[^/]*/", "", q)
  # 2) fora do repo: pelo menos encurta o home, para o ranking caber na tela
  if (q == p && lar != "") sub("^" lar "/", "~/", q)
  return q
}
# dedupe por (sessao, requestId): UMA chamada de API vira VÁRIAS linhas no JSONL
# quando a resposta tem vários blocos, e todas repetem o mesmo usage. Medido
# neste repo: 329 linhas para 144 requests (2,28x). Sem isto, `restantes` — e
# portanto TODA a régua — sai inflado. Herdado de tokens-report.sh (06/08).
# Chave inclui a sessão porque `restantes` é posicional DENTRO da sessão; "-"
# (transcript antigo, sem requestId nem uuid) nunca colapsa.
$1=="REQ" {
  s=$2; k=s SUBSEP $3
  if ($3 != "-" && (k in visto)) next
  visto[k]=1; req[s]++; next }
$1=="USE" { nome[$2 SUBSEP $3]=$4; arq[$2 SUBSEP $3]=$5; cmd[$2 SUBSEP $3]=$6; next }
# a posição importa: só se sabe quantos requests vêm DEPOIS no fim do arquivo
$1=="RES" { n++; rsess[n]=$2; rid[n]=$3; rtam[n]=$4; rpos[n]=req[$2]; next }
END {
  if (n == 0) { print "  (nenhum tool_result encontrado)"; exit }
  for (i = 1; i <= n; i++) {
    ch = rsess[i] SUBSEP rid[i]
    t = (ch in nome) ? nome[ch] : "?"
    restantes = req[rsess[i]] - rpos[i]; if (restantes < 0) restantes = 0
    o = (rtam[i] / cpt) * restantes
    # rótulo em ASCII puro: o printf do awk conta BYTES, então um travessão
    # desalinharia a coluna — e o teste casa esta string sem -i e sem locale.
    nk = 1; kk[1] = t; ww[1] = 1
    if (modo == "arquivo") {
      kk[1] = "(" t " - sem arquivo)"
      if ((ch in arq) && arq[ch] != "") { kk[1] = normaliza(arq[ch]) }
      else if (ver_shell == 1 && t == "Bash") {
        alv = alvos(cmd[ch])
        if (alv != "") {
          # a saída de `cat A B` é UMA saída de dois arquivos e não há como saber
          # o rateio — divide igual e DECLARA. Fabricar um rateio seria pior.
          nk = split(alv, av, " ")
          for (z = 1; z <= nk; z++) { kk[z] = normaliza(av[z]); ww[z] = 1 / nk }
          vs_n++; vs_o += o } }
    } else if (modo == "comando") {
      kk[1] = "(" t " - sem comando)"
      if (t == "Bash") {
        bash_n++; bash_o += o
        kk[1] = classifica(cmd[ch])
        if (kk[1] == "(nao classificado)") { nc_n++; nc_o += o } }
    }
    for (z = 1; z <= nk; z++) {
      k = kk[z]
      ocup[k] += o * ww[z]; chars[k] += rtam[i] * ww[z]; cnt[k]++
      if (rtam[i] > maior[k]) maior[k] = rtam[i] }
    soma += o
  }
  # Uma taxonomia que não classifica não está respondendo, e o número tem de sair
  # JUNTO da tabela — senão o leitor toma um ranking de 54% do volume por um
  # ranking do volume. Marcador ASCII, caixa fixa: casável com grep -F sem locale.
  if (modo == "comando") {
    if (bash_n > 0) {
      printf "TAXONOMIA-NAO-CLASSIFICADO n=%d de %d chamadas Bash (%.1f%%), %.1f%% da ocupacao Bash\n",
             nc_n, bash_n, 100*nc_n/bash_n, 100*nc_o/(bash_o>0?bash_o:1) > "/dev/stderr"
      if (bash_o > 0 && 100*nc_o/bash_o > 25)
        printf "TAXONOMIA-FRACA: mais de 25%% da ocupacao Bash sem classificar — a tabela abaixo NAO responde a pergunta.\n" > "/dev/stderr"
    } else {
      printf "TAXONOMIA-SEM-BASH: nenhuma chamada Bash na janela — a tabela abaixo nao mede comando.\n" > "/dev/stderr" }
  }
  if (modo == "arquivo" && ver_shell == 1)
    printf "VER-SHELL n=%d leituras dobradas no ranking, %.1f%% da ocupacao total\n",
           vs_n+0, 100*vs_o/(soma>0?soma:1) > "/dev/stderr"
  if (soma <= 0) soma = 1
  # zero-padding no 1º campo p/ ordenar numericamente com sort(1) sem perder a chave
  for (k in ocup)
    printf "%018.3f\t%s\t%d\t%d\t%d\t%.1f\n", ocup[k], k, cnt[k], chars[k], maior[k], 100*ocup[k]/soma
}' "$BRUTO" | sort -rn | head -"$LINHAS" | awk -F'\t' -v modo="$MODO" '
BEGIN { w = 30; cab = "ferramenta"
        if (modo == "arquivo") { w = 56; cab = "arquivo" }
        if (modo == "comando") { w = 34; cab = "comando (produtor)" }
        printf "\n%-*s %6s %12s %9s %13s %7s\n", w, cab, "n", "chars tot", "maior", "tok*req(M)", "%" }
{ printf "%-*s %6d %12d %9d %13.1f %6.1f%%\n", w, $2, $3, $4, $5, ($1+0)/1e6, $6 }'

echo
echo "regra: o que pesa não é o tamanho da saída, é tamanho x quanto tempo ela ainda" >&2
echo "fica no contexto. Saída grande CEDO na sessão é a mais cara de todas." >&2
# Marcador positivo de fim: ASCII, caixa fixa, sem acento — casável com grep sem
# -i e sem depender de locale (lição do #1483).
echo "OCUPACAO-CONTEXTO-OK modo=${MODO} sessoes=${#ALVOS[@]}"
