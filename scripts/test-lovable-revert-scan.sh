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

run_scan() { LRS_PATTERNS='^supabase/functions/' bash "$SCAN" 2>/dev/null; }

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

echo
if [ "$fail" -eq 0 ]; then echo "PASS — todos os casos"; else echo "FALHOU"; fi
exit "$fail"
