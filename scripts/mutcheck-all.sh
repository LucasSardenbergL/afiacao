#!/usr/bin/env bash
#
# mutcheck-all — roda TODOS os contratos de cobertura money-path e agrega.
#
# Descobre scripts/mutcheck.d/*.mut, lê o alvo de cada um (diretivas '# @src:' e
# '# @test:' no topo — ignoradas pelo mutcheck.sh por serem comentário) e roda
# scripts/mutcheck.sh por contrato. Exit != 0 se QUALQUER contrato:
#   - divergir (EXPECT != obtido → regressão de cobertura: um teste perdeu poder), ou
#   - ficar dessincronizado (perl não casa = INVÁLIDO → o .mut está stale após um
#     refactor do helper; atualize o .mut pro novo texto).
#
# Uso:  bash scripts/mutcheck-all.sh    (ou: bun run mutcheck)
# CI:   job 'mutation-check' (não-required por ora — ver .github/workflows/ci.yml).
#
set -uo pipefail

cd "$(git rev-parse --show-toplevel 2>/dev/null || echo .)" || { echo "mutcheck-all: não consegui ir pra raiz do repo" >&2; exit 2; }
MUTCHECK="scripts/mutcheck.sh"

shopt -s nullglob
muts=(scripts/mutcheck.d/*.mut)
if [[ ${#muts[@]} -eq 0 ]]; then
  echo "mutcheck-all: nenhum contrato em scripts/mutcheck.d/ — nada a fazer."
  exit 0
fi

failed=()
for mut in "${muts[@]}"; do
  src=$(sed -n 's/^#[[:space:]]*@src:[[:space:]]*//p' "$mut" | head -1)
  tst=$(sed -n 's/^#[[:space:]]*@test:[[:space:]]*//p' "$mut" | head -1)
  if [[ -z "$src" || -z "$tst" ]]; then
    echo "✗ $mut — falta diretiva '# @src:' ou '# @test:'"
    failed+=("$mut (sem alvo)"); continue
  fi
  echo "──────────────────────────────────────────────────────────"
  if bash "$MUTCHECK" "$src" "$tst" "$mut"; then :; else
    failed+=("$mut (exit $?)")
  fi
done

echo "══════════════════════════════════════════════════════════"
if [[ ${#failed[@]} -eq 0 ]]; then
  echo "mutcheck-all: ✓ ${#muts[@]} contrato(s) honrado(s) — nenhuma regressão de cobertura."
  exit 0
fi
echo "mutcheck-all: ✗ ${#failed[@]}/${#muts[@]} contrato(s) com problema:"
printf '  - %s\n' "${failed[@]}"
echo "(divergência = teste perdeu poder; INVÁLIDO = .mut stale após refactor — atualize o .mut)"
exit 1
