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

# Métrica escalar é SEMPRE `if ! var=$(jq ...)`, nunca um helper que atribui por
# indireção: ali o `if !` testaria o printf (que passa) e não o jq (que quebrou),
# e a métrica viraria string vazia com falhou=0 — o exit engolido de sempre.

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

# O DENOMINADOR é a resposta. "0 linha de subagente" tem DUAS leituras opostas —
# (a) regra não alcança subagente · (b) nenhum subagente rodou na janela medida —
# e só o nº de sessões/subagentes observados separa uma da outra. Sem isto o
# relatório deixa ausência de CASO passar por resultado NEGATIVO.
if ! sessoes=$(jq -rs '[.[]|select(.erro|not)|.sessao]|unique|length' "$LOG"); then
  sessoes='?'; falhou=1
fi
if ! subagentes=$(jq -rs '[.[]|select(.erro|not)|select(.agente!="principal")]|length' "$LOG"); then
  subagentes='?'; falhou=1
fi
echo "  ── denominador: $sessoes sessão(ões) · $subagentes evento(s) de subagente"
if [ "$subagentes" = "0" ]; then
  echo "  ⚠️  ZERO evento de subagente ⇒ ausência de CASO, NÃO resposta negativa."
  echo "     A pergunta 'regra path-scoped alcança subagente?' segue SEM controle:"
  echo "     antes de crer num teste que dá negativo, exija ≥1 linha aqui com"
  echo "     agent_type — é ela que prova que o sensor ENXERGA subagente."
fi

echo
echo "── 2) por motivo de carga ────────────────────────────────────"
secao '[.[]|select(.erro|not)] | group_by(.motivo)
  | map({k: .[0].motivo, n: length}) | sort_by(-.n)[] | "  \(.n)×  \(.k)"'

echo
echo "── 3) peso por arquivo (chars, último visto) ─────────────────"
# `-.c` com c=null EXPLODE no jq; e imprimir null como 0 repetiria a fabricação
# que o hook acabou de parar de fazer. n/d = o payload não trouxe file_content.
secao '[.[]|select(.erro|not)] | group_by(.arquivo)
  | map({k: (.[0].arquivo|split("/")|.[-2:]|join("/")), c: (.[-1].chars)})
  | sort_by(-(.c // -1))[] | "  \(.c // "n/d")  \(.k)"'
if ! medidos=$(jq -rs '[.[]|select(.erro|not)|select(.chars != null)]|length' "$LOG"); then
  medidos='?'; falhou=1
fi
if [ "$medidos" = "0" ]; then
  echo "  ⚠️  nenhum evento traz \`file_content\` — peso é n/d (não é 0)."
  echo "     Confira \`campos\` no log para o contrato real do payload."
fi

exit "$falhou"
