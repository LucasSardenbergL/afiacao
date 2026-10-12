#!/usr/bin/env bash
# build-id-dist-prova.sh — a prova de ponta a ponta do build-id contra o `dist/index.html` REAL (M-21).
#
# `src/lib/__tests__/build-id-paridade.test.ts` tem um bloco que só roda com `dist/`. No job `testes`
# do CI não há build, então ele era o "1 skipped" de toda suíte: a prova existia e nunca rodava. O CI
# chama ESTE script no job `edges-e-build`, logo depois do `Build`.
#
# Por que script e não `bunx vitest` direto no step: o step depende do `dist/` que o step anterior
# gerou, e o motor de exclusividade roda cada gate SOZINHO numa árvore limpa — não tem como medi-lo.
# É a mesma categoria do `mutcheck-seco-gate.sh` e do `roda-nucleo-ci.sh` (step bloqueante sem nome
# de script, fora da conta do `exclusividade` por desenho).
#
# Fail-closed: `BUILD_ID_EXIGE_DIST=1` faz `dist/` ausente REPROVAR o teste em vez de pulá-lo, e
# este script ainda exige a marca do teste na saída verbose e zero `skipped` — arquivo não achado
# ou teste pulado não passam como verde.
set -euo pipefail
cd "$(dirname "$0")/.."

log="$(mktemp)"
trap 'rm -f "$log"' EXIT

BUILD_ID_EXIGE_DIST=1 bunx vitest run src/lib/__tests__/build-id-paridade.test.ts --reporter verbose 2>&1 | tee "$log"

if ! grep -qF 'acha o entry no index.html gerado pelo build' "$log"; then
  echo "::error::a prova contra o dist/ NAO apareceu na saida (arquivo nao achado ou renomeado?)"
  exit 1
fi
if grep -qE '[0-9]+ skipped' "$log"; then
  echo "::error::a prova contra o dist/ foi PULADA"
  exit 1
fi
echo "BUILD_ID_DIST_OK"
