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
# A ESCOLHA da sentinela é o outro furo, e o pior deles: o script acha os bytes de QUALQUER
# string presente no bundle — inclusive uma que já estava lá ANTES do PR que se verifica. Verde
# assim confirma um Publish que talvez não tenha acontecido, e falso positivo ENCERRA a
# verificação (o falso negativo ao menos a prolonga). Por isso `--pai <sha>`: prova, no git e
# antes de tocar a rede, que a sentinela é EXCLUSIVA do PR. Mordido em 2026-08-24 no #1949
# (`visita_tentativa` era do #1945, mesmo arquivo, publicado horas antes).
#
# Uso:   verify-frontend.sh [--pai <sha>] [--novo <sha>] '<string-literal-unica-do-commit>' [https://app.url]
#        --pai  <sha>  commit ANTERIOR ao PR: exige 0 ocorrência da sentinela nele (exclusividade)
#        --novo <sha>  commit que INTRODUZIU a sentinela (default HEAD): exige >= 1 ocorrência
# Exit:  0 = ALVO presente (no ar) · 1 = ausente (Publish pendente / alvo não-único)
#        2 = enumeração quebrada (formato do bundler/Workbox mudou — NÃO confie no resultado)
#        3 = o script se RECUSA a dar veredito: uso inválido, ou a prova de exclusividade
#            falhou/não pôde ser feita. NUNCA é uma afirmação sobre o deploy. Fail-CLOSED de
#            propósito: guard que degrada para "não provei" vira guard que não guarda nada.
set -uo pipefail

recusa() { printf '%s\n' "$@" >&2; exit 3; }

PAI=""; NOVO="HEAD"; PAI_SET=0; ALVO=""; ALVO_SET=0; APP=""
while [ $# -gt 0 ]; do
  case "$1" in
    --pai)  [ $# -ge 2 ] || recusa "❌ [--pai] USO_INVALIDO — --pai exige <sha>"
            PAI_SET=1; PAI="$2"; shift 2 ;;
    --novo) [ $# -ge 2 ] || recusa "❌ [--pai] USO_INVALIDO — --novo exige <sha>"
            NOVO="$2"; shift 2 ;;
    *)      if [ "$ALVO_SET" = 0 ]; then ALVO="$1"; ALVO_SET=1; else APP="$1"; fi; shift ;;
  esac
done
[ "$ALVO_SET" = 1 ] && [ -n "$ALVO" ] || recusa "uso: verify-frontend.sh [--pai <sha>] '<string-alvo-literal-do-commit>' [url]"
APP="${APP:-https://steu.lovable.app}"

# ---- guard de EXCLUSIVIDADE da sentinela (roda ANTES de qualquer curl) ----
if [ "$PAI_SET" = 1 ]; then
  [ -n "$PAI" ] || recusa "❌ [--pai] USO_INVALIDO — --pai exige um <sha> não-vazio"
  # `command -v git` NÃO basta: presente-porém-quebrado esvazia o guard igual. Exigimos resposta
  # POSITIVA de cada consulta — sem repo, sem sha resolvido, sem veredito.
  _topo=$(git rev-parse --show-toplevel 2>/dev/null) || _topo=""
  [ -n "$_topo" ] || recusa "❌ [--pai] GIT_INDISPONIVEL — 'git rev-parse --show-toplevel' não respondeu (fora de um repositório? git quebrado?). Rode do worktree do PR."
  _sha_pai=$(git rev-parse --verify --quiet "$PAI^{commit}" 2>/dev/null) || _sha_pai=""
  [ -n "$_sha_pai" ] || recusa "❌ [--pai] SHA_NAO_RESOLVIDO — '$PAI' não é um commit deste repositório"
  _sha_novo=$(git rev-parse --verify --quiet "$NOVO^{commit}" 2>/dev/null) || _sha_novo=""
  [ -n "$_sha_novo" ] || recusa "❌ [--pai] SHA_NAO_RESOLVIDO — '$NOVO' (--novo) não é um commit deste repositório"

  # LADO POSITIVO primeiro: sem ele o zero no pai é AUSÊNCIA DE DADO (sha ou pathspec errado),
  # não prova de novidade. Mesma semântica de casamento do grep dos chunks (BRE, sem -F).
  _n_novo=$(git grep -c -e "$ALVO" "$_sha_novo" -- src/ 2>/dev/null | wc -l | tr -d ' ')
  [ "$_n_novo" != 0 ] || recusa \
    "❌ [--pai] SENTINELA_AUSENTE_NO_COMMIT_NOVO — a sentinela não aparece em src/ nem no commit ${NOVO} ($_sha_novo)." \
    "   O 0 no pai NÃO vale nada aqui: isso é sha/pathspec errado, ou string não-literal (minificada, comentário, template)."
  _n_pai=$(git grep -c -e "$ALVO" "$_sha_pai" -- src/ 2>/dev/null | wc -l | tr -d ' ')
  if [ "$_n_pai" -ne 0 ]; then
    printf '%s\n' "❌ [--pai] SENTINELA_NAO_EXCLUSIVA — já existia em ${PAI} ($_sha_pai), em $_n_pai arquivo(s) de src/:" >&2
    git grep -c -e "$ALVO" "$_sha_pai" -- src/ 2>/dev/null | sed 's/^/     /' >&2
    recusa "   Um verde com ela confirmaria bytes de um PR ANTERIOR, não este Publish. Escolha uma sentinela introduzida por ESTE PR."
  fi
  echo "✓ sentinela exclusiva: 0 ocorrências em $PAI · $_n_novo arquivo(s) em $NOVO (pathspec src/)"
else
  echo "⚠️  EXCLUSIVIDADE_NAO_PROVADA — sem --pai <sha-do-commit-anterior>: se a sentinela já existia antes deste PR, o verde abaixo é de um Publish anterior"
fi
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
