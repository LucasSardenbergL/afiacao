#!/usr/bin/env bash
# check-claude-md-budget.sh — orçamento APERTADO do CLAUDE.md (frente 1 do refactor, 2026-06-15).
#
# O CLAUDE.md é carregado em TODA sessão + subagente. Inchado, ele empurra os subagentes
# pra perto do limite de contexto → thrashing de auto-compact (registrado em #819) e
# encarece toda sessão. A frente 1 o enxugou de ~68 KB → ~13 KB, movendo o detalhe pra
# docs/agent/* (lição operacional) e docs/historico/* (diário de PR). Este gate impede o re-inchaço.
#
# Estourou? NÃO adicione linha aqui — mova a lição pro docs/agent/<dominio>.md, o
# histórico pro docs/historico/, e deixe no CLAUDE.md só a REGRA + o ponteiro pro doc.
#
# Bytes/palavras são a métrica dura (estável); a estimativa de tokens é informativa.
# Linha gigante = sinal de que entrou um bullet de diário que devia ir pra docs/historico/.
set -euo pipefail

f="${1:-CLAUDE.md}"
MAX_BYTES=20480 # 20 KB (~5,5k tokens). Pós-refactor ~13 KB — folga p/ regra nova, barra o diário.
MAX_WORDS=2600
MAX_LINE=2000 # chars por linha — linha maior = bullet de diário (mover pra docs/historico/)

[ -f "$f" ] || {
  echo "❌ não achei $f (rode da raiz do repo)" >&2
  exit 2
}

bytes=$(wc -c <"$f")
words=$(wc -w <"$f")
maxline=$(awk '{ if (length > m) { m = length; ln = NR } } END { print m"@"ln }' "$f")
maxlen="${maxline%@*}"
maxln="${maxline#*@}"
est_tokens=$((bytes * 10 / 35))

fail=0
if [ "$bytes" -gt "$MAX_BYTES" ]; then
  echo "❌ $f: $bytes bytes > teto $MAX_BYTES — mova lição pra docs/agent/ e histórico pra docs/historico/ (ver topo do CLAUDE.md)"
  fail=1
fi
if [ "$words" -gt "$MAX_WORDS" ]; then
  echo "❌ $f: $words palavras > teto $MAX_WORDS"
  fail=1
fi
if [ "$maxlen" -gt "$MAX_LINE" ]; then
  echo "❌ $f: linha $maxln tem $maxlen chars > teto $MAX_LINE — provável bullet de diário (mova pra docs/historico/)"
  fail=1
fi

if [ "$fail" -eq 0 ]; then
  echo "✅ $f: $bytes bytes / $words palavras / ≈${est_tokens} tokens / maior linha $maxlen chars — dentro do orçamento (teto ${MAX_BYTES}B / ${MAX_WORDS}w / linha ${MAX_LINE}c)"
fi
exit "$fail"
