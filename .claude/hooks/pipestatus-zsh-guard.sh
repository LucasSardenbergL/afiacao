#!/usr/bin/env bash
# pipestatus-zsh-guard.sh — PreToolUse(Bash): AVISA quando o comando lê um exit code que o zsh esvazia.
#
# POR QUÊ: o Bash tool desta máquina roda em /bin/zsh. `PIPESTATUS` é um bash-ism; o zsh chama
# `pipestatus` (MINÚSCULO e 1-INDEXED). O nome errado não dá erro — expande para VAZIO. E vazio,
# no `[` do zsh, não é "sem dado": é `0`, que por acaso é o exit code de SUCESSO. Medido nos dois
# shells em 2026-08-23 (docs/historico/evidencia-positiva-shell.md §9):
#
#   false | true                                                  # o pipeline FALHOU
#   if [ "${PIPESTATUS[0]}" -eq 0 ]; then echo "PIPELINE OK"; fi  # imprime OK
#
#   zsh:  ${PIPESTATUS[0]}=vazio · ${pipestatus[1]}=1 ✓ · ${pipestatus[0]}=vazio
#   bash: ${PIPESTATUS[0]}=1 ✓   · ${pipestatus[1]}=vazio · [ "" -eq 0 ] = erro ALTO
#
# Duas formas fabricam veredito no zsh, e a SEGUNDA é o erro de quem acabou de aprender a lição —
# corrige a caixa e mantém o índice do bash:
#   (A) PIPESTATUS  (maiúsculo, qualquer forma)  — a variável não existe no zsh
#   (B) pipestatus[0] (minúsculo, índice ZERO)   — existe, mas zsh é 1-indexed; [1] é o certo
#
# ── POR QUE AVISA E NÃO BLOQUEIA (revisto — a 1ª versão bloqueava) ────────────────────────────
# A versão inicial dava `deny`, apostando que a fronteira "o zsh expande?" coincidiria com "é
# bug?" e daria precisão de sobra. Revisão adversária do Codex (2026-08-23, enquadramento
# defensivo de COBERTURA) derrubou a aposta, e cada achado foi reproduzido aqui em `zsh -f`:
#
#   FALSO NEGATIVO — a aritmética do zsh NÃO precisa de `$`, e variável ausente vira 0:
#     (( PIPESTATUS[0] == 0 ))   ·   [[ pipestatus[0] -eq 0 ]]   ·   let 'rc = PIPESTATUS[0]'
#     Todos fabricam o veredito; o detector, que só procurava expansão `$…`, liberava os três.
#   FALSO POSITIVO — `echo x # ${PIPESTATUS[0]}` é COMENTÁRIO: o zsh não expande nada, e o guard
#     bloqueava. É exatamente o precedente de 2026-06-24 (guard barrou o commit que DOCUMENTAVA o
#     padrão) se repetindo no guard que dizia tê-lo fechado "por construção".
#   FALSO POSITIVO — `setopt KSH_ZERO_SUBSCRIPT` torna [0] legítimo; e sob `set -u` a expansão
#     ABORTA (exit 1) em vez de fabricar — bloquear ali contradizia a própria mensagem do hook,
#     que recomenda `set -u`.
#
# Um detector com furos comprovados nos DOIS sentidos não tem a precisão que justifica bloquear.
# Como AVISO a economia se inverte: o falso positivo custa uma linha de contexto (não trava
# trabalho), então o detector pode ser mais amplo e mais simples — e é por isso que o ramo (A)
# abaixo deixou de exigir o `$`. Endurecer para `deny` é uma decisão de FASE N+1, que exige sinal
# de campo desta fase (docs/historico/fase-sem-sinal.md): quantas vezes disparou, e em quê.
#
# ── O QUE ELE NÃO PEGA (limitações medidas, não presumidas) ───────────────────────────────────
# A tese "o zsh não expandiu, logo é legítimo" é FALSA para reinterpretação posterior: `eval`,
# `let 'rc = PIPESTATUS[0]'`, `env zsh -c "$var"`, `xargs`, `ssh host "…"`, `make` com
# SHELL:=/bin/zsh e `npm run` com script-shell=zsh executam o texto num zsh que este hook não
# enxerga. Também escapam indireção (`${(P)nome}` — travado como teste C5), índice calculado que
# não começa em 0, delimitador de heredoc exótico (`<<'E"OF'`, `<<$X`) e o 2º heredoc de uma mesma
# linha. No sentido oposto, ainda avisa à toa quando há aspas simples dentro de `$(…)` sob aspas
# duplas externas (`"$(printf '%s' '\${PIPESTATUS[0]}')"` é literal) — como é aviso, custa uma
# linha. É prevenção de acidente de boa-fé, não sandbox contra adversário.
#
# Fail-open de infra (sem jq/awk -> exit 0): é um SENSOR, não um script que apaga.
# Testes em scripts/test-pipestatus-zsh-guard.sh.
set -u

entrada="$(cat)"

# PORTÃO BARATO, ANTES de qualquer fork: este hook roda em TODA chamada Bash (dezenas por turno) e
# ~99% dos comandos não têm nada a ver com o assunto. Glob case-insensitive em bash puro custa ~0ms.
# Casa só `PIPE`, não a palavra inteira: a continuação de linha (`\`+newline) parte o nome ao meio
# no payload, e o portão com a palavra completa deixava passar batido justamente o caso que a
# colagem lá embaixo existe para pegar — otimização fabricando falso negativo. Limite assumido:
# partir DENTRO de "PIPE" ainda escapa. Custo: `set -o pipefail` e afins pagam o jq+awk (~70ms).
case "$entrada" in
  *[Pp][Ii][Pp][Ee]*) ;;
  *'$?'*) ;;   # 2o gatilho: eco de $? no fim. Perde o caso patologico de continuacao de
                 # linha ENTRE o $ e o ? — casar so '$' pegaria toda variavel e faria fork a toa.
  *) exit 0 ;;
esac

command -v jq >/dev/null 2>&1 || exit 0
command -v awk >/dev/null 2>&1 || exit 0

# Um único jq: tool_name na 1ª linha, comando no resto. Não dá para achatar com @tsv como os outros
# hooks fazem — o comando PRECISA manter as quebras de linha (heredoc), e tool_name nunca tem
# newline, então o corte na 1ª linha é seguro.
bruto="$(printf '%s' "$entrada" | jq -r '(.tool_name // ""), (.tool_input.command // "")' 2>/dev/null)"
tool="${bruto%%$'\n'*}"
cmd="${bruto#*$'\n'}"
[ -z "$tool" ] || [ "$tool" = "Bash" ] || exit 0   # defesa se o matcher do settings.json mudar
[ -n "$cmd" ] || exit 0

# Silenciador: intenção declarada como env-assignment NO INÍCIO (não substring solta).
[[ "$cmd" =~ ^[[:space:]]*PIPESTATUS_INTENCIONAL=(1|true)([[:space:]]|$) ]] && exit 0

# Continuação de linha: o zsh remove `\`+newline ANTES de tokenizar, então `${PIPE\<nl>STATUS[0]}`
# é uma leitura válida. Colar aqui é o que impede o scanner de perder o nome partido ao meio.
cmd="${cmd//\\$'\n'/}"

# ── Scanner de quoting ────────────────────────────────────────────────────────────────────────
# Reconstrói só o que o zsh de fora vai EXECUTAR e devolve o ramo casado. O que cai em aspas
# simples, $'...', comentário ou heredoc com delimitador quoted é descartado — é MENÇÃO, não uso.
ramo="$(printf '%s' "$cmd" | awk '
  function emite(s) { vis = vis s }
  function separador(c) { return (c == "" || c == " " || c == "\t" || c == ";" || c == "&" || c == "|" || c == "(" ) }
  BEGIN { st = 0; inhd = 0; hd = ""; hdq = 0; hdash = 0; vis = "" }
  {
    linha = $0
    if (inhd) {                                    # dentro de heredoc: procura o fechamento
      t = linha; if (hdash) sub(/^\t+/, "", t)   # so `<<-` remove indentacao, e so TABs
      if (t == hd) { inhd = 0; hd = ""; next }
      if (!hdq) emite("\n" linha)                  # heredoc NÃO-quoted expande
      next
    }
    pend = 0; n = length(linha); i = 1; ant = ""
    while (i <= n) {
      c = substr(linha, i, 1)
      if (st == 0) {                               # fora de aspas
        if (c == "#" && separador(ant)) break      # comentario: o zsh ignora ate o fim da linha
        if (c == "\\") { ant = ""; i += 2; continue }
        if (c == "\x27") { st = 1; i++; continue }
        if (c == "\"")   { st = 2; i++; continue }
        if (c == "$" && substr(linha, i+1, 1) == "\x27") { st = 3; i += 2; continue }
        if (c == "<" && substr(linha, i+1, 1) == "<" && substr(linha, i+2, 1) != "<") {
          j = i + 2; hyf = 0
          if (substr(linha, j, 1) == "-") { hyf = 1; j++ }
          while (substr(linha, j, 1) == " " || substr(linha, j, 1) == "\t") j++
          q = substr(linha, j, 1); hq = 0
          if (q == "\x27" || q == "\"" || q == "\\") { hq = 1; j++ }
          d = ""
          while (j <= n) {
            ch = substr(linha, j, 1)
            if (hq && (ch == "\x27" || ch == "\"")) { j++; break }
            if (ch ~ /[A-Za-z0-9_]/) { d = d ch; j++ } else break
          }
          # NAO sobrescreve um heredoc ja pendente: fica com o PRIMEIRO da linha (o 2o e limitacao
          # assumida). Sobrescrever fazia o corpo do 1o ser julgado pelo quoting do ULTIMO.
          if (d != "" && !pend) { hd = d; hdq = hq; hdash = hyf; pend = 1 }
          ant = ">"; i = j; continue
        }
        emite(c); ant = c; i++; continue
      }
      if (st == 1) { if (c == "\x27") st = 0; i++; continue }          # aspas simples: opaco
      if (st == 3) { if (c == "\\") { i += 2; continue }               # $\x27...\x27: opaco
                     if (c == "\x27") st = 0; i++; continue }
      if (c == "\\") { i += 2; continue }                              # aspas duplas: \$ nao expande
      if (c == "\"") { st = 0; i++; continue }
      emite(c); i++                                                    # aspas duplas EXPANDEM
    }
    if (pend) inhd = 1
    emite("\n")
  }
  # Janela de ~40 chars de cada lado do match, para o sensor. Deliberadamente NAO e o comando
  # inteiro: o log vai para disco e comando de agente carrega token/senha. Segredo nao costuma
  # ficar colado em PIPESTATUS, entao a janela estreita e o que basta para julgar VP/FP sem
  # arrastar credencial junto. Tabs/newlines viram espaco (a linha do log tem de ser UMA linha).
  # `re` chega como STRING, nunca como /literal/: em awk, /re/ em posicao de argumento
  # AVALIA para 0 ou 1 ($0 ~ /re/) e a funcao receberia um numero. Foi assim que o trecho
  # saiu vazio na 1a versao — e pior, casou por acidente onde o comando tinha um "0".
  function janela(re,   ini, s) {
    if (!match(vis, re)) return ""
    ini = RSTART - 40; if (ini < 1) ini = 1
    s = substr(vis, ini, RLENGTH + 80)
    gsub(/[\t\n]/, " ", s); gsub(/  +/, " ", s)
    return s
  }
  function grita(ramo, re) { printf "%s\t%s\n", ramo, janela(re); exit }
  END {
    # A palavra NUA (sem `$`) so e perigosa onde algo AVALIA identificador como aritmetica:
    # (( … )), [[ … ]] e `let` tratam parametro ausente como 0. Fora dai, `PIPESTATUS` solto e
    # MENCAO — `git commit -m "…PIPESTATUS…"` e `grep PIPESTATUS docs/` sao rotina neste repo, e
    # avisar neles seria o precedente 2026-06-24 outra vez, so que como ruido em vez de bloqueio.
    arit = (vis ~ /\(\(/ || vis ~ /\[\[/ || vis ~ /(^|[^A-Za-z0-9_])let([^A-Za-z0-9_]|$)/)
    # (A) bash-ism: PIPESTATUS nao existe no zsh -> vazio. `[^}]*` cobre flags de parametro do zsh
    # como ${(e)PIPESTATUS[0]} e ${#PIPESTATUS[@]}.
    if (vis ~ /\$\{[^}]*PIPESTATUS/ || vis ~ /\$PIPESTATUS([^A-Za-z0-9_]|$)/) { grita("BASHISM", "\\$\\{?[^}]*PIPESTATUS") }
    if (arit && vis ~ /(^|[^A-Za-z0-9_])PIPESTATUS([^A-Za-z0-9_]|$)/)            { grita("BASHISM", "PIPESTATUS") }
    # (B) zsh e 1-INDEXED: pipestatus[0…] e sempre vazio. Indice que COMECA em 0 pega [0] e [0+0].
    if (vis ~ /\$\{[^}]*pipestatus\[[[:space:]]*0/ || vis ~ /\$pipestatus\[[[:space:]]*0/) { grita("INDICE-ZERO", "\\$\\{?[^}]*pipestatus\\[[[:space:]]*0") }
    if (arit && vis ~ /(^|[^A-Za-z0-9_])pipestatus\[[[:space:]]*0/)                            { grita("INDICE-ZERO", "pipestatus\\[[[:space:]]*0") }
    # ECO-DE-EXIT: `cmd; echo "EXIT=$?"` como ULTIMO comando. O NUMERO impresso esta certo — e o do
    # cmd — mas o exit code do COMPOUND passa a ser o do `echo`, que e 0 sempre. Quem le o conjunto
    # em vez do texto (o harness, a notificacao de tarefa em background, um `&&` adiante) recebe
    # SUCESSO com o trabalho quebrado. Mesma familia do PIPESTATUS: veredito fabricado.
    # PRECISAO > RECALL, porque `echo $?` e comum e quase sempre legitimo. Exige as DUAS condicoes:
    #   (a) o echo/printf com $? e o ULTIMO comando — se vier outra coisa depois, o exit e dela;
    #   (b) existe comando ANTES dele — `echo $?` sozinho nao mente sobre trabalho nenhum.
    # LIMITES MEDIDOS (/codex defensivo, cada um reproduzido em zsh -f). Ficam como FN de
    # proposito: fecha-los custaria balanceamento de parenteses/aspas no scanner, e o preco de um
    # guard barulhento e alto — ele perde a credibilidade dos TRES ramos de uma vez.
    #   `false; echo "EXIT=$? $(printf x | cat)"` — o `|` DENTRO de $( ) rouba o separador;
    #   `false; echo "nota; EXIT=$?"`             — `;` textual dentro de aspas duplas idem;
    #   `false; { echo "EXIT=$?"; }` / `(...)` / `time` / `command` / `eval` / funcao — o segmento
    #     nao COMECA por echo|printf;
    #   `false; echo "EXIT=$?" || true`           — curto-circuito poe outra coisa depois;
    #   `false; echo "EXIT=$?" | tee`             — o pipe engole (e a propria ajuda ja avisa disso).
    linhaf = vis
    sub(/[[:space:]]+$/, "", linhaf)
    sub(/[[:space:]]*;+[[:space:]]*$/, "", linhaf)   # `;` TERMINAL: sem isto `ultimo` fica vazio e
                                                     # `cmd; echo "EXIT=$?";` — comum — passa batido
    pos = 0; cond = 0
    for (kk = 1; kk <= length(linhaf); kk++) {
      cc = substr(linhaf, kk, 1)
      # REDIRECAO nao e separador: em `>&2`, `2>&1` e `&>` o `&` nao inicia comando nenhum.
      if (cc == ">" || cc == "<") { kk++; continue }
      if (cc == "&" && substr(linhaf, kk + 1, 1) == ">") { kk++; continue }
      if (cc == ";" || cc == "\n") { pos = kk; cond = 0; continue }
      if (cc == "&" || cc == "|") {
        if (substr(linhaf, kk + 1, 1) == cc) {         # `&&` / `||`: CURTO-CIRCUITO
          pos = kk + 1; cond = 1; kk++
        } else { pos = kk; cond = 0 }
      }
    }
    # `cond` mata o FP mais caro do ramo: em `false && echo "EXIT=$?"` o echo NEM EXECUTA quando o
    # trabalho falha — o compound devolve 1, fiel. E em `true && echo "$?"` devolve 0, tambem fiel.
    # Depois de `&&`/`||` o relator nunca fabrica sucesso, entao avisar ali e so ruido.
    if (pos > 0 && !cond) {
      ultimo = substr(linhaf, pos + 1)
      if (ultimo ~ /^[[:space:]]*(echo|printf)([[:space:]]|$)/ && ultimo ~ /\$\?/) {
        grita("ECO-DE-EXIT", "(echo|printf)[^;&|]*\\$\\?")
      }
    }
  }
')"

[ -n "$ramo" ] || exit 0
trecho="${ramo#*$'\t'}"; ramo="${ramo%%$'\t'*}"

# PIPESTATUS-BASHISM-NO-ZSH / PIPESTATUS-INDICE-ZERO sao CONTRATO DE TESTE: marcadores ASCII, caixa
# fixa, exclusivos de um ramo. scripts/test-pipestatus-zsh-guard.sh casa por eles com `command grep`
# SEM -i — prosa acentuada casaria o ramo errado sob pt_BR.UTF-8 e nao sob LC_ALL=C (#1483).
# shellcheck disable=SC2016  # a ajuda ENSINA o idioma: $? e ${pipestatus[1]} sao literais
idioma='Idioma correto (escolha um):
  1. CAPTURA PELADA, sem pipe (preferido — vale em qualquer shell):
       cmd > /tmp/saida.log 2>&1; rc=$?
       head -c 1500 /tmp/saida.log        # o recorte NAO mexe mais no rc
  2. zsh-only, ciente do 1-INDEX:  cmd | tail -5; rc=${pipestatus[1]}
  3. delegue o trecho ao bash, com aspas SIMPLES para o zsh nao expandir antes:
       bash -c '"'"'cmd | tail -5; echo ${PIPESTATUS[0]}'"'"'
E `set -u` no topo de script converte esta classe inteira (todo bash-ism que so se manifesta como
string vazia) de silencio em ABORTO — e a leitura passa a falhar alto em vez de aprovar.

Isto e um AVISO, nao um bloqueio: se o seu caso e um dos legitimos (comentario, KSH_ZERO_SUBSCRIPT,
texto que vai rodar noutro shell), siga em frente. Para silenciar: PIPESTATUS_INTENCIONAL=1 <cmd>'

# shellcheck disable=SC2016  # a ajuda ENSINA o idioma: $? e $rc sao literais, nao para expandir
idioma_eco='Idioma correto (escolha um):
  1. PROPAGUE o veredito — a ultima instrucao decide o exit do conjunto:
       cmd > /tmp/saida.log 2>&1; rc=$?
       head -c 1500 /tmp/saida.log
       [ "$rc" -eq 0 ]        # <- ultima instrucao: o conjunto REPROVA junto com o cmd
  2. Se voce QUER so registrar o codigo, registre — mas ESTE aviso vai disparar de novo, e esta
     certo: gravar no log nao conserta o exit do conjunto, so lhe da onde ler a verdade.
       cmd > /tmp/saida.log 2>&1
       echo "EXIT=$?" >> /tmp/saida.log       # <- o exit do conjunto continua sendo 0, MENTINDO
       command grep EXIT= /tmp/saida.log      # <- a evidencia e ESTA linha, nao a notificacao
     Prefira (1) sempre que alguem — harness, `&&`, `if` — for LER o codigo do conjunto.
Nos dois casos vale a regra: `| tail`/`| head` no fim engolem o exit code do trabalho, e `$?` depois
de um pipe e do ULTIMO estagio. Capture o rc ANTES de recortar a saida.

Isto e um AVISO, nao um bloqueio. Para silenciar: PIPESTATUS_INTENCIONAL=1 <cmd>'

if [ "$ramo" = "ECO-DE-EXIT" ]; then
  msg="🔴 \`echo \$?\` no fim: o exit do CONJUNTO vira o do echo (=0) — quem le o codigo, nao o texto, ve SUCESSO"
  ctx="ECO-DE-EXIT-FABRICA-VEREDITO: este comando termina com um \`echo\`/\`printf\` que imprime \`\$?\`. O NUMERO impresso esta certo — e o do comando anterior — mas o exit code do COMPOUND passa a ser o do \`echo\`, que e 0 SEMPRE. Quem le o codigo em vez do texto recebe SUCESSO com o trabalho quebrado: o harness, a notificacao de tarefa em background, um \`&&\` adiante, um \`if\` que envolva a chamada. Nao e teorico — numa unica sessao de 2026-08-24 este padrao produziu TRES notificacoes de 'exit code 0' enganosas: uma para um \`bun run test:hooks\` que tinha 4 falhas, uma para um \`codex exec\` que falhou nas 3 tentativas por DNS, e uma terceira num watcher. E a mesma familia do PIPESTATUS vazio: veredito fabricado a partir de dado que nao foi consultado (ausente != zero, docs/agent/money-path.md).

$idioma_eco"
elif [ "$ramo" = "BASHISM" ]; then
  msg="🔴 PIPESTATUS e bash-ism — no zsh (que roda este comando) expande para VAZIO, e vazio vale 0 = SUCESSO"
  ctx="PIPESTATUS-BASHISM-NO-ZSH: este comando le \`PIPESTATUS\`, mas o Bash tool roda em /bin/zsh — onde essa variavel NAO EXISTE. Ela expande para VAZIO, e no \`[\` do zsh a string vazia vale 0, que e o exit code de SUCESSO. Entao \`false | true\` seguido de \`[ \"\${PIPESTATUS[0]}\" -eq 0 ]\` imprime PIPELINE OK: o comando FABRICA um veredito de sucesso a partir de dado AUSENTE (ausente != zero, docs/agent/money-path.md). Nada avisa — o \`[\` nem reclama. Vale igual sem o cifrao: \`(( PIPESTATUS[0] == 0 ))\`, \`[[ PIPESTATUS[0] -eq 0 ]]\` e \`let\` avaliam o identificador NU e tratam ausente como 0.

$idioma"
else
  msg="🔴 zsh e 1-INDEXED: \${pipestatus[0]} e sempre vazio — e vazio vale 0 = SUCESSO"
  ctx="PIPESTATUS-INDICE-ZERO: este comando le \`pipestatus[0]\`. O NOME esta certo para o zsh, mas o INDICE nao — arrays do zsh sao 1-INDEXED, entao [0] e sempre VAZIO (medido). E vazio, no \`[\` do zsh, vale 0 = SUCESSO: o comando fabrica aprovacao a partir de dado ausente. O primeiro comando do pipe e \${pipestatus[1]}. (Excecao: sob \`setopt KSH_ZERO_SUBSCRIPT\` ou \`KSH_ARRAYS\` o [0] passa a ser legitimo — se e o seu caso, ignore este aviso.)

$idioma"
fi

# ── SENSOR DE CAMPO ───────────────────────────────────────────────────────────────────────────
# Sem isto, a frase "endurecer para deny e fase N+1" seria inalcancavel POR CONSTRUCAO: o aviso vai
# para o contexto e evapora, e ninguem consegue responder "quantas vezes disparou, e em que"
# (docs/historico/fase-sem-sinal.md — superficie de uso nasce COM o sensor). Quem LE isto e
# `scripts/pipestatus-guard-sinal.sh`; um log sem query nao e sensor, e lixo.
#
# FORA do repo de proposito: ~30 worktrees compartilham este guard, e um log versionado viraria ima
# de conflito (a mesma razao pela qual o CLAUDE.md proibe roadmap em arquivo compartilhado).
# Escrita concorrente sem lock so e segura enquanto a linha couber no `PIPE_BUF` — que no macOS e
# 512 bytes (`getconf PIPE_BUF /`), NAO os 4096 do Linux. Dai o teto abaixo, que e invariante de
# CORRETUDE (linha picotada envenena a query), nao estetica.
#
# ARMADILHA MEDIDA: truncar o CAMPO nao limita a LINHA — o escape do JSON infla depois do corte.
# Com trecho ja cortado em 160, medi 642 bytes so de aspas (cada " vira \") e 1282 bytes de bytes
# de controle (cada um vira \u00XX, 6 bytes). A versao anterior media 176 bytes com dado TIPICO e
# declarava o invariante provado — pior caso e outra medicao. Por isso o teto e conferido na LINHA
# PRONTA, num laco que encolhe o trecho ate caber.
# Falha de log NUNCA cala o aviso: todo o bloco e best-effort.
TETO_LINHA=511   # 511 + o "\n" = 512 = PIPE_BUF do macOS, o mais estrito das plataformas em jogo
registrar_sinal() {
  local log dir linha wt corte janela ts
  log="${PIPESTATUS_GUARD_LOG:-$HOME/.claude/afiacao-pipestatus-guard.jsonl}"
  dir="${log%/*}"
  [ -d "$dir" ] || (umask 077; mkdir -p "$dir") 2>/dev/null || return 0
  # Nasce 0600: o arquivo guarda FRAGMENTO DE COMANDO. A criacao vem com umask 077 para nao
  # existir janela em que ele esteja 0644, e o chmod conserta log legado (custa um fork, mas so
  # no caminho de DISPARO, que e raro por construcao — o caminho quente saiu no portao barato).
  [ -e "$log" ] || (umask 077; : >> "$log") 2>/dev/null || return 0
  chmod 600 "$log" 2>/dev/null || true
  # Redacao: a janela e estreita, mas se um segredo encostar nela ele NAO vai para o disco.
  local seguro
  seguro="$(printf '%s' "$1" | sed -E \
    -e 's/(eyJ[A-Za-z0-9_.-]{8,})/<JWT-REDIGIDO>/g' \
    -e 's/((token|key|secret|senha|password|passwd|pwd|auth|apikey)["'"'"']?[=:][[:space:]]*)[^[:space:]"'"'"']+/\1<REDIGIDO>/gI' \
    -e 's/([Bb]earer[[:space:]]+)[^[:space:]]+/\1<REDIGIDO>/g' 2>/dev/null)"
  seguro="${seguro:-$1}"
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null)"
  wt="$(printf '%.48s' "${PWD##*/}")"
  # `jq -a` forca saida ASCII pura => ${#linha} conta BYTES em QUALQUER locale, sem fork de `wc`.
  for corte in 160 80 40 0; do
    if [ "$corte" -eq 0 ]; then janela='<TRECHO-OMITIDO-LINHA-LONGA>'
    else janela="$(printf "%.${corte}s" "$seguro")"; fi
    linha="$(jq -n -c -a --arg ts "$ts" --arg ramo "$2" --arg trecho "$janela" --arg wt "$wt" \
      '{ts:$ts, ramo:$ramo, trecho:$trecho, wt:$wt}' 2>/dev/null)" || return 0
    [ -n "$linha" ] || return 0
    [ "${#linha}" -lt "$TETO_LINHA" ] && break
  done
  # Guarda final: se nem o marcador coube (ramo absurdo), NAO grava — linha picotada envenena a
  # query, e um sensor que mente e pior que sensor nenhum.
  [ "${#linha}" -lt "$TETO_LINHA" ] || return 0
  printf '%s\n' "$linha" >> "$log" 2>/dev/null || return 0
}
registrar_sinal "$trecho" "$ramo"

jq -n --arg m "$msg" --arg c "$ctx" \
  '{systemMessage:$m, hookSpecificOutput:{hookEventName:"PreToolUse", additionalContext:$c}}'
exit 0
