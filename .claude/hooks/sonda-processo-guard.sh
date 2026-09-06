#!/usr/bin/env bash
# sonda-processo-guard.sh — PreToolUse(Bash): AVISA quando um laco espera por um processo
# identificado por PADRAO DE TEXTO, em vez de esperar pelo processo que ELE MESMO iniciou.
#
# POR QUE: `pgrep -f` casa a LINHA DE COMANDO, e a tabela de processos e da MAQUINA, nao da
# worktree. Medido em 2026-09-06 com ~27 sessoes Claude vivas
# (docs/historico/evidencia-positiva-shell.md §13):
#
#   until ! pgrep -f 'mutcheck.sh scripts/sonda-versao-sql' > /dev/null; do sleep 20; done
#   echo "mutcheck local terminou"; grep -E 'sumario|baseline' .mut1.txt | tail -3
#
# O padrao casou CINCO PIDs e nenhum era um mutcheck em execucao — eram shells de outras
# worktrees, incluindo o PROPRIO watcher (a cmdline dele contem o texto que ele procura). Os dois
# desfechos sao o mesmo defeito de identidade:
#   - so casa o trabalho ALHEIO  -> declara fim quando o VIZINHO acaba, e le arquivo vazio
#                                   (grep sem ocorrencia = zero linhas = "sem problema")
#   - casa a si mesmo/outro watcher -> nunca sai do laco (um ficou preso 06:26:10 numa M2 de 8GB)
#
# A regra em uma linha: AUSENCIA DE PROCESSO ALHEIO NAO E PRESENCA DO MEU RESULTADO.
#
# ── O GATILHO E A CONJUNCAO, NUNCA `pgrep` SOZINHO ────────────────────────────────────────────
# `pgrep -f` tem uso legitimo e cotidiano — `.claude/hooks/vigia-worktree.sh` conta sessoes vivas
# com ele e esta CERTO. So dispara quando as tres coisas aparecem juntas:
#   (1) um laco `while`/`until`;
#   (2) na CONDICAO do laco, uma sonda de processo por texto (`pgrep …`, ou `ps` + `grep`);
#   (3) no CORPO do laco, um `sleep` — o que o torna uma ESPERA, e nao outra coisa.
# Medida do corpus (2026-09-06): os 2 usos executaveis de pgrep no repo nao casam nenhum dos tres
# — `vigia-worktree.sh` e contagem pontual sem laco, `scripts/test-heavy.sh` usa `-P` (por PPID,
# que identifica uma EXECUCAO, nao um padrao de texto). Taxa base de falso positivo medida: 0.
#
# NAO exige o `-f`: `pgrep <nome>` num laco de espera tem o MESMO defeito de sujeito (mede a
# maquina). O `-f` so agrava, porque a cmdline do proprio watcher entra no conjunto casado.
# NAO olha o SENTIDO da espera (`while pgrep` = espere sumir · `until pgrep` = espere aparecer):
# os dois medem o objeto errado. "Presenca de processo alheio nao e presenca do meu servico" e o
# espelho exato da §13, e distinguir os sentidos exigiria herdar a semantica do `!` do shell —
# que e justamente o que a §9 deste mesmo catalogo diz que um detector textual nao faz.
#
# ── POR QUE AVISA E NUNCA BLOQUEIA ────────────────────────────────────────────────────────────
# Precedente direto: `pipestatus-zsh-guard.sh` nasceu BLOQUEANTE e foi rebaixado a AVISO por uma
# revisao adversaria que provou falso negativo E falso positivo — "um detector de padrao de shell
# nao herda a semantica do shell" (§9). Aqui existe um falso positivo LEGITIMO e permanente:
# esperar por um processo que e de fato unico na maquina (um daemon, um app de GUI). Esse caso
# nunca vai desaparecer, entao este hook nao tem — e nao tera — precisao para `deny`. Como AVISO a
# economia se inverte: o falso positivo custa UMA LINHA de contexto, o falso negativo custou uma
# sessao presa por 6h26 e um veredito fabricado.
#
# ── O QUE ELE NAO PEGA (limites assumidos, travados por teste) ────────────────────────────────
# - espera por texto SEM laco de shell (`watch`, `timeout`, um sleep unico seguido de pgrep);
# - `ps` sem `grep` na condicao — de proposito: `while ps -p "$pid"` espera pelo MEU pid, e e o
#   idioma CERTO, igual a `while kill -0 "$pid"`;
# - reinterpretacao posterior: `eval`, `ssh host "…"`, `xargs`, `bash <<EOF` (heredoc alimentando
#   um shell). O corpo de heredoc e descartado por ser DADO — e quase sempre e;
# - laco montado em runtime a partir de variavel.
# No sentido oposto, ainda avisa a toa quando o sujeito e genuinamente unico na maquina. E aviso:
# custa uma linha. E prevencao de acidente de boa-fe, nao sandbox contra adversario.
#
# Fail-open de infra (sem jq/awk -> exit 0): e um SENSOR, nao um script que apaga.
# Testes em scripts/test-sonda-processo-guard.sh.
set -u

entrada="$(cat)"

# PORTAO BARATO, ANTES de qualquer fork: este hook roda em TODA chamada Bash e ~99% dos comandos
# nao tem nada a ver com o assunto. `sleep` e condicao NECESSARIA do gatilho e e raro no caminho
# quente, entao ele filtra primeiro; so depois o segundo portao. Glob em bash puro custa ~0ms.
# Limite assumido: continuacao de linha DENTRO da palavra `sleep` escapa (patologico).
case "$entrada" in
  *[Ss][Ll][Ee][Ee][Pp]*) ;;
  *) exit 0 ;;
esac
case "$entrada" in
  *pgrep*|*ps*) ;;   # `ps` como substring e comum (https, steps), mas ja passou pelo portao do
  *) exit 0 ;;       # `sleep`: o custo de deixar passar e o fork de jq+awk (~70ms), raro.
esac

command -v jq >/dev/null 2>&1 || exit 0
command -v awk >/dev/null 2>&1 || exit 0

# Um unico jq: tool_name na 1a linha, comando no resto. O comando PRECISA manter as quebras de
# linha (heredoc), e tool_name nunca tem newline, entao o corte na 1a linha e seguro.
bruto="$(printf '%s' "$entrada" | jq -r '(.tool_name // ""), (.tool_input.command // "")' 2>/dev/null)"
tool="${bruto%%$'\n'*}"
cmd="${bruto#*$'\n'}"
[ -z "$tool" ] || [ "$tool" = "Bash" ] || exit 0   # defesa se o matcher do settings.json mudar
[ -n "$cmd" ] || exit 0

# Silenciador: intencao declarada como env-assignment NO INICIO (nao substring solta).
[[ "$cmd" =~ ^[[:space:]]*SONDA_PROCESSO_INTENCIONAL=(1|true)([[:space:]]|$) ]] && exit 0

# Continuacao de linha: o shell remove `\`+newline ANTES de tokenizar, entao um laco quebrado em
# varias linhas com `\` e um laco so. Colar aqui e o que impede o scanner de perder a estrutura.
cmd="${cmd//\\$'\n'/}"

# ── SCANNER DE QUOTING + ANALISADOR DE LACO ───────────────────────────────────────────────────
# O scanner e derivado do de `pipestatus-zsh-guard.sh` (codigo ja provado em campo). NAO foi
# extraido para uma lib compartilhada de proposito: a suite daquele hook FALSIFICA sabotando
# strings que vivem DENTRO do arquivo dele (`perl -0pi -e` sobre o corpo do awk), e mover o
# scanner quebraria a falsificacao do vizinho — num arquivo que ~30 worktrees compartilham.
#
# Divergencia deliberada do original: aqui o corpo de heredoc e descartado SEMPRE, quoted ou nao.
# La o risco era a EXPANSAO (o zsh expande dentro de heredoc nao-quoted, e isso ja e o bug de
# leitura); aqui o risco e a EXECUCAO de uma estrutura de laco, e corpo de heredoc nao e executado
# pelo shell externo em nenhum dos dois casos. E o que protege o precedente de 2026-06-24 (um
# guard do repo bloqueou o commit que DOCUMENTAVA o padrao que ele detectava) — este proprio hook
# nasce numa sessao que escreve o padrao literal em doc, commit e PR.
saida="$(printf '%s' "$cmd" | awk '
  function separador(c) { return (c == "" || c == " " || c == "\t" || c == ";" || c == "&" || c == "|" || c == "(" ) }
  function eflag_f(t) { return (t ~ /^-[A-Za-z]*f/ || t == "--full") }
  BEGIN { st = 0; inhd = 0; hd = ""; hdash = 0; vis = "" }
  {
    linha = $0
    if (inhd) {                                    # dentro de heredoc: so procura o fechamento
      t = linha; if (hdash) sub(/^\t+/, "", t)   # so `<<-` remove indentacao, e so TABs
      if (t == hd) { inhd = 0; hd = "" }
      next                                         # corpo de heredoc e DADO: descarta sempre
    }
    pend = 0; n = length(linha); i = 1; ant = ""
    while (i <= n) {
      c = substr(linha, i, 1)
      if (st == 0) {                               # fora de aspas
        if (c == "#" && separador(ant)) break      # comentario: ignora ate o fim da linha
        if (c == "\\") { ant = ""; i += 2; continue }
        if (c == "\x27") { st = 1; i++; continue }
        if (c == "\"")   { st = 2; i++; continue }
        if (c == "$" && substr(linha, i+1, 1) == "\x27") { st = 3; i += 2; continue }
        if (c == "<" && substr(linha, i+1, 1) == "<" && substr(linha, i+2, 1) != "<") {
          j = i + 2; hyf = 0
          if (substr(linha, j, 1) == "-") { hyf = 1; j++ }
          while (substr(linha, j, 1) == " " || substr(linha, j, 1) == "\t") j++
          q = substr(linha, j, 1)
          if (q == "\x27" || q == "\"" || q == "\\") j++
          d = ""
          while (j <= n) {
            ch = substr(linha, j, 1)
            if (ch ~ /[A-Za-z0-9_]/) { d = d ch; j++ } else break
          }
          ch = substr(linha, j, 1)
          if (ch == "\x27" || ch == "\"") j++
          # NAO sobrescreve um heredoc ja pendente: fica com o PRIMEIRO da linha (o 2o e limite
          # assumido, herdado do hook de origem).
          if (d != "" && !pend) { hd = d; hdash = hyf; pend = 1 }
          ant = ">"; i = j; continue
        }
        vis = vis c; ant = c; i++; continue
      }
      if (st == 1) { if (c == "\x27") st = 0; i++; continue }          # aspas simples: MENCAO
      if (st == 3) { if (c == "\\") { i += 2; continue }               # $\x27…\x27: MENCAO
                     if (c == "\x27") st = 0; i++; continue }
      if (c == "\\") { i += 2; continue }                              # aspas duplas
      if (c == "\"") { st = 0; i++; continue }
      vis = vis c; i++            # aspas duplas: `bash -c "while pgrep …"` EXECUTA mesmo
    }
    if (pend) inhd = 1
    vis = vis "\n"
  }
  END {
    # Tokeniza o texto VISIVEL: tudo que nao serve a um token de comando vira separador. Assim
    # `[ -z "$(pgrep -f X)" ]` e `until ! pgrep -f X` chegam na mesma forma — a sonda dentro de
    # `$(…)` conta igual, que e o ponto: o defeito e do SUJEITO, nao da sintaxe.
    linhaf = vis
    gsub(/[^A-Za-z0-9_.:\/-]/, " ", linhaf)
    nt = split(linhaf, tok, / +/)
    for (a = 1; a <= nt; a++) {
      if (tok[a] != "while" && tok[a] != "until") continue
      # (1) CONDICAO: do `while`/`until` ate o `do` que o fecha.
      temPgrep = 0; temPs = 0; temGrep = 0; temF = 0
      for (b = a + 1; b <= nt && tok[b] != "do"; b++) {
        if (tok[b] == "pgrep") { temPgrep = 1; continue }
        if (tok[b] == "ps")    { temPs = 1; continue }
        if (tok[b] == "grep" || tok[b] == "egrep" || tok[b] == "fgrep") { temGrep = 1; continue }
        if (temPgrep && eflag_f(tok[b])) temF = 1
      }
      if (b > nt) continue                       # laco sem `do`: nao e laco
      # `ps` SEM `grep` fica de fora de proposito: `while ps -p "$pid"` espera pelo MEU pid e e o
      # idioma CERTO — mesma familia de `while kill -0 "$pid"`.
      ramo = ""
      if (temPgrep) ramo = "SONDA-PGREP-MEDE-A-MAQUINA"
      else if (temPs && temGrep) ramo = "SONDA-PS-GREP-MEDE-A-MAQUINA"
      if (ramo == "") continue
      # (2) CORPO: do `do` ate o `done` que o fecha, contando aninhamento. Sem `sleep` no corpo
      # nao e ESPERA (um `while pgrep …; do kill …; done` e outra coisa, e nao e esta armadilha).
      prof = 1; temSleep = 0; fim = nt
      for (k = b + 1; k <= nt; k++) {
        if (tok[k] == "do") prof++
        else if (tok[k] == "done") { prof--; if (prof == 0) { fim = k; break } }
        else if (tok[k] == "sleep") temSleep = 1
      }
      if (!temSleep) continue
      # Trecho para o sensor: os tokens do laco, ja sem aspas e sem `$` (a tokenizacao os comeu).
      # Deliberadamente NAO e o comando inteiro — o log vai para disco e comando de agente carrega
      # credencial. 160 chars bastam para julgar VP/FP.
      trecho = ""
      for (k = a; k <= fim && length(trecho) < 160; k++) trecho = trecho tok[k] " "
      printf "%s\t%s\t%s\n", ramo, (temF ? "com-f" : "sem-f"), substr(trecho, 1, 160)
      exit
    }
  }
')"

[ -n "$saida" ] || exit 0
ramo="${saida%%$'\t'*}"
resto="${saida#*$'\t'}"
flag="${resto%%$'\t'*}"
trecho="${resto#*$'\t'}"

idioma='O IDIOMA CERTO — espere pelo SEU processo, ou por um marcador que ele mesmo escreveu:

  bash scripts/trabalho.sh > .saida.txt 2>&1 & pid=$!   # o PID e MEU, nao um padrao de texto
  wait "$pid"; rc=$?                                    # (de outro shell: while kill -0 "$pid")

  { bash scripts/trabalho.sh; echo "RC=$?"; } >> .saida.txt 2>&1   # marcador POSITIVO de fim…
  command grep -q "^RC=" .saida.txt                                # …e espere por ELE

E confira o SEGUNDO passo tambem: `grep` num arquivo que ninguem escreveu devolve zero linhas, e
zero linha le-se como "sem problema". Exija afirmacao POSITIVA (marcador de fim, exit code
capturado colado), nunca a ausencia de sinal — docs/agent/money-path.md, ausente != zero.

Isto e um AVISO, nao um bloqueio. Se o sujeito e mesmo unico na maquina (um daemon, um app de
GUI), ignore. Para silenciar: SONDA_PROCESSO_INTENCIONAL=1 <cmd>'

if [ "$ramo" = "SONDA-PGREP-MEDE-A-MAQUINA" ]; then
  msg="🔴 laco esperando por \`pgrep\`: a tabela de processos e da MAQUINA, nao da sua worktree"
  ctx="SONDA-PGREP-MEDE-A-MAQUINA: este comando espera num laco cuja condicao e um \`pgrep\`. Um padrao de texto identifica um COMANDO, nao uma EXECUCAO — e a tabela de processos e da MAQUINA inteira, com ~30 worktrees rodando os MESMOS comandos. Medido em 2026-09-06 (docs/historico/evidencia-positiva-shell.md §13): \`until ! pgrep -f 'mutcheck.sh …'\` casou CINCO PIDs e NENHUM era um mutcheck em execucao — eram shells de outras worktrees, inclusive o proprio watcher, cuja linha de comando contem o texto que ele procura. Os dois desfechos sao o mesmo defeito: ou voce declara fim quando o trabalho do VIZINHO acaba (e le um arquivo vazio), ou nunca sai do laco (um watcher ficou preso 06:26:10 numa M2 de 8GB). Vale nos DOIS sentidos: esperar SUMIR le a saida do vizinho como sua, e esperar APARECER le o processo do vizinho como o seu servico.

$idioma"
else
  msg="🔴 laco esperando por \`ps | grep\`: mede a MAQUINA inteira, nao o seu trabalho"
  ctx="SONDA-PS-GREP-MEDE-A-MAQUINA: este comando espera num laco cuja condicao e um \`ps\` filtrado por \`grep\` — a mesma armadilha do \`pgrep -f\`, e com um agravante: o proprio \`grep\` do pipeline costuma casar a si mesmo. Um padrao de texto identifica um COMANDO, nao uma EXECUCAO, e a tabela de processos e da MAQUINA inteira, com ~30 worktrees rodando os MESMOS comandos (docs/historico/evidencia-positiva-shell.md §13). Ou voce declara fim quando o trabalho do VIZINHO acaba, ou nunca sai do laco.

$idioma"
fi

# ── SENSOR DE CAMPO ───────────────────────────────────────────────────────────────────────────
# Sem isto ninguem consegue responder "quantas vezes disparou, e em que" — e a decisao de manter,
# afrouxar ou aposentar este guard ficaria sem denominador (docs/historico/fase-sem-sinal.md:
# superficie de uso nasce COM o sensor). Quem LE isto e o mesmo script do guard vizinho, que ja
# aceita o log como argumento — o formato da linha e IGUAL de proposito:
#   bash scripts/pipestatus-guard-sinal.sh ~/.claude/afiacao-sonda-processo-guard.jsonl
# FORA do repo de proposito: ~30 worktrees compartilham este guard, e um log versionado viraria
# ima de conflito. Falha de log NUNCA cala o aviso: todo o bloco e best-effort.
TETO_LINHA=511   # 511 + o "\n" = 512 = PIPE_BUF do macOS, o mais estrito das plataformas em jogo
registrar_sinal() {
  local log dir linha wt corte janela ts d seguro
  log="${SONDA_PROCESSO_GUARD_LOG:-$HOME/.claude/afiacao-sonda-processo-guard.jsonl}"
  dir="${log%/*}"
  [ -d "$dir" ] || (umask 077; mkdir -p "$dir") 2>/dev/null || return 0
  # Nasce 0600: o arquivo guarda FRAGMENTO DE COMANDO.
  [ -e "$log" ] || (umask 077; : >> "$log") 2>/dev/null || return 0
  chmod 600 "$log" 2>/dev/null || true
  # Redacao: a janela e estreita e a tokenizacao ja comeu as aspas, mas se um segredo encostar
  # nela ele NAO vai para o disco (o CLAUDE.md proibe segredo em texto plano em disco, e log
  # tambem e disco). Mesma lista do guard vizinho, medida la.
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
  # Sobe a arvore ate o `.git` em bash puro: `${PWD##*/}` gravaria o basename do CWD (rodando de
  # `<worktree>/src/lib` o log diria `lib`, e o agrupamento por worktree viraria ficcao).
  d="$PWD"
  wt=""
  while [ -n "$d" ] && [ "$d" != "/" ]; do
    if [ -e "$d/.git" ]; then wt="${d##*/}"; break; fi
    d="${d%/*}"
  done
  wt="$(printf '%.48s' "${wt:-${PWD##*/}}")"
  # `jq -a` forca saida ASCII pura => ${#linha} conta BYTES em QUALQUER locale, sem fork de `wc`.
  # O teto e conferido na LINHA PRONTA: truncar o CAMPO nao limita a linha, porque o escape do
  # JSON infla DEPOIS do corte (medido no guard vizinho).
  for corte in 160 80 40 0; do
    if [ "$corte" -eq 0 ]; then janela='<TRECHO-OMITIDO-LINHA-LONGA>'
    else janela="$(printf "%.${corte}s" "$seguro")"; fi
    linha="$(jq -n -c -a --arg ts "$ts" --arg ramo "$2" --arg trecho "$janela" --arg wt "$wt" \
      --arg flag "$3" '{ts:$ts, ramo:$ramo, trecho:$trecho, wt:$wt, flag:$flag}' 2>/dev/null)" || return 0
    [ -n "$linha" ] || return 0
    [ "${#linha}" -lt "$TETO_LINHA" ] && break
  done
  # Se nem o marcador coube, NAO grava: linha picotada envenena a query, e sensor que mente e pior
  # que sensor nenhum.
  [ "${#linha}" -lt "$TETO_LINHA" ] || return 0
  printf '%s\n' "$linha" >> "$log" 2>/dev/null || return 0
}
registrar_sinal "$trecho" "$ramo" "$flag"

jq -n --arg m "$msg" --arg c "$ctx" \
  '{systemMessage:$m, hookSpecificOutput:{hookEventName:"PreToolUse", additionalContext:$c}}'
exit 0
