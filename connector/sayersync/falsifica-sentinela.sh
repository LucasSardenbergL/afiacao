#!/usr/bin/env bash
# falsifica-sentinela.sh — prova que os asserts da sentinela '0'/0 têm DENTE.
#
# Por que existe: 7 dos 13 asserts do contrato da sentinela PASSAM antes da
# implementação (hoje nada é omitido → len(itens)≠0 → o veto de base pura nunca é
# exercido). Assert que passa nos dois mundos não prova nada sozinho — só a
# sabotagem dirigida mostra que ele distingue a implementação certa da errada.
#
# Cada falsificação declara o CONJUNTO EXATO de vermelhos esperado (nomes, não só
# contagem): "vermelho certo E SÓ ELE" é uma afirmação sobre o conjunto, e um
# harness que não sabe enumerar não pode fazê-la (lição #1505).
#
# Uso: connector/sayersync/falsifica-sentinela.sh
set -u

cd "$(dirname "$0")" || exit 1
ALVO=pg.go
BKP=$(mktemp -t pgbkp.XXXXXX)
cp "$ALVO" "$BKP"
restaura() { cp "$BKP" "$ALVO"; rm -f "$BKP"; }
trap restaura EXIT

# falhas: nomes dos testes vermelhos, ordenados. Devolve o sentinela
# __BUILD_QUEBRADO__ quando a sabotagem não COMPILA.
#
# Por que a distinção é obrigatória (mordido nesta própria sessão, 2026-07-21):
# a 1ª versão de F2 removia ` && !sentinelaVista`, que é a ÚNICA leitura da
# variável → Go recusa com "declared and not used" → o pacote não compila → NÃO
# EXISTE linha "--- FAIL:" nenhuma → o harness leu "zero vermelhos" e reportou
# "o assert NAO tem dente". Diagnóstico exatamente invertido: o assert está
# ótimo, quem estava quebrado era a sabotagem. É o "exit code não distingue
# 'pegou o bug' de 'não rodou nada'" do money-path.md numa forma nova — aqui nem
# o exit code mente, mente a AUSÊNCIA de vermelho, que parece evidência e é
# ausência de dado. Sabotagem em linguagem compilada tem de ser COMPILÁVEL:
# troque o VALOR de um predicado, não remova a leitura de um símbolo.
falhas() {
  local out
  out=$(go test ./... -count=1 -v 2>&1)
  if printf '%s' "$out" | command grep -qE '\[build failed\]|declared and not used|undefined:|^# sayersync'; then
    echo "__BUILD_QUEBRADO__"
    return
  fi
  printf '%s' "$out" \
    | command grep -E '^--- FAIL: ' \
    | sed 's/^--- FAIL: //; s/ .*$//' \
    | sort | tr '\n' ' ' | sed 's/ $//'
}

rc=0

# ── baseline: TEM de estar verde antes de qualquer sabotagem ──
echo "── baseline ──"
b=$(falhas)
if [ -n "$b" ]; then
  echo "ABORTA: baseline ja vermelho: $b"
  exit 1
fi
total=$(go test ./... -count=1 -v 2>&1 | command grep -cE '^--- PASS: ')
echo "baseline VERDE ($total asserts passando)"

# $1 = rotulo · $2 = conjunto esperado (nomes ordenados, separados por espaco) · $3.. = sed
checa() {
  rotulo="$1"; esperado="$2"; shift 2
  cp "$BKP" "$ALVO"
  for expr in "$@"; do sed -i '' -E "$expr" "$ALVO"; done
  if command diff -q "$BKP" "$ALVO" >/dev/null; then
    echo "FALHA [$rotulo]: a sabotagem NAO alterou o arquivo (sed nao casou) -- falsificacao INVALIDA"
    rc=1; return
  fi
  obtido=$(falhas)
  if [ "$obtido" = "__BUILD_QUEBRADO__" ]; then
    echo "FALHA [$rotulo]: a sabotagem NAO COMPILA -- falsificacao INVALIDA (nao mede nada)."
    echo "   troque o VALOR de um predicado; nao remova a leitura de um simbolo."
    rc=1; return
  fi
  if [ "$obtido" = "$esperado" ]; then
    echo "OK [$rotulo] vermelho exato: $obtido"
  else
    echo "FALHA [$rotulo]"
    echo "   esperado: $esperado"
    echo "   obtido  : ${obtido:-<nenhum vermelho: o assert NAO tem dente>}"
    rc=1
  fi
}

echo "── falsificacoes ──"

# F1 — remove o ESCOPO: a regra passaria a valer para formula padrao tambem.
checa "F1 escopo personalizada" \
  "TestSentinela_NaoAplicaEmFormulaPadrao" \
  's/if personalizada \&\& corantePresente/if corantePresente/'

# F2 — neutraliza o VETO: 6 sentinelas voltariam a declarar base pura (P1 do Codex).
# Sabota o VALOR (a sentinela nunca é registrada), nao a leitura da variavel --
# remover ` && !sentinelaVista` deixa o simbolo sem uso e o pacote nao compila.
checa "F2 veto is_base_pura" \
  "TestSentinela_MisturadaComVazio_NaoDeclaraBasePura TestSentinela_TodosSlotsSentinela_NaoDeclaraBasePura" \
  's/sentinelaVista = true/sentinelaVista = false/'

# F3 — ignora a DOSE: qualquer '0' viraria sentinela, inclusive com dose real.
checa "F3 dose exatamente zero" \
  "TestSentinela_DoseNaoZeroSegueEmitida" \
  's/qtdOK \&\& qtd == 0 \&\&/qtdOK \&\&/'

# F4 — afrouxa a CANONICALIZACAO: " 0 " passaria a casar como sentinela.
checa "F4 id canonico" \
  "TestSentinela_IdNaoCanonicoSegueEmitido" \
  's/fmt\.Sprintf\("%v", coranteVal\) == sentinelaSlotLivre/strings.TrimSpace(fmt.Sprintf("%v", coranteVal)) == sentinelaSlotLivre/'

# F5 — remove a FINITUDE: NaN/Inf nativos voltariam a passar.
checa "F5 finitude float nativo" \
  "TestToFloat64OK_RejeitaNaNInfEmFloatNativo" \
  's/^\t\treturn finitoOK\(n\)$/\t\treturn n, true/'

echo "── fim ──"
[ "$rc" -eq 0 ] && echo "TODAS AS FALSIFICACOES PRODUZIRAM O VERMELHO EXATO" || echo "HA FALSIFICACAO SEM DENTE OU IMPRECISA"
exit "$rc"
