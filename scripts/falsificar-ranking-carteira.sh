#!/usr/bin/env bash
# Falsificação do ranking do Master pela carteira (spec 2026-10-06-ranking-atribuicao-por-carteira §6).
#
# Sabota UMA camada por vez e exige VERMELHO exatamente nos testes que a sabotagem declara: todos eles,
# e nenhum outro. Sabotagem verde = teste inalcançado ou redundante; vermelho fora da lista = asserção
# que casa por acidente; arquivo de teste que nem carrega conta como vermelho ERRADO.
#
# ⚠️ O CONTROLE roda na MESMA invocação, antes do 1º replace, e aborta se não estiver verde
# (docs/historico/falsificacao-sem-linha-de-base.md). A bateria inteira roda em LC_ALL=C E em
# pt_BR.UTF-8 (#1483); os testes casam por marcador ASCII entre colchetes ([RK-D]…), com grep -F.
#
# Uso:  bash scripts/falsificar-ranking-carteira.sh   (commite antes: restaurar() é git checkout --)
set -uo pipefail
cd "$(dirname "$0")/.." || exit 2

FONTES=(
  src/lib/dashboard/team-kpis.ts
  src/lib/dashboard/fetch-donos-carteira.ts
  src/lib/dashboard/fetch-pedidos-mtd.ts
  src/hooks/useTeamRanking.ts
  src/hooks/useTeamKpis.ts
  src/components/dashboard/RankingVendedoresCard.tsx
)
ALVOS=(
  src/lib/dashboard/__tests__/team-kpis.test.ts
  src/lib/dashboard/__tests__/fetch-donos-carteira.test.ts
  src/lib/dashboard/__tests__/fetch-pedidos-mtd.test.ts
  src/hooks/__tests__/useTeamRanking.carteira.test.tsx
  src/hooks/__tests__/useTeamKpis.atividade.test.tsx
  src/components/dashboard/__tests__/RankingVendedoresCard.carteira.test.tsx
)

TMP="$(mktemp -d)"
restaurar() { git checkout -- "${FONTES[@]}" 2>/dev/null || true; }
trap 'restaurar; rm -rf "$TMP"' EXIT

# Estado limpo é PRÉ-REQUISITO: restaurar() descartaria edição não commitada junto com a sabotagem.
if ! git diff --quiet -- "${FONTES[@]}" "${ALVOS[@]}"; then
  echo "ABORTADO: há edição não commitada nas fontes ou nos testes. Commite antes de falsificar."
  exit 2
fi

# Roda os ALVOS e imprime uma linha por teste: "P<TAB>nome" (passou), "F<TAB>nome" (falhou),
# "S<TAB>nome" (nem passou nem falhou) ou "Q<TAB>arquivo" (o arquivo nem carregou). Sem relatório JSON
# → "Q": vitest que nem subiu não pode virar "zero falhas".
rodar() {
  local json="$TMP/r.json"
  rm -f "$json"
  bunx vitest run "${ALVOS[@]}" --reporter=json --outputFile="$json" >"$TMP/saida.txt" 2>&1
  if [ ! -s "$json" ]; then
    printf 'Q\t__SEM_RELATORIO__\n'
    return 0
  fi
  PYTHONIOENCODING=utf-8 python3 - "$json" <<'PY'
import json, sys
with open(sys.argv[1], encoding='utf-8') as f:
    d = json.load(f)
for arq in d.get('testResults', []):
    testes = arq.get('assertionResults', [])
    if arq.get('status') == 'failed' and not testes:
        print('Q\t' + arq.get('name', '?'))
    for t in testes:
        st = t.get('status')
        marca = 'P' if st == 'passed' else ('F' if st == 'failed' else 'S')
        print(marca + '\t' + t.get('fullName', '(sem nome)'))
PY
}

controle() {
  local n
  rodar >"$TMP/controle.txt"
  n="$(grep -c '^P' "$TMP/controle.txt" || true)"
  if grep -qv '^P' "$TMP/controle.txt" || [ "$n" -eq 0 ]; then
    echo "ABORTADO (LC_ALL=$LC_ALL): o controle não está verde — nenhuma sabotagem provaria nada."
    grep -v '^P' "$TMP/controle.txt" | sed 's/^/    /'
    exit 1
  fi
  echo "controle verde (LC_ALL=$LC_ALL): $n testes"
}

falhou=0
# sabotar <rótulo> <arquivo> <trecho velho> <trecho novo> <marcadores que TÊM de avermelhar, por vírgula>
sabotar() {
  local rotulo="$1" arquivo="$2" velho="$3" novo="$4" esperados="$5"
  local -a marcas
  local m linha vermelhos faltou="" sobrou="" casou
  IFS=',' read -r -a marcas <<<"$esperados"
  # O marcador declarado tem de EXISTIR no controle — senão "faltou" seria sobre um teste fantasma.
  for m in "${marcas[@]}"; do
    if ! grep -qF -- "$m" "$TMP/controle.txt"; then
      echo "✗ $rotulo — o marcador $m não existe no controle"
      falhou=1
      return
    fi
  done
  # Aplicar tem de ser VERIFICADO: padrão que não casa deixaria a fonte intacta e a suíte verde.
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
  rodar >"$TMP/sab.txt"
  restaurar
  vermelhos="$(grep -v '^P' "$TMP/sab.txt" || true)"
  if [ -z "$vermelhos" ]; then
    echo "✗ $rotulo — SEM DENTE: sabotei e a suíte seguiu verde"
    falhou=1
    return
  fi
  # Sem pipe para `grep -q` (aqui e no locale abaixo): com `pipefail`, o grep que sai no 1º casamento
  # derruba o produtor por SIGPIPE (141) e o veredito se inverte — medido com `locale -a | grep -qx`.
  for m in "${marcas[@]}"; do
    grep -qF -- "$m" <<<"$vermelhos" || faltou="$faltou $m"
  done
  while IFS= read -r linha; do
    casou=0
    for m in "${marcas[@]}"; do
      case "$linha" in *"$m"*) casou=1 ;; esac
    done
    [ "$casou" -eq 1 ] || sobrou="$sobrou | $linha"
  done <<<"$vermelhos"
  if [ -n "$faltou" ] || [ -n "$sobrou" ]; then
    echo "✗ $rotulo — vermelho DIFERENTE do declarado (faltou:${faltou:- nada} · sobrou:${sobrou:- nada})"
    falhou=1
  else
    echo "✓ $rotulo — vermelho exatamente em $esperados"
  fi
}

for LOC in C pt_BR.UTF-8; do
  locais="$(locale -a 2>/dev/null)"
  if [ "$LOC" != C ] && ! grep -qx -- "$LOC" <<<"$locais"; then
    echo "ABORTADO: o locale $LOC não existe nesta máquina — a falsificação exige os dois."
    exit 2
  fi
  export LC_ALL="$LOC"
  echo
  echo "== LC_ALL=$LC_ALL =="
  controle

  sabotar 'S1 carteira sem o filtro eligible' src/lib/dashboard/fetch-donos-carteira.ts \
    "      .eq('eligible', true)"$'\n' '' \
    '[FD-ELIG]'
  sabotar 'S2 credito por created_by' src/lib/dashboard/team-kpis.ts \
    'const dono = o.customer_user_id ? donoPorCliente.get(o.customer_user_id) : undefined;' \
    'const dono = (o as { created_by?: string }).created_by ?? (o.customer_user_id ? donoPorCliente.get(o.customer_user_id) : undefined);' \
    '[RK-D],[RK-E]'
  # shellcheck disable=SC2016  # `${...}` aqui é o LITERAL do template TS a casar, não expansão de shell.
  sabotar 'S3 erro da carteira vira mapa' src/lib/dashboard/fetch-donos-carteira.ts \
    'if (error) throw new Error(`carteira_assignments (donos): ${error.message}`);' \
    'if (error) return donos;' \
    '[FD-ERRO],[FD-ERRO-LOTE2]'
  sabotar 'S4 data nula vira fim' src/lib/dashboard/fetch-donos-carteira.ts \
    'if (data == null) throw' \
    'if (data == null) break; if (false) throw' \
    '[FD-NULO]'
  sabotar 'S5 nao-vendedor somado em naoAtribuido' src/lib/dashboard/team-kpis.ts \
    'const balde = dono === undefined ? naoAtribuido : carteiraNaoVendedor;' \
    'const balde = naoAtribuido;' \
    '[RK-B]'
  sabotar 'S6 rankingSemPedido olha 2 destinos' src/lib/dashboard/team-kpis.ts \
    'r.ranking.length === 0 && r.carteiraNaoVendedor.pedidos === 0 && r.naoAtribuido.pedidos === 0' \
    'r.ranking.length === 0 && r.naoAtribuido.pedidos === 0' \
    '[RK-SP],[CARD-SO-NV]'
  sabotar 'S6b card volta a olhar 2 destinos' src/components/dashboard/RankingVendedoresCard.tsx \
    'if (rankingSemPedido(data)) return null;' \
    'if (data.ranking.length === 0 && data.naoAtribuido.pedidos === 0) return null;' \
    '[CARD-SO-NV]'
  sabotar 'S7 tile sem o filtro de hash_payload' src/hooks/useTeamKpis.ts \
    "        .is('hash_payload', null)"$'\n' '' \
    '[TK-HASH]'
  sabotar 'S8 hook manda lista vazia a carteira' src/hooks/useTeamRanking.ts \
    'fetchDonosCarteira(clienteIds)' \
    'fetchDonosCarteira([])' \
    '[HK-IDS]'
  sabotar 'S9 hook engole a falha da carteira' src/hooks/useTeamRanking.ts \
    'fetchDonosCarteira(clienteIds)' \
    'fetchDonosCarteira(clienteIds).catch(() => new Map<string, string>())' \
    '[HK-FALHA]'
  sabotar 'S10 pagina do mes sem customer_user_id' src/lib/dashboard/fetch-pedidos-mtd.ts \
    "'total, status, customer_user_id, order_date_kpi'" \
    "'total, status, order_date_kpi'" \
    '[MTD-COL]'
done

echo
if [ "$falhou" -eq 0 ]; then
  echo "TODAS AS SABOTAGENS TEM DENTE NOS DOIS LOCALES"
  exit 0
fi
echo "HA SABOTAGEM SEM DENTE OU COM VERMELHO ERRADO — veja acima"
exit 1
