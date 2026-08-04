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
# Diretivas OPCIONAIS por contrato (mesmo parse das obrigatórias):
#   # @test_cmd:     runner do contrato    → MUTCHECK_TEST_CMD
#   # @compile_cmd:  compila-check         → MUTCHECK_COMPILE_CMD
#
# Existem porque o default do mutcheck.sh ('bunx vitest run' + 'bun build') só serve
# a helper de `src/`. Um helper de EDGE roda em Deno: o vitest não conhece `Deno.test`
# e daria baseline VERMELHO, abortando o contrato — e um .mut de edge no diretório
# derrubaria o job inteiro do CI. Era por isso que a política do #1643/#1644 ficou
# FALSIFICADA à mão sem contrato versionado. Com as diretivas, o contrato carrega o
# runner que lhe cabe (`deno test --no-remote …`, o mesmo do script `test:edges`).
#
# ⚠️ Valor VAZIO conta como ausente (cai no default). Para DESLIGAR o compila-check
# use '# @compile_cmd: true' — `true <src>` sai 0 sempre, que é o contrato de
# `compila()`. '# @compile_cmd:' pelado devolveria `bun build`, que num alvo Deno
# aborta o contrato com "harness/ambiente quebrado" — mensagem que aponta pro lugar
# errado.
#
# Uso:  bash scripts/mutcheck-all.sh    (ou: bun run mutcheck)
# CI:   job 'mutation-check' (não-required por ora — ver .github/workflows/ci.yml).
#       O job precisa do runtime de TODO contrato registrado: hoje bun (default) E
#       deno (o contrato de edge abaixo) — ver o step 'Setup Deno' de lá.
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
  # Overrides opcionais. Só entram no ambiente quando o contrato DECLARA — assim
  # nenhum .mut existente muda de comportamento (e `MUTCHECK_COMPILE_CMD=""` no
  # mutcheck.sh usa `${VAR-default}`, então exportar vazio DESLIGARIA o compila-check
  # de todo mundo, calado).
  test_cmd=$(sed -n 's/^#[[:space:]]*@test_cmd:[[:space:]]*//p' "$mut" | head -1)
  compile_cmd=$(sed -n 's/^#[[:space:]]*@compile_cmd:[[:space:]]*//p' "$mut" | head -1)
  envs=()
  [[ -n "$test_cmd" ]] && envs+=("MUTCHECK_TEST_CMD=$test_cmd")
  [[ -n "$compile_cmd" ]] && envs+=("MUTCHECK_COMPILE_CMD=$compile_cmd")

  echo "──────────────────────────────────────────────────────────"
  # o runner sai no log: sem isso, "baseline VERMELHO" num contrato de edge parece
  # cobertura quebrada quando é runtime ausente no PATH.
  [[ ${#envs[@]} -gt 0 ]] && printf '  runner do contrato: %s\n' "${envs[@]}"
  if env ${envs[@]+"${envs[@]}"} bash "$MUTCHECK" "$src" "$tst" "$mut"; then :; else
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
