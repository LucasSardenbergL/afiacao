#!/usr/bin/env bash
# mutcheck-seco-gate.sh — o gate barato que teria barrado o #2380.
#
# Roda `mutcheck-all.sh --seco` (perl+diff, ~1s) e reprova quando ESTE diff INTRODUZ um
# contrato ambíguo — padrão do `.mut` que deixou de casar o fonte, ou passou a casar mais
# de uma linha. Foi assim que o #2380 envenenou a main: 754 linhas duplicaram o bloco SQL,
# 18 padrões viraram ambíguos, e o PR mergeou 42s depois do job concluir FAILURE porque
# `mutation-check` não é required.
#
# Por que "INTRODUZ" e não "existe": o job cheio segue não-required de propósito
# (ci.yml, job mutation-check) — ele leva minutos e um refactor alheio pode dessincronizar
# um `.mut` que não é seu, travando PR de terceiro. Comparar contra a base devolve a falha
# a quem tocou o fonte. O caminho feliz nem paga a comparação: só quando o HEAD acusa é
# que a base é consultada.
#
# NÃO mede cobertura — a suíte não roda aqui. Verde significa "os padrões ainda são
# cirúrgicos", não "os testes têm dente". Quem mede dente é o `mutation-check`.
#
# Uso: scripts/mutcheck-seco-gate.sh [base-ref]     (default: origin/main)
# Exit: 0 = nada introduzido · 1 = este diff introduziu · 2 = não consegui decidir
set -euo pipefail

BASE_REF="${1:-origin/main}"
TMP=$(mktemp -d)
BASE_WT="$TMP/base"
# shellcheck disable=SC2329  # invocada indiretamente pelo trap logo abaixo
cleanup() {
  [ -d "$BASE_WT" ] && git worktree remove --force "$BASE_WT" >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT

# Lista os contratos com problema, um caminho por linha (basename, para comparar entre
# árvores). Sem `|| true`: a saída vazia é o sinal de sucesso, e queremos o exit code.
contratos_com_problema() {
  sed -n 's/^  - \(.*\) (exit [0-9]*)$/\1/p' "$1" | xargs -n1 basename 2>/dev/null | sort -u
}

echo "== mutcheck --seco no HEAD =="
if bash scripts/mutcheck-all.sh --seco > "$TMP/head.log" 2>&1; then
  tail -1 "$TMP/head.log"
  echo "✅ nenhum contrato ambíguo — nada a comparar com a base."
  exit 0
fi
tail -2 "$TMP/head.log"
contratos_com_problema "$TMP/head.log" > "$TMP/head.txt"
if [ ! -s "$TMP/head.txt" ]; then
  echo "::error::mutcheck-all --seco falhou mas não nomeou contrato — não dá para decidir de quem é a falha."
  cat "$TMP/head.log"
  exit 2
fi

# O HEAD está sujo. A base decide se a sujeira é DESTE diff.
echo "== o HEAD acusou; conferindo a base ($BASE_REF) =="
if ! git rev-parse --verify "$BASE_REF" >/dev/null 2>&1; then
  echo "::error::base '$BASE_REF' não existe nesta árvore (fetch raso?). Fail-closed: tratando tudo como introduzido."
  cat "$TMP/head.txt"
  exit 1
fi
BASE_SHA=$(git merge-base HEAD "$BASE_REF")
git worktree add --detach "$BASE_WT" "$BASE_SHA" >/dev/null 2>&1 || {
  echo "::error::não consegui materializar a base em worktree — não dá para atribuir a falha."
  exit 2
}
# O sensor é o de HOJE, aplicado ao fonte+contratos DA BASE. Duas razões: (1) a pergunta
# aqui é mecânica — "este padrão casa UMA linha?" — e medi-la com dois critérios diferentes
# nos dois lados não daria comparação nenhuma; (2) a base pode ser anterior ao próprio
# `--seco`, e aí o script de lá ignoraria a flag e rodaria a suíte inteira por mutação —
# minutos de gate, não segundos. Medido na falsificação: sem esta cópia o gate estourou
# 240s sem terminar.
cp scripts/mutcheck.sh scripts/mutcheck-all.sh "$BASE_WT/scripts/" || {
  echo "::error::não consegui levar o sensor de hoje para a base — sem isso a comparação não é comparável."
  exit 2
}
if (cd "$BASE_WT" && bash scripts/mutcheck-all.sh --seco > "$TMP/base.log" 2>&1); then
  : > "$TMP/base.txt"   # base limpa: tudo que o HEAD acusa é novo
else
  contratos_com_problema "$TMP/base.log" > "$TMP/base.txt"
fi

INTRODUZIDOS=$(comm -23 "$TMP/head.txt" "$TMP/base.txt" || true)
if [ -z "$INTRODUZIDOS" ]; then
  echo "⚠️  contrato(s) ambíguo(s) no HEAD, mas JÁ ambíguos na base — não é deste diff:"
  sed 's/^/     /' "$TMP/head.txt"
  echo "✅ gate passa (a dívida é anterior; o job mutation-check segue reportando-a)."
  exit 0
fi
echo "::error::este diff INTRODUZIU contrato(s) de mutação ambíguo(s):"
printf '%s\n' "$INTRODUZIDOS" | sed 's/^/     - /'
echo ""
echo "O padrão do .mut deixou de casar UMA linha do fonte — normalmente porque o fonte"
echo "ganhou um bloco parecido. Ancore o padrão no texto PRÓPRIO do bloco que ele mede"
echo "(alias, nome de coluna, o THEN do ramo) e rode:"
echo "  bash scripts/mutcheck-all.sh --seco"
exit 1
