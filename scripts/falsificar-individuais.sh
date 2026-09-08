#!/usr/bin/env bash
# Falsificação das camadas TS do conserto da ordem do melhor individual.
#
# Uma suíte verde não prova que ela PRENDE alguma coisa: prova que passou. Este script sabota
# uma camada por vez e exige VERMELHO — e exige que o vermelho seja o teste CERTO, pelo nome.
# Sabotagem que fica verde denuncia teste inalcançado ou redundante; vermelho no teste errado
# denuncia asserção que casa por acidente.
#
# ⚠️ O CONTROLE roda na MESMA invocação, ANTES do primeiro `sed`, e o script aborta se ele não
# estiver verde. Sem isso a suíte poderia estar sempre-vermelha e todas as sabotagens
# "aprovariam" — a armadilha catalogada em docs/historico/falsificacao-sem-linha-de-base.md.
#
# Uso:  bun run falsificar:individuais      (ou ./scripts/falsificar-individuais.sh)
set -uo pipefail
cd "$(dirname "$0")/.." || exit 2

FONTES=(
  src/lib/farmer/melhor-individual.ts
  src/hooks/useBundleEngine.ts
  src/components/farmer/bundles/CustomerBundleCard.tsx
)
ALVOS=(
  src/lib/farmer/__tests__/melhor-individual.test.ts
  src/components/farmer/bundles/__tests__/CustomerBundleCard.test.tsx
  src/hooks/__tests__/bundle-melhor-individual-bulk.test.tsx
)

TMP="$(mktemp -d)"
restaurar() { git checkout -- "${FONTES[@]}" 2>/dev/null || true; }
trap 'restaurar; rm -rf "$TMP"' EXIT

# Estado limpo é PRÉ-REQUISITO: `restaurar()` é `git checkout --`, e ele descartaria edição não
# commitada junto com a sabotagem. Falhar aqui é o certo — o contrário perde trabalho.
if ! git diff --quiet -- "${FONTES[@]}"; then
  echo "ABORTADO: há edição não commitada nas fontes. Commite antes de falsificar."
  exit 2
fi

falhas_por_nome() {
  local json="$TMP/r.json"
  rm -f "$json"
  bunx vitest run "${ALVOS[@]}" --reporter=json --outputFile="$json" >"$TMP/saida.txt" 2>&1
  # Ausência de relatório NÃO é ausência de falha: sem este ramo, um vitest que nem subiu
  # (import quebrado, sintaxe inválida) devolveria zero nomes e passaria por "verde".
  if [ ! -s "$json" ]; then
    echo "__SEM_RELATORIO__"
    return 0
  fi
  python3 - "$json" <<'PY'
import json, sys
with open(sys.argv[1]) as f:
    d = json.load(f)
for arquivo in d.get('testResults', []):
    for t in arquivo.get('assertionResults', []):
        if t.get('status') == 'failed':
            print(t.get('fullName', '(sem nome)'))
PY
}

echo "── CONTROLE: a suíte tem de estar VERDE antes de qualquer sabotagem ──"
base="$(falhas_por_nome)"
if [ -n "$base" ]; then
  echo "ABORTADO: a linha de base já está vermelha — nenhuma sabotagem provaria nada."
  echo "$base"
  exit 1
fi
echo "controle verde ✓"
echo

falhou=0
sabotar() {
  local rotulo="$1" arquivo="$2" velho="$3" novo="$4" esperado="$5"

  # Aplicar tem de ser VERIFICADO: um padrão que não casa deixaria a fonte intacta, a suíte
  # verde, e o script diria "sem dente" sobre uma sabotagem que nunca existiu.
  if ! python3 - "$arquivo" "$velho" "$novo" <<'PY'
import io, sys
p, velho, novo = sys.argv[1], sys.argv[2], sys.argv[3]
s = io.open(p, encoding='utf-8').read()
if s.count(velho) != 1:
    print('  padrão casou %d vez(es) — sabotagem NÃO aplicada' % s.count(velho))
    sys.exit(1)
io.open(p, 'w', encoding='utf-8').write(s.replace(velho, novo))
PY
  then
    echo "✗ $rotulo — NÃO APLICOU"
    falhou=1
    restaurar
    return
  fi

  local vermelhos n
  vermelhos="$(falhas_por_nome)"
  n="$(printf '%s' "$vermelhos" | grep -c . || true)"
  restaurar

  if [ "$n" -eq 0 ]; then
    echo "✗ $rotulo — SEM DENTE: sabotei e a suíte seguiu verde"
    falhou=1
  elif ! printf '%s\n' "$vermelhos" | grep -qF "$esperado"; then
    echo "✗ $rotulo — vermelho no teste ERRADO ($n falha(s)); esperava casar: $esperado"
    printf '%s\n' "$vermelhos" | sed 's/^/    /'
    falhou=1
  else
    echo "✓ $rotulo — $n vermelho(s), incluindo o esperado"
  fi
}

# ── F1: a chave do Map perde o tipo ──────────────────────────────────────────────────────────
# O defeito original: uma linha por cliente fazia a segunda rota sobrescrever a primeira, e a
# rota perdida virava `nenhum` — um veredicto sobre o que ninguém verificou.
# shellcheck disable=SC2016  # `${...}` aqui é o LITERAL do template TS a casar, não expansão de shell.
sabotar 'F1 chave do Map sem o tipo' src/hooks/useBundleEngine.ts \
  '`${linha.customer_user_id}:${linha.recommendation_type}`' \
  '`${linha.customer_user_id}:cross_sell`' \
  'as DUAS rotas do mesmo cliente coexistem'

# ── F2: a projeção promove o sobrevivente a eleito ───────────────────────────────────────────
# A fabricação central: `empatado` que perdeu um nome no catálogo virando eleição.
sabotar 'F2 nome único vira eleição' src/lib/farmer/melhor-individual.ts \
  '    situacao: linha.situacao,' \
  "    situacao: nomes.length === 1 ? 'eleito' : linha.situacao," \
  'o sobrevivente não vira vencedor'

# ── F3: some o invariante cruzado do `empatado` ──────────────────────────────────────────────
# Campo a campo, `{empatado, candidatos:1}` é uma linha válida — e não representa empate nenhum.
sabotar 'F3 empatado sem cardinalidade' src/lib/farmer/melhor-individual.ts \
  "    if (situacao === 'empatado' && (produtos.length < 2 || candidatos < 2)) {" \
  "    if (false) {" \
  'derruba a leitura INTEIRA'

# ── F4: o sensor volta a contar célula ───────────────────────────────────────────────────────
# Com denominador por célula, a deriva de catálogo some justamente no estado com mais nomes.
sabotar 'F4 sensor por célula' src/hooks/useBundleEngine.ts \
  'skusIndividuaisPedidos += linha.produtos.length;' \
  'skusIndividuaisPedidos += 1;' \
  'a resolução conta SKU, não célula'

# ── F5: o filtro de inclusão exige as DUAS rotas ─────────────────────────────────────────────
# Com `every`, o cliente que tem só uma rota some da lista — a omissão que afirma ausência.
sabotar 'F5 filtro exige ambas as rotas' src/hooks/useBundleEngine.ts \
  "TIPOS_INDIVIDUAIS.some((t) => individuais[t].status !== 'nenhum')" \
  "TIPOS_INDIVIDUAIS.every((t) => individuais[t].status !== 'nenhum')" \
  'DETECTOR: o cenário produz bundle'

# ── F6: a célula perde o qualificador ────────────────────────────────────────────────────────
# Sem ele os nomes aparecem sem dizer o que são: a tela volta a insinuar ranking onde não há.
sabotar 'F6 célula sem qualificador' src/components/farmer/bundles/CustomerBundleCard.tsx \
  '  const qualificador = QUALIFICADOR[celula.situacao];' \
  '  const qualificador = null;' \
  'nomeia os produtos E declara o que sabe'

# ── F7: o total de produtos vira o de nomes resolvidos ───────────────────────────────────────
# O rodapé "1 de 2 sem nome" some, e a célula passa a esconder que escondeu.
sabotar 'F7 total de produtos = nomes resolvidos' src/lib/farmer/melhor-individual.ts \
  '    produtos: linha.produtos.length,' \
  '    produtos: nomes.length,' \
  'sem nome'

# ── F8: o nome deixa de ser aparado ──────────────────────────────────────────────────────────
# Achado R5/2: `if (nome)` aceita `"   "`, e a célula renderiza um parágrafo em branco contado
# como resolvido. Nome que não se lê não identifica produto nenhum.
sabotar 'F8 nome sem trim' src/lib/farmer/melhor-individual.ts \
  '    const nome = nomeDoSku(sku)?.trim();' \
  '    const nome = nomeDoSku(sku);' \
  'conta como não resolvido'

echo
if [ "$falhou" -eq 0 ]; then
  echo "TODAS AS SABOTAGENS TÊM DENTE"
  exit 0
fi
echo "HÁ SABOTAGEM SEM DENTE — veja acima"
exit 1
