#!/usr/bin/env bash
# test-idioma-errexit-leitura.sh — prende, no bash do CI (5.x) E no do Mac (3.2), o idioma com que as
# provas de db/ leem a medição de uma sabotagem sem deixar o ERRO passar por valor:
#
#     set +e; v="$(set -e; <leitura>)"; rc=$?; set -e
#
# O defeito que ele fecha (docs/historico/falsificacao-exit-nao-e-dente.md, fase dos parciais de db/):
# o subshell de `$(...)` nasce SEM errexit (bash fora do modo POSIX), e uma leitura composta — "purga;
# soma" — que erra no meio segue adiante e imprime exatamente o valor que a sabotagem declara. Medido
# em db/test-analytics-outbox-perda.sh: a purga sabotada com 1/0 deixava a soma parada em "0", o
# declarado. O `set -e` explícito dentro da substituição só vale FORA de lista ||/&& e de condição de
# `if` — nesses contextos o bash ignora o errexit, e se a regra alcança a substituição depende da
# versão. As provas nunca usam esse contexto; por isso ele é MEDIDO e impresso (INFO), não afirmado.
#
# Rode: bash scripts/test-idioma-errexit-leitura.sh
#       bash scripts/test-idioma-errexit-leitura.sh --falsificar   (sabota; exige o vermelho DECLARADO)
set -euo pipefail

if [ "${1:-}" = "--falsificar" ]; then
  # Cada sabotagem DECLARA os asserts que a acusam, e só eles caem; controle verde nesta invocação
  # antes da primeira (sempre-vermelha aprovaria tudo). docs/historico/falsificacao-exit-nao-e-dente.md
  SELF="${BASH_SOURCE[0]}"
  TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
  # Camadas 2 e 4 (2026-09-29): a rodada chega ao recibo com o MESMO nº de asserts, e não traz linha de
  # stderr que o controle não traz. Até então o laço julgava só os FAIL declarados — uma rodada que os
  # imprimisse e MORRESSE antes do recibo, ou que caísse por crash, passava.
  # shellcheck source=scripts/lib/falsificacao-stderr.sh disable=SC1091
  . "$(dirname "$SELF")/lib/falsificacao-stderr.sh"
  bash "$SELF" > "$TMP/c.log" 2> "$TMP/c.log.stderr" || { echo "controle NÃO verde — a falsificação não roda:"; cat "$TMP/c.log" "$TMP/c.log.stderr"; exit 1; }
  command grep -qx 'RESULTADO: 5 ok / 0 fail' "$TMP/c.log" || { echo "controle sem o recibo 5/0:"; cat "$TMP/c.log"; exit 1; }
  echo "  controle: 5 ok / 0 fail; $(linha_de_base "$TMP/c.log")"
  # asserts EXECUTADOS numa rodada = ok+fail do recibo; vazio se ela morreu antes dele
  recibo() { sed -n 's/^RESULTADO: \([0-9][0-9]*\) ok \/ \([0-9][0-9]*\) fail$/\1 \2/p' "$1" | awk '{ print $1 + $2 }'; }
  SABOTAGENS="sem_errexit_na_leitura:A1,A2,A3 operando_que_existe:A5"
  VERM=0; FALH=0
  for s in $SABOTAGENS; do
    nome="${s%%:*}"; decl="${s#*:}"
    # shellcheck disable=SC2016  # literal de propósito: é o texto `"$(set -e; ` que a sabotagem remove
    case "$nome" in
      sem_errexit_na_leitura) sed 's/"$(set -e; /"$(/g' "$SELF" > "$TMP/s.sh" ;;
      operando_que_existe) sed "s/\$(( 1 + \$(printf '') ))/\$(( 1 + 0 ))/" "$SELF" > "$TMP/s.sh" ;;
      *) echo "  ❌ $nome — sabotagem sem ramo"; FALH=$((FALH+1)); continue ;;
    esac
    if cmp -s "$SELF" "$TMP/s.sh" || ! bash -n "$TMP/s.sh"; then echo "  ❌ $nome — a sabotagem NÃO aplicou (ou quebrou a sintaxe)"; FALH=$((FALH+1)); continue; fi
    bash "$TMP/s.sh" > "$TMP/s.log" 2> "$TMP/s.log.stderr" && { echo "  ❌ $nome — saiu 0: sem dente"; FALH=$((FALH+1)); continue; }
    out="$(cat "$TMP/s.log")"
    faltou=""
    for id in ${decl//,/ }; do printf '%s\n' "$out" | command grep -q "^  FAIL $id " || faltou="$faltou $id"; done
    n="$(printf '%s\n' "$out" | command grep -c '^  FAIL ' || true)"; esperado="$(printf '%s\n' "${decl//,/ }" | wc -w | tr -d ' ')"
    if [ "$(recibo "$TMP/s.log")" != "$(recibo "$TMP/c.log")" ]; then echo "  ❌ $nome — a rodada NÃO chegou ao recibo com os $(recibo "$TMP/c.log") asserts: vermelho de aborto, não de assert"; FALH=$((FALH+1))
    elif novas="$(camada4 "$nome" "$TMP/s.log" "$TMP/c.log" "$TMP/s.sh" "$SELF")"; [ -n "$novas" ]; then echo "  ❌ $nome — vermelha com erro que o CONTROLE não tem (crash, não julgamento): $(printf '%s' "$novas" | head -c 160)"; FALH=$((FALH+1))
    elif [ -n "$faltou" ]; then echo "  ❌ $nome — os declarados NÃO caíram:$faltou"; FALH=$((FALH+1))
    elif [ "$n" != "$esperado" ]; then echo "  ❌ $nome — caíram $n, declarados $esperado ($decl)"; FALH=$((FALH+1))
    else echo "  ✅ $nome — vermelha no que declara ($decl)"; VERM=$((VERM+1)); fi
  done
  echo "SABOTAGENS: $VERM vermelhas / $FALH falhas"
  [ "$FALH" -eq 0 ] && [ "$VERM" -eq 2 ]
  exit
fi

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ok   $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FAIL $1"; }
echo "bash ${BASH_VERSION}"

# A1 — leitura composta que erra no meio: para ali, e o valor declarado NÃO sai.
set +e; v="$(set -e; false; echo declarado)"; rc=$?; set -e
if [ "$rc" -ne 0 ] && [ -z "$v" ]; then ok "A1 composta para no erro (rc=$rc)"; else bad "A1 composta seguiu: rc=$rc v=[$v]"; fi

# A2 — o cenário é uma FUNÇÃO (o formato dos cenários do watchdog): o errexit vale dentro dela.
cena() { false; echo declarado; }
set +e; v="$(set -e; cena)"; rc=$?; set -e
if [ "$rc" -ne 0 ] && [ -z "$v" ]; then ok "A2 função para no erro (rc=$rc)"; else bad "A2 função seguiu: rc=$rc v=[$v]"; fi

# A3 — a medição numa ATRIBUIÇÃO dentro da função (o `mede`): a atribuição que falha derruba o cenário.
mede() { local x; x="$(false)"; echo "depois:$x"; }
set +e; v="$(set -e; mede)"; rc=$?; set -e
if [ "$rc" -ne 0 ] && [ -z "$v" ]; then ok "A3 atribuição que falha derruba (rc=$rc)"; else bad "A3 atribuição seguiu: rc=$rc v=[$v]"; fi

# A4 — o contraste: a medição no ARGUMENTO de um echo perde o erro (é por isso que o `mede` existe).
set +e; v="$(set -e; echo "$(printf 1; false)|f=0")"; rc=$?; set -e
if [ "$rc" -eq 0 ] && [ "$v" = "1|f=0" ]; then ok "A4 no argumento do echo o erro some (rc=$rc, v=[$v]) — o contraste que justifica o mede"
else bad "A4 o echo passou a propagar o erro (rc=$rc v=[$v]): reavalie o mede"; fi

# A5 — operando VAZIO vindo de `$(...)` na aritmética não é status de comando: mata o shell na hora,
# e nem `|| true` o segura (é por isso que o `rodar` do watchdog valida a leitura ANTES da conta).
v="$( ( : "$(( 1 + $(printf '') ))" || true; echo sobreviveu ) 2>/dev/null || true )"
if [ "$v" != "sobreviveu" ]; then ok "A5 aritmética com operando vazio mata o shell (nem || true segura)"
else bad "A5 o shell sobreviveu à aritmética com operando vazio — reavalie a validação do rodar"; fi

# INFO — o contexto que as provas NÃO usam: a substituição dentro de lista || e de condição de if.
set +e; v="$(set -e; false; echo passou)" || true; set -e
echo "  INFO em lista ||: errexit da substituição $([ -z "$v" ] && echo respeitado || echo IGNORADO) (v=[$v])"
v=""; if v="$(set -e; false; echo passou)"; then :; fi
echo "  INFO em condição de if: errexit da substituição $([ -z "$v" ] && echo respeitado || echo IGNORADO) (v=[$v])"

echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" -eq 0 ]
