#!/usr/bin/env bash
# verify-frontend.sh — prova, PELOS BYTES, se uma string-alvo de um commit está no build
# de frontend servido em produção (Lovable). É o Passo 4 da skill lovable-deploy-verify.
#
# Enumerar os chunks tem furos sutis — nenhuma fonte sozinha é completa (validado contra
# produção em 2026-06-18, com 2ª opinião do Codex). Por isso enumera pela UNIÃO de:
#   (A) FECHAMENTO TRANSITIVO do grafo lazy do Vite: index.html + entry + o `__vite__mapDeps`
#       aninhado de CADA chunk, iterando até estabilizar. Pega o 2º nível (lazy-dentro-de-
#       página) que o entry sozinho perde. O entry sozinho dava 260; o closure, 274.
#   (B) PRECACHE do Workbox em /sw.js: o que o app de fato cacheia. MAS globIgnores /
#       maximumFileSizeToCacheInBytes podem omitir chunks grandes (medido: precache=268,
#       faltavam 6 que o closure tinha). Por isso UNIÃO, nunca uma fonte só.
#
# O método ANTIGO (grep de literais `/assets/...js` no entry) retornava 0 — o Vite cita
# os chunks como "assets/x.js" (sem barra, entre aspas). O regex aqui é SEM barra, casando
# os dois formatos, e normaliza com a barra.
#
# Uso:   verify-frontend.sh '<string-literal-unica-do-commit>' [https://app.url]
# Exit:  0 = ALVO presente (no ar) · 1 = ausente (Publish pendente / alvo não-único)
#        2 = enumeração quebrada (formato do bundler/Workbox mudou — NÃO confie no resultado)
set -uo pipefail

ALVO="${1:?uso: verify-frontend.sh '<string-alvo-literal-do-commit>' [url]}"
APP="${2:-https://steu.lovable.app}"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# regex ÚNICO dos chunks (o worker paralelo reusa o MESMO — sem drift). Casa "assets/x.js"
# com e sem barra (o Vite cita sem barra, entre aspas); normaliza sempre COM barra.
RE_CHUNK='assets/[A-Za-z0-9_-]+\.js'
extrai() { grep -oE "$RE_CHUNK" | sed 's|^|/|'; }

PAR="${PAR:-8}"   # curls simultâneos (override via env; macOS bash 3.2 — sem 'wait -n')

# crawl_deps <arquivo-de-chunks>: baixa TODOS os chunks do arquivo EM PARALELO e imprime os
# deps extraídos de cada. Cada worker escreve no SEU arquivo (nome derivado do chunk) -> zero
# intercalação de linhas mesmo com -P alto. Substitui o curl 1-a-1 que dava timeout/exit 143.
crawl_deps() {
  local listfile="$1" wdir
  wdir=$(mktemp -d "$TMP/w.XXXXXX")
  # $1..$4 são posicionais do `sh` FILHO (não do bash pai) — aspas simples de propósito.
  # shellcheck disable=SC2016
  xargs -P "$PAR" -I {} sh -c '
    curl -fsS "$2$1" 2>/dev/null | grep -oE "$4" | sed "s|^|/|" > "$3/$(echo "$1" | tr "/" "_")"
  ' _ {} "$APP" "$wdir" "$RE_CHUNK" < "$listfile"
  cat "$wdir"/* 2>/dev/null
  rm -rf "$wdir"
}

ENTRY=$(curl -fsS "$APP/" 2>/dev/null | grep -oE '/assets/index-[A-Za-z0-9_-]+\.js' | head -1)
[ -n "$ENTRY" ] || { echo "❌ não achei o entry em $APP/ — site fora do ar ou HTML mudou de forma"; exit 2; }
echo "entry: $ENTRY"

# (A) fechamento transitivo
{ curl -fsS "$APP/"; curl -fsS "$APP$ENTRY"; } 2>/dev/null | extrai | sort -u > "$TMP/closure.txt"
cp "$TMP/closure.txt" "$TMP/frontier.txt"
while [ -s "$TMP/frontier.txt" ]; do
  crawl_deps "$TMP/frontier.txt" | sort -u > "$TMP/deps.txt"          # curls do nível em PARALELO
  comm -13 "$TMP/closure.txt" "$TMP/deps.txt" > "$TMP/frontier.txt"   # só os ainda-desconhecidos
  sort -u "$TMP/closure.txt" "$TMP/frontier.txt" -o "$TMP/closure.txt"
done

# (B) precache do Workbox
curl -fsS "$APP/sw.js" 2>/dev/null | extrai | sort -u > "$TMP/precache.txt" || : > "$TMP/precache.txt"

# UNIÃO das duas fontes
sort -u "$TMP/closure.txt" "$TMP/precache.txt" > "$TMP/chunks.txt"
N=$(wc -l < "$TMP/chunks.txt" | tr -d ' ')
_clo=$(wc -l < "$TMP/closure.txt" | tr -d ' '); _pc=$(wc -l < "$TMP/precache.txt" | tr -d ' ')
echo "chunks (closure ∪ precache): $N   [closure=$_clo · precache=$_pc]"
echo "  só-closure (servidos fora do precache): $(comm -23 "$TMP/closure.txt" "$TMP/precache.txt" | wc -l | tr -d ' ')  ·  só-precache (órfãos do crawl): $(comm -13 "$TMP/closure.txt" "$TMP/precache.txt" | wc -l | tr -d ' ')"

# GUARD: o método antigo dava 0. Contagem 0/1 = enumeração quebrada — não conclua nada.
if [ "$N" -lt 2 ]; then echo "❌ enumeração suspeita ($N chunks) — formato do bundler/Workbox mudou; NÃO conclua 'não está no ar'"; exit 2; fi

# grep da string-alvo em TODOS os chunks da união, EM PARALELO com HALT-ON-HIT: o 1º worker
# que casa faz exit 255 -> o xargs para de disparar novos (os em-voo terminam). O stdout traz
# o(s) chunk(s) que casaram; sem match em nenhum, o xargs varre tudo e o stdout fica vazio.
# shellcheck disable=SC2016  # $1..$3 são do `sh` FILHO — aspas simples de propósito
HIT=$(xargs -P "$PAR" -I {} sh -c '
  curl -fsS "$2$1" 2>/dev/null | grep -q -- "$3" && { echo "$1"; exit 255; }
  exit 0
' _ {} "$APP" "$ALVO" < "$TMP/chunks.txt" 2>/dev/null)

if [ -n "$HIT" ]; then
  printf '%s\n' "$HIT" | while read -r c; do [ -n "$c" ] && echo "✅ ALVO em $c"; done
  echo "→ no ar ✓ (entry $ENTRY)"; exit 0
fi
echo "→ ❌ ALVO ausente nos $N chunks: Publish pendente, OU o ALVO não é literal/único no bundle"
exit 1
