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
# O CONTROLE NEGATIVO da sonda era o outro recado — e recado depende de alguém lembrar, que é
# exatamente como a armadilha acima passou. Um `exit 0` sozinho não distingue "está no ar" de "o
# script dá verde pra tudo", então quando o ALVO casa o script AUTO-AUDITA: reexecuta o MESMO
# pipeline (curl+grep+captura) no MESMO chunk que acabou de casar, com uma string aleatória
# nascida neste processo. Se ela "casar", o verde não vale nada -> exit 2.
#   Por que UM chunk e não uma 2ª varredura inteira: discriminar é propriedade do par
#   (padrão, grep), não do chunk — repetir em 334 chunks é redundância, não informação nova.
#   Medido em prod 2026-08-24: varredura completa = 334 req / 18s; este controle = 1 req / 0,14s.
#
# O CONTROLE POSITIVO é o irmão dele no ramo AUSENTE, onde o risco se inverte: ali o script AFIRMA
# "Publish pendente", e uma sonda CEGA produz a MESMA saída — se os chunks passam a falhar (CDN 403
# em /assets/*, rate limit, DNS) enquanto o index.html ainda responde, a varredura vem vazia por
# não ter enxergado nada, e o operador pede um Publish que não era necessário. Ausência de sinal
# não é sinal. Então, antes de afirmar ausência, uma AGULHA derivada do corpo do entry é procurada
# NO entry pelo MESMO varre(). Não é circular: o corpo (baixado lá no closure) só ESCOLHE a agulha;
# o veredito sai de um curl+grep NOVO, no momento da conclusão — se a rede caiu no meio da
# varredura, é esse request que denuncia. Falhou -> SONDA_CEGA + exit 2, nunca exit 1. +1 request.
#
# Uso:   verify-frontend.sh [--pai <sha>] [--novo <sha>] '<string-literal-unica-do-commit>' [https://app.url]
#        --pai  <sha>  commit ANTERIOR ao PR: exige 0 ocorrência da sentinela nele (exclusividade)
#        --novo <sha>  commit que INTRODUZIU a sentinela (default HEAD): exige >= 1 ocorrência
# Exit:  0 = ALVO presente (no ar) E o controle negativo passou · 1 = ausente (Publish pendente /
#            alvo não-único) E o controle positivo provou que a sonda ainda enxergava
#        2 = a MECÂNICA da sonda não é confiável — NÃO confie no resultado. Três causas: a
#            enumeração quebrou (formato do bundler/Workbox mudou); o casamento não discrimina
#            (SONDA_NAO_DISCRIMINA, ramo do hit); ou a sonda não enxerga nada (SONDA_CEGA, ramo
#            ausente). Conserte a sonda antes de concluir qualquer coisa.
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

# ---- string do CONTROLE NEGATIVO — gerada ANTES de tocar a rede, como o guard --pai ----
# Hex puro: o grep dos chunks é BRE (sem -F), então um metacaractere aqui poderia mudar a
# semântica do controle. Aleatória e nascida neste processo: "não casou" só tem uma explicação
# possível, e é a que queremos provar. Sonda de guard é fail-CLOSED — sem entropia, sem veredito.
_ent=$(head -c 32 /dev/urandom 2>/dev/null | od -An -tx1 2>/dev/null | tr -dc 'a-f0-9')
case "$_ent" in *[!0-9a-f]* | '') _ent="" ;; esac
[ "${#_ent}" -ge 24 ] || recusa \
  "❌ [controle] ENTROPIA_INDISPONIVEL — não consegui gerar a string do controle negativo (/dev/urandom + od + tr)." \
  "   Sem ela um verde não seria auditável, e verde não-auditável é o falso positivo que ENCERRA a verificação."
CONTROLE="controle_negativo_${_ent}"

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

# (A) fechamento transitivo. O CORPO do entry fica SALVO: é dele que sai a agulha do controle
# positivo do ramo ausente, e o download já acontecia aqui — nesta etapa o controle custa 0
# request a mais. Em disco, não em variável: o entry real passa de 200KB.
curl -fsS "$APP$ENTRY" 2>/dev/null > "$TMP/entry.js"
{ curl -fsS "$APP/" 2>/dev/null; cat "$TMP/entry.js"; } | extrai | sort -u > "$TMP/closure.txt"
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

# varre <arquivo-de-chunks> <padrão>: grepa o padrão em TODOS os chunks do arquivo, EM PARALELO
# e com HALT-ON-HIT — o 1º worker que casa faz exit 255 -> o xargs para de disparar novos (os
# em-voo terminam). Imprime o(s) chunk(s) que casaram; sem match, varre tudo e imprime nada.
# É o ÚNICO caminho de casamento do script: veredito e controle negativo passam pelos MESMOS
# curl+grep+captura, senão o controle não estaria auditando o que produz o veredito.
varre() {
  # $1..$3 são do `sh` FILHO (não do bash pai) — aspas simples de propósito.
  # shellcheck disable=SC2016
  xargs -P "$PAR" -I {} sh -c '
    curl -fsS "$2$1" 2>/dev/null | grep -q -- "$3" && { echo "$1"; exit 255; }
    exit 0
  ' _ {} "$APP" "$2" < "$1" 2>/dev/null
}

HIT=$(varre "$TMP/chunks.txt" "$ALVO")

if [ -n "$HIT" ]; then
  printf '%s\n' "$HIT" | while read -r c; do [ -n "$c" ] && echo "✅ ALVO em $c"; done

  # ---- CONTROLE NEGATIVO (automático neste ramo, +1 request) ----
  # O ramo do hit é o perigoso: falso positivo ENCERRA a verificação. Aqui o mesmo pipeline
  # procura, no MESMO chunk que acabou de casar, uma string que não pode estar lá. Casar =
  # o mecanismo não discrimina, e o "✅ ALVO" acima é ruído com cara de prova.
  _c1=$(printf '%s\n' "$HIT" | head -1)
  printf '%s\n' "$_c1" > "$TMP/controle.txt"
  if [ -n "$(varre "$TMP/controle.txt" "$CONTROLE")" ]; then
    printf '%s\n' \
      "❌ [controle] SONDA_NAO_DISCRIMINA — o MESMO grep 'achou' $CONTROLE em $_c1." \
      "   Essa string é aleatória e nasceu neste processo: casá-la é impossível para um mecanismo" \
      "   que funciona. Logo o ✅ acima NÃO é evidência de nada — a sonda está dando verde pra" \
      "   tudo (grep/curl/pipeline degradados). Conserte a sonda ANTES de concluir sobre o deploy." >&2
    exit 2
  fi
  echo "✓ CONTROLE_NEGATIVO_OK — $_c1 não casa $CONTROLE (a sonda sabe dizer não)"
  echo "→ no ar ✓ (entry $ENTRY)"; exit 0
fi
# ---- CONTROLE POSITIVO (automático neste ramo, +1 request) ----
# Roda ANTES de imprimir o veredito, de propósito: se a sonda está cega o script não deve nem
# ENUNCIAR "ausente" — a frase é uma afirmação sobre o mundo, e ele não teria olhado pra ele.
_cego=""
# Fallback do SPA / página de erro com 200 passa batido pelo -f do curl: o corpo VEM, só não é o
# chunk. Aí a agulha nasceria do próprio fallback e casaria em si mesma — verde por CEGUEIRA.
case "$(head -c 512 "$TMP/entry.js" | tr -d '[:space:]' | cut -c1)" in
  '<') _cego="ENTRY_NAO_E_JS — $ENTRY respondeu HTML (fallback do SPA / erro com 200), não JavaScript" ;;
esac
# Agulha = o MAIOR token [A-Za-z0-9_] do corpo. DERIVADA, nunca fixa — string fixa do bundle
# quebra no build seguinte e viraria exit 2 espúrio. Alfanumérica porque o grep dos chunks é BRE:
# metacaractere aqui mudaria a semântica do controle, mesma razão do hex puro no negativo.
_agulha=$(tr -c 'A-Za-z0-9_' '\n' < "$TMP/entry.js" | awk '{ if (length($0) > length(m)) m = $0 } END { print m }')
if [ -z "$_cego" ] && [ "${#_agulha}" -lt 12 ]; then
  _cego="AGULHA_INDISPONIVEL — o corpo de $ENTRY ($(wc -c < "$TMP/entry.js" | tr -d ' ') bytes) não deu token de 12+ caracteres"
fi
# EXIBIÇÃO truncada (o grep segue usando a agulha INTEIRA): medido contra prod em 2026-08-25, o
# maior token do entry é o payload da anon key do Supabase — pública por desenho, ela VAI no
# bundle, mas 200+ chars com cara de credencial não têm por que entrar na transcrição a cada run.
_agulha_vis="$_agulha"
[ "${#_agulha}" -le 20 ] || _agulha_vis="$(printf '%.8s' "$_agulha")...(${#_agulha} chars)"
if [ -z "$_cego" ]; then
  printf '%s\n' "$ENTRY" > "$TMP/controle_positivo.txt"
  [ -n "$(varre "$TMP/controle_positivo.txt" "$_agulha")" ] || \
    _cego="AGULHA_NAO_CASOU — '$_agulha_vis' saiu do corpo de $ENTRY e o mesmo curl+grep não a acha lá"
fi
if [ -n "$_cego" ]; then
  printf '%s\n' \
    "❌ [controle] SONDA_CEGA: $_cego" \
    "   Logo NÃO dá pra afirmar 'ausente': varredura vazia por 'nenhum chunk casou' e por 'nenhum" \
    "   chunk RESPONDEU' são a mesma saída, e esta é a segunda. Publish pendente segue possível — só" \
    "   não está provado. Conserte a sonda (CDN/rede/DNS/formato) ANTES de pedir outro Publish." >&2
  exit 2
fi
echo "✓ CONTROLE_POSITIVO_OK — $ENTRY ainda devolve bytes e o mesmo grep acha '$_agulha_vis' neles"

echo "→ ❌ ALVO ausente nos $N chunks: Publish pendente, OU o ALVO não é literal/único no bundle"
echo "   CONTROLE_NEGATIVO_NAO_SE_APLICA: ele audita o falso POSITIVO, e este ramo é o outro — aqui"
echo "   o risco é o falso NEGATIVO (sonda cega lê idêntico a 'Publish pendente'), e quem o cobre é"
echo "   o CONTROLE_POSITIVO acima."
exit 1
