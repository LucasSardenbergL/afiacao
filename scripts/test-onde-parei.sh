#!/usr/bin/env bash
# test-onde-parei.sh — TDD do scripts/onde-parei.sh com `git`/`gh` STUBADOS e
# HOME de fixture (sem rede, sem tocar worktree de verdade).
#
# Contrato testado (exit codes): 0=HÁ trabalho a retomar · 3=CONSULTEI e não há
# nada · 6=NÃO CONSEGUI CONSULTAR (estado DESCONHECIDO) · 64=uso errado.
#
# O coração é a CONTAGEM DE TRANSCRIÇÕES. A sonda nasceu (#2182) contando as
# sessões com `tool_use` no diretório do worktree e reportando `n-1`, assumindo
# que exatamente UMA delas é a sessão atual. A suposição é falsa no uso
# DOCUMENTADO `onde-parei.sh <outro-worktree>`: ali NENHUMA transcrição é a
# atual, e o -1 come uma sessão real. Com n=1 (worktree com exatamente uma
# sessão anterior, limpo e sem PR) o desconto zera a contagem, o gatilho de
# arqueologia (n>1) não arma e a sonda sai 3 = "NADA A RETOMAR" com uma
# transcrição inteira em disco — o fail-open que a §Armadilhas do CLAUDE.md
# chama de sonda que falha e diz "nada".
#
# Uso: bash scripts/test-onde-parei.sh              (exit 0 = tudo verde)
#      bash scripts/test-onde-parei.sh --falsificar (sabota a correção; exige vermelho)
set -u

here="$(cd "$(dirname "$0")" && pwd)"
SONDA="${SONDA_OVERRIDE:-$here/onde-parei.sh}"
[ -x "$SONDA" ] || { echo "❌ sonda não encontrada/executável: $SONDA" >&2; exit 1; }

stub="$(mktemp -d)"
raiz="$(mktemp -d)"
trap 'rm -rf "$stub" "$raiz"' EXIT

# ── stubs ───────────────────────────────────────────────────────────────────
# git: responde só o que a sonda pergunta. SIM_* controla o cenário.
cat >"$stub/git" <<'STUB'
#!/bin/sh
case "$*" in
  "rev-parse --is-inside-work-tree") exit 0 ;;
  "rev-parse --abbrev-ref HEAD")     echo "${SIM_BRANCH:-claude/fixture}" ;;
  "fetch -q origin")                 [ -n "${SIM_FETCH_FALHA:-}" ] && exit 1; exit 0 ;;
  "log --oneline origin/main..HEAD") printf '%s' "${SIM_AHEAD:-}" ;;
  "rev-list --count HEAD..origin/main") echo "${SIM_ATRAS:-0}" ;;
  "status --porcelain")              printf '%s' "${SIM_DIRTY:-}" ;;
  *) exit 0 ;;
esac
STUB
# gh: SIM_GH_FALHA=1 → o binário EXISTE mas a consulta falha (é o caso 6, e é
# diferente de "gh ausente": presente-porém-quebrada esvazia o guard igual).
cat >"$stub/gh" <<'STUB'
#!/bin/sh
[ -n "${SIM_GH_FALHA:-}" ] && { echo "gh: rede fora" >&2; exit 1; }
printf '%s' "${SIM_PRS:-}"
STUB
chmod +x "$stub/git" "$stub/gh"

falhas=0
ok()   { printf '  ✅ %s\n' "${1//$'\n'/ | }"; }
ruim() { printf '  ❌ %s\n' "${1//$'\n'/ | }"; falhas=$((falhas+1)); }

# Monta um worktree-fixture e seu diretório de transcrições em HOME de teste.
#   $1 nome  $2 lista de "id:com_tool_use(1|0)" separada por espaço
montar() {
  wt="$raiz/wt-$1"; mkdir -p "$wt"
  export HOME_FIXTURE="$raiz/home-$1"
  slug=${wt//[\/.]/-}
  proj="$HOME_FIXTURE/.claude/projects/$slug"
  mkdir -p "$proj"
  for spec in $2; do
    id=${spec%%:*}; tem=${spec##*:}
    if [ "$tem" = 1 ]; then
      printf '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash"}]}}\n' >"$proj/$id.jsonl"
    else
      printf '{"type":"user","message":{"content":"oi"}}\n' >"$proj/$id.jsonl"
    fi
  done
}

# Roda a sonda contra o fixture. Devolve exit em $rc e saída em $saida.
rodar() {
  saida=$(env PATH="$stub:$PATH" HOME="$HOME_FIXTURE" \
              CLAUDE_CODE_SESSION_ID="${ID_ATUAL:-}" \
              SIM_BRANCH="${SIM_BRANCH:-claude/fixture}" \
              SIM_DIRTY="${SIM_DIRTY:-}" SIM_AHEAD="${SIM_AHEAD:-}" \
              SIM_PRS="${SIM_PRS:-}" SIM_GH_FALHA="${SIM_GH_FALHA:-}" \
              SIM_FETCH_FALHA="${SIM_FETCH_FALHA:-}" \
              "$SONDA" "$@" 2>&1)
  rc=$?
}

# Igual a rodar(), mas de DENTRO do worktree e sem argumento — é assim que a
# sonda distingue "meu próprio worktree" de "outro".
rodar_de_dentro() {
  saida=$(cd "$wt" && env PATH="$stub:$PATH" HOME="$HOME_FIXTURE" \
              CLAUDE_CODE_SESSION_ID="${ID_ATUAL:-}" \
              SIM_BRANCH="${SIM_BRANCH:-claude/fixture}" SIM_DIRTY="${SIM_DIRTY:-}" \
              SIM_AHEAD="${SIM_AHEAD:-}" SIM_PRS="${SIM_PRS:-}" \
              SIM_GH_FALHA="${SIM_GH_FALHA:-}" SIM_FETCH_FALHA="${SIM_FETCH_FALHA:-}" \
              "$SONDA" 2>&1)
  rc=$?
}

caso() { # $1 nome  $2 rc esperado
  if [ "$rc" -eq "$2" ]; then ok "$1 (exit $rc)"
  else ruim "$1 — esperava exit $2, veio $rc"; printf '%s\n' "$saida" | sed 's/^/       /'; fi
}
dump() { printf '%s\n' "$saida" | sed 's/^/       /'; }
contem() {   # $1 padrão  $2 nome
  if printf '%s' "$saida" | grep -q "$1"; then ok "$2"; else ruim "$2 — não achei /$1/ na saída"; dump; fi
}
nao_contem() { # $1 padrão  $2 (vazio)  $3 nome
  if printf '%s' "$saida" | grep -q "$1"; then ruim "$3 — achei /$1/ e não devia"; dump; else ok "$3"; fi
}

# ── modo falsificação ───────────────────────────────────────────────────────
# Sabota a SONDA (nunca o arquivo versionado: a mutação vai para uma CÓPIA em
# $raiz, servida por SONDA_OVERRIDE) e EXIGE vermelho. Suíte que não fica
# vermelha quando a invariante quebra é teatro — e aqui o teatro seria caro: o
# contrato desta sonda é 3 ≠ 6, e confundir os dois faz a sessão descartar
# trabalho real por "nada a retomar".
#
# Este bloco existia SÓ no cabeçalho (linha 19) até 2026-09-07: `--falsificar`
# era um argumento que ninguém parseava, então a flag caía na suíte normal e
# saía VERDE, exit 0, com saída byte-a-byte idêntica à do controle. Quem
# seguisse o "Uso:" recebia verde de um contrato que promete vermelho e
# registrava "falsificação feita" — veredito fabricado a partir de código que
# não existe, a mesma família de `ausente != zero`.
# shellcheck disable=SC2016  # as aspas simples nas expressões sed abaixo são de
# propósito: `$MESMO_WT` e `$ATUAL` são o TEXTO que o sed procura DENTRO da
# sonda. Expandir aqui escreveria um padrão que não casa — sabotagem vazia, que
# a trava (2) pega, mas só depois de custar uma rodada.
if [ "${1:-}" = "--falsificar" ]; then
  printf '== falsificacao (sabota a SONDA e EXIGE vermelho NO ASSERT que a sabotagem declara) ==\n'

  # Fixture de FUMAÇA: cenário trivial que a sonda tem de atravessar sem erro
  # de bash. Serve só à trava (4) de aplica().
  montar fumaca "s-fumaca:1"
  wt_fumaca="$wt"; home_fumaca="$HOME_FIXTURE"

  # Asserts EXECUTADOS numa rodada da suíte (✅ + ❌): o recibo de que ela rodou inteira.
  asserts() { LC_ALL=C grep -cE '^  (✅|❌) ' "$1" || true; }
  vermelhos() { { LC_ALL=C grep -Eo '^  ❌ P[0-9]+[a-z]? ' "$1" || true; } | LC_ALL=C awk '{ printf "%s ", $2 }'; }
  # A camada 4 (o stderr INTEIRO da sonda, por linha, contra o do controle) e o embrulho que o
  # recolhe: a suíte roda a sonda com `2>&1` DENTRO da saída que os asserts julgam, e o log só a
  # mostrava quando um assert caía — o stderr de toda chamada chegava ao juiz por acaso.
  # shellcheck source=scripts/lib/falsificacao-stderr.sh disable=SC1091
  . "$here/lib/falsificacao-stderr.sh"

  # ── CONTROLE: verde ANTES do primeiro sed ─────────────────────────────────
  # "Ficou vermelho" só é informação se existir um verde do qual sair. Sem esta
  # trava, um arnês incondicionalmente vermelho (stub quebrado, fixture podre)
  # APROVA TUDO: toda sabotagem produz o vermelho exigido e o gate anuncia
  # "toda mutação foi detectada". O controle roda a MESMA invocação do laço
  # (cópia em $raiz, o mesmo SONDA_OVERRIDE) e só troca a sabotagem por NADA —
  # por isso não é redundante com o `bun run test:hooks`, que roda a suíte crua
  # sobre o alvo REAL, outra invocação. O LOG dele é a régua das camadas abaixo:
  # quantos asserts a suíte executa, e que o assert declarado SABE ficar verde.
  controle="$raiz/controle-sonda.sh"; ctl="$raiz/controle.log"
  cp "$SONDA" "$controle"; chmod +x "$controle"
  : > "$ctl.stderr"
  emb_ctl="$(embrulha_alvo "$controle" "$ctl.stderr")" || { ruim "nao consegui embrulhar o controle"; exit 1; }
  if SONDA_OVERRIDE="$emb_ctl" bash "$0" >"$ctl" 2>&1; then
    ok "controle (copia SEM sabotagem) -> VERDE ($(asserts "$ctl") asserts; $(linha_de_base "$ctl"))"
  else
    ruim "controle SEM sabotagem ja esta VERMELHO — sem linha de base, sabotar nao prova nada"
  fi
  case "$(asserts "$ctl")" in
    ''|0) ruim "controle SEM assert legivel — sem ele nao ha como saber se a rodada sabotada julgou algo" ;;
  esac
  if [ "$falhas" -ne 0 ]; then
    printf '\n❌ falsificacao ABORTADA: sem verde de partida.\n'
    printf '   Conserte a suite primeiro; sabotar sobre vermelho produz veredito fabricado.\n'
    exit 1
  fi

  # <sabotagem>:<IDs dos asserts que TÊM de acusá-la> — `,` = E (cada um tem de virar), `|` = OU
  # (basta um). O ID é o 1º token que o assert imprime (`❌ P6 …`). Exit≠0 NÃO é dente: até
  # 2026-09-27 este laço contava como "-> vermelho" QUALQUER rodada que saísse ≠0 — assert alheio,
  # aborto, a sonda morrendo de `set -u` no ramo que o assert mede. Os colaterais (asserts que
  # também caem, mas não existem para pegar ESTA sabotagem) ficam de fora de propósito.
  # docs/historico/falsificacao-exit-nao-e-dente.md
  SABOTAGENS="falha_sai_3:P6 guard_do_gh_some:P6 atual_volta_a_contar:P1 sem_tool_use_conta:P4
              desconto_ignora_mesmo_wt:P9 desconto_ignora_var:P10 veredito_sai_0:P5"

  # registra <nome> <descricao> <invariante que deve quebrar> <expressao sed> — a TABELA das
  # sabotagens. Nome da lista sem registro e registro fora da lista são FALHA (abaixo): o primeiro
  # não sabotaria nada, o segundo nunca rodaria.
  registradas=""
  registra() {
    case " $registradas " in *" $1 "*) echo "registra: nome REPETIDO ($1) — o 2o registro sobrescreveria o 1o" >&2; exit 2 ;; esac
    registradas="$registradas $1"
    printf -v "desc_$1" '%s' "$2"; printf -v "regra_$1" '%s' "$3"; printf -v "expr_$1" '%s' "$4"
  }
  registra falha_sai_3 "falha() sai 3 em vez de 6" \
           "3 != 6 — nao-consegui-consultar viraria 'nada a retomar' (fail-open)" \
           's/exit 6; }/exit 3; }/'
  registra guard_do_gh_some "guard do gh some (presente-porem-quebrada)" \
           "gh que RESPONDE erro tem de virar 6, nao seguir com PRS=lixo" \
           's/falha "gh pr list falhou/: "gh pr list falhou/'
  registra atual_volta_a_contar "a sessao ATUAL deixa de ser excluida da contagem" \
           "a sessao que sonda nao e trabalho a retomar" \
           's/&& continue/\&\& :/'
  registra sem_tool_use_conta "transcricao sem tool_use passa a contar" \
           "sessao que so abriu nao e historia" \
           's/|| continue/|| true/'
  registra desconto_ignora_mesmo_wt "desconto heuristico ignora MESMO_WT" \
           "sondando OUTRO worktree, descontar inventa uma sessao atual que nao existe la" \
           's/\[ "\$MESMO_WT" = 1 \]/true/'
  registra desconto_ignora_var "desconto heuristico ignora a var estar definida" \
           "com CLAUDE_CODE_SESSION_ID definido nao ha o que estimar" \
           's/\[ -z "\$ATUAL" \]/true/'
  registra veredito_sai_0 "veredito final sai 0 em vez de 3" \
           "worktree sem nada tem de dizer 3, nao 0" \
           's/exit 3$/exit 0/'

  copia="$raiz/sonda-sabotada.sh"
  # aplica — escreve a cópia sabotada; 1 = falsificação VAZIA (já acusada), nada a julgar.
  aplica() {
    erro=$(sed "$expr" "$SONDA" 2>&1 >"$copia"); chmod +x "$copia"
    # (1) sed inválido escreve cópia vazia, que fica vermelha sem ter sabotado nada
    if [ -n "$erro" ]; then
      ruim "\"$desc\": sed invalido (${erro:0:60}) — sabotagem vazia"; return 1
    fi
    # (2) padrão que não casa deixa a sonda intacta
    if cmp -s "$SONDA" "$copia"; then
      ruim "\"$desc\": padrao nao casou, sonda intacta — sabotagem vazia"; return 1
    fi
    # (3) sintaxe de shell quebrada = vermelho pelo motivo errado
    if ! bash -n "$copia" 2>/dev/null; then
      ruim "\"$desc\": quebrou a SINTAXE do shell — vermelho pelo motivo errado"; return 1
    fi
    # (4) `bash -n` NÃO vê erro de runtime, e a sonda roda sob `set -u`: uma
    # sabotagem que deixe variável sem definir pintaria tudo de vermelho por
    # erro de bash, não por invariante quebrada — poder aparente inflado. A
    # fumaça só atravessa o cenário TRIVIAL; o ramo de cada assert é vigiado
    # pela camada 4 do laço, sobre o log inteiro.
    sonda_ant="$SONDA"
    SONDA="$copia"; export HOME_FIXTURE="$home_fumaca"; ID_ATUAL=s-fumaca
    rodar "$wt_fumaca"; fumaca="$saida"
    SONDA="$sonda_ant"
    if printf '%s' "$fumaca" | grep -qE 'unbound variable|command not found|syntax error'; then
      ruim "\"$desc\": quebrou o RUNTIME do bash (${fumaca:0:60}) — vermelho pelo motivo errado"; return 1
    fi
  }

  # A rodada só conta como vermelha com as QUATRO camadas (as do sync-reprocess):
  #   1. a sabotagem APLICOU (as travas de aplica());
  #   2. a suíte rodou INTEIRA (nº de asserts = o do controle: aborto no meio não é assert);
  #   3. CADA assert declarado está VERDE no controle e VERMELHO aqui (o mesmo assert virou);
  #   4. nenhuma linha de erro que o controle não tem (`camada4`): o stderr INTEIRO da sonda, por
  #      linha normalizada — a sonda que morre de `set -u` no ramo do assert derruba o assert certo
  #      por CRASH, não por julgamento, e o erro de FERRAMENTA não está em lista-negra nenhuma.
  # Nome repetido rodaria a mesma mutação duas vezes (e inflaria o recibo); `|` (OU) não é
  # suportado por este juiz: os dois greps poderiam casar MEMBROS diferentes (Codex, 2026-09-27).
  # shellcheck disable=SC2086  # a divisão em palavras da lista é o ponto
  repetidos="$(printf '%s\n' $SABOTAGENS | cut -d: -f1 | sort | uniq -d | tr '\n' ' ')"
  [ -z "$repetidos" ] || { ruim "SABOTAGENS com nome repetido: $repetidos"; }
  case "$SABOTAGENS" in *'|'*) ruim "SABOTAGENS com | (OU): declare por , (E) — este juiz exige o MESMO assert nos dois lados" ;; esac
  for item in $SABOTAGENS; do
    sab="${item%%:*}"; exigidos="${item#*:}"
    v="desc_$sab"; desc="${!v-}"; v="regra_$sab"; regra="${!v-}"; v="expr_$sab"; expr="${!v-}"
    if [ -z "$expr" ]; then
      ruim "\"$sab\": na lista SABOTAGENS e SEM registro — nada foi sabotado"; continue
    fi
    aplica || continue
    log="$raiz/sabotada-$sab.log"; : > "$log.stderr"
    emb="$(embrulha_alvo "$copia" "$log.stderr")" || { ruim "\"$desc\": nao consegui embrulhar a copia"; continue; }
    if SONDA_OVERRIDE="$emb" bash "$0" >"$log" 2>&1; then
      ruim "\"$desc\" passou VERDE — a suite NAO cobre: $regra"; continue
    fi
    # Daqui em diante a rodada saiu ≠0 — o que, sozinho, não prova NADA.
    faltam=""
    for exigido in ${exigidos//,/ }; do
      if ! LC_ALL=C grep -Eq "^  ✅ ($exigido) " "$ctl" || ! LC_ALL=C grep -Eq "^  ❌ ($exigido) " "$log"; then
        faltam="$faltam $exigido"
      fi
    done
    if [ "$(asserts "$log")" != "$(asserts "$ctl")" ]; then
      ruim "\"$desc\": a suite NAO rodou inteira ($(asserts "$log") de $(asserts "$ctl") asserts) — vermelho de aborto, nao de assert"
    elif novas="$(camada4 "$sab" "$log" "$ctl" "$copia" "$controle")"; [ -n "$novas" ]; then
      ruim "\"$desc\": vermelha com erro que o CONTROLE nao tem — o assert caiu por crash, nao por julgamento"
      printf '%s\n' "$novas" | head -3 | LC_ALL=C sed 's/^/       /'
    elif [ -n "$faltam" ]; then
      ruim "\"$desc\": vermelha, mas o assert declarado NAO virou (verde no controle -> vermelho aqui):$faltam"
      printf '       vermelhos desta rodada: %s\n' "$(vermelhos "$log")"
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

  echo
  if [ "$falhas" -eq 0 ]; then
    echo "✅ falsificacao: toda sabotagem ficou vermelha NO assert que declara"; exit 0
  else
    echo "❌ falsificacao: $falhas sabotagem(ns) sem o vermelho certo — a suite nao cobre o que promete"; exit 1
  fi
fi

echo "▶ onde-parei.sh"

# 1. Worktree limpo cuja ÚNICA transcrição é a da sessão ATUAL → nada a retomar.
#    (guarda contra super-sinalizar: sem isto a correção viraria "sempre exit 0")
unset SIM_DIRTY SIM_PRS SIM_GH_FALHA SIM_AHEAD
montar so-atual "sessao-atual:1"
ID_ATUAL=sessao-atual
rodar "$wt"
caso "P1 só a sessão atual → nada a retomar" 3

# 2. REGRESSÃO: outro worktree, 1 sessão anterior, limpo e sem PR.
#    Nenhuma transcrição é a atual → há história, e a sonda tem de dizer isso.
montar outro-1 "sessao-antiga:1"
ID_ATUAL=sessao-desta-sessao
rodar "$wt"
caso "P2 outro worktree com 1 sessão anterior → HÁ trabalho" 0
contem "1 sess" "P2b conta a sessão anterior (não a some no -1)"

# 3. Duas sessões anteriores além da atual → conta 2, não 3.
montar duas "sessao-atual:1 velha-a:1 velha-b:1"
ID_ATUAL=sessao-atual
rodar "$wt"
caso "P3 2 anteriores + a atual → HÁ trabalho" 0
contem "2 sess" "P3b conta 2 (exclui a atual do total)"

# 4. Transcrição sem tool_use não é história.
montar sem-tool "sessao-atual:1 vazia:0"
ID_ATUAL=sessao-atual
rodar "$wt"
caso "P4 sessão sem tool_use não conta" 3

# 5. Sem transcrição nenhuma → nada a retomar.
montar nenhuma ""
ID_ATUAL=sessao-atual
rodar "$wt"
caso "P5 sem transcrição → nada a retomar" 3

# 6. 3 ≠ 6: gh presente mas a consulta FALHA → DESCONHECIDO, nunca "nada".
montar gh-quebrada "sessao-atual:1"
SIM_GH_FALHA=1; ID_ATUAL=sessao-atual
rodar "$wt"
caso "P6 gh responde erro → NÃO CONSEGUI CONSULTAR" 6
unset SIM_GH_FALHA

# 7. Uso errado.
HOME_FIXTURE="$raiz"; ID_ATUAL=x
rodar "$raiz/nao-existe-mesmo"
caso "P7 caminho inexistente → uso errado" 64

# 8. DEGRADAÇÃO, lado seguro: sem CLAUDE_CODE_SESSION_ID, sondando o PRÓPRIO
#    worktree, a heurística velha (descontar 1) ainda vale.
montar degrada-dentro "so-uma:1"
ID_ATUAL=''
rodar_de_dentro
caso "P8 sem a var, no próprio worktree → desconta 1 → nada a retomar" 3
contem "heur" "P8b diz que descontou por heurística (não finge certeza)"

# 9. DEGRADAÇÃO, lado perigoso: sem a var, sondando OUTRO worktree, descontar
#    inventaria uma sessão atual que não existe ali → não desconta.
montar degrada-fora "so-uma:1"
ID_ATUAL=''
rodar "$wt"
caso "P9 sem a var, em outro worktree → NÃO desconta → HÁ trabalho" 0

echo
# 10. O caminho MAIS COMUM de todos: de DENTRO do próprio worktree, com a var
#     DEFINIDA. Aqui a heurística de desconto não tem o que estimar — a sessão
#     atual já saiu da conta pelo `continue` lá em cima. Descontar de novo
#     subtrai DUAS vezes e, com n=1, zera: a sonda sairia 3 = "NADA A RETOMAR"
#     com uma transcrição inteira em disco, o fail-open que ela existe para
#     evitar. É o ÚNICO caso que alcança o guard `[ -z "$ATUAL" ]`: sem ele a
#     mutação que troca esse guard por `true` sobrevive verde (medido em
#     2026-09-07, com o --falsificar recém-nascido — o caso 8 não serve porque
#     lá a var é vazia de propósito, e o 2 roda de fora, onde MESMO_WT=0 já
#     barra o desconto antes do guard).
montar dentro-com-var "sessao-atual:1 velha:1"
ID_ATUAL=sessao-atual
rodar_de_dentro
caso "P10 de dentro, com a var definida → conta a anterior" 0
contem "1 sess" "P10b conta 1 (a atual saiu pelo continue, não pela heurística)"
nao_contem "heur" "" "P10c com a var definida, não desconta por heurística"

if [ "$falhas" -eq 0 ]; then echo "✅ onde-parei.sh: tudo verde"; exit 0
else echo "❌ onde-parei.sh: $falhas asserção(ões) vermelha(s)"; exit 1; fi
