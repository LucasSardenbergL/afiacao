#!/usr/bin/env bash
#
# mutcheck — mutation-check disciplinado pra UM helper puro money-path.
#
# Por que existe: a suíte passar não prova que ela tem PODER. Um teste só vale se
# FALHA quando a invariante é violada. Esta ferramenta planta bugs conhecidos
# (mutações) num helper e mede quais SOBREVIVEM (nenhum teste falha = teatro).
# Achou 3 buracos reais em suítes "robustas + Codex" no Afiação (route-outcome,
# aging-helpers) — ver scripts/mutcheck.d/*.mut e a skill auto-ensino.
#
# Não substitui Stryker (mutador genérico): aqui as mutações são ESCOLHIDAS e
# versionadas — viram o CONTRATO executável das invariantes que importam.
#
# Disciplina embutida (os guards que separam medição de sensação):
#   - backup-por-cópia + trap: NUNCA deixa o arquivo de produção mutado, nem em Ctrl-C.
#   - baseline-check: se a suíte já está vermelha, aborta (resultado seria lixo).
#   - guard anti-não-aplicação: perl que não casou = INVÁLIDO, não falso "sobrevive".
#   - substituição única: mutação que toca >1 linha = regex largo (nó incerto) → INVÁLIDO.
#   - compila-check: mutante que NÃO compila = morto pelo COMPILADOR, não por um teste →
#     INVÁLIDO, não falso-PEGA (senão o poder aparente da suíte fica inflado). [achado do Codex]
#   - controle+ : exige ≥1 mutação EXPECT=PEGA que de fato pegue, senão o harness é suspeito.
#
# Uso:
#   scripts/mutcheck.sh <src.ts> <test.ts> <mutations.mut>
#   scripts/mutcheck.sh --selftest      # auto-valida a mecânica (sem vitest, ~1s)
#
# Formato do .mut (separador '|', 3 campos; '#'/vazias ignoradas):
#   EXPECT | LABEL | <expressão perl -pe>
#   EXPECT ∈ PEGA | SOBREVIVE | ?     (? = exploratório: reportado, não falha o gate)
#   ex:  PEGA | faixaAging <=30->>30 | s/diasAtraso <= 30/diasAtraso < 30/
#   '|' pode aparecer no perl (regex alternation) — é sempre o 3º campo (o resto).
#
# Exit code = nº de PROBLEMAS (divergência EXPECT≠obtido + inválidas + baseline/controle).
#   0 = todas as mutações com EXPECT bateram, controle+ ok → a suíte honra o contrato.
#   N = N problemas (use pra gate em CI; sobreviventes '?' NÃO contam como problema).
#
# Tuning (env):
#   MUTCHECK_TEST_CMD   runner (default 'bunx vitest run'); recebe <test.ts> ao fim.
#
set -euo pipefail

# ───────────────────────── self-test (mecânica pura, sem vitest) ─────────────────────────
if [[ "${1:-}" == "--selftest" ]]; then
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  src="$tmp/fixture.ts"; test="$tmp/fixture.runner"; mut="$tmp/fixture.mut"
  cat > "$src" <<'EOF'
export const pick = (xs)=> Math.min(...xs); // anchor
let a = 1;
let b = 2;
EOF
  # runner FAKE: recebe o TEST (como o vitest) e inspeciona o SRC vizinho (como um
  # import faria) — NÃO a si mesmo. "passa" só se o SRC ainda contém Math.min.
  cat > "$test" <<'EOF'
#!/usr/bin/env bash
grep -q 'Math.min' "$(dirname "$1")/fixture.ts" && exit 0 || exit 1
EOF
  chmod +x "$test"
  cat > "$mut" <<'EOF'
PEGA      | min->max (coberto)        | s/Math\.min/Math.max/
SOBREVIVE | comentario (inerte)       | s/anchor/ANCHOR/
?         | inexistente (nao casa)    | s/NAO_EXISTE_XYZ/z/
?         | multi-linha (regex largo) | s/let /const /
?         | quebra sintaxe            | s/Math\.min\(/Math.min((/
EOF
  out=$(MUTCHECK_TEST_CMD="$test" "$0" "$src" "$test" "$mut" 2>&1) || true
  fail=0
  grep -q "PEGA" <<<"$out" || { echo "selftest: FALHOU — não reportou PEGA"; fail=1; }
  grep -qE "min->max.*✓ PEGA|min->max.*PEGA" <<<"$out" || { echo "selftest: FALHOU — controle+ não pegou"; fail=1; }
  grep -qE "comentario.*SOBREVIVE" <<<"$out" || { echo "selftest: FALHOU — mutação inerte devia sobreviver"; fail=1; }
  grep -qiE "inexistente.*(INVÁLID|INVALID)" <<<"$out" || { echo "selftest: FALHOU — mutação que não casa devia ser INVÁLIDA"; fail=1; }
  grep -qiE "multi-linha.*(INVÁLID|INVALID).*linhas" <<<"$out" || { echo "selftest: FALHOU — multi-linha (regex largo) devia ser INVÁLIDA"; fail=1; }
  grep -qiE "quebra sintaxe.*(INVÁLID|INVALID).*compila" <<<"$out" || { echo "selftest: FALHOU — mutante que não compila devia ser INVÁLIDO"; fail=1; }
  # ancora na MARCA "✓ PEGA", não na substring "PEGA" (a própria mensagem INVÁLIDO diz "seria falso-PEGA")
  if grep -qE "quebra sintaxe.*✓ PEGA" <<<"$out"; then echo "selftest: FALHOU — mutante que não compila virou FALSO-PEGA"; fail=1; fi
  # revert: o fixture tem que voltar ao original (Math.min E os `let` que a mutação multi-linha tocou)
  grep -q 'Math.min(...xs)' "$src" || { echo "selftest: FALHOU — backup/revert não restaurou Math.min"; fail=1; }
  grep -q 'let a = 1' "$src" || { echo "selftest: FALHOU — revert não restaurou a mutação multi-linha"; fail=1; }
  if [[ $fail -eq 0 ]]; then echo "selftest: ✓ mecânica ok (PEGA/SOBREVIVE/INVÁLIDO[não-casou·multi-linha·não-compila]/revert)"; exit 0; fi
  echo "--- saída do mutcheck sob teste ---"; echo "$out"; exit 1
fi

# ───────────────────────── args ─────────────────────────
if [[ $# -ne 3 ]]; then
  echo "uso: $0 <src.ts> <test.ts> <mutations.mut>   (ou --selftest)" >&2
  exit 2
fi
SRC="$1"; TEST="$2"; MUT="$3"
for f in "$SRC" "$TEST" "$MUT"; do
  [[ -f "$f" ]] || { echo "erro: arquivo não encontrado: $f" >&2; exit 2; }
done

read -ra TEST_CMD <<< "${MUTCHECK_TEST_CMD:-bunx vitest run}"
# Compila-check: distingue "morto por TESTE" (PEGA real) de "morto pelo COMPILADOR"
# (mutante com sintaxe inválida — sem isso vira falso-PEGA, inflando o poder aparente
# da suíte). Default bun build (esbuild: pega SINTAXE, não tipos — coerente com o vitest,
# que roda via esbuild). MUTCHECK_COMPILE_CMD="" desliga o check (degrada honesto).
read -ra COMPILE_CMD <<< "${MUTCHECK_COMPILE_CMD-bun build --target node --outfile /dev/null}"

# ───────────────────────── backup + revert garantido ─────────────────────────
BACKUP=$(mktemp)
cp "$SRC" "$BACKUP"
restore() { cp "$BACKUP" "$SRC"; }
trap 'restore; rm -f "$BACKUP"' EXIT INT TERM

run_tests() { "${TEST_CMD[@]}" "$TEST" >/dev/null 2>&1; }  # exit code é a verdade
compila() { [[ ${#COMPILE_CMD[@]} -eq 0 ]] && return 0; "${COMPILE_CMD[@]}" "$SRC" >/dev/null 2>&1; }
linhas_mudadas() { diff "$BACKUP" "$SRC" | grep -cE '^> ' || true; }  # nº de linhas novas (1 = subst. única)

trim() { local s="$1"; s="${s#"${s%%[![:space:]]*}"}"; s="${s%"${s##*[![:space:]]}"}"; printf '%s' "$s"; }

echo "mutcheck: $SRC × $TEST"

# ───────────────────────── baseline ─────────────────────────
if run_tests; then
  echo "  baseline: ✓ verde"
else
  echo "  baseline: ✗ VERMELHO — a suíte já falha sem mutação. Resultados seriam lixo. Abortando." >&2
  exit 1
fi

# ───────────────────────── loop de mutações ─────────────────────────
problems=0; n=0; pegas=0; sobrev=0; invalid=0; ctrl_total=0; ctrl_ok=0
printf "  %-9s %-40s %s\n" "EXPECT" "LABEL" "RESULTADO"
while IFS='|' read -r c_expect c_label c_expr || [[ -n "${c_expect:-}" ]]; do
  c_expect=$(trim "${c_expect:-}")
  [[ -z "$c_expect" || "$c_expect" == \#* ]] && continue
  c_label=$(trim "${c_label:-}")
  c_expr=$(trim "${c_expr:-}")
  n=$((n+1))

  perl -i -pe "$c_expr" "$SRC"
  # guard 1: a mutação aplicou? (não-casou = perl errado / .mut stale após refactor)
  if cmp -s "$SRC" "$BACKUP"; then
    printf "  %-9s %-40s %s\n" "$c_expect" "$c_label" "⚠ INVÁLIDO (não casou)"
    invalid=$((invalid+1)); problems=$((problems+1)); restore; continue
  fi
  # guard 2: substituição ÚNICA? (mutação de operador toca 1 linha; >1 = regex largo, nó incerto)
  nl=$(linhas_mudadas)
  if [[ "$nl" -ne 1 ]]; then
    printf "  %-9s %-40s %s\n" "$c_expect" "$c_label" "⚠ INVÁLIDO (tocou $nl linhas — regex largo)"
    invalid=$((invalid+1)); problems=$((problems+1)); restore; continue
  fi
  # guard 3: o mutante COMPILA? senão "morto pelo compilador" seria falso-PEGA (poder inflado)
  if ! compila; then
    printf "  %-9s %-40s %s\n" "$c_expect" "$c_label" "⚠ INVÁLIDO (não compila — seria falso-PEGA)"
    invalid=$((invalid+1)); problems=$((problems+1)); restore; continue
  fi
  # sinal limpo: compila + única → o teste MATA o mutante?
  if run_tests; then got="SOBREVIVE"; else got="PEGA"; fi
  restore

  local_flag=""
  if [[ "$c_expect" == "PEGA" || "$c_expect" == "SOBREVIVE" ]]; then
    [[ "$c_expect" != "$got" ]] && local_flag="  ← DIVERGE" && problems=$((problems+1))
  fi
  [[ "$c_expect" == "PEGA" ]] && { ctrl_total=$((ctrl_total+1)); [[ "$got" == "PEGA" ]] && ctrl_ok=$((ctrl_ok+1)); }

  if [[ "$got" == "PEGA" ]]; then
    pegas=$((pegas+1)); mark="✓ PEGA"
  else
    sobrev=$((sobrev+1)); mark="⚠ SOBREVIVE"
  fi
  printf "  %-9s %-40s %s%s\n" "$c_expect" "$c_label" "$mark" "$local_flag"
done < "$MUT"

# ───────────────────────── controle+ ─────────────────────────
ctrl_msg="n/d"
if [[ $ctrl_total -gt 0 ]]; then
  if [[ $ctrl_ok -eq $ctrl_total ]]; then ctrl_msg="✓ ($ctrl_ok/$ctrl_total)"; else ctrl_msg="✗ ($ctrl_ok/$ctrl_total)"; fi
else
  ctrl_msg="⚠ NENHUM controle+ (suspeite do harness)"; problems=$((problems+1))
fi

echo "sumário: $n mutações · $pegas pegas · $sobrev sobreviventes · $invalid inválidas · controle+ $ctrl_msg · $problems problema(s)"
exit "$problems"
