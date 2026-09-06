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
nao_contem "só a atual" "" "não rotula sessão alheia como 'a atual'"

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
if [ "$falhas" -eq 0 ]; then echo "✅ onde-parei.sh: tudo verde"; exit 0
else echo "❌ onde-parei.sh: $falhas asserção(ões) vermelha(s)"; exit 1; fi
