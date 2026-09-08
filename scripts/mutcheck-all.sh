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

# MUTCHECK_DIR existe para o teste do SENSOR (scripts/test-mutcheck-sensor.sh) poder medir os
# quatro estados — honrado, DIVERGE, INVÁLIDA e baseline vermelho — contra contratos de fixture,
# em segundos. Sem isso a única forma de exercitar o alarme seria sabotar um contrato real e
# rodar os 23, e um sensor caro de exercitar não é exercitado (docs/historico/fase-sem-sinal.md).
shopt -s nullglob
muts=("${MUTCHECK_DIR:-scripts/mutcheck.d}"/*.mut)
if [[ ${#muts[@]} -eq 0 ]]; then
  echo "mutcheck-all: nenhum contrato em scripts/mutcheck.d/ — nada a fazer."
  exit 0
fi

# Resumo estruturado, SÓ quando MUTCHECK_RESUMO aponta um arquivo (default: nada muda).
# Existe porque as duas causas de vermelho aqui têm remédios OPOSTOS e o log as fundia numa
# linha só: INVÁLIDA = o `.mut` envelheceu junto com o fonte (manutenção do contrato, ruído
# esperado num repo multi-sessão) × DIVERGE = a suíte PERDEU PODER (regressão de cobertura, o
# sinal caro). Um alarme que não as separa manda o leitor para o remédio errado — é o precedente
# dos 4 vazios no mesmo pixel (docs/historico/fase-sem-sinal.md §2). Medido 2026-09-07 (#2316):
# o vermelho da main era 3 INVÁLIDAS e ZERO divergências, e custou horas para ser lido.
RESUMO="${MUTCHECK_RESUMO:-}"
itens=()
registrar() { # <mut> <rc> <arquivo-de-saída>
  [[ -z "$RESUMO" ]] && return 0
  local m="$1" rc="$2" out="$3" inval diver abortou sumario
  inval=$(grep -c '⚠ INVÁLIDO' "$out" || true)
  diver=$(grep -c '← DIVERGE' "$out" || true)
  # baseline vermelho / compilador ausente = o MONITOR quebrou, não a cobertura regrediu.
  if grep -q 'baseline: ✗' "$out"; then abortou=true; else abortou=false; fi
  sumario=$(grep -o 'sumário: .*' "$out" | tail -1 | sed 's/["\\]/ /g')
  itens+=("{\"mut\":\"$m\",\"exit\":$rc,\"invalidas\":$inval,\"divergencias\":$diver,\"abortou\":$abortou,\"sumario\":\"$sumario\"}")
}

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
  # A saída vai para arquivo e é ECOADA de volta: o log do CI fica idêntico, e o exit code é
  # capturado PELADO (um `| tee` aqui devolveria o status do tee — a classe de
  # docs/historico/evidencia-positiva-shell.md).
  saida=$(mktemp)
  env ${envs[@]+"${envs[@]}"} bash "$MUTCHECK" "$src" "$tst" "$mut" > "$saida" 2>&1
  rc=$?
  cat "$saida"
  registrar "$mut" "$rc" "$saida"
  rm -f "$saida"
  if [[ $rc -ne 0 ]]; then
    failed+=("$mut (exit $rc)")
  fi
done

if [[ -n "$RESUMO" ]]; then
  { printf '{"total":%d,"com_problema":%d,"contratos":[' "${#muts[@]}" "${#failed[@]}"
    for i in "${!itens[@]}"; do [[ $i -gt 0 ]] && printf ','; printf '%s' "${itens[$i]}"; done
    printf ']}\n'
  } > "$RESUMO"
fi

echo "══════════════════════════════════════════════════════════"
if [[ ${#failed[@]} -eq 0 ]]; then
  echo "mutcheck-all: ✓ ${#muts[@]} contrato(s) honrado(s) — nenhuma regressão de cobertura."
  exit 0
fi
echo "mutcheck-all: ✗ ${#failed[@]}/${#muts[@]} contrato(s) com problema:"
printf '  - %s\n' "${failed[@]}"
echo "(divergência = teste perdeu poder; INVÁLIDO = .mut stale após refactor — atualize o .mut)"
exit 1
