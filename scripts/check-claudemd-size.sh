#!/usr/bin/env bash
# check-claudemd-size.sh — vigia o tamanho do CLAUDE.md pra não re-inchar.
#
# O CLAUDE.md guarda só REGRAS/invariantes (é carregado em toda sessão + subagente).
# Histórico de PR/incidente vai pra docs/registro/; procedimento pra docs/runbooks/.
# Tetos GENEROSOS (folga sobre o estado pós-faxina de 2026-06-14, ~75 KB / 9,5k palavras).
# Bytes/palavras são a métrica certa — linhas enganam (um bullet de registro vira 1 linha
# de 10 mil chars). Linha gigante = sinal de que entrou registro que devia ir pra docs/.
set -euo pipefail

f="${1:-CLAUDE.md}"
MAX_BYTES=92160 # 90 KB
MAX_WORDS=12000
MAX_LINE=2000 # chars por linha

[ -f "$f" ] || {
  echo "❌ não achei $f (rode da raiz do repo)" >&2
  exit 2
}

bytes=$(wc -c <"$f")
words=$(wc -w <"$f")
maxline=$(awk '{ if (length > m) { m = length; ln = NR } } END { print m"@"ln }' "$f")
maxlen="${maxline%@*}"
maxln="${maxline#*@}"

fail=0
if [ "$bytes" -gt "$MAX_BYTES" ]; then
  echo "❌ $f: $bytes bytes > teto $MAX_BYTES — mova histórico pra docs/registro/ ou detalhe pra docs/runbooks/"
  fail=1
fi
if [ "$words" -gt "$MAX_WORDS" ]; then
  echo "❌ $f: $words palavras > teto $MAX_WORDS"
  fail=1
fi
if [ "$maxlen" -gt "$MAX_LINE" ]; then
  echo "❌ $f: linha $maxln tem $maxlen chars > teto $MAX_LINE — provável bullet de registro (mova pra docs/registro/)"
  fail=1
fi

if [ "$fail" -eq 0 ]; then
  echo "✅ $f: $bytes bytes / $words palavras / maior linha $maxlen chars — dentro do orçamento (teto ${MAX_BYTES}B / ${MAX_WORDS}w / ${MAX_LINE}c)"
fi
exit "$fail"
