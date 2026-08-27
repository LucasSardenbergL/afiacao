#!/usr/bin/env bash
# pendencias.sh — "o que ficou por terminar?", respondido por MEDIÇÃO e não por memória.
#
# Sessão é bancada, não livro-caixa. Sessão limpa não deixa registro e nunca será enumerável;
# pendência deixa rastro em prod e no git, que são consultáveis e não têm memória seletiva.
# Este script pergunta aos dois eixos e junta o veredito.
#
#   EIXO CÓDIGO   `wt:orfas`          — sessões mortas cujo trabalho não chegou na main
#   EIXO DEPLOY   `pendencias:deploy` — edge cujo bundle em prod diverge da main (passivo)
#
# A REGRA QUE DEFINE ESTE SCRIPT: eixo que NÃO pôde ser consultado não vira "limpo". Ele é
# nomeado como NÃO CONSULTADO e o exit vira 2. Um painel que responde verde varrendo metade
# ensina o operador a ler silêncio como aprovação — o hábito exato que a varredura desfaz.
# Por isso o resumo sempre imprime QUANTOS eixos responderam, e não só o que achou.
#
# EXIT: 0 = todos os eixos responderam e nada pendente · 1 = pendência encontrada
#       2 = algum eixo não consultado (veredito INCOMPLETO, não aprovação)

raiz="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$raiz" || { echo "erro: não entrei na raiz do repo" >&2; exit 2; }

consultados=0
falhos=0
pendencias=0
declare -a resumo=()

# Roda um eixo preservando o exit REAL. Sem `| tail` e sem `echo` depois: os dois engolem o
# código de saída, e é dele que sai o veredito (docs/historico/evidencia-positiva-shell.md).
rodar_eixo() {
  local nome="$1" descricao="$2"; shift 2
  local saida rc
  echo ""
  echo "═══ $nome — $descricao"
  saida="$("$@" 2>&1)"
  rc=$?
  printf '%s\n' "$saida"

  case "$rc" in
    0) consultados=$((consultados + 1)); resumo+=("✅ $nome: consultado, nada pendente") ;;
    1) consultados=$((consultados + 1)); pendencias=$((pendencias + 1))
       resumo+=("🔴 $nome: PENDÊNCIA encontrada") ;;
    *) falhos=$((falhos + 1))
       resumo+=("⚠️  $nome: NÃO CONSULTADO (exit $rc) — isto não é 'limpo'") ;;
  esac
}

rodar_eixo "DEPLOY" "edge em prod divergente da main (passivo, sem secret)" \
  bun scripts/pendencias-deploy.ts
rodar_eixo "CÓDIGO" "sessões mortas com trabalho fora da main" \
  bash scripts/wt-orfas.sh

echo ""
echo "════════════════════ RESUMO ════════════════════"
for l in "${resumo[@]}"; do echo "  $l"; done
echo "  eixos consultados: $consultados · não consultados: $falhos"

if [ "$falhos" -gt 0 ]; then
  echo "  ⇒ veredito INCOMPLETO: um eixo calou. Não leia isto como aprovação."
  exit 2
fi
if [ "$pendencias" -gt 0 ]; then
  echo "  ⇒ há pendência para fechar."
  exit 1
fi
echo "  ⇒ nada pendente nos eixos consultados."
exit 0
