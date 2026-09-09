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
#   - backup + trap que ENCERRA + restore VERIFICADO: não deixa o arquivo de produção
#     mutado em saída normal, Ctrl-C (INT) ou SIGTERM. SIGKILL não passa por trap nenhum —
#     esse caso é coberto pela rodada SEGUINTE, que RECUSA começar (sentinela em disco).
#     A promessa antiga ("nem em Ctrl-C") era falsa: ver o bloco 'backup + revert garantido'.
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
  export MUTCHECK_PENDENTES_DIR="$tmp/pendentes"
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
PEGAA     | typo no EXPECT            | s/let a/let aa/
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
  grep -qiE "typo no EXPECT.*(INVÁLID|INVALID).*EXPECT desconhecido" <<<"$out" || { echo "selftest: FALHOU — EXPECT inválido (typo) devia ser recusado, não tratado como exploratório"; fail=1; }
  grep -q 'let a = 1' "$src" || { echo "selftest: FALHOU — revert não restaurou a mutação multi-linha"; fail=1; }

  # ───────── caso SINAL: a garantia do cabeçalho ("nem em Ctrl-C") ganha gate ─────────
  # Regressão real (2026-09-08): um SIGTERM externo no meio da rodada deixou
  # .claude/hooks/destructive-bash-guard.sh MUTADO no disco — hook de segurança DESARMADO,
  # varrido depois por um `git add -A`. O caminho feliz acima não pega isto: só a MORTE pega.
  # A ORDEM importa: o sinal que chega ANTES da 1ª mutação é o fatal (o handler apaga o
  # backup e o script SEGUE vivo mutando sem volta); o que chega com o SRC já mutado é
  # benigno hoje — cobrimos os dois, senão o gate testa só a metade inofensiva.
  sinal_src="$tmp/sinal.ts"; sinal_mut="$tmp/sinal.mut"; sinal_run="$tmp/sinal-runner.sh"
  sinal_orig="$tmp/sinal.ORIG"; sinal_marcas="$tmp/marcas"; alvo=""
  cat > "$sinal_run" <<EOS
#!/usr/bin/env bash
echo r >> "$sinal_marcas"
sleep 3
exit 0
EOS
  chmod +x "$sinal_run"
  cat > "$sinal_mut" <<'EOS'
? | evento PreToolUse->PostToolUse | s{hookEventName: "PreToolUse"}{hookEventName: "PostToolUse"}
? | alfa 1->99                     | s/alfa = 1/alfa = 99/
EOS
  criar_caso_sinal() {
    : > "$sinal_marcas"
    cat > "$sinal_src" <<'EOS'
export const guard = { hookEventName: "PreToolUse" };
export const alfa = 1;
EOS
    cp "$sinal_src" "$sinal_orig"
    MUTCHECK_TEST_CMD="$sinal_run" MUTCHECK_COMPILE_CMD=true \
      "$0" "$sinal_src" "$sinal_src" "$sinal_mut" >"$tmp/sinal.log" 2>&1 &
    alvo=$!
  }
  # Esperas por CONDIÇÃO, com TETO e ramo que DIZ que não conseguiu. Um `sleep` fixo aqui
  # seria fail-OPEN: mataria fora da janela e o teste ficaria VERDE sem tê-la exercitado.
  esperar_baseline() {  # o runner rodando pela 1ª vez = baseline, SRC ainda intacto
    local i=0
    while [[ $i -lt 150 ]]; do
      [[ -s "$sinal_marcas" ]] && return 0
      i=$((i + 1)); sleep 0.1
    done
    return 1
  }
  esperar_mutado() {
    local i=0
    while [[ $i -lt 150 ]]; do
      cmp -s "$sinal_src" "$sinal_orig" || return 0
      i=$((i + 1)); sleep 0.1
    done
    return 1
  }
  matar_e_conferir() {  # $1=sinal $2=rótulo
    kill -"$1" "$alvo" 2>/dev/null || true
    wait "$alvo" 2>/dev/null || true
    if ! cmp -s "$sinal_src" "$sinal_orig"; then
      echo "selftest[sinal]: FALHOU — SIG$1 $2 DEIXOU o SRC mutado no disco"; fail=1
    fi
  }

  # (a) SIGTERM durante o BASELINE — a ordem FATAL
  criar_caso_sinal
  if esperar_baseline; then matar_e_conferir TERM "durante o baseline"; else
    echo "selftest[sinal]: FALHOU — baseline não começou em 15s: janela NÃO exercitada (inconclusivo ≠ aprovado)"; fail=1
    kill -TERM "$alvo" 2>/dev/null || true; wait "$alvo" 2>/dev/null || true
  fi

  # (b) SIGTERM com o SRC JÁ mutado
  criar_caso_sinal
  if esperar_mutado; then matar_e_conferir TERM "com o SRC já mutado"; else
    echo "selftest[sinal]: FALHOU — SRC nunca ficou mutado em 15s: janela NÃO exercitada (inconclusivo ≠ aprovado)"; fail=1
    kill -TERM "$alvo" 2>/dev/null || true; wait "$alvo" 2>/dev/null || true
  fi

  # (c) SIGKILL — nenhum trap intercepta; o que TEM que valer é a rodada SEGUINTE RECUSAR
  criar_caso_sinal
  if ! esperar_mutado; then
    echo "selftest[sinal]: FALHOU — janela não exercitada no caso SIGKILL (inconclusivo ≠ aprovado)"; fail=1
    kill -KILL "$alvo" 2>/dev/null || true; wait "$alvo" 2>/dev/null || true
  else
    kill -KILL "$alvo" 2>/dev/null || true
    wait "$alvo" 2>/dev/null || true
    if cmp -s "$sinal_src" "$sinal_orig"; then
      echo "selftest[sinal]: FALHOU — SIGKILL não deixou o SRC mutado: o cenário não chegou a ser montado"; fail=1
    fi
    saida2=$(MUTCHECK_TEST_CMD="$sinal_run" MUTCHECK_COMPILE_CMD=true \
      "$0" "$sinal_src" "$sinal_src" "$sinal_mut" 2>&1) || true
    if ! grep -q 'MUTCHECK-RESTO-DE-MUTACAO' <<<"$saida2"; then
      echo "selftest[sinal]: FALHOU — após SIGKILL a rodada seguinte NÃO recusou começar (sem MUTCHECK-RESTO-DE-MUTACAO)"; fail=1
    fi
  fi

  if [[ $fail -eq 0 ]]; then echo "selftest: ✓ mecânica ok (PEGA/SOBREVIVE/INVÁLIDO[não-casou·multi-linha·não-compila]/revert)"; exit 0; fi
  echo "--- saída do mutcheck sob teste ---"; echo "$out"; exit 1
fi

# ───────────────────────── args ─────────────────────────
# --seco: só perl+diff. NÃO mede cobertura (a suíte não roda) — mede se cada padrão do
# .mut ainda é CIRÚRGICO no fonte de hoje: casa, e casa UMA linha. É o guard barato que
# pega o .mut stale (o modo de falha do #2380) em ~1s em vez dos minutos da rodada cheia.
SECO=0
if [[ "${1:-}" == "--seco" ]]; then SECO=1; shift; fi
if [[ $# -ne 3 ]]; then
  echo "uso: $0 [--seco] <src.ts> <test.ts> <mutations.mut>   (ou --selftest)" >&2
  exit 2
fi
SRC="$1"; TEST="$2"; MUT="$3"
for f in "$SRC" "$TEST" "$MUT"; do
  [[ -f "$f" ]] || { echo "erro: arquivo não encontrado: $f" >&2; exit 2; }
done

read -ra TEST_CMD <<< "${MUTCHECK_TEST_CMD:-bunx vitest run}"
# Compila-check: distingue "morto por TESTE" (PEGA real) de "morto pelo COMPILADOR"
# (mutante com sintaxe inválida — sem isso vira falso-PEGA, inflando o poder aparente).
# Default bun build = aproximação RÁPIDA de validade de sintaxe; NÃO é o mesmo transform
# do vitest (bun usa bundler próprio, vitest usa Vite/esbuild) — concordam em sintaxe TS
# comum, podem divergir em casos exóticos. Pega SINTAXE, não tipos (coerente com o vitest,
# que ignora tipos). Limitação: NÃO pega mutante que compila mas LANÇA no import (runtime
# top-level) — esse ainda vira falso-PEGA. MUTCHECK_COMPILE_CMD="" desliga (degrada honesto).
read -ra COMPILE_CMD <<< "${MUTCHECK_COMPILE_CMD-bun build --target node --outfile /dev/null}"

# ───────────────────────── backup + revert garantido ─────────────────────────
# O trap sozinho NÃO basta — e a forma ingênua era ATIVAMENTE pior (regressão 2026-09-08,
# que deixou .claude/hooks/destructive-bash-guard.sh mutado no disco, hook DESARMADO):
#   1. `trap ... INT TERM` em bash NÃO encerra o script: o handler roda e a execução SEGUE
#      da instrução seguinte. Um handler que já apagava o BACKUP deixava o processo VIVO e
#      sem volta — a `perl -i` seguinte mutava e todo `restore` virava `cp <inexistente>`,
#      que só reclama em stderr. Fim: arquivo de produção mutado com exit 0.
#      → INT/TERM apenas `exit`; quem restaura e limpa é o trap EXIT, uma vez só.
#   2. restaurar sem CONFERIR é fail-OPEN (o `cp` pode falhar calado) → restaure e COMPARE.
#   3. SIGKILL não passa por trap nenhum: nada dentro do processo evita o resto de mutação.
#      Então quem recusa é a rodada SEGUINTE — sentinela em disco, fail-CLOSED.
PENDENTES="${MUTCHECK_PENDENTES_DIR:-${TMPDIR:-/tmp}/mutcheck-pendentes}"
mkdir -p "$PENDENTES"
SRC_ABS="$(cd "$(dirname "$SRC")" && pwd)/$(basename "$SRC")"
CHAVE="$PENDENTES/$(printf '%s' "$SRC_ABS" | tr -c 'A-Za-z0-9._-' '_')"
BACKUP="$CHAVE.original"     # o backup É a via de recuperação: vive junto da sentinela,
SENTINELA="$CHAVE.pendente"  # não em /tmp aleatório que ninguém acha depois.

# guard de ENTRADA: sobrou mutação de uma rodada que morreu sem restaurar?
if [[ -f "$SENTINELA" ]]; then
  if [[ -f "$BACKUP" ]] && cmp -s "$SRC" "$BACKUP"; then
    rm -f "$SENTINELA"   # arquivo íntegro: resto inofensivo, segue
  else
    {
      echo "mutcheck: MUTCHECK-RESTO-DE-MUTACAO — a rodada anterior morreu com o SRC MUTADO."
      echo "  arquivo: $SRC_ABS"
      echo "  O conteúdo em disco NÃO é o original: é (ou pode ser) um bug PLANTADO. Não"
      echo "  commite — foi assim que um hook de segurança entrou num 'git add -A'."
      if [[ -f "$BACKUP" ]]; then
        echo "  restaure:  cp '$BACKUP' '$SRC_ABS'"
      else
        echo "  backup perdido — restaure pelo git:  git checkout -- '$SRC_ABS'"
      fi
      echo "  e então:   rm '$SENTINELA'"
    } >&2
    exit 3
  fi
fi

cp "$SRC" "$BACKUP"
printf 'mutcheck pendente para %s\n' "$SRC_ABS" > "$SENTINELA"

# restore VERIFICADO: devolver 0 sem conferir seria o mesmo fail-open de novo.
restore() {
  cp "$BACKUP" "$SRC" 2>/dev/null || true
  cmp -s "$SRC" "$BACKUP" && return 0
  echo "mutcheck: MUTCHECK-FALHA-AO-RESTAURAR $SRC_ABS (backup: $BACKUP)" >&2
  return 1
}
# shellcheck disable=SC2329  # invocada pela string do `trap` abaixo, que o shellcheck não segue
finalizar() {
  local rc=$?
  trap '' INT TERM        # o encerramento não pode ser interrompido pela metade
  if restore; then
    rm -f "$BACKUP" "$SENTINELA"
  else
    echo "mutcheck: $SRC_ABS pode estar MUTADO — sentinela MANTIDA em $SENTINELA" >&2
    if [[ $rc -eq 0 ]]; then rc=9; fi
  fi
  exit "$rc"
}
trap finalizar EXIT
trap 'exit 143' TERM      # 128+15 — o `exit` é que dispara o EXIT acima
trap 'exit 130' INT       # 128+2

run_tests() { "${TEST_CMD[@]}" "$TEST" >/dev/null 2>&1; }  # exit code é a verdade
compila() { [[ ${#COMPILE_CMD[@]} -eq 0 ]] && return 0; "${COMPILE_CMD[@]}" "$SRC" >/dev/null 2>&1; }
linhas_mudadas() { diff "$BACKUP" "$SRC" | grep -cE '^> ' || true; }  # nº de linhas novas (1 = subst. única)

trim() { local s="$1"; s="${s#"${s%%[![:space:]]*}"}"; s="${s%"${s##*[![:space:]]}"}"; printf '%s' "$s"; }

echo "mutcheck: $SRC × $TEST"

# ───────────────────────── baseline ─────────────────────────
# baseline do COMPILADOR (gêmeo do baseline-de-testes): o SRC original PRECISA compilar —
# senão `bun`/o compilador está ausente/quebrado no PATH e TODOS os mutantes virariam
# falso-INVÁLIDO ("não compila"), mascarando a causa como se fosse cobertura. É controle do
# AMBIENTE, não da cobertura. (Achado do Codex: sem isso o gate de CI fica vermelho mudo se
# o bun sumir.)
if [[ $SECO -eq 1 ]]; then
  echo "  baseline: — modo SECO (perl+diff; a suíte NÃO roda, logo isto não é veredito de cobertura)"
elif ! compila; then
  echo "  baseline: ✗ o SRC ORIGINAL não compila com '${COMPILE_CMD[*]:-}' — harness/ambiente quebrado (bun no PATH?). Abortando." >&2
  exit 1
elif run_tests; then
  echo "  baseline: ✓ verde (compila + suíte passa)"
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
  # enum de EXPECT: um typo (ex.: "PEGAA") cairia no ramo exploratório e DESLIGARIA o gate
  # pra essa linha em silêncio — recusa explícita (achado do Codex).
  if [[ "$c_expect" != "PEGA" && "$c_expect" != "SOBREVIVE" && "$c_expect" != "?" ]]; then
    printf "  %-9s %-40s %s\n" "$c_expect" "$c_label" "⚠ INVÁLIDO (EXPECT desconhecido — use PEGA|SOBREVIVE|?)"
    invalid=$((invalid+1)); problems=$((problems+1)); continue
  fi

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
  # No SECO o veredito termina aqui: o padrão casou e tocou UMA linha, que é tudo que
  # este modo se propõe a afirmar. Segue sem compilar nem testar.
  if [[ $SECO -eq 1 ]]; then
    printf "  %-9s %-40s %s\n" "$c_expect" "$c_label" "✓ cirúrgica"
    restore; continue
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
if [[ $SECO -eq 1 ]]; then
  ctrl_msg="n/d (seco)"
elif [[ $ctrl_total -gt 0 ]]; then
  if [[ $ctrl_ok -eq $ctrl_total ]]; then ctrl_msg="✓ ($ctrl_ok/$ctrl_total)"; else ctrl_msg="✗ ($ctrl_ok/$ctrl_total)"; fi
else
  ctrl_msg="⚠ NENHUM controle+ (suspeite do harness)"; problems=$((problems+1))
fi

if [[ $SECO -eq 1 ]]; then
  echo "sumário SECO: $n padrões · $((n-invalid)) cirúrgicos · $invalid ambíguo(s)/não-casado(s) · $problems problema(s) — cobertura NÃO medida"
else
  echo "sumário: $n mutações · $pegas pegas · $sobrev sobreviventes · $invalid inválidas · controle+ $ctrl_msg · $problems problema(s)"
fi
exit "$problems"
