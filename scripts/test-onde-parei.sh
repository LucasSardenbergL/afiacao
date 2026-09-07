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
ok()   { printf '  ✅ %s\n' "$1"; }
ruim() { printf '  ❌ %s\n' "$1"; falhas=$((falhas+1)); }

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
  printf '== falsificacao (sabota a SONDA e EXIGE vermelho) ==\n'

  # Fixture de FUMAÇA: cenário trivial que a sonda tem de atravessar sem erro
  # de bash. Serve só à trava (4) de sabota().
  montar fumaca "s-fumaca:1"
  wt_fumaca="$wt"; home_fumaca="$HOME_FIXTURE"

  # ── CONTROLE: verde ANTES do primeiro sed ─────────────────────────────────
  # "Ficou vermelho" só é informação se existir um verde do qual sair. Sem esta
  # trava, um arnês incondicionalmente vermelho (stub quebrado, fixture podre)
  # APROVA TUDO: toda sabotagem produz o vermelho exigido e o gate anuncia
  # "toda mutação foi detectada". O controle roda a MESMA invocação do laço
  # (cópia em $raiz, o mesmo SONDA_OVERRIDE) e só troca a sabotagem por NADA —
  # por isso não é redundante com o `bun run test:hooks`, que roda a suíte crua
  # sobre o alvo REAL, outra invocação.
  controle="$raiz/controle-sonda.sh"
  cp "$SONDA" "$controle"; chmod +x "$controle"
  if SONDA_OVERRIDE="$controle" bash "$0" >/dev/null 2>&1; then
    ok "controle (copia SEM sabotagem) -> VERDE"
  else
    ruim "controle SEM sabotagem ja esta VERMELHO — sem linha de base, sabotar nao prova nada"
  fi
  if [ "$falhas" -ne 0 ]; then
    printf '\n❌ falsificacao ABORTADA: sem verde de partida.\n'
    printf '   Conserte a suite primeiro; sabotar sobre vermelho produz veredito fabricado.\n'
    exit 1
  fi

  copia="$raiz/sonda-sabotada.sh"
  # sabota <descricao> <invariante que deve quebrar> <expressao sed>
  sabota() {
    desc="$1"; regra="$2"; expr="$3"
    erro=$(sed "$expr" "$SONDA" 2>&1 >"$copia"); chmod +x "$copia"
    # (1) sed inválido escreve cópia vazia, que fica vermelha sem ter sabotado nada
    if [ -n "$erro" ]; then
      ruim "\"$desc\": sed invalido (${erro:0:60}) — sabotagem vazia"; return
    fi
    # (2) padrão que não casa deixa a sonda intacta
    if cmp -s "$SONDA" "$copia"; then
      ruim "\"$desc\": padrao nao casou, sonda intacta — sabotagem vazia"; return
    fi
    # (3) sintaxe de shell quebrada = vermelho pelo motivo errado
    if ! bash -n "$copia" 2>/dev/null; then
      ruim "\"$desc\": quebrou a SINTAXE do shell — vermelho pelo motivo errado"; return
    fi
    # (4) `bash -n` NÃO vê erro de runtime, e a sonda roda sob `set -u`: uma
    # sabotagem que deixe variável sem definir pintaria tudo de vermelho por
    # erro de bash, não por invariante quebrada — poder aparente inflado.
    sonda_ant="$SONDA"
    SONDA="$copia"; export HOME_FIXTURE="$home_fumaca"; ID_ATUAL=s-fumaca
    rodar "$wt_fumaca"; fumaca="$saida"
    SONDA="$sonda_ant"
    if printf '%s' "$fumaca" | grep -qE 'unbound variable|command not found|syntax error'; then
      ruim "\"$desc\": quebrou o RUNTIME do bash (${fumaca:0:60}) — vermelho pelo motivo errado"; return
    fi
    if SONDA_OVERRIDE="$copia" bash "$0" >/dev/null 2>&1; then
      ruim "\"$desc\" passou VERDE — a suite NAO cobre: $regra"
    else
      ok "\"$desc\" -> vermelho"
    fi
  }

  # Uma camada por vez: a que ficar VERDE é redundante ou inalcançada.
  sabota "falha() sai 3 em vez de 6" \
         "3 != 6 — nao-consegui-consultar viraria 'nada a retomar' (fail-open)" \
         's/exit 6; }/exit 3; }/'
  sabota "guard do gh some (presente-porem-quebrada)" \
         "gh que RESPONDE erro tem de virar 6, nao seguir com PRS=lixo" \
         's/falha "gh pr list falhou/: "gh pr list falhou/'
  sabota "a sessao ATUAL deixa de ser excluida da contagem" \
         "a sessao que sonda nao e trabalho a retomar" \
         's/&& continue/\&\& :/'
  sabota "transcricao sem tool_use passa a contar" \
         "sessao que so abriu nao e historia" \
         's/|| continue/|| true/'
  sabota "desconto heuristico ignora MESMO_WT" \
         "sondando OUTRO worktree, descontar inventa uma sessao atual que nao existe la" \
         's/\[ "\$MESMO_WT" = 1 \]/true/'
  sabota "desconto heuristico ignora a var estar definida" \
         "com CLAUDE_CODE_SESSION_ID definido nao ha o que estimar" \
         's/\[ -z "\$ATUAL" \]/true/'
  sabota "veredito final sai 0 em vez de 3" \
         "worktree sem nada tem de dizer 3, nao 0" \
         's/exit 3$/exit 0/'

  echo
  if [ "$falhas" -eq 0 ]; then
    echo "✅ falsificacao: toda sabotagem virou vermelho"; exit 0
  else
    echo "❌ falsificacao: $falhas sabotagem(ns) sobreviveu(ram) — a suite nao cobre o que promete"; exit 1
  fi
fi

echo "▶ onde-parei.sh"

# 1. Worktree limpo cuja ÚNICA transcrição é a da sessão ATUAL → nada a retomar.
#    (guarda contra super-sinalizar: sem isto a correção viraria "sempre exit 0")
unset SIM_DIRTY SIM_PRS SIM_GH_FALHA SIM_AHEAD
montar so-atual "sessao-atual:1"
ID_ATUAL=sessao-atual
rodar "$wt"
caso "só a sessão atual → nada a retomar" 3

# 2. REGRESSÃO: outro worktree, 1 sessão anterior, limpo e sem PR.
#    Nenhuma transcrição é a atual → há história, e a sonda tem de dizer isso.
montar outro-1 "sessao-antiga:1"
ID_ATUAL=sessao-desta-sessao
rodar "$wt"
caso "outro worktree com 1 sessão anterior → HÁ trabalho" 0
contem "1 sess" "conta a sessão anterior (não a some no -1)"

# 3. Duas sessões anteriores além da atual → conta 2, não 3.
montar duas "sessao-atual:1 velha-a:1 velha-b:1"
ID_ATUAL=sessao-atual
rodar "$wt"
caso "2 anteriores + a atual → HÁ trabalho" 0
contem "2 sess" "conta 2 (exclui a atual do total)"

# 4. Transcrição sem tool_use não é história.
montar sem-tool "sessao-atual:1 vazia:0"
ID_ATUAL=sessao-atual
rodar "$wt"
caso "sessão sem tool_use não conta" 3

# 5. Sem transcrição nenhuma → nada a retomar.
montar nenhuma ""
ID_ATUAL=sessao-atual
rodar "$wt"
caso "sem transcrição → nada a retomar" 3

# 6. 3 ≠ 6: gh presente mas a consulta FALHA → DESCONHECIDO, nunca "nada".
montar gh-quebrada "sessao-atual:1"
SIM_GH_FALHA=1; ID_ATUAL=sessao-atual
rodar "$wt"
caso "gh responde erro → NÃO CONSEGUI CONSULTAR" 6
unset SIM_GH_FALHA

# 7. Uso errado.
HOME_FIXTURE="$raiz"; ID_ATUAL=x
rodar "$raiz/nao-existe-mesmo"
caso "caminho inexistente → uso errado" 64

# 8. DEGRADAÇÃO, lado seguro: sem CLAUDE_CODE_SESSION_ID, sondando o PRÓPRIO
#    worktree, a heurística velha (descontar 1) ainda vale.
montar degrada-dentro "so-uma:1"
ID_ATUAL=''
rodar_de_dentro
caso "sem a var, no próprio worktree → desconta 1 → nada a retomar" 3
contem "heur" "diz que descontou por heurística (não finge certeza)"

# 9. DEGRADAÇÃO, lado perigoso: sem a var, sondando OUTRO worktree, descontar
#    inventaria uma sessão atual que não existe ali → não desconta.
montar degrada-fora "so-uma:1"
ID_ATUAL=''
rodar "$wt"
caso "sem a var, em outro worktree → NÃO desconta → HÁ trabalho" 0

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
caso "de dentro, com a var definida → conta a anterior" 0
contem "1 sess" "conta 1 (a atual saiu pelo continue, não pela heurística)"
nao_contem "heur" "" "com a var definida, não desconta por heurística"

if [ "$falhas" -eq 0 ]; then echo "✅ onde-parei.sh: tudo verde"; exit 0
else echo "❌ onde-parei.sh: $falhas asserção(ões) vermelha(s)"; exit 1; fi
