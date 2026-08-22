#!/usr/bin/env bash
# instrucoes-relatorio.sh — lê o sensor `.claude/hooks/instrucoes-carregadas.sh`
# e responde as 2 perguntas que decidem o split do CLAUDE.md:
#
#   1. regra `paths:` / CLAUDE.md aninhado chega no SUBAGENTE?
#   2. o que recarrega depois do /compact (e o que fica AUSENTE)?
#
# Três desfechos DIFERENTES, nunca confundidos:
#   log inexistente → ausência de dado (o sensor não rodou ainda)
#   evento com .erro → SENSOR quebrado
#   seção que falha  → exit != 0, nunca "seção vazia" silenciosa
set -uo pipefail

LOG="${AFIACAO_INSTR_LOG:-$HOME/.config/afiacao/instrucoes-carregadas.jsonl}"
falhou=0

if [ ! -f "$LOG" ]; then
  echo "⏳ sensor ainda NÃO coletou nada ($LOG não existe)."
  echo "   Isso NÃO é 'nada carregou' — é ausência de dado. O hook só grava a"
  echo "   partir da PRÓXIMA sessão iniciada depois que o settings.json valer."
  exit 0
fi

command -v jq >/dev/null 2>&1 || { echo "❌ jq ausente — não dá para ler o log"; exit 2; }

# roda um filtro jq e FALHA ALTO se ele quebrar (jq que quebra sai 0 no pipeline
# e a seção vazia passaria por "não achei nada" — a armadilha do exit engolido)
secao() {
  if ! jq -rs "$1" "$LOG"; then
    echo "  ❌ seção FALHOU (jq) — sensor/filtro quebrado, NÃO ausência de dado"
    falhou=1
  fi
}

total=$(wc -l <"$LOG" | tr -d ' ')
erros=$(jq -rs '[.[]|select(.erro)]|length' "$LOG" 2>/dev/null || echo '?')
echo "📊 $total evento(s) · $erros com erro de sensor"
echo "   $LOG"
[ "$erros" != "0" ] && echo "   ⚠️  evento com erro = SENSOR quebrado, não ausência de carga."

echo
echo "── 1) chega no subagente? (arquivo ⟵ agente) ─────────────────"
secao '[.[]|select(.erro|not)]
  | group_by(.arquivo + " @ " + .agente)
  | map({k: ((.[0].arquivo|split("/")|.[-2:]|join("/")) + "  ⟵ " + .[0].agente), n: length})
  | sort_by(-.n)[] | "  \(.n)×  \(.k)"'

echo
echo "── 2) por motivo de carga ────────────────────────────────────"
secao '[.[]|select(.erro|not)] | group_by(.motivo)
  | map({k: .[0].motivo, n: length}) | sort_by(-.n)[] | "  \(.n)×  \(.k)"'

echo
echo "── 3) peso por arquivo (chars, último visto) ─────────────────"
secao '[.[]|select(.erro|not)] | group_by(.arquivo)
  | map({k: (.[0].arquivo|split("/")|.[-2:]|join("/")), c: (.[-1].chars)})
  | sort_by(-.c)[] | "  \(.c)  \(.k)"'

exit "$falhou"
