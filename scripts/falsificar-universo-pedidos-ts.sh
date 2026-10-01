#!/usr/bin/env bash
# Falsificação do gate do universo de pedidos no TS/edges (src/__tests__/universo-pedidos-ts-gate.test.ts).
#
# Uma suíte verde não prova que ela PRENDE: prova que passou. Cada sabotagem abaixo reintroduz a
# classe num arquivo REAL (ou cega uma peça do detector/walker/registro) e exige VERMELHO com a MARCA
# do ramo — o nome do teste que tem de cair E o arquivo que ele tem de nomear. Vermelho sem a marca é
# falha da falsificação (asserção que casa por acidente, ou lista truncada que não diz o arquivo).
#
# ⚠️ O CONTROLE roda na MESMA invocação, antes da 1ª sabotagem, e o script aborta se não estiver verde
# (docs/historico/falsificacao-sem-linha-de-base.md). Sabotagem que não altera o arquivo é TEATRO e
# conta como falha. Restauro por CÓPIA (cp/mv), nunca `git checkout --`: em árvore suja o checkout
# apagaria trabalho não commitado junto com a sabotagem (money-path.md §9).
#
# Uso:  bun run falsificar:universo-pedidos-ts [LOCALE]     (default C; rode também pt_BR.UTF-8)
# Saída: FALSIFICACAO_OK e exit 0 · exit 1 = alguma sabotagem não deu o vermelho certo · 3 = controle não verde.
set -u
cd "$(dirname "$0")/.." || exit 2
T=src/__tests__/universo-pedidos-ts-gate.test.ts
LOC="${1:-C}"
OUT=$(mktemp); BK=$(mktemp -d)
rodar() { LC_ALL="$LOC" bunx vitest run "$T" > "$OUT" 2>&1; echo $?; }
falhas=0
controle() {
  local rc; rc=$(rodar)
  if [ "$rc" = 0 ] && grep -q 'Tests  18 passed (18)' "$OUT"; then echo "CONTROLE $1: verde (18/18)"; else echo "CONTROLE $1: NÃO verde (rc=$rc) — aborto"; tail -5 "$OUT"; exit 3; fi
}
# sabotar <id> <arquivo> <perl-expr> <prova-que-pegou(regex no arquivo)> <marca1> [marca2]
sabotar() {
  local id=$1 arq=$2 expr=$3 prova=$4 m1=$5 m2=${6:-}
  cp "$arq" "$BK/$id"
  perl -0pi -e "$expr" "$arq"
  # Duas provas de que a sabotagem pegou: o arquivo MUDOU (cmp) e o trecho sabotado está lá.
  if cmp -s "$BK/$id" "$arq" || ! grep -q -E -- "$prova" "$arq"; then echo "$id: SABOTAGEM NÃO PEGOU (teatro) — $arq"; mv "$BK/$id" "$arq"; falhas=$((falhas+1)); return; fi
  local rc; rc=$(rodar)
  mv "$BK/$id" "$arq"
  local ok=1
  [ "$rc" != 0 ] || ok=0
  grep -q -F -- "$m1" "$OUT" || ok=0
  if [ -n "$m2" ]; then grep -q -F -- "$m2" "$OUT" || ok=0; fi
  if [ $ok = 1 ]; then echo "$id: VERMELHO com a marca ✓ ($m1${m2:+ + $m2})"; else echo "$id: FALHOU — rc=$rc, marca ausente ($m1 / $m2)"; falhas=$((falhas+1)); grep -E 'FAIL|×' "$OUT" | head -5; fi
}
controle antes
# S5 mira um LOOKUP estável (não uma dívida, que some quando o PR do domínio a quita) e S11 sabota
# "teto − 1": nenhuma sabotagem depende de quanta dívida resta.
sabotar S1 src/hooks/useFarmerScoring.ts "s/(\.not\('status', 'in', STATUS_NAO_VENDA_POSTGREST\)\n\s*)\.is\('deleted_at', null\)/\1.limit(1_000_000)/" "limit\(1_000_000\)" "G1: leitura fora" "src/hooks/useFarmerScoring.ts"
sabotar S2 src/hooks/useBundleEngine.ts "s/(\.is\('deleted_at', null\))/\1.neq('status', 'cancelado')/" "neq\('status', 'cancelado'\)" "G1: leitura fora" "src/hooks/useBundleEngine.ts"
sabotar S3 src/hooks/useCrossSellEngine.ts "s/\A/const X_STATUS = ['cancelado', 'rascunho'];\n/" "X_STATUS = \['cancelado'" "G5: nenhuma c" "src/hooks/useCrossSellEngine.ts"
sabotar S4 supabase/functions/_shared/mapas-paginados.ts 's/\.not\("status", "in", STATUS_NAO_VENDA_POSTGREST\)/.not("status", "in", "(cancelado,rascunho,pendente)")/' '"\(cancelado,rascunho,pendente\)"' "supabase/functions/_shared/mapas-paginados.ts" "G5: nenhuma c"
sabotar S5 src/hooks/useGlobalSearch.ts "s/(\.ilike\('omie_numero_pedido', pat\))/\1.not('status', 'in', STATUS_NAO_VENDA_POSTGREST).is('deleted_at', null)/" "STATUS_NAO_VENDA_POSTGREST\)\.is" "G2: o registro só encolhe" "src/hooks/useGlobalSearch.ts"
sabotar S6 src/lib/gates/universo-pedidos-ts.ts "s/const ehConstanteCanonica = \(n: ts.Expression \| undefined\) => referencia\(n, CONSTANTE_CANONICA\);/const ehConstanteCanonica = (_n: ts.Expression | undefined) => true;/" "=> true;" "metade do contrato não basta"
sabotar S7 src/lib/gates/universo-pedidos-ts.ts "s/(function variavelDestino\(topo: ts.Node\): string \| undefined \{\n)/\1  if (topo) return undefined;\n/" "if \(topo\) return undefined;" "segue a VARIÁVEL" "src/lib/dashboard/fetch-pedidos-mtd.ts"
sabotar S8 src/__tests__/universo-pedidos-ts-gate.test.ts 's/const EXT = \/\\\.\(ts\|tsx\)\$\/;/const EXT = \/\\.(tsz)\$\/;/' 'tsz' "sentinela: o walker anda"
sabotar S9 src/lib/gates/universo-pedidos-ts.ts 's/const callee = desembrulhar\(n\.expression\);\n(\s+if \(ts\.isPropertyAccessExpression\(callee\) && callee\.name\.text === "from")/const callee = n.expression;\n\1/' "const callee = n\.expression;" "formas reais de escrever o from"
sabotar S10 src/lib/gates/universo-pedidos-ts-registro.ts "s/, incluiApagado: 'mede INSERÇÃO de linha, e o pedido apagado depois também foi inserido'//" "sinal de vida do sistema: a linha mais recente, de qualquer status' \}" "G3: feed de propósito"
# shellcheck disable=SC2016  # o $1 é do perl (/e), não do shell
sabotar S11 src/lib/gates/universo-pedidos-ts-registro.ts 's/export const TETO_DIVIDA = (\d+);/"export const TETO_DIVIDA = ".($1-1).";"/e' "TETO_DIVIDA = -?[0-9]+;" "G4: a dívida só desce"
controle depois
echo "LOCALE=$LOC falhas=$falhas"
rm -rf "$OUT" "$BK"
[ $falhas = 0 ] && echo "FALSIFICACAO_OK" || exit 1
