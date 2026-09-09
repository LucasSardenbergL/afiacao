#!/usr/bin/env bash
# test-lovable-revert-scan.sh — TDD do scripts/lovable-revert-scan.sh (repos git descartáveis).
#
# Regra: dado um commit DIRETO na main (sem "(#N)" no fim do subject — assinatura do bot do
#        Lovable), o scan reporta REVERSAO quando esse commit REMOVEU linha substantiva que um
#        merge de PR RECENTE (janela LRS_WINDOW) tinha ADICIONADO no mesmo arquivo sensível
#        (LRS_PATTERNS). Sem isso → stdout mudo, exit 0. Merge de PR no HEAD → mudo (defesa
#        em profundidade; o workflow já filtra). Linha trivial/comentário não conta.
#
# Uso: bash scripts/test-lovable-revert-scan.sh   (exit 0 = tudo verde)
set -u

here="$(cd "$(dirname "$0")" && pwd)"
SCAN="$here/lovable-revert-scan.sh"

base="$(mktemp -d)"
trap 'rm -rf "$base"' EXIT

fail=0

# mkrepo <dir> — repo git novo com commit inicial do arquivo sensível
mkrepo() {
  local d="$1"
  mkdir -p "$d" && cd "$d" || return 1
  git init -q -b main
  git config user.email t@t && git config user.name t
  mkdir -p supabase/functions/edge-x
  printf 'const base = 1;\n' > supabase/functions/edge-x/index.ts
  printf 'leitura\n' > README.md
  git add -A && git commit -qm "base"
}

# commit_pr <arquivo> <msg-sem-sufixo> <pr#> [data] — simula squash-merge de PR (subject com "(#N)")
commit_pr() {
  local f="$1" msg="$2" pr="$3" data="${4:-}"
  git add "$f"
  if [ -n "$data" ]; then
    GIT_AUTHOR_DATE="$data" GIT_COMMITTER_DATE="$data" git commit -qm "$msg (#$pr)"
  else
    git commit -qm "$msg (#$pr)"
  fi
}

# commit_direto <arquivo> <msg> — simula commit do bot (sem "(#N)")
commit_direto() { git add "$1" && git commit -qm "$2"; }

# COR_ENV injeta a cor pelo AMBIENTE; SCAN_ATUAL aponta para uma CÓPIA sabotada. A fonte em
# disco NUNCA é mutada: outra worktree (ou um vitest concorrente) leria o arquivo quebrado, e esse
# vermelho é justamente o que ninguém consegue reproduzir depois.
COR_ENV=""
SCAN_ATUAL=""
run_scan() {
  # shellcheck disable=SC2086  # COR_ENV é lista KEY=VAL (ou vazia), precisa expandir em palavras
  env $COR_ENV LRS_PATTERNS="^supabase/functions/" bash "${SCAN_ATUAL:-$SCAN}" 2>/dev/null
}

expect_hit() {  # <nome> <token1> <token2>
  local nome="$1" t1="$2" t2="$3" out
  out="$(run_scan)"
  if printf '%s' "$out" | grep -qF "REVERSAO" \
     && printf '%s' "$out" | grep -qF "$t1" \
     && printf '%s' "$out" | grep -qF "$t2"; then
    echo "  ok    hit   | $nome"
  else
    echo "  FAIL  want hit ($t1, $t2) | $nome | out='$out'"; fail=1
  fi
}

expect_mudo() {  # <nome>
  local nome="$1" out
  out="$(run_scan)"
  if [ -z "$out" ]; then echo "  ok    mudo  | $nome"
  else echo "  FAIL  want mudo | $nome | out='$out'"; fail=1; fi
}

echo "── caso-alvo: bot remove linha que merge recente adicionou → REVERSAO ──"
mkrepo "$base/r1"
{ printf 'const base = 1;\nif (!precoValidado) { throw new Error("gate"); }\nconst guardaDePreco = validaContraOmie(pedido);\n' > supabase/functions/edge-x/index.ts; }
commit_pr supabase/functions/edge-x/index.ts "fix(edge): blinda o gate de preco [money-path]" 100
{ printf 'const base = 1;\n' > supabase/functions/edge-x/index.ts; }
commit_direto supabase/functions/edge-x/index.ts "Changes"
expect_hit "reversao classica do bot" "#100" "supabase/functions/edge-x/index.ts"

echo "── NÃO dispara ──"
mkrepo "$base/r2"
{ printf 'const base = 1;\nconst novaLinhaDoBot = true;\n' > supabase/functions/edge-x/index.ts; }
commit_direto supabase/functions/edge-x/index.ts "Changes"
expect_mudo "bot so ADICIONA (nada removido)"

mkrepo "$base/r3"
{ printf 'const base = 1;\nconst guardaDePrecoAntiga = validaContraOmie(pedido);\n' > supabase/functions/edge-x/index.ts; }
commit_pr supabase/functions/edge-x/index.ts "feat(edge): guarda antiga" 90 "2026-07-01T10:00:00"
{ printf 'const base = 1;\n' > supabase/functions/edge-x/index.ts; }
commit_direto supabase/functions/edge-x/index.ts "Changes"
expect_mudo "merge FORA da janela de 48h"

mkrepo "$base/r4"
{ printf 'const base = 1;\nconst guardaDePreco = validaContraOmie(pedido);\n' > supabase/functions/edge-x/index.ts; }
commit_pr supabase/functions/edge-x/index.ts "fix(edge): guarda" 101
{ printf 'const base = 1;\n' > supabase/functions/edge-x/index.ts; }
commit_pr supabase/functions/edge-x/index.ts "refactor(edge): remove guarda de proposito" 102
expect_mudo "HEAD e merge de PR (nao e commit direto)"

mkrepo "$base/r5"
{ printf 'const base = 1;\nif (x) {\n}\n' > supabase/functions/edge-x/index.ts; }
commit_pr supabase/functions/edge-x/index.ts "feat(edge): abre bloco" 103
{ printf 'const base = 1;\n' > supabase/functions/edge-x/index.ts; }
commit_direto supabase/functions/edge-x/index.ts "Changes"
expect_mudo "remocao SO de linha trivial/curta nao conta"

mkrepo "$base/r6"
{ printf 'leitura\nlinha substantiva de documentacao que o bot removeu\n' > README.md; }
commit_pr README.md "docs: linha" 104
{ printf 'leitura\n' > README.md; }
commit_direto README.md "Changes"
expect_mudo "arquivo fora do padrao sensivel"

mkrepo "$base/r7"
{ printf 'const base = 1;\n// comentario-aviso que o bot costuma apagar sem reverter o gate\n' > supabase/functions/edge-x/index.ts; }
commit_pr supabase/functions/edge-x/index.ts "docs(edge): aviso" 105
{ printf 'const base = 1;\n' > supabase/functions/edge-x/index.ts; }
commit_direto supabase/functions/edge-x/index.ts "Changes"
expect_mudo "remocao de COMENTARIO puro nao conta (bot apaga aviso sem reverter gate)"

# ══════════════════════════════════════════════════════════════════════════════════════════════
# COR: o veredito não pode depender de o git estar colorindo
#
# A decisão sai do prefixo `^-`/`^+` da saída do git. Com cor o ESC vem ANTES do sinal, o `grep`
# casa ZERO, a lista sai vazia e o scan conclui "sem reversão" — fail-OPEN: some justamente o
# alarme que ele existe para dar. Medido antes do conserto: o caso-alvo abaixo saía MUDO nas três
# vias. O git não colore em pipe por default, mas obedece color.ui/color.diff=always de QUALQUER
# camada: o AMBIENTE (GIT_CONFIG_PARAMETERS, que o runner do CI pode carregar) e a config do
# repo/global. Classe: docs/historico/gate-que-le-saida-colorida.md.
# ══════════════════════════════════════════════════════════════════════════════════════════════
echo "── cor LIGADA não pode mudar o veredito ──"

# cenario_alvo <dir> — o mesmo caso-alvo do topo. O scan é read-only, então UM repo serve de
# controle E de sabotagem: a única variável entre eles passa a ser o script, nunca o cenário.
cenario_alvo() {
  mkrepo "$1"
  { printf 'const base = 1;\nif (!precoValidado) { throw new Error("gate"); }\nconst guardaDePreco = validaContraOmie(pedido);\n' > supabase/functions/edge-x/index.ts; }
  commit_pr supabase/functions/edge-x/index.ts "fix(edge): blinda o gate de preco [money-path]" 100
  { printf 'const base = 1;\n' > supabase/functions/edge-x/index.ts; }
  commit_direto supabase/functions/edge-x/index.ts "Changes"
}
ALVO_PR="#100"
ALVO_F="supabase/functions/edge-x/index.ts"

cenario_alvo "$base/cor"

COR_ENV="GIT_CONFIG_PARAMETERS='color.ui=always'"
expect_hit "cor pelo AMBIENTE (GIT_CONFIG_PARAMETERS) — a via do runner" "$ALVO_PR" "$ALVO_F"
COR_ENV=""

git config color.ui always
expect_hit "cor por color.ui na config do repo" "$ALVO_PR" "$ALVO_F"
git config --unset color.ui

git config color.diff always
expect_hit "cor por color.diff (a chave específica do diff)" "$ALVO_PR" "$ALVO_F"
git config --unset color.diff

echo "── falsificação: a fixação de cor é LOAD-BEARING ──"
# CONTROLE PRIMEIRO, e ele ABORTA as sabotagens se não estiver verde: sabotar um arnês que já está
# vermelho aprova TUDO — toda sabotagem produz o vermelho exigido e o gate anuncia sucesso
# (docs/historico/falsificacao-sem-linha-de-base.md). Este controle é a CÓPIA (não o alvo em
# disco), com a cor LIGADA, no MESMO repo e na MESMA invocação das sabotagens: nada muda entre
# ele e elas exceto o `sed`.
cp "$SCAN" "$base/copia.sh"
SCAN_ATUAL="$base/copia.sh"
COR_ENV="GIT_CONFIG_PARAMETERS='color.ui=always'"

controle_ok=0
if printf '%s' "$(run_scan)" | grep -qF "REVERSAO"; then
  controle_ok=1
  echo "  ok    base  | CONTROLE: cópia intacta + cor ligada → REVERSAO (há verde de onde sair)"
else
  echo "  FAIL  CONTROLE vermelho ANTES da 1ª sabotagem — nada abaixo provaria coisa alguma"; fail=1
fi

# _sabota <nome> <expr-sed> — quebra UMA fixação de cor na cópia e exige que o alarme SUMA.
_sabota() {
  local nome="$1" expr="$2" out
  [ "$controle_ok" -eq 1 ] || return 0
  sed "$expr" "$SCAN" > "$base/copia.sh"
  if cmp -s "$SCAN" "$base/copia.sh"; then
    echo "  FAIL  sed obsoleto | $nome — a sabotagem não mudou NADA (o teste estaria cego)"; fail=1
    return 0
  fi
  out="$(run_scan)"
  if [ -z "$out" ]; then echo "  ok    sabot | $nome → alarme SUMIU (a flag é load-bearing)"
  else echo "  FAIL  $nome → alarme sobreviveu; a flag não está sob teste | out='$out'"; fail=1; fi
}

_sabota "sem --no-color no \`git diff\` (mata a lista 'removed')" \
  's|git diff --no-color "$sha^"|git diff "$sha^"|'
_sabota "sem --no-color no \`git show\` (mata a lista 'added')" \
  's|git show --no-color --format= "$m"|git show "$m"|'
# O 3º `--no-color` (o do `git diff --name-only` da linha do `changed`) NÃO entra aqui de
# propósito: `--name-only` foi MEDIDO saindo limpo mesmo com color.ui=always, então a flag ali é
# cinto-e-suspensório contra versão futura do git — sabotá-la ficaria VERDE, e sabotagem verde
# sinaliza "redundante", que aqui é a resposta certa e intencional (não um teste cego).

SCAN_ATUAL=""
COR_ENV=""
cd "$base"

echo
if [ "$fail" -eq 0 ]; then echo "PASS — todos os casos"; else echo "FALHOU"; fi
exit "$fail"
