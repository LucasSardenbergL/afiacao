#!/usr/bin/env bash
# test-lovable-publish.sh — TDD do scripts/lovable-publish.sh (repo git descartável + curl FALSO).
#
# O curl falso (PATH) serve o ar (`steu`), a API do Lovable e grava cada chamada em $F/log. O
# estado de cada cenário mora em arquivos de $F: ar (SHA servido), ws (latest_commit_sha),
# post_code, dep_status, vira (SHA que o ar passa a servir depois do POST), atraso (CDN lento).
#
# Controle na MESMA invocação: o cenário RETIDO roda também contra uma CÓPIA com o gate de ordem
# sabotado e exige que ela NÃO retenha — sem isso, um teste que sempre "retém" aprovaria tudo.
#
# Uso: bash scripts/test-lovable-publish.sh   (exit 0 = tudo verde)
set -u

here="$(cd "$(dirname "$0")" && pwd)"
ALVO="$here/lovable-publish.sh"
base="$(mktemp -d)"
trap 'rm -rf "$base"' EXIT
F="$base/estado"; BIN="$base/bin"; mkdir -p "$F" "$BIN"
fail=0

cat > "$BIN/curl" <<'FAKE'
#!/usr/bin/env bash
F="$LP_FAKE"; out=""; fmt=""; met=GET; url=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift ;; -w) fmt="$2"; shift ;; -X) met="$2"; shift ;;
    -H|--data|--max-time) shift ;; -*) ;; *) url="$1" ;;
  esac; shift
done
echo "$met $url" >> "$F/log"
emite() { if [ -n "$out" ]; then printf '%s' "$2" > "$out"; else printf '%s' "$2"; fi; [ -n "$fmt" ] && printf '%s' "$1"; return 0; }
case "$url" in
  https://app.test/) [ -f "$F/fora" ] && exit 22; emite 200 '<script src="/assets/index-AbC123.js"></script>' ;;
  https://app.test/assets/index-AbC123.js)
    if [ -f "$F/atraso" ] && grep -q '^POST' "$F/log"; then
      n=$(cat "$F/atraso"); if [ "$n" -le 0 ]; then cp "$F/vira" "$F/ar"; else echo $((n - 1)) > "$F/atraso"; fi
    fi
    if [ -f "$F/sem_carimbo" ]; then emite 200 'x=1'; else emite 200 "window.__BUILD_SHA__=\"$(cut -c1-8 "$F/ar")\";"; fi ;;
  https://api.test/v1/projects/P) emite 200 "{\"latest_commit_sha\":\"$(cat "$F/ws")\"}" ;;
  https://api.test/v1/projects/P/publish)
    c=$(cat "$F/post_code")
    # com $F/atraso o ar só vira depois de N leituras do entry (CDN lento); sem ele, vira já no POST
    [ "$c" = 202 ] && [ -f "$F/vira" ] && [ ! -f "$F/atraso" ] && cp "$F/vira" "$F/ar"
    if [ "$c" = 202 ]; then emite 202 '{"id":"dep1","status":"running"}'; else emite "$c" '{"error":"x"}'; fi ;;
  https://api.test/v1/projects/P/publish/dep1)
    emite 200 "{\"id\":\"dep1\",\"status\":\"$(cat "$F/dep_status")\",\"error_message\":\"boom\",\"error_class\":\"code\"}" ;;
  *) [ -n "$fmt" ] && printf 000; exit 7 ;;
esac
FAKE
chmod +x "$BIN/curl"

# repo: origin bare + clone; commits: base → front (src/) → mig (migration) → doc (docs/)
cd "$base" && git init -q --bare origin.git && git clone -q origin.git r 2>/dev/null && cd r || exit 1
git config user.email t@t && git config user.name t && git checkout -q -b main
c() { mkdir -p "$(dirname "$1")"; echo "$RANDOM" >> "$1"; git add -A; git commit -qm "$2"; git rev-parse HEAD; }
BASE=$(c src/a.ts base); FRONT=$(c src/b.ts front); MIG=$(c supabase/migrations/1_x.sql mig)
FRONT2=$(c src/c.ts front2); git push -q origin main 2>/dev/null

# roda <rc-esperado> <veredito> <head> [alvo] — com o estado de $F já semeado
roda() {
  local esp="$1" ver="$2" head="$3" alvo="${4:-$ALVO}" out rc
  : > "$F/log"
  out=$(PATH="$BIN:$PATH" LP_FAKE="$F" LOVABLE_API_KEY=k LOVABLE_PROJECT_ID=P APP_URL=https://app.test \
    LOVABLE_API_BASE=https://api.test LP_SLEEP=true LP_ESPERA_SYNC=20 LP_ESPERA_DEPLOY=6 LP_ESPERA_AR=20 \
    bash "$alvo" "$head" 2>&1); rc=$?
  if [ "$rc" = "$esp" ] && printf '%s' "$out" | tail -1 | grep -qx "VEREDITO=$ver"; then return 0; fi
  echo "FALHOU [$CENARIO]: esperado rc=$esp $ver, veio rc=$rc"; printf '%s\n' "$out" | sed 's/^/    /'; fail=1; return 1
}
semeia() { rm -f "$F"/*; echo "$1" > "$F/ar"; echo "$2" > "$F/ws"; echo 202 > "$F/post_code"; echo completed > "$F/dep_status"; }
sem_post() { if grep -q '^POST' "$F/log"; then echo "FALHOU [$CENARIO]: fez POST"; fail=1; fi; }

CENARIO=ja_no_ar;      semeia "$FRONT2" "$FRONT2"; roda 0 JA_NO_AR "$FRONT2"; sem_post
CENARIO=publicado;     semeia "$BASE" "$FRONT"; echo "$FRONT" > "$F/vira"; roda 0 PUBLICADO "$FRONT"
CENARIO=retido;        semeia "$BASE" "$FRONT2"; roda 10 RETIDO "$FRONT2"; sem_post
CENARIO=liberar_outro; semeia "$BASE" "$FRONT2"; LP_LIBERAR_SHA="$MIG" roda 10 RETIDO "$FRONT2"; sem_post
CENARIO=liberado;      semeia "$BASE" "$FRONT2"; echo "$FRONT2" > "$F/vira"
                       LP_LIBERAR_SHA="$FRONT2" roda 0 PUBLICADO "$FRONT2"
CENARIO=nada;          git checkout -q -b doc "$FRONT"; DOC=$(c docs/x.md doc); git checkout -q main
                       semeia "$FRONT" "$DOC"; roda 0 NADA_A_PUBLICAR "$DOC"; sem_post
CENARIO=cdn_lento;     semeia "$BASE" "$FRONT"; echo "$FRONT" > "$F/vira"; echo 2 > "$F/atraso"; roda 0 PUBLICADO "$FRONT"
CENARIO=post_503;      semeia "$BASE" "$FRONT"; echo 503 > "$F/post_code"; roda 20 AMBIGUO "$FRONT"
CENARIO=post_403;      semeia "$BASE" "$FRONT"; echo 403 > "$F/post_code"; roda 21 FALHOU "$FRONT"
CENARIO=dep_error;     semeia "$BASE" "$FRONT"; echo error > "$F/dep_status"; roda 21 FALHOU "$FRONT"
CENARIO=dep_preso;     semeia "$BASE" "$FRONT"; echo running > "$F/dep_status"; roda 20 AMBIGUO "$FRONT"
CENARIO=ar_parado;     semeia "$BASE" "$FRONT"; roda 21 FALHOU "$FRONT"
CENARIO=adiante_sujo;  semeia "$BASE" "$FRONT"; echo "$FRONT2" > "$F/vira"; roda 22 PUBLICOU_NAO_AVALIADO "$FRONT"
CENARIO=adiante_limpo; semeia "$BASE" "$MIG"; echo "$FRONT2" > "$F/vira"; LP_LIBERAR_SHA="$MIG" roda 0 PUBLICADO_ADIANTE "$MIG"
CENARIO=sem_carimbo;   semeia "$BASE" "$FRONT"; touch "$F/sem_carimbo"; roda 6 MECANICA "$FRONT"; sem_post
CENARIO=site_fora;     semeia "$BASE" "$FRONT"; touch "$F/fora"; roda 6 MECANICA "$FRONT"; sem_post
CENARIO=nao_ancestral; semeia "$FRONT2" "$FRONT"; roda 6 MECANICA "$FRONT"; sem_post
CENARIO=superado;      semeia "$BASE" "$BASE"; roda 0 SUPERADO "$FRONT"; sem_post
CENARIO=sync_preso;    git push -q origin "$FRONT:refs/heads/main" -f 2>/dev/null
                       semeia "$BASE" "$BASE"; roda 6 MECANICA "$FRONT"; sem_post
                       git push -q origin "$FRONT2:refs/heads/main" -f 2>/dev/null
CENARIO=sem_chave;     semeia "$BASE" "$FRONT"
                       out=$(PATH="$BIN:$PATH" LP_FAKE="$F" bash "$ALVO" "$FRONT" 2>&1); rc=$?
                       [ "$rc" = 6 ] || { echo "FALHOU [$CENARIO]: rc=$rc"; fail=1; }

# Controle: gate de ordem sabotado ⇒ o cenário RETIDO NÃO pode reter.
CENARIO=controle_sabotado
sab="$base/sabotado.sh"
# shellcheck disable=SC2016  # o `$PEND` é LITERAL do fonte sabotado, não para expandir aqui
sed 's/^if \[ -n "\$PEND" \]; then$/if false; then/' "$ALVO" > "$sab"
if cmp -s "$ALVO" "$sab"; then echo "FALHOU [$CENARIO]: a sabotagem não pegou (o sed não casou)"; fail=1
else
  semeia "$BASE" "$FRONT2"; echo "$FRONT2" > "$F/vira"
  # subshell: o `fail=1` que o roda grava ao divergir não pode vazar para o placar deste controle
  if ( roda 10 RETIDO "$FRONT2" "$sab" ) >/dev/null 2>&1; then echo "FALHOU [$CENARIO]: sabotado ainda reteve"; fail=1; fi
fi

[ "$fail" = 0 ] && echo "test-lovable-publish: OK"
exit "$fail"
