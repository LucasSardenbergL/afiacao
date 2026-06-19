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

# extrai caminhos de chunk de qualquer corpo (index.html, chunk JS ou sw.js), normalizando
extrai() { grep -oE 'assets/[A-Za-z0-9_-]+\.js' | sed 's|^|/|'; }

ENTRY=$(curl -fsS "$APP/" 2>/dev/null | grep -oE '/assets/index-[A-Za-z0-9_-]+\.js' | head -1)
[ -n "$ENTRY" ] || { echo "❌ não achei o entry em $APP/ — site fora do ar ou HTML mudou de forma"; exit 2; }
echo "entry: $ENTRY"

# (A) fechamento transitivo
{ curl -fsS "$APP/"; curl -fsS "$APP$ENTRY"; } 2>/dev/null | extrai | sort -u > "$TMP/closure.txt"
cp "$TMP/closure.txt" "$TMP/frontier.txt"
while [ -s "$TMP/frontier.txt" ]; do
  while read -r c; do curl -fsS "$APP$c" 2>/dev/null; done < "$TMP/frontier.txt" | extrai | sort -u > "$TMP/deps.txt"
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

# grep da string-alvo em TODOS os chunks da união
found=0
while read -r c; do
  curl -fsS "$APP$c" 2>/dev/null | grep -q -- "$ALVO" && { echo "✅ ALVO em $c"; found=1; }
done < "$TMP/chunks.txt"

if [ "$found" = 1 ]; then echo "→ no ar ✓ (entry $ENTRY)"; exit 0; fi
echo "→ ❌ ALVO ausente nos $N chunks: Publish pendente, OU o ALVO não é literal/único no bundle"
exit 1
