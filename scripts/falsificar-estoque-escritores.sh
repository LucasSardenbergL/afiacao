#!/usr/bin/env bash
# Falsificação do gate dos escritores de estoque (src/__tests__/estoque-escritores-gate.test.ts) e do
# detector dele (src/lib/gates/__tests__/estoque-escritores.test.ts).
#
# Uma suíte verde não prova que ela PRENDE: prova que passou. Cada sabotagem reintroduz a classe num
# arquivo REAL (ou cega uma peça do detector) e exige VERMELHO com a MARCA do ramo — o nome da regra que
# tem de cair E o arquivo que ela tem de nomear. Vermelho sem a marca é falha da falsificação.
#
# ⚠️ O CONTROLE roda na MESMA invocação, antes da 1ª sabotagem, e o script aborta se não estiver verde
# (docs/historico/falsificacao-sem-linha-de-base.md). Sabotagem que não altera o arquivo é TEATRO e conta
# como falha. Restauro por CÓPIA (cp/mv), nunca `git checkout --`.
#
# Uso:  bun run falsificar:estoque-escritores [LOCALE]     (default C; rode também pt_BR.UTF-8)
# Saída: FALSIFICACAO_OK e exit 0 · exit 1 = alguma sabotagem não deu o vermelho certo · 3 = controle não verde.
set -u
cd "$(dirname "$0")/.." || exit 2
T="src/__tests__/estoque-escritores-gate.test.ts src/lib/gates/__tests__/estoque-escritores.test.ts"
LOC="${1:-C}"
OUT=$(mktemp); BK=$(mktemp -d)
# shellcheck disable=SC2086  # T é uma lista de arquivos de propósito
rodar() { LC_ALL="$LOC" bunx vitest run $T > "$OUT" 2>&1; echo $?; }
falhas=0
controle() {
  local rc; rc=$(rodar)
  if [ "$rc" = 0 ] && grep -q 'Tests  13 passed (13)' "$OUT"; then echo "CONTROLE $1: verde (13/13)"; else echo "CONTROLE $1: NÃO verde (rc=$rc) — aborto"; tail -5 "$OUT"; exit 3; fi
}
# sabotar <id> <arquivo> <perl-expr> <prova-que-pegou(regex no arquivo)> <marca1> [marca2]
sabotar() {
  local id=$1 arq=$2 expr=$3 prova=$4 m1=$5 m2=${6:-}
  cp "$arq" "$BK/$id"
  perl -0pi -e "$expr" "$arq"
  if cmp -s "$BK/$id" "$arq" || ! grep -q -E -- "$prova" "$arq"; then echo "$id: SABOTAGEM NÃO PEGOU (teatro) — $arq"; mv "$BK/$id" "$arq"; falhas=$((falhas+1)); return; fi
  local rc; rc=$(rodar)
  mv "$BK/$id" "$arq"
  local ok=1
  [ "$rc" != 0 ] || ok=0
  grep -q -F -- "$m1" "$OUT" || ok=0
  if [ -n "$m2" ]; then grep -q -F -- "$m2" "$OUT" || ok=0; fi
  if [ $ok = 1 ]; then echo "$id: VERMELHO com a marca ✓ ($m1${m2:+ + $m2})"; else echo "$id: FALHOU — rc=$rc, marca ausente ($m1 / $m2)"; falhas=$((falhas+1)); grep -E 'FAIL|AssertionError' "$OUT" | head -5; fi
}
controle antes
# G3 — o dono mantém o import e perde a CHAMADA do zero confirmado.
sabotar S1 supabase/functions/sync-reprocess/index.ts 's/await zerarConfirmadosForaDaLista\(/await Promise.resolve(/' 'await Promise\.resolve\(\{' "G3: dono do zero sem a chamada" "supabase/functions/sync-reprocess/index.ts"
# G4 — um escritor grava o zero LITERAL (a forma do "|| 0" sem a fonte).
sabotar S2 supabase/functions/tint-omie-sync/index.ts 's/estoque: prod\.quantidade_estoque \|\| 0,/estoque: 0,/' 'estoque: 0,' "G4: zero literal de estoque num escritor" "supabase/functions/tint-omie-sync/index.ts"
# G1 — um writer NOVO de posição numa edge fora do registro.
sabotar S3 supabase/functions/omie-sync-status-produtos/index.ts 's/\z/\nexport const sabotagemEstoque = (db: { from: (t: string) => { update: (v: unknown) => unknown } }) => db.from("inventory_position").update({ saldo: 1 });\n/' 'sabotagemEstoque' "G1: escritor de estoque fora do registro" "supabase/functions/omie-sync-status-produtos/index.ts"
# G2 — a entrada do registro cujo arquivo deixou de escrever (o registro só encolhe).
sabotar S4 supabase/functions/tint-omie-sync/index.ts 's/\.from\("omie_products"\)/.from("omie_productz")/g' 'omie_productz' "G2: entrada do registro que não escreve mais" "supabase/functions/tint-omie-sync/index.ts"
# Detector cego para a posição: a sentinela tem de cair (sem ela, G1–G4 aprovariam um repo sem escritores).
sabotar S5 src/lib/gates/estoque-escritores.ts 's/inventory_position/inventory_positionz/g' 'inventory_positionz' "sentinela: o walker anda e o detector acha os dois donos"
# Detector que lê comentário: a escrita comentada passaria a contar.
sabotar S6 src/lib/gates/estoque-escritores.ts 's/removerComentarios\(fonte\)/fonte/' 'const limpa = fonte;' "escrita COMENTADA não conta"
controle depois
echo "LOCALE=$LOC falhas=$falhas"
rm -rf "$OUT" "$BK"
[ $falhas = 0 ] && echo "FALSIFICACAO_OK" || exit 1
