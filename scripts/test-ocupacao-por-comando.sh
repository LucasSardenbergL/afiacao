#!/usr/bin/env bash
# test-ocupacao-por-comando.sh — TDD de `ocupacao-contexto.sh --por-comando`.
#
# POR QUE ESTA SUÍTE EXISTE:
# `--por-arquivo` respondeu "o que ocupa" e a resposta foi: Bash, 77,1%. A
# pergunta seguinte — QUAL comando — tem uma resposta fácil e errada: a primeira
# palavra da linha. Ela é errada porque a primeira palavra quase nunca é quem
# produziu os bytes:
#
#     echo "--- worktrees ---" && git worktree list | head -40
#
# classifica como `echo` (produz 20 chars) em vez de `git worktree` (produz os
# 40 kB). Medido em piso-de-contexto.md: por prefixo, 46,5% das chamadas caem em
# "outros". A régua usa outra regra — o PRODUTOR é o head-word do 1º estágio de
# cada pipeline — e o não-classificado cai para 0,3%.
#
# Os três jeitos de esta régua mentir, e o caso que pega cada um:
#   (a) voltar a classificar por PREFIXO. O ranking continua plausível (nomes de
#       comando reais, percentuais que somam 100) e aponta para `echo`/`cd`, que
#       não têm remédio. Casos 1-6.
#   (b) atribuir ao ÚLTIMO estágio do pipeline. `cat x | head` viraria `head`, e
#       o conselho sairia invertido: "corte o head" quando o gasto é o `cat`.
#       Caso 2.
#   (c) esconder o quanto NÃO classificou. Um ranking de 54% do volume passa por
#       ranking do volume se o número não aparecer ao lado. Casos 8-9.
#
# (c) é `ausente ≠ zero` aplicado a taxonomia: a diferença entre "o resto é
# pequeno" e "o resto eu não sei ler" não está na tabela — está no marcador.
#
# Uso: bash scripts/test-ocupacao-por-comando.sh              (exit 0 = verde)
#      bash scripts/test-ocupacao-por-comando.sh --falsificar (sabota o alvo; exige vermelho)
set -u

here="$(cd "$(dirname "$0")" && pwd)"
ALVO="${OCUPACAO_OVERRIDE:-$here/ocupacao-contexto.sh}"
command -v jq >/dev/null 2>&1 || { echo "SKIP — jq ausente"; exit 0; }

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT

falhas=0
ok()   { printf '  \033[32mok\033[0m    %s\n' "$1"; }
ruim() { printf '  \033[31mFALHA\033[0m %s\n' "$1"; falhas=$((falhas+1)); }
# Casa ASCII, caixa fixa, sem -i: sob pt_BR.UTF-8 o `grep -i` dobra acento e casa
# o ramo errado (#1483). Todo marcador testado aqui é ASCII de propósito.
tem() { printf '%s' "$1" | command grep -qF "$2"; }

linha_req() { jq -nc --arg r "$1" --arg s "$2" \
  '{requestId:$r, sessionId:$s, message:{usage:{input_tokens:1}}}'; }
# tool_use de Bash: o comando vai em input.command (é de lá que a régua lê)
linha_bash() { # <requestId> <sessao> <toolid> <comando>
  jq -nc --arg r "$1" --arg s "$2" --arg i "$3" --arg c "$4" \
    '{requestId:$r, sessionId:$s, message:{usage:{input_tokens:1}, content:[
       {type:"tool_use", id:$i, name:"Bash", input:{command:$c}}]}}'; }
linha_read() { # <requestId> <sessao> <toolid> <file_path>
  jq -nc --arg r "$1" --arg s "$2" --arg i "$3" --arg f "$4" \
    '{requestId:$r, sessionId:$s, message:{usage:{input_tokens:1}, content:[
       {type:"tool_use", id:$i, name:"Read", input:{file_path:$f}}]}}'; }
linha_res() { jq -nc --arg s "$1" --arg i "$2" --argjson n "$3" \
  '{sessionId:$s, message:{content:[{type:"tool_result", tool_use_id:$i, content:("x"*$n)}]}}'; }

novo_projects() { d="$tmp/$1/projects/-Users-x-Projetos-afiacao-teste"; mkdir -p "$d"; printf '%s' "$tmp/$1/projects"; }
roda()  { CLAUDE_PROJECTS_DIR="$1" bash "$ALVO" --por-comando --linhas 99 "${@:2}" 2>>"${ERROS_DO_ALVO:-/dev/null}"; }
rodae() { CLAUDE_PROJECTS_DIR="$1" bash "$ALVO" --por-comando --linhas 99 "${@:2}" 2>&1; }

# ---- fixture: uma sessão, um comando por chamada, saídas de tamanho igual ----
# Tamanho igual em todas: assim o RANKING só pode vir da classificação, nunca do
# volume. Se o rótulo sair errado, a linha esperada simplesmente não existe.
monta() { # <dir-projects> <sessao> <cmd1> [cmd2 ...]
  P="$1"; S="$2"; shift 2
  F="$P/-Users-x-Projetos-afiacao-teste/$S.jsonl"; : > "$F"
  k=0
  for c in "$@"; do
    k=$((k+1))
    linha_bash "r$k" "$S" "t$k" "$c" >> "$F"
    linha_res  "$S" "t$k" 4000 >> "$F"
  done
  # requests depois das chamadas: sem `restantes` > 0 toda ocupação é zero
  for j in $(seq 1 30); do linha_req "z$j" "$S" >> "$F"; done
}

if [ "${1:-}" != "--falsificar" ]; then echo "▶ ocupacao-contexto.sh --por-comando"; fi

# ---- caso 1: a TESE — o produtor não é a primeira palavra -------------------
P1="$(novo_projects p1)"
monta "$P1" s1 'echo "--- worktrees ---" && git worktree list | head -40'
s="$(roda "$P1")"
if tem "$s" "git worktree"; then ok "K1 caso 1: 'echo X && git worktree list | head' -> git worktree"
else ruim "K1 caso 1: nao classificou como 'git worktree' (prefixo daria 'echo')"; fi
if tem "$s" "echo"; then ruim "K1b caso 1: classificou como 'echo' — regra de PREFIXO"; else ok "K1b caso 1: 'echo' nao virou rotulo"; fi

# ---- caso 2: dentro do pipeline, só o 1º estágio produz ---------------------
P2="$(novo_projects p2)"
monta "$P2" s2 'cat docs/agent/money-path.md | grep -n RLS | head -20'
s="$(roda "$P2")"
if tem "$s" "cat"; then ok "K2 caso 2: 'cat X | grep | head' -> cat (1o estagio)"
else ruim "K2 caso 2: o produtor do pipeline nao foi o 1o estagio"; fi
if tem "$s" "head"; then ruim "K2b caso 2: atribuiu ao ULTIMO estagio — conselho sai invertido"; else ok "K2b caso 2: 'head' nao virou rotulo"; fi

# ---- caso 3: newline é separador de comando --------------------------------
# O jq troca newline por ';' de propósito. Achatar em espaço apaga a fronteira e
# 'cd /path' engole o comando seguinte — foi assim que 17,4% ficou sem classe.
P3="$(novo_projects p3)"
monta "$P3" s3 "$(printf 'cd /Users/x/Projetos/afiacao\nrg -n padrao src/')"
s="$(roda "$P3")"
if tem "$s" "rg"; then ok "K3 caso 3: 'cd <path>' + newline + 'rg' -> rg"
else ruim "K3 caso 3: newline nao separou — 'cd' engoliu o comando seguinte"; fi

# ---- caso 4: o produtor pode estar no CORPO do laço ------------------------
P4="$(novo_projects p4)"
# shellcheck disable=SC2016  # $f e' literal: e' o COMANDO da fixture, nao expansao aqui
monta "$P4" s4 'for f in a b c; do cat supabase/functions/$f/index.ts; done'
s="$(roda "$P4")"
if tem "$s" "cat"; then ok "K4 caso 4: corpo de laco -> cat"
else ruim "K4 caso 4: perdeu o produtor dentro do 'do' (palavra de sintaxe pulou o segmento)"; fi

# ---- caso 5: wrapper não produz saída própria ------------------------------
P5="$(novo_projects p5)"
monta "$P5" s5 'command grep -rl "ANTHROPIC_API_KEY" supabase/functions/'
s="$(roda "$P5")"
if tem "$s" "grep"; then ok "K5 caso 5: 'command grep' -> grep"
else ruim "K5 caso 5: o wrapper 'command' virou o rotulo"; fi

# ---- caso 6: prefixo de atribuição não é comando ---------------------------
P6="$(novo_projects p6)"
monta "$P6" s6 'SP=/tmp/x sed -n 1,50p scripts/deploy.sh'
s="$(roda "$P6")"
if tem "$s" "sed"; then ok "K6 caso 6: 'FOO=bar sed' -> sed"
else ruim "K6 caso 6: a atribuicao virou o rotulo"; fi

# ---- caso 7: multiplexer ganha subcomando ----------------------------------
# `git` sozinho não é acionável: `git log` e `git diff` pedem remédios opostos.
P7="$(novo_projects p7)"
monta "$P7" s7 'git log --oneline -40'
s="$(roda "$P7")"
if tem "$s" "git log"; then ok "K7 caso 7: 'git log --oneline' -> 'git log' (com subcomando)"
else ruim "K7 caso 7: colapsou em 'git' — perde a distincao que decide o remedio"; fi

# ---- caso 8: o marcador de honestidade SAI e traz numero -------------------
s="$(rodae "$P7")"
if tem "$s" "TAXONOMIA-NAO-CLASSIFICADO"; then ok "K8 caso 8: marcador de nao-classificado presente"
else ruim "K8 caso 8: a tabela saiu sem dizer QUANTO ficou sem classificar"; fi

# ---- caso 9: taxonomia fraca se declara ------------------------------------
# Comandos que a regra não sabe ler. Se >25% da ocupação Bash cair fora, a régua
# tem de dizer que a tabela NÃO responde — senão 54% do volume passa por 100%.
P9="$(novo_projects p9)"
# `echo` puro e' o caso real de "nao ha produtor a cortar": a saida existe, mas
# nenhum comando produziu bytes de um arquivo/consulta. A regra devolve
# "(nao classificado)" e a regua tem de DIZER que a tabela nao responde.
monta "$P9" s9 'echo alfa' 'echo beta' 'echo gama'
s="$(rodae "$P9")"
if tem "$s" "TAXONOMIA-FRACA"; then ok "K9 caso 9: >25% sem classe -> declara que nao responde"
else ruim "K9 caso 9: taxonomia fraca passou calada"; fi

# ---- caso 10: sem Bash na janela é AUSENCIA, não zero ----------------------
P10="$(novo_projects p10)"
F="$P10/-Users-x-Projetos-afiacao-teste/s10.jsonl"; : > "$F"
linha_read r1 s10 t1 /Users/x/Projetos/afiacao/docs/agent/deploy.md >> "$F"
linha_res  s10 t1 4000 >> "$F"
for j in $(seq 1 30); do linha_req "z$j" s10 >> "$F"; done
s="$(rodae "$P10")"
if tem "$s" "TAXONOMIA-SEM-BASH"; then ok "K10 caso 10: janela sem Bash se declara em vez de tabela muda"
else ruim "K10 caso 10: zero chamadas Bash saiu como tabela normal — ausencia como medida"; fi

# ---- caso 11: os modos somam o MESMO total ---------------------------------
# Contrato do cabeçalho ("as três somam o MESMO total"). Se `--por-comando`
# descartar o que não sabe ler, o total encolhe e todo percentual infla.
P11="$(novo_projects p11)"
monta "$P11" s11 'cat a.md' 'git log' 'psql -c "select 1"' '{ }'
# Soma `chars tot` (NF-3), nao o percentual. O percentual e' normalizado DENTRO
# de cada modo: se um modo descartasse linhas, as restantes so inflariam ate 100%
# e a igualdade passaria — o teste nao testaria nada. Bytes sao absolutos.
# O cabecalho tambem termina em `%`; o guard de numerico o descarta.
soma() { printf '%s\n' "$1" | LC_ALL=C awk '$NF ~ /%$/ && $(NF-3) ~ /^[0-9]+$/ {s+=$(NF-3)} END{printf "%d", s}'; }
sc="$(soma "$(roda "$P11")")"
sf="$(CLAUDE_PROJECTS_DIR="$P11" bash "$ALVO" --por-ferramenta --linhas 99 "$P11"/-Users-x-Projetos-afiacao-teste/s11.jsonl 2>>"${ERROS_DO_ALVO:-/dev/null}")"
sf="$(soma "$sf")"
if LC_ALL=C awk -v v="${sc:-0}" 'BEGIN{exit !(v > 0)}'; then
  if [ "$sc" = "$sf" ]; then ok "K11 caso 11: --por-comando e --por-ferramenta contam os mesmos $sc chars"
  else ruim "K11 caso 11: totais divergem (comando=$sc ferramenta=$sf) — um dos modos descarta"; fi
else ruim "K11 caso 11: controle positivo falhou — soma zero, nada foi medido"; fi

# ---- caso 12: --ver-shell dobra a leitura via shell no ranking -------------
P12="$(novo_projects p12)"
monta "$P12" s12 "sed -n 1,120p docs/agent/money-path.md"
sv="$(CLAUDE_PROJECTS_DIR="$P12" bash "$ALVO" --por-arquivo --ver-shell --linhas 99 2>>"${ERROS_DO_ALVO:-/dev/null}")"
sn="$(CLAUDE_PROJECTS_DIR="$P12" bash "$ALVO" --por-arquivo --linhas 99 2>>"${ERROS_DO_ALVO:-/dev/null}")"
if tem "$sv" "docs/agent/money-path.md"; then ok "K12 caso 12: --ver-shell atribui 'sed -n X,Yp F' ao arquivo F"
else ruim "K12 caso 12: --ver-shell nao dobrou a leitura via shell no ranking"; fi
if tem "$sn" "(Bash - sem arquivo)"; then ok "K12b caso 12: SEM o flag a linha de base fica intacta"
else ruim "K12b caso 12: o comportamento default mudou — a linha de base de 2026-09-07 deixa de reproduzir"; fi

# ---- caso 13: flag fora de contexto RECUSA em vez de ignorar --------------
CLAUDE_PROJECTS_DIR="$P12" bash "$ALVO" --por-comando --ver-shell >/dev/null 2>&1
if [ "$?" = "2" ]; then ok "K13 caso 13: --ver-shell com --por-comando -> exit 2 (recusa)"
else ruim "K13 caso 13: flag ignorado em silencio — a tabela mente sobre o que mede"; fi

# ---- caso 14: a saída não pode depender do locale --------------------------
# A chave de ordenação é um %018.3f; sob locale de vírgula o `sort -rn` do meio
# do pipeline pode REORDENAR o ranking. Falsificar num locale só não diz nada.
LOC_VIRGULA=""
for L in pt_BR.UTF-8 pt_BR.utf8 de_DE.UTF-8; do
  if [ "$(LC_ALL="$L" awk 'BEGIN{printf "%.1f", 1.5}' 2>/dev/null)" = "1,5" ]; then LOC_VIRGULA="$L"; break; fi
done
if [ -z "$LOC_VIRGULA" ]; then
  printf '  \033[33mSKIP\033[0m  locale decimal-virgula ausente — caso 14 SEM cobertura\n'
else
  sl="$(LC_ALL="$LOC_VIRGULA" CLAUDE_PROJECTS_DIR="$P11" bash "$ALVO" --por-comando --linhas 99 2>>"${ERROS_DO_ALVO:-/dev/null}")"
  nv="$(printf '%s' "$sl" | command grep -cE '[0-9],[0-9]' || true)"
  if [ "${nv:-0}" -eq 0 ]; then ok "K14 caso 14: sob $LOC_VIRGULA a saida segue com ponto decimal"
  else ruim "K14 caso 14: sob $LOC_VIRGULA sairam $nv numero(s) com virgula — saida depende do locale"; fi
fi

# ---- falsificação ----------------------------------------------------------
if [ "${1:-}" = "--falsificar" ]; then
  printf '\n== falsificacao (sabota o ALVO e EXIGE vermelho NO ASSERT que a sabotagem declara) ==\n'

  # Os logs das rodadas saem SEM cor (`sem_cor`), para o ID casar logo depois da palavra.
  esc="$(printf '\033')"
  sem_cor() { LC_ALL=C sed "s/${esc}\[[0-9;]*m//g" "$1"; }
  # Asserts EXECUTADOS numa rodada (ok + FALHA): o recibo de que a suíte rodou inteira.
  asserts() { LC_ALL=C grep -cE '^  (ok +|FALHA )' "$1" || true; }
  # Erro de execução do bash no ALVO: no log (o que a suíte despeja da saída dele) e no que
  # ERROS_DO_ALVO recolhe das chamadas que a suíte normal manda para /dev/null (elas MEDEM o stdout).
  erros_exec() { cat "$1" "$1.stderr" 2>/dev/null | LC_ALL=C grep -cE 'unbound variable|command not found|syntax error|bad substitution' || true; }
  vermelhos() { { LC_ALL=C grep -Eo '^  FALHA K[0-9]+[a-z]? ' "$1" || true; } | LC_ALL=C awk '{ printf "%s ", $2 }'; }

  # CONTROLE antes do primeiro sed: um arnês incondicionalmente vermelho APROVA
  # TUDO — toda sabotagem produz o vermelho exigido e o gate anuncia "cobre
  # tudo". Roda na MESMA invocação, mesmo OCUPACAO_OVERRIDE, sem sabotagem.
  if [ -n "${OCUPACAO_OVERRIDE:-}" ]; then
    printf '   OCUPACAO_OVERRIDE ja definido — recursao. Abortando.\n'; exit 1
  fi
  controle="$tmp/controle.sh"; cp "$ALVO" "$controle"; chmod +x "$controle"
  # O LOG do controle é a régua das camadas do laço: quantos asserts a suíte executa, e que o
  # assert declarado SABE ficar verde nesta invocação.
  ctl="$tmp/controle.log"
  : > "$ctl.stderr"
  OCUPACAO_OVERRIDE="$controle" ERROS_DO_ALVO="$ctl.stderr" bash "$0" >"$ctl.cru" 2>&1; rc=$?
  sem_cor "$ctl.cru" > "$ctl"
  if [ "$rc" -eq 0 ] && [ "$(asserts "$ctl")" -gt 0 ]; then
    ok "controle (copia SEM sabotagem) -> VERDE ($(asserts "$ctl") asserts)"
  else
    ruim "controle SEM sabotagem ja esta VERMELHO — sem linha de base, sabotar nao prova nada"
    printf '   Abortando: sabotagem sobre arnes vermelho aprova qualquer coisa.\n'; exit 1
  fi

  copia="$tmp/sabotado.sh"
  aplica() {  # escreve a cópia sabotada; 1 = falsificação VAZIA (já acusada), nada a julgar
    if ! erro="$(sed "$expr" "$ALVO" 2>&1 >"$copia")"; then
      ruim "\"$desc\": sed invalido (${erro:0:60}) — sabotagem vazia"; return 1; fi
    if cmp -s "$ALVO" "$copia"; then
      ruim "\"$desc\": padrao nao casou, alvo intacto — sabotagem vazia"; return 1; fi
    chmod +x "$copia"
    # Sintaxe quebrada pintaria TODO caso de vermelho sem ter sabotado a regra — e a sabotagem
    # que só DERRUBA o alvo em runtime também: a fumaça roda a cópia no caso 1 e procura o erro.
    if ! bash -n "$copia" 2>/dev/null; then
      ruim "\"$desc\": quebrou a SINTAXE do shell — vermelho pelo motivo errado"; return 1; fi
    fum="$(CLAUDE_PROJECTS_DIR="$P1" bash "$copia" --por-comando --linhas 99 2>&1 || true)"
    if printf '%s' "$fum" | command grep -qE 'unbound variable|command not found|syntax error'; then
      ruim "\"$desc\": quebrou o RUNTIME (${fum:0:60}) — vermelho pelo motivo errado"; return 1; fi
  }

  # <sabotagem>:<IDs dos asserts que TÊM de acusá-la> — `,` = E (cada um tem de virar), `|` = OU
  # (basta um). O ID é o 1º token que o assert imprime (`FALHA K4 …`). Exit≠0 NÃO é dente: até
  # 2026-09-27 este laço contava "-> vermelho" para QUALQUER rodada que saísse ≠0 — assert alheio,
  # aborto, sintaxe quebrada (não havia `bash -n`). Colaterais ficam de fora de propósito.
  # docs/historico/falsificacao-exit-nao-e-dente.md
  SABOTAGENS="prefixo_1a_palavra:K1 ultimo_estagio:K2b sintaxe_pula_segmento:K4
              multiplexer_sem_subcomando:K7 sem_marcador_nao_classificado:K8 taxonomia_fraca_calada:K9
              sem_bash_tabela_normal:K10 ver_shell_descarta_alvo:K12 ver_shell_default:K12b
              flag_fora_de_contexto:K13 locale_nao_forcado:K14"

  # registra <nome> <descricao> <expressao sed> — a TABELA das sabotagens. Nome da lista sem
  # registro e registro fora da lista são FALHA (no fim do laço): o primeiro não sabotaria nada, o
  # segundo nunca rodaria.
  registradas=""
  registra() { registradas="$registradas $1"; printf -v "desc_$1" '%s' "$2"; printf -v "expr_$1" '%s' "$3"; }

  registra prefixo_1a_palavra "classifica por PREFIXO (1a palavra)" \
    's|^  ns = split(cmd, segs, /&&.*$|  ns = 1; segs[1] = cmd|'
  # delimitador `#`, e o padrao para em `est` — `\|` dentro de BRE e' alternacao
  # no GNU e literal no BSD, entao nem o padrao nem a troca podem conter a barra.
  registra ultimo_estagio "atribui ao ULTIMO estagio do pipeline" \
    's#^    split(segs\[i\], est.*#    nnn = split(segs[i], est, "[|]"); est[1] = est[nnn]#'
  registra sintaxe_pula_segmento "palavra de sintaxe pula o segmento (perde corpo de laco)" \
    's|^      if (!so_sintaxe(w)) break|      break|'
  registra multiplexer_sem_subcomando "multiplexer perde o subcomando" \
    's|^  if (w !~ /\^(git\|gh\|bun|  if (1) return w; if (w !~ /^(git\|gh\|bun|'
  registra sem_marcador_nao_classificado "marcador de nao-classificado removido" \
    's|TAXONOMIA-NAO-CLASSIFICADO|TAXONOMIA-SILENCIOSA|'
  registra taxonomia_fraca_calada "taxonomia fraca deixa de se declarar" \
    's|> 25)$|> 999)|'
  registra sem_bash_tabela_normal "janela sem Bash vira tabela normal" \
    's|TAXONOMIA-SEM-BASH|TAXONOMIA-QUIETA|'
  registra ver_shell_descarta_alvo "--ver-shell descarta o alvo do shell" \
    's|^        if (alv != "") {|        if (0) {|'
  registra ver_shell_default "--ver-shell vira default (quebra a linha de base)" \
    's|^VER_SHELL=0|VER_SHELL=1|'
  # shellcheck disable=SC2016  # $VER_SHELL/$MODO sao literais: casam o TEXTO do alvo
  registra flag_fora_de_contexto "flag fora de contexto passa calado" \
    's|^if \[ "\$VER_SHELL" -eq 1 \] && \[ "\$MODO" != arquivo \]; then|if false; then|'
  # Esta sabotagem só tem detector se a máquina tiver locale de vírgula — é o
  # caso 14, e ele sai SKIP no CI. Sabotar sem detector conta cobertura que não
  # foi exercida: anuncia em vez de passar calado (mesma regra da suíte irmã).
  # shellcheck disable=SC2016  # ${LC_ALL:-C} vai LITERAL para dentro do alvo sabotado
  registra locale_nao_forcado "locale deixa de ser forcado" \
    's|^export LC_ALL=C|export LC_ALL=${LC_ALL:-C}|'

  # A rodada só conta como vermelha com as QUATRO camadas (as do sync-reprocess):
  #   1. a sabotagem APLICOU e não quebrou o alvo (as travas de aplica());
  #   2. a suíte rodou INTEIRA (nº de asserts = o do controle: aborto no meio não é assert);
  #   3. CADA assert declarado está VERDE no controle e VERMELHO aqui (o mesmo assert virou);
  #   4. nenhum erro de execução do bash no alvo que o controle não tem — o alvo que morre no ramo
  #      do assert derruba o assert certo por CRASH, não por julgamento.
  for item in $SABOTAGENS; do
    sab="${item%%:*}"; exigidos="${item#*:}"
    v="desc_$sab"; desc="${!v-}"; v="expr_$sab"; expr="${!v-}"
    if [ -z "$expr" ]; then
      ruim "\"$sab\": na lista SABOTAGENS e SEM registro — nada foi sabotado"; continue
    fi
    # Esta só tem detector se a máquina tiver locale de vírgula — é o caso 14, e ele sai SKIP no
    # CI. Sabotar sem detector conta cobertura que não foi exercida: anuncia em vez de passar calado.
    if [ "$sab" = locale_nao_forcado ] && [ -z "$LOC_VIRGULA" ]; then
      printf '  \033[33mSKIP\033[0m  sabotagem do LC_ALL=C sem locale decimal-virgula — NAO exercitada\n'; continue
    fi
    aplica || continue
    log="$tmp/sabotada-$sab.log"
    : > "$log.stderr"
    OCUPACAO_OVERRIDE="$copia" ERROS_DO_ALVO="$log.stderr" bash "$0" >"$log.cru" 2>&1; rc=$?
    sem_cor "$log.cru" > "$log"
    if [ "$rc" -eq 0 ]; then
      ruim "\"$desc\": alvo sabotado e a suite passou VERDE — invariante sem cobertura"; continue
    fi
    # Daqui em diante a rodada saiu ≠0 — o que, sozinho, não prova NADA.
    faltam=""
    for exigido in ${exigidos//,/ }; do
      if ! LC_ALL=C grep -Eq "^  ok +($exigido) " "$ctl" || ! LC_ALL=C grep -Eq "^  FALHA ($exigido) " "$log"; then
        faltam="$faltam $exigido"
      fi
    done
    if [ "$(asserts "$log")" != "$(asserts "$ctl")" ]; then
      ruim "\"$desc\": a suite NAO rodou inteira ($(asserts "$log") de $(asserts "$ctl") asserts) — vermelho de aborto, nao de assert"
    elif [ "$(erros_exec "$log")" != "$(erros_exec "$ctl")" ]; then
      ruim "\"$desc\": vermelha com ERRO de execucao no alvo — o assert caiu por crash, nao por julgamento"
    elif [ -n "$faltam" ]; then
      ruim "\"$desc\": vermelha, mas o assert declarado NAO virou (verde no controle -> vermelho aqui):$faltam · vermelhos: $(vermelhos "$log")"
    else
      ok "\"$desc\" -> vermelho no assert declarado ($exigidos) · vermelhos: $(vermelhos "$log")"
    fi
  done
  for r in $registradas; do
    case " $SABOTAGENS " in
      *[[:space:]]"$r:"*) ;;
      *) ruim "\"$r\": registrada e FORA da lista SABOTAGENS — nunca roda, e o verde nao a cobre" ;;
    esac
  done
fi

printf '\n'
if [ "$falhas" -eq 0 ]; then printf '\033[32mTODOS OS CASOS OK\033[0m\n'; exit 0; fi
printf '\033[31m%d falha(s)\033[0m\n' "$falhas"; exit 1
