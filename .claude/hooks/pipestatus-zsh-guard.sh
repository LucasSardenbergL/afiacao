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
  END {
    # A palavra NUA (sem `$`) so e perigosa onde algo AVALIA identificador como aritmetica:
    # (( … )), [[ … ]] e `let` tratam parametro ausente como 0. Fora dai, `PIPESTATUS` solto e
    # MENCAO — `git commit -m "…PIPESTATUS…"` e `grep PIPESTATUS docs/` sao rotina neste repo, e
    # avisar neles seria o precedente 2026-06-24 outra vez, so que como ruido em vez de bloqueio.
    arit = (vis ~ /\(\(/ || vis ~ /\[\[/ || vis ~ /(^|[^A-Za-z0-9_])let([^A-Za-z0-9_]|$)/)
    # (A) bash-ism: PIPESTATUS nao existe no zsh -> vazio. `[^}]*` cobre flags de parametro do zsh
    # como ${(e)PIPESTATUS[0]} e ${#PIPESTATUS[@]}.
    if (vis ~ /\$\{[^}]*PIPESTATUS/ || vis ~ /\$PIPESTATUS([^A-Za-z0-9_]|$)/) { print "BASHISM"; exit }
    if (arit && vis ~ /(^|[^A-Za-z0-9_])PIPESTATUS([^A-Za-z0-9_]|$)/)            { print "BASHISM"; exit }
    # (B) zsh e 1-INDEXED: pipestatus[0…] e sempre vazio. Indice que COMECA em 0 pega [0] e [0+0].
    if (vis ~ /\$\{[^}]*pipestatus\[[[:space:]]*0/ || vis ~ /\$pipestatus\[[[:space:]]*0/) { print "INDICE-ZERO"; exit }
    if (arit && vis ~ /(^|[^A-Za-z0-9_])pipestatus\[[[:space:]]*0/)                            { print "INDICE-ZERO"; exit }
  }
')"

[ -n "$ramo" ] || exit 0

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

if [ "$ramo" = "BASHISM" ]; then
  msg="🔴 PIPESTATUS e bash-ism — no zsh (que roda este comando) expande para VAZIO, e vazio vale 0 = SUCESSO"
  ctx="PIPESTATUS-BASHISM-NO-ZSH: este comando le \`PIPESTATUS\`, mas o Bash tool roda em /bin/zsh — onde essa variavel NAO EXISTE. Ela expande para VAZIO, e no \`[\` do zsh a string vazia vale 0, que e o exit code de SUCESSO. Entao \`false | true\` seguido de \`[ \"\${PIPESTATUS[0]}\" -eq 0 ]\` imprime PIPELINE OK: o comando FABRICA um veredito de sucesso a partir de dado AUSENTE (ausente != zero, docs/agent/money-path.md). Nada avisa — o \`[\` nem reclama. Vale igual sem o cifrao: \`(( PIPESTATUS[0] == 0 ))\`, \`[[ PIPESTATUS[0] -eq 0 ]]\` e \`let\` avaliam o identificador NU e tratam ausente como 0.

$idioma"
else
  msg="🔴 zsh e 1-INDEXED: \${pipestatus[0]} e sempre vazio — e vazio vale 0 = SUCESSO"
  ctx="PIPESTATUS-INDICE-ZERO: este comando le \`pipestatus[0]\`. O NOME esta certo para o zsh, mas o INDICE nao — arrays do zsh sao 1-INDEXED, entao [0] e sempre VAZIO (medido). E vazio, no \`[\` do zsh, vale 0 = SUCESSO: o comando fabrica aprovacao a partir de dado ausente. O primeiro comando do pipe e \${pipestatus[1]}. (Excecao: sob \`setopt KSH_ZERO_SUBSCRIPT\` ou \`KSH_ARRAYS\` o [0] passa a ser legitimo — se e o seu caso, ignore este aviso.)

$idioma"
fi

jq -n --arg m "$msg" --arg c "$ctx" \
  '{systemMessage:$m, hookSpecificOutput:{hookEventName:"PreToolUse", additionalContext:$c}}'
exit 0
