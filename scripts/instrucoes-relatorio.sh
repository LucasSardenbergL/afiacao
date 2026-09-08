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
# `.agente` agora é null quando o payload não traz `agent_type` (antes era o
# default "principal", que rotulava como observação o que nunca foi observado).
# O rótulo diz isso em voz alta em vez de concatenar null e sumir com a diferença.
secao '[.[]|select(.erro|not)]
  | group_by(.arquivo + " @ " + (.agente // "-"))
  | map({k: ((.[0].arquivo|split("/")|.[-2:]|join("/")) + "  ⟵ " + (.[0].agente // "(agent_type ausente)")), n: length})
  | sort_by(-.n)[] | "  \(.n)×  \(.k)"'

# O DENOMINADOR é a resposta. "0 linha de subagente" tem DUAS leituras opostas —
# (a) regra não alcança subagente · (b) nenhum subagente rodou na janela medida —
# e só o nº de sessões/subagentes observados separa uma da outra. Sem isto o
# relatório deixa ausência de CASO passar por resultado NEGATIVO.
if ! sessoes=$(jq -rs '[.[]|select(.erro|not)|.sessao]|unique|length' "$LOG"); then
  sessoes='?'; falhou=1
fi
# `!= "principal"` virou `!= null` junto com o hook: com o default removido,
# comparar contra "principal" contaria TODO evento como subagente.
if ! subagentes=$(jq -rs '[.[]|select(.erro|not)|select(.agente != null)]|length' "$LOG"); then
  subagentes='?'; falhou=1
fi
echo "  ── denominador: $sessoes sessão(ões) · $subagentes evento(s) de subagente"
if [ "$subagentes" = "0" ]; then
  # RESPONDIDO em 2026-09-07, e a resposta não estava neste log — estava no
  # denominador de FORA dele: 24 dirs `subagents/` e 148 arquivos de subagente na
  # mesma janela, contra 0 eventos aqui; b0466403 rodou 34 subagentes → 3 eventos.
  echo "  ℹ️  ZERO evento de subagente é o ESPERADO: o InstructionsLoaded não é"
  echo "     emitido para subagente — cegueira ESTRUTURAL do hook, já medida."
  echo "     Não confunda com 'a regra não alcança o subagente': ela ALCANÇA."
  echo "     Sonda direta (subagente sem tools, tool_uses: 0) citou o CLAUDE.md"
  echo "     inteiro. Detalhe: docs/historico/split-claude-md-sensor.md."
fi

echo
echo "── 2) por motivo de carga ────────────────────────────────────"
secao '[.[]|select(.erro|not)] | group_by(.motivo)
  | map({k: .[0].motivo, n: length}) | sort_by(-.n)[] | "  \(.n)×  \(.k)"'

echo
echo "── 3) peso por arquivo (bytes/palavras do disco · chars do payload) ──"
# `-.c` com c=null EXPLODE no jq; e imprimir null como 0 repetiria a fabricação
# que o hook acabou de parar de fazer. n/d = não medido — nunca "vazio".
# `chars` continua n/d por CONTRATO (o payload não traz file_content); quem
# responde "quanto pesou" é `bytes_arquivo`, medido do disco pelo hook.
secao '[.[]|select(.erro|not)] | group_by(.arquivo)
  | map({k: (.[0].arquivo|split("/")|.[-2:]|join("/")),
         b: (.[-1].bytes_arquivo), p: (.[-1].palavras_arquivo), c: (.[-1].chars)})
  | sort_by(-(.b // -1))[]
  | "  \(.b // "n/d") bytes · \(.p // "n/d") palavras · chars=\(.c // "n/d")  \(.k)"'
if ! pesados=$(jq -rs '[.[]|select(.erro|not)|select(.bytes_arquivo != null)]|length' "$LOG"); then
  pesados='?'; falhou=1
fi
if [ "$pesados" = "0" ]; then
  echo "  ⚠️  nenhum evento com \`bytes_arquivo\` — ou o log é anterior ao conserto"
  echo "     de 2026-09-07, ou o file_path não era legível. n/d NÃO é 0."
fi

exit "$falhou"
