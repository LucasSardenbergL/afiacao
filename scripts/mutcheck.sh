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
  printf 'export const pick = (xs)=> Math.min(...xs); // anchor\n' > "$src"
  # runner FAKE: recebe o TEST (como o vitest) e inspeciona o SRC vizinho (como um
  # import faria) — NÃO a si mesmo. "passa" só se o SRC ainda contém Math.min.
  cat > "$test" <<'EOF'
#!/usr/bin/env bash
grep -q 'Math.min' "$(dirname "$1")/fixture.ts" && exit 0 || exit 1
EOF
  chmod +x "$test"
  cat > "$mut" <<'EOF'
PEGA      | min->max (coberto)      | s/Math\.min/Math.max/
SOBREVIVE | comentario (inerte)     | s/anchor/ANCHOR/
?         | inexistente (nao casa)  | s/NAO_EXISTE_XYZ/z/
EOF
  out=$(MUTCHECK_TEST_CMD="$test" "$0" "$src" "$test" "$mut" 2>&1) || true
  fail=0
  grep -q "PEGA" <<<"$out" || { echo "selftest: FALHOU — não reportou PEGA"; fail=1; }
  grep -qE "min->max.*✓ PEGA|min->max.*PEGA" <<<"$out" || { echo "selftest: FALHOU — controle+ não pegou"; fail=1; }
  grep -qE "comentario.*SOBREVIVE" <<<"$out" || { echo "selftest: FALHOU — mutação inerte devia sobreviver"; fail=1; }
  grep -qiE "inexistente.*(INVÁLID|INVALID)" <<<"$out" || { echo "selftest: FALHOU — mutação que não casa devia ser INVÁLIDA"; fail=1; }
  # revert: o fixture tem que voltar ao original (com Math.min)
  grep -q 'Math.min(...xs)' "$src" || { echo "selftest: FALHOU — backup/revert não restaurou o arquivo"; fail=1; }
  if [[ $fail -eq 0 ]]; then echo "selftest: ✓ mecânica ok (PEGA/SOBREVIVE/INVÁLIDO/revert)"; exit 0; fi
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

# ───────────────────────── backup + revert garantido ─────────────────────────
BACKUP=$(mktemp)
cp "$SRC" "$BACKUP"
restore() { cp "$BACKUP" "$SRC"; }
trap 'restore; rm -f "$BACKUP"' EXIT INT TERM

run_tests() { "${TEST_CMD[@]}" "$TEST" >/dev/null 2>&1; }  # exit code é a verdade

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
  if cmp -s "$SRC" "$BACKUP"; then
    printf "  %-9s %-40s %s\n" "$c_expect" "$c_label" "⚠ INVÁLIDO (perl não casou)"
    invalid=$((invalid+1)); problems=$((problems+1))
    continue
  fi
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
