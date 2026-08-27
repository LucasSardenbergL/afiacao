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

# ⚠️ NEM TODO EIXO CODIFICA PENDÊNCIA NO EXIT — e supor que sim já produziu um verde falso aqui.
#
# `pendencias-deploy` foi escrito para este contrato (0=limpo, 1=pendência, 2=mecânica). O
# `wt:orfas` NÃO: ele é um RELATÓRIO, e devolve 0 para dizer "rodei", listando as candidatas no
# corpo. Na primeira execução deste script ele imprimiu 35 CANDIDATAS e o resumo disse "nada
# pendente" — o verde falso exato que a varredura existe para impedir, cometido pela varredura.
#
# Então cada eixo declara COMO se lê a pendência dele:
#   exit   — o código de saída é o veredito
#   linha  — a pendência está numa linha do corpo; o extrator devolve o número
# E o modo `linha` é FAIL-CLOSED: se o padrão não casar, o eixo vira NÃO CONSULTADO em vez de
# zero. Mudança no formato da saída se leria como "nada achei", que é o mesmo bug de novo.

# Extrai "branches: 35 CANDIDATA(s)" -> 35. Silêncio (vazio) = não consegui ler, NÃO é zero.
contar_candidatas() {
  sed -n 's/.*branches:[[:space:]]*\([0-9][0-9]*\)[[:space:]]*CANDIDATA.*/\1/p' | head -1
}

rodar_eixo() {
  local nome="$1" descricao="$2" modo="$3"; shift 3
  local saida rc n
  echo ""
  echo "═══ $nome — $descricao"
  saida="$("$@" 2>&1)"
  rc=$?
  printf '%s\n' "$saida"

  # Exit >=2 é falha de mecânica em QUALQUER modo: o eixo não respondeu.
  if [ "$rc" -ge 2 ]; then
    falhos=$((falhos + 1))
    resumo+=("⚠️  $nome: NÃO CONSULTADO (exit $rc) — isto não é 'limpo'")
    return
  fi

  if [ "$modo" = "exit" ]; then
    consultados=$((consultados + 1))
    if [ "$rc" -eq 1 ]; then
      pendencias=$((pendencias + 1)); resumo+=("🔴 $nome: PENDÊNCIA encontrada")
    else
      resumo+=("✅ $nome: consultado, nada pendente")
    fi
    return
  fi

  n="$(printf '%s\n' "$saida" | contar_candidatas)"
  if [ -z "$n" ]; then
    falhos=$((falhos + 1))
    resumo+=("⚠️  $nome: NÃO CONSULTADO — não achei a linha de contagem; formato mudou?")
  elif [ "$n" -gt 0 ]; then
    consultados=$((consultados + 1)); pendencias=$((pendencias + 1))
    resumo+=("🔴 $nome: $n candidata(s) para triar")
  else
    consultados=$((consultados + 1)); resumo+=("✅ $nome: consultado, nada pendente")
  fi
}

# --selftest: prova que o extrator lê o número E que ele CALA quando o formato muda.
if [ "${1:-}" = "--selftest" ]; then
  got="$(printf '  branches: 35 CANDIDATA(s) · 14 sem rastro\n' | contar_candidatas)"
  [ "$got" = "35" ] || { echo "selftest FALHOU: extraiu '$got', esperava 35" >&2; exit 1; }
  got="$(printf '  branches: trinta e cinco candidatas\n' | contar_candidatas)"
  [ -z "$got" ] || { echo "selftest FALHOU: devia calar em formato novo, veio '$got'" >&2; exit 1; }
  got="$(printf '  branches: 0 CANDIDATA(s)\n' | contar_candidatas)"
  [ "$got" = "0" ] || { echo "selftest FALHOU: zero legítimo virou '$got'" >&2; exit 1; }
  echo "selftest OK — extrai, cala no formato desconhecido, e distingue zero de ilegível"
  exit 0
fi

rodar_eixo "DEPLOY" "edge em prod divergente da main (passivo, sem secret)" exit \
  bun scripts/pendencias-deploy.ts
rodar_eixo "CÓDIGO" "sessões mortas com trabalho fora da main" linha \
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
