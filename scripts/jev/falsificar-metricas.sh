#!/usr/bin/env bash
# Falsificação das métricas do backtest do Jev (scripts/jev/metricas.ts).
#
# A suíte verde prova que passou, não que PRENDE. Este script sabota uma fórmula por vez e exige
# VERMELHO no teste CERTO, pelo nome — sabotagem que fica verde denuncia asserção frouxa; vermelho
# no teste errado denuncia asserção que casa por acidente.
#
# ⚠️ O CONTROLE roda na MESMA invocação, ANTES do primeiro sabotar, e o script aborta se ele não
# estiver verde (docs/historico/falsificacao-sem-linha-de-base.md). Os nomes esperados são ASCII
# puros, sem -i: rode nos DOIS locales para provar que o casamento não depende de ambiente.
#
# Uso:  LC_ALL=C bash scripts/jev/falsificar-metricas.sh
#       LC_ALL=pt_BR.UTF-8 bash scripts/jev/falsificar-metricas.sh
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 2

FONTE=scripts/jev/metricas.ts
ALVO=scripts/jev/metricas.test.ts

TMP="$(mktemp -d)"
restaurar() { git checkout -- "$FONTE" 2>/dev/null || true; }
trap 'restaurar; rm -rf "$TMP"' EXIT

# `restaurar()` é `git checkout --`: descartaria edição não commitada junto com a sabotagem.
if ! git diff --quiet -- "$FONTE"; then
  echo "ABORTADO: há edição não commitada em $FONTE. Commite antes de falsificar."
  exit 2
fi

falhas_por_nome() {
  local json="$TMP/r.json"
  rm -f "$json"
  bunx vitest run "$ALVO" --reporter=json --outputFile="$json" >"$TMP/saida.txt" 2>&1
  # Sem relatório NÃO é sem falha: um vitest que nem subiu devolveria zero nomes ("verde").
  if [ ! -s "$json" ]; then
    echo "__SEM_RELATORIO__"
    return 0
  fi
  python3 - "$json" <<'PY'
import json, sys
with open(sys.argv[1]) as f:
    d = json.load(f)
for arquivo in d.get('testResults', []):
    if arquivo.get('status') == 'failed' and not arquivo.get('assertionResults'):
        print('__ARQUIVO_FALHOU_SEM_TESTES__')
    for t in arquivo.get('assertionResults', []):
        if t.get('status') == 'failed':
            print(t.get('fullName', '(sem nome)'))
PY
}

echo "── CONTROLE: a suíte tem de estar VERDE antes de qualquer sabotagem (LC_ALL=${LC_ALL:-<vazio>}) ──"
base="$(falhas_por_nome)"
if [ -n "$base" ]; then
  echo "ABORTADO: a linha de base já está vermelha — nenhuma sabotagem provaria nada."
  echo "$base"
  exit 1
fi
passaram="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("numPassedTests", -1))' "$TMP/r.json")"
if [ "$passaram" != "25" ]; then
  echo "ABORTADO: o controle rodou $passaram teste(s), não 25 (a suíte mudou? atualize o número)."
  exit 1
fi
echo "controle verde ✓ (25 testes)"
echo

falhou=0
sabotar() {
  local rotulo="$1" velho="$2" novo="$3" esperado="$4"

  # Aplicar tem de ser VERIFICADO: padrão que não casa deixaria a fonte intacta e a suíte verde.
  if ! python3 - "$FONTE" "$velho" "$novo" <<'PY'
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

# S1 — ECE como média SIMPLES das faixas (ignora quantos itens cada faixa tem).
sabotar 'S1 ECE sem peso por faixa' \
  '    ece += (f.n / n) * Math.abs(f.acerto - f.confMedia);' \
  '    ece += Math.abs(f.acerto - f.confMedia) / faixas.filter((x) => x.n > 0).length;' \
  'valor calculado'

# S2 — cobertura divide pelas "respondíveis": a falha operacional some do denominador.
sabotar 'S2 cobertura sem a falha no denominador' \
  '    cobertura: total > 0 ? respondidas / total : null,' \
  '    cobertura: total > 0 ? respondidas / (total - falhas) : null,' \
  'fica no DENOMINADOR'

# S3 — limiar exclusivo: prob == limiar deixa de responder.
sabotar 'S3 limiar exclusivo' \
  '    if (p.prob >= limiar) {' \
  '    if (p.prob > limiar) {' \
  'INCLUSIVO'

# S4 — sem o teto da última faixa: prob = 1 cai num índice que não existe.
sabotar 'S4 prob 1 fora da ultima faixa' \
  '    const idx = Math.min(nFaixas - 1, Math.max(0, Math.floor(p.prob * nFaixas)));' \
  '    const idx = Math.max(0, Math.floor(p.prob * nFaixas));' \
  'prob = 1,0 cai na'

# S5 — acerto sem respondidas vira 0 (fabricação: ausente vira zero).
sabotar 'S5 acerto ausente vira zero' \
  '    acerto: respondidas > 0 ? acertos / respondidas : null,' \
  '    acerto: respondidas > 0 ? acertos / respondidas : 0,' \
  'acerto NULL, nunca 0 nem 1'

# S6 — "regra de três" (3/n) no lugar do Clopper-Pearson exato.
sabotar 'S6 regra de tres no lugar do Clopper-Pearson' \
  '  if (erros <= 0) return 1 - Math.pow(alfa, 1 / n);' \
  '  if (erros <= 0) return Math.min(1, 3 / n);' \
  '0 erros em 150'

# S7 — portão pelo erro OBSERVADO (otimista com N pequeno), não pelo limite superior.
sabotar 'S7 limiar pelo erro observado' \
  '    if (r.respondidas > 0 && r.limiteSuperiorErro !== null && r.limiteSuperiorErro <= erroAlvo) return t;' \
  '    if (r.respondidas > 0 && r.erros / r.respondidas <= erroAlvo) return t;' \
  'alvo 10%: 0,85 reprova'

# S8 — toda mudança de decisão vira "troca confiante" (inclusive o cruzamento de limiar).
sabotar 'S8 troca confiante sem exigir as duas respostas' \
  '        if (da !== null && db !== null) trocasConfiantes++;' \
  '        trocasConfiantes++;' \
  '0 trocas confiantes'

# S9 — percentil com floor no rank (subestima a cauda).
sabotar 'S9 percentil com floor' \
  '  const rank = Math.ceil((p / 100) * ordenados.length);' \
  '  const rank = Math.floor((p / 100) * ordenados.length);' \
  'p50/p95 de 5 lat'

echo
if [ "$falhou" -ne 0 ]; then
  echo "FALSIFICACAO-METRICAS-FALHOU"
  exit 1
fi
echo "FALSIFICACAO-METRICAS-OK (9/9 sabotagens vermelhas no teste certo)"
