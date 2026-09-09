#!/usr/bin/env bash
# Falsificação da contenção de baixa não-ingerida (#396) nos consumidores do dashboard financeiro
# e do drill-down do cockpit — os dois que ficaram fora do PR #2416.
#
# Uma suíte verde não prova que ela PRENDE alguma coisa: prova que passou. Este script sabota uma
# camada por vez e exige VERMELHO — e exige que o vermelho seja o teste CERTO, pelo nome.
# Sabotagem que fica verde denuncia teste inalcançado ou redundante; vermelho no teste errado
# denuncia asserção que casa por acidente.
#
# ⚠️ Metade das sabotagens é do tipo "degradar por VALOR em vez de por FONTE" — a inversão que o
# #2416 existe para impedir. Elas têm de acender o bloco de CONTROLE, não o de degradação: é o
# controle que prova que a correção não passou a mentir no sentido oposto.
#
# ⚠️ O CONTROLE roda na MESMA invocação, ANTES do primeiro `sed`, e o script aborta se ele não
# estiver verde. Sem isso a suíte poderia estar sempre-vermelha e todas as sabotagens
# "aprovariam" — a armadilha catalogada em docs/historico/falsificacao-sem-linha-de-base.md.
#
# Uso:  bun run falsificar:baixa      (ou ./scripts/falsificar-baixa-nao-ingerida.sh)
set -uo pipefail
cd "$(dirname "$0")/.." || exit 2

FONTES=(
  src/lib/financeiro/totais-contas.ts
  src/components/financeiro/dashboard/ContasReceberTab.tsx
  src/components/financeiro/dashboard/ContasPagarTab.tsx
  src/components/financeiro/CockpitDrillDown.tsx
  src/services/financeiroService.ts
)
ALVOS=(
  src/lib/financeiro/__tests__/totais-contas.test.ts
  src/services/__tests__/exportContasCSV.baixa-indisponivel.test.ts
  src/components/financeiro/dashboard/__tests__/contas-tabs.baixa-indisponivel.test.tsx
  src/components/financeiro/__tests__/CockpitDrillDown.baixa-indisponivel.test.tsx
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
  echo "ABORTADO: a suíte JÁ está vermelha — nenhuma sabotagem provaria nada."
  printf '%s\n' "$base" | sed 's/^/    /'
  exit 2
fi
echo "✓ linha de base verde"
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

# ── F1: o total deixa de degradar ────────────────────────────────────────────────────────────
# O defeito original: somar uma coluna que o ingest nunca preencheu e servir o resultado como
# fato — "Recebido R$ 0,00" sobre R$ 27,8M de títulos com status RECEBIDO.
sabotar 'F1 total da baixa não degrada' src/lib/financeiro/totais-contas.ts \
  'baixa: baixaOuIndisponivel(baixa, procedencia),' \
  'baixa,' \
  'degrada recebido e saldo para null'

# ── F2: o SALDO deixa de degradar ────────────────────────────────────────────────────────────
# O saldo é coluna GERADA a partir da baixa: com o subtraendo sempre 0 ele devolve o valor de
# face até para liquidado. Esquecê-lo é o erro fácil — a coluna que se olha primeiro é a outra.
sabotar 'F2 total do saldo não degrada' src/lib/financeiro/totais-contas.ts \
  'saldo: baixaOuIndisponivel(saldo, procedencia),' \
  'saldo,' \
  'degrada recebido e saldo para null'

# ── F3: o gatilho vira o VALOR ───────────────────────────────────────────────────────────────
# A inversão que o #2416 existe para impedir: acerta o acervo de hoje por coincidência e passa a
# mentir no sentido oposto no dia em que a ingestão existir. Tem de acender o CONTROLE.
sabotar 'F3 total degrada por valor, não por fonte' src/lib/financeiro/totais-contas.ts \
  'baixa: baixaOuIndisponivel(baixa, procedencia),' \
  'baixa: baixa === 0 ? null : baixa,' \
  'soma 0 com fonte que ingere a baixa continua 0'

# ── F4/F5: as células POR TÍTULO da aba de recebíveis ────────────────────────────────────────
# Card degradado ao lado de linhas dizendo "R$ 0,00" seria lido como bug da tela.
sabotar 'F4 célula de recebíveis não degrada' src/components/financeiro/dashboard/ContasReceberTab.tsx \
  'const celulaBaixa = (v: number) => fmtBaixa(baixaIndisponivel ? null : v);' \
  'const celulaBaixa = (v: number) => fmtBaixa(v);' \
  'nas células da linha'

sabotar 'F5 aba de recebíveis degrada por valor' src/components/financeiro/dashboard/ContasReceberTab.tsx \
  'const baixaIndisponivel = !crTotals.procedencia.ingereBaixa;' \
  'const baixaIndisponivel = crTotals.baixa === 0;' \
  'recebe 0 medido e exibe moeda no card e na linha'

# ── F6/F7: o gêmeo de contas a pagar ─────────────────────────────────────────────────────────
sabotar 'F6 célula de contas a pagar não degrada' src/components/financeiro/dashboard/ContasPagarTab.tsx \
  'const celulaBaixa = (v: number) => fmtBaixa(baixaIndisponivel ? null : v);' \
  'const celulaBaixa = (v: number) => fmtBaixa(v);' \
  'mostra "—" nas células da linha e diz por quê'

sabotar 'F7 aba de contas a pagar degrada por valor' src/components/financeiro/dashboard/ContasPagarTab.tsx \
  'const baixaIndisponivel = !cpTotals.procedencia.ingereBaixa;' \
  'const baixaIndisponivel = cpTotals.baixa === 0;' \
  'ramo de contas a pagar com 0 medido idem'

# ── F8/F9/F10: o drill-down do cockpit ───────────────────────────────────────────────────────
sabotar 'F8 drill-down não degrada a baixa' src/components/financeiro/CockpitDrillDown.tsx \
  '  const apurado = baixaOuIndisponivel(v, BAIXA_OMIE_LIST);' \
  '  const apurado: number | null = v;' \
  'mostra "—" em Recebido e Saldo'

sabotar 'F9 drill-down degrada por valor' src/components/financeiro/CockpitDrillDown.tsx \
  '  const apurado = baixaOuIndisponivel(v, BAIXA_OMIE_LIST);' \
  '  const apurado: number | null = v === 0 ? null : v;' \
  'recebido 0 medido sai como moeda'

# O total do cabeçalho é a MESMA subtração — degradar a coluna e deixar o total é meia contenção.
sabotar 'F10 total do cabeçalho não degrada' src/components/financeiro/CockpitDrillDown.tsx \
  "{total === null ? '—' : fmt(total)}" \
  '{fmt(total ?? 0)}' \
  'não afirma um Total no cabeçalho'

# ── F11/F12: o CSV, que SAI da tela e vira planilha ──────────────────────────────────────────
sabotar 'F11 CSV de recebíveis não degrada' src/services/financeiroService.ts \
  "  const celulaBaixa = (v: number) => baixaOuIndisponivel(v, procedencia) ?? procedencia.motivo ?? '';
  const rows = data.map(cr => [" \
  '  const celulaBaixa = (v: number) => v;
  const rows = data.map(cr => [' \
  'não exporta o 0 fabricado de Recebido'

sabotar 'F12 CSV degrada por valor' src/services/financeiroService.ts \
  "  const celulaBaixa = (v: number) => baixaOuIndisponivel(v, procedencia) ?? procedencia.motivo ?? '';
  const rows = data.map(cr => [" \
  "  const celulaBaixa = (v: number) => (v === 0 ? procedencia.motivo ?? '' : v);
  const rows = data.map(cr => [" \
  'recebido 0 medido sai como 0'

# O gêmeo de contas a pagar é uma CAMADA À PARTE: a asserção dele existia, mas sem sabotá-lo eu
# estaria afirmando a cobertura em vez de prová-la — os dois exports são funções independentes.
sabotar 'F13 CSV de contas a pagar não degrada' src/services/financeiroService.ts \
  "  const celulaBaixa = (v: number) => baixaOuIndisponivel(v, procedencia) ?? procedencia.motivo ?? '';
  const rows = data.map(cp => [" \
  '  const celulaBaixa = (v: number) => v;
  const rows = data.map(cp => [' \
  'degrada Pago e Saldo no ramo de contas a pagar'

sabotar 'F14 CSV de contas a pagar degrada por valor' src/services/financeiroService.ts \
  "  const celulaBaixa = (v: number) => baixaOuIndisponivel(v, procedencia) ?? procedencia.motivo ?? '';
  const rows = data.map(cp => [" \
  "  const celulaBaixa = (v: number) => (v === 0 ? procedencia.motivo ?? '' : v);
  const rows = data.map(cp => [" \
  'pago 0 medido sai como 0 no ramo de contas a pagar'

echo
if [ "$falhou" -ne 0 ]; then
  echo "FALSIFICAÇÃO REPROVADA — ver marcas ✗ acima."
  exit 1
fi
echo "FALSIFICAÇÃO OK: toda camada sabotada acendeu o teste esperado."
