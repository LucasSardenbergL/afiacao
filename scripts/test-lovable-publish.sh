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
    # $F/vira_em: o ar vira depois de N leituras do entry SEM POST (o Publish do vigia, visto de fora)
    if [ -f "$F/vira_em" ]; then
      n=$(cat "$F/vira_em"); if [ "$n" -le 0 ]; then cp "$F/vira" "$F/ar"; else echo $((n - 1)) > "$F/vira_em"; fi
    fi
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
semeia() { rm -rf "${F:?}"/*; echo "$1" > "$F/ar"; echo "$2" > "$F/ws"; echo 202 > "$F/post_code"; echo completed > "$F/dep_status"; }
sem_post() { if grep -q '^POST' "$F/log"; then echo "FALHOU [$CENARIO]: fez POST"; fail=1; fi; }

# --julgar: o tick do vigia local — sem chave e sem tocar a API; PUBLICAR só onde o modo cheio publicaria
julga() { local esp="$1" ver="$2" head="$3" out rc; : > "$F/log"
  out=$(PATH="$BIN:$PATH" LP_FAKE="$F" APP_URL=https://app.test LOVABLE_API_BASE=https://api.test \
    env -u LOVABLE_API_KEY bash "$ALVO" --julgar "$head" 2>&1); rc=$?
  if [ "$rc" != "$esp" ] || ! printf '%s' "$out" | tail -1 | grep -qx "VEREDITO=$ver"; then
    echo "FALHOU [$CENARIO]: esperado rc=$esp $ver, veio rc=$rc"; printf '%s\n' "$out" | sed 's/^/    /'; fail=1; fi
  if grep -q 'api.test' "$F/log"; then echo "FALHOU [$CENARIO]: --julgar tocou a API"; fail=1; fi; }
CENARIO=julgar_publicar; semeia "$BASE" "$FRONT"; julga 0 PUBLICAR "$FRONT"
CENARIO=julgar_retido;   semeia "$BASE" "$FRONT2"; julga 10 RETIDO "$FRONT2"
CENARIO=julgar_ja;       semeia "$FRONT2" "$FRONT2"; julga 0 JA_NO_AR "$FRONT2"

CENARIO=ja_no_ar;      semeia "$FRONT2" "$FRONT2"; roda 0 JA_NO_AR "$FRONT2"; sem_post
CENARIO=publicado;     semeia "$BASE" "$FRONT"; echo "$FRONT" > "$F/vira"; roda 0 PUBLICADO "$FRONT"
CENARIO=retido;        semeia "$BASE" "$FRONT2"; roda 10 RETIDO "$FRONT2"; sem_post
# liberar ANCESTRAL sem migration depois dele vale (o caso real: liberou a main, a main andou 3 min)
CENARIO=liberar_ancestral; semeia "$BASE" "$FRONT2"; echo "$FRONT2" > "$F/vira"
                       LP_LIBERAR_SHA="$MIG" roda 0 PUBLICADO "$FRONT2"
CENARIO=liberar_antigo; semeia "$BASE" "$FRONT2"; LP_LIBERAR_SHA="$FRONT" roda 10 RETIDO "$FRONT2"; sem_post
CENARIO=liberar_curto; semeia "$BASE" "$FRONT2"; LP_LIBERAR_SHA="${FRONT2:0:12}" roda 10 RETIDO "$FRONT2"; sem_post
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

# ── --esperar <sha>: observa o ar, nunca publica nem toca a API ─────────────────────────────────
# espera <rc> <última-linha (regex -x)> <sha> [alvo] — origin/main = FRONT2 aqui (restaurado acima)
espera() { local esp="$1" ult="$2" sha="$3" alvo="${4:-$ALVO}" out rc; : > "$F/log"
  out=$(PATH="$BIN:$PATH" LP_FAKE="$F" APP_URL=https://app.test LOVABLE_API_BASE=https://api.test \
    LP_SLEEP=true LP_ESPERAR_PRAZO=50 LP_ESPERAR_INTERVALO=10 LP_VIGIA_ESTADO="$F/vigia" \
    env -u LOVABLE_API_KEY bash "$alvo" --esperar "$sha" 2>&1); rc=$?; ESP_OUT=$out
  if [ "$rc" = "$esp" ] && printf '%s' "$out" | tail -1 | grep -qxE "$ult"; then
    if grep -qE '^POST|api\.test' "$F/log"; then echo "FALHOU [$CENARIO]: --esperar tocou a API"; fail=1; return 1; fi
    return 0; fi
  echo "FALHOU [$CENARIO]: esperado rc=$esp /$ult/, veio rc=$rc"; printf '%s\n' "$out" | sed 's/^/    /'; fail=1; return 1; }
leituras() { grep -c 'index-AbC123.js' "$F/log"; }
vigia() { mkdir -p "$F/vigia"; }

# ar já contém (ancestralidade, não igualdade): ar=FRONT2 ⊇ FRONT
CENARIO=esperar_ja;      semeia "$FRONT2" x; espera 0 "NO_AR=$FRONT2" "$FRONT"
# passa a conter após N leituras: migration liberada à mão no vigia → espera, o ar vira, sai 0
CENARIO=esperar_vira;    semeia "$BASE" x; vigia; echo "$FRONT2" > "$F/vigia/liberar"
                         echo "$FRONT2" > "$F/vira"; echo 4 > "$F/vira_em"
                         espera 0 "NO_AR=$FRONT2" "$FRONT" \
                           && { [ "$(leituras)" -ge 5 ] || { echo "FALHOU [$CENARIO]: saiu sem esperar ($(leituras) leituras)"; fail=1; }; }
# timeout: liberado, mas o ar nunca vira
CENARIO=esperar_timeout; semeia "$BASE" x; vigia; echo "$FRONT2" > "$F/vigia/liberar"; espera 30 TIMEOUT "$FRONT"
# RETIDO por migration de OUTRO PR no intervalo ar..main (FRONT não tem migration; a main tem)
CENARIO=esperar_retido_mig;  semeia "$BASE" x; espera 10 'RETIDO=migration:supabase/migrations/1_x\.sql' "$FRONT" \
  && { printf '%s' "$ESP_OUT" | grep -qF -- "--liberar $FRONT2" || { echo "FALHOU [$CENARIO]: não imprimiu o comando de liberação da main"; fail=1; }; }
# liberado para um SHA ANTERIOR à migration: segue RETIDO e diz que a liberação é velha
CENARIO=esperar_lib_antiga;  semeia "$BASE" x; vigia; echo "$FRONT" > "$F/vigia/liberar"
                             espera 10 'RETIDO=migration:supabase/migrations/1_x\.sql' "$FRONT" \
  && { printf '%s' "$ESP_OUT" | grep -qF "liberado para SHA antigo ${FRONT:0:8}" || { echo "FALHOU [$CENARIO]: não distinguiu liberação antiga"; fail=1; }; }
# caso real 26/11 08:36: liberou 39ea6374 (a main), a main foi a 8ca02e51 (só front) 2 min depois
CENARIO=esperar_caso_2611;   semeia "$BASE" x; vigia; echo "$MIG" > "$F/vigia/liberar"
                             echo "$FRONT2" > "$F/vira"; echo 4 > "$F/vira_em"; espera 0 "NO_AR=$FRONT2" "$FRONT2"
# só edge: ledger diz não servida → RETIDO; diz servida → espera (o vigia libera) até o prazo
git checkout -q -b edge "$FRONT2"; EDGE=$(c supabase/functions/f/index.ts edge); git checkout -q main
git push -q origin "$EDGE:refs/heads/main" -f 2>/dev/null
CENARIO=esperar_retido_edge; semeia "$MIG" x; vigia; echo 1 > "$F/vigia/pendencias-$EDGE"
                             espera 10 'RETIDO=edge:supabase/functions/f/index\.ts' "$FRONT2"
CENARIO=esperar_edge_servida; semeia "$MIG" x; vigia; echo 0 > "$F/vigia/pendencias-$EDGE"; espera 30 TIMEOUT "$FRONT2"
# main só com inerte além do ar → não haverá Publish: sai 0 sem esperar o prazo
git push -q origin "$DOC:refs/heads/main" -f 2>/dev/null
CENARIO=esperar_inerte;  semeia "$FRONT" x; espera 0 "NADA_A_PUBLICAR=$FRONT" "$DOC"
git push -q origin "$FRONT2:refs/heads/main" -f 2>/dev/null
CENARIO=esperar_fora_main; semeia "$BASE" x; espera 6 'MECANICA=FORA_DA_MAIN:.*' "$EDGE"
CENARIO=esperar_sha_ruim;  semeia "$BASE" x; espera 6 'MECANICA=SHA_NAO_RESOLVE:.*' deadbeef
CENARIO=esperar_ar_fora;   semeia "$BASE" x; touch "$F/fora"; espera 6 'MECANICA=AR_ILEGIVEL:.*' "$FRONT"
# carimbo de um commit que este clone não tem (merge recente): fetch e resolve
# `-b main`: o HEAD do bare segue o init.defaultBranch da máquina (master no CI) — sem isto o r2
# commita num ramo órfão e o push para main é recusado (non-ff)
git clone -q -b main "$base/origin.git" "$base/r2" 2>/dev/null
NOVO=$(cd "$base/r2" && git config user.email t@t && git config user.name t && c src/n.ts novo)
(cd "$base/r2" && git push -q origin HEAD:refs/heads/main 2>/dev/null) \
  || { echo "FALHOU [esperar_fetch]: o push do NOVO para o origin falhou"; fail=1; }
git rev-parse -q --verify "$NOVO^{commit}" >/dev/null && { echo "FALHOU [esperar_fetch]: o clone já tinha o NOVO"; fail=1; }
CENARIO=esperar_fetch;   semeia "$NOVO" x; espera 0 "NO_AR=$NOVO" "$FRONT2"


# ── --decidir: a decisão única (vigia e --esperar), lendo o estado em $F/vigia ────────────────────
# decide <rc> <veredito> <head> [alvo] → DEC_OUT com a saída
decide() { local esp="$1" ver="$2" head="$3" alvo="${4:-$ALVO}" rc; : > "$F/log"
  DEC_OUT=$(PATH="$BIN:$PATH" LP_FAKE="$F" APP_URL=https://app.test LOVABLE_API_BASE=https://api.test \
    LP_ESTADO="$F/vigia" env -u LOVABLE_API_KEY bash "$alvo" --decidir "$head" 2>&1); rc=$?
  if [ "$rc" = "$esp" ] && printf '%s' "$DEC_OUT" | tail -1 | grep -qx "VEREDITO=$ver"; then
    grep -q 'api.test' "$F/log" && { echo "FALHOU [$CENARIO]: --decidir tocou a API"; fail=1; return 1; }; return 0; fi
  echo "FALHOU [$CENARIO]: esperado rc=$esp $ver, veio rc=$rc"; printf '%s\n' "$DEC_OUT" | sed 's/^/    /'; fail=1; return 1; }
tem_dec() { printf '%s' "$DEC_OUT" | grep -qF -- "$1" || { echo "FALHOU [$CENARIO]: faltou '$1'"; printf '%s\n' "$DEC_OUT" | sed 's/^/    /'; fail=1; }; }
sem_dec() { printf '%s' "$DEC_OUT" | grep -qF -- "$1" && { echo "FALHOU [$CENARIO]: não devia ter '$1'"; fail=1; }; return 0; }
# caso real 25/11 23:04: liberou 3bda3e02 (= a main), a main foi a c39f1f5a (só front) 3 min depois
CENARIO=dec_caso_2511;   semeia "$BASE" x; vigia; echo "$MIG" > "$F/vigia/liberar"
                         decide 0 PUBLICAR "$FRONT2" && { tem_dec "LIBERADO=liberar base=${MIG:0:8} ar=${BASE:0:8}"; tem_dec "PISO=$FRONT2"; }
CENARIO=dec_sem_liberar; semeia "$BASE" x; vigia; decide 10 RETIDO "$FRONT2" && { tem_dec "RETIDO=migration:supabase/migrations/1_x.sql"; tem_dec "--liberar $FRONT2"; sem_dec PISO=; }
CENARIO=dec_lib_curto;   semeia "$BASE" x; vigia; echo "${MIG:0:12}" > "$F/vigia/liberar"; decide 10 RETIDO "$FRONT2" && tem_dec "ignorado"
CENARIO=dec_lib_HEAD;    semeia "$BASE" x; vigia; echo HEAD > "$F/vigia/liberar"; decide 10 RETIDO "$FRONT2" && tem_dec "ignorado"
# piso: camadas atestadas numa decisão anterior não re-travam o próximo PR (sem liberar)
CENARIO=dec_piso;        semeia "$BASE" x; vigia; echo "$MIG" > "$F/vigia/piso"; decide 0 PUBLICAR "$FRONT2" && tem_dec "LIBERADO=piso"
CENARIO=dec_piso_fora;   semeia "$BASE" x; vigia; echo "$EDGE" > "$F/vigia/piso"; decide 10 RETIDO "$FRONT2" && tem_dec "não é ancestral"
# só migration + inerte: nada publicável → NADA_A_PUBLICAR (ninguém retido), mas SEM avançar o piso
CENARIO=dec_so_mig;      semeia "$FRONT" x; vigia; decide 0 NADA_A_PUBLICAR "$MIG" && { sem_dec PISO=; tem_dec "camadas pendentes"; }
CENARIO=dec_ja;          semeia "$FRONT2" x; vigia; decide 0 JA_NO_AR "$FRONT2" && tem_dec "PISO=$FRONT2"
# só edge: o cache do ledger com a MESMA validade (15 min) para vigia e --esperar
CENARIO=dec_edge_sem;    semeia "$MIG" x; vigia; decide 11 PRECISA_LEDGER "$EDGE"
CENARIO=dec_edge_0;      semeia "$MIG" x; vigia; echo 0 > "$F/vigia/pendencias-$EDGE"; decide 0 PUBLICAR "$EDGE" && { tem_dec "LIBERADO=ledger"; tem_dec "PISO=$EDGE"; }
CENARIO=dec_edge_1;      semeia "$MIG" x; vigia; echo 1 > "$F/vigia/pendencias-$EDGE"; decide 10 RETIDO "$EDGE" && tem_dec "RETIDO=edge:supabase/functions/f/index.ts"
CENARIO=dec_edge_velho;  semeia "$MIG" x; vigia; echo 0 > "$F/vigia/pendencias-$EDGE"; touch -t 202001010000 "$F/vigia/pendencias-$EDGE"
                         decide 11 PRECISA_LEDGER "$EDGE"
CENARIO=dec_edge_mec;    semeia "$MIG" x; vigia; echo 2 > "$F/vigia/pendencias-$EDGE"; decide 6 MECANICA "$EDGE"
# teste e doc de edge não são camada: só _test.ts/.md em supabase/functions + front → PUBLICAR
git checkout -q -b edgeteste "$FRONT2"; c supabase/functions/f/x_test.ts t >/dev/null; c supabase/functions/f/README.md d >/dev/null
ETESTE=$(c src/t.ts front3); git checkout -q main
CENARIO=julgar_edge_teste; semeia "$FRONT2" x; julga 0 PUBLICAR "$ETESTE"

# ── --liberar <sha>: 40 hex, ancestral da origin/main, gravação atômica, mostra a main medida ─────
libera() { local esp="$1" sha="$2" rc; LIB_OUT=$(PATH="$BIN:$PATH" LP_FAKE="$F" APP_URL=https://app.test LP_ESTADO="$F/vigia" \
    bash "$ALVO" --liberar "$sha" 2>&1); rc=$?
  [ "$rc" = "$esp" ] || { echo "FALHOU [$CENARIO]: --liberar rc=$rc (esperado $esp)"; printf '%s\n' "$LIB_OUT" | sed 's/^/    /'; fail=1; return 1; }; }
git push -q origin "$FRONT2:refs/heads/main" -f 2>/dev/null
CENARIO=liberar_curto_cli; semeia "$BASE" x; vigia; libera 2 "${MIG:0:8}" && [ ! -f "$F/vigia/liberar" ] || { echo "FALHOU [$CENARIO]: aceitou/gravou"; fail=1; }
CENARIO=liberar_HEAD_cli;  semeia "$BASE" x; vigia; libera 2 HEAD && [ ! -f "$F/vigia/liberar" ] || { echo "FALHOU [$CENARIO]: aceitou HEAD"; fail=1; }
CENARIO=liberar_fora_cli;  semeia "$BASE" x; vigia; libera 2 "$EDGE" || true
CENARIO=liberar_ok_cli;    semeia "$BASE" x; vigia
  if libera 0 "$MIG"; then
    [ "$(cat "$F/vigia/liberar")" = "$MIG" ] || { echo "FALHOU [$CENARIO]: conteúdo $(cat "$F/vigia/liberar")"; fail=1; }
    printf '%s' "$LIB_OUT" | grep -qF "main medida agora: ${FRONT2:0:8}" || { echo "FALHOU [$CENARIO]: não mostrou a main medida"; fail=1; }
    printf '%s' "$LIB_OUT" | grep -qF "supabase/migrations/1_x.sql" || { echo "FALHOU [$CENARIO]: não listou a migration coberta"; fail=1; }
    ls "$F/vigia"/liberar.tmp.* >/dev/null 2>&1 && { echo "FALHOU [$CENARIO]: sobrou tmp"; fail=1; }
  fi

# falsificação da decisão, com CONTROLE verde na mesma invocação
sabota_dec() { # <nome> <sed> <semeador> <rc> <veredito> <head>
  local nome="$1" expr="$2" sem="$3" s="$base/sabd-$1.sh"; shift 3
  sed "$expr" "$ALVO" > "$s"
  if cmp -s "$ALVO" "$s"; then echo "FALHOU [sabd-$nome]: a sabotagem não pegou (o sed não casou)"; fail=1; return; fi
  CENARIO="controle-dec-$nome"; "$sem"; decide "$@" || return
  "$sem"; if ( decide "$@" "$s" ) >/dev/null 2>&1; then echo "FALHOU [sabd-$nome]: cópia sabotada ainda passou"; fail=1; fi
}
# shellcheck disable=SC2329
s_lib_mig()  { semeia "$BASE" x; vigia; rm -f "$F/vigia"/*; echo "$MIG" > "$F/vigia/liberar"; }
# shellcheck disable=SC2329
s_piso_mig() { semeia "$BASE" x; vigia; rm -f "$F/vigia"/*; echo "$MIG" > "$F/vigia/piso"; }
# shellcheck disable=SC2329
s_nada()     { semeia "$FRONT2" x; vigia; rm -f "$F/vigia"/*; }
# ancestral → igualdade (o código de antes): o caso real volta a ficar RETIDO
# shellcheck disable=SC2016
sabota_dec ancestral 's/git merge-base --is-ancestor "\$s" "\$HEAD_SHA" 2>\/dev\/null ||/[ "$s" = "$HEAD_SHA" ] ||/' s_lib_mig 0 PUBLICAR "$FRONT2"
# piso ignorado → o próximo PR re-trava
# shellcheck disable=SC2016
sabota_dec piso 's/\[ -s "\$ESTADO\/piso" \] && considera/false \&\& considera/' s_piso_mig 0 PUBLICAR "$FRONT2"
# filtro de teste/doc de edge desligado → RETIDO por *_test.ts
sabota_dec teste_edge "s/^NAO_CAMADA=.*/NAO_CAMADA='^\$'/" s_nada 0 PUBLICAR "$ETESTE"

# Falsificação com CONTROLE verde na MESMA invocação: o cenário passa no alvo real E fica vermelho
# numa cópia sabotada — senão um teste que sempre passa (ou sempre falha) aprovaria tudo.
sabota() { # sabota <nome> <sed> <semeador> <rc> <regex> <sha> — o semeador roda antes de CADA lado
  local nome="$1" expr="$2" sem="$3" s="$base/sab-$1.sh"; shift 3
  sed "$expr" "$ALVO" > "$s"
  if cmp -s "$ALVO" "$s"; then echo "FALHOU [sab-$nome]: a sabotagem não pegou (o sed não casou)"; fail=1; return; fi
  CENARIO="controle-$nome"; "$sem"; espera "$@" || return       # controle: alvo real, verde
  "$sem"; if ( espera "$@" "$s" ) >/dev/null 2>&1; then echo "FALHOU [sab-$nome]: cópia sabotada ainda passou"; fail=1; fi
}
git push -q origin "$FRONT2:refs/heads/main" -f 2>/dev/null
# shellcheck disable=SC2329  # semeadores chamados indiretamente pelo sabota
s_contem() { semeia "$FRONT2" x; }
# shellcheck disable=SC2329
s_retido() { semeia "$BASE" x; }
# shellcheck disable=SC2329
s_vira()   { semeia "$BASE" x; vigia; echo "$FRONT2" > "$F/vigia/liberar"; echo "$FRONT2" > "$F/vira"; echo 4 > "$F/vira_em"; }
# ancestralidade → igualdade: ar=FRONT2 já contém FRONT, mas a cópia não vê
# shellcheck disable=SC2016  # $PEDIDO/$AR/$MIG são LITERAIS do fonte sabotado
sabota ancestral 's/git merge-base --is-ancestor "\$PEDIDO" "\$AR" 2>\/dev\/null \&\& sai 0/[ "$PEDIDO" = "$AR" ] \&\& sai 0/' \
  s_contem 0 "NO_AR=$FRONT2" "$FRONT"
# RETIDO por migration ignorado → a cópia espera até o TIMEOUT
# shellcheck disable=SC2016
sabota retido 's/\[ -n "\$MIG" \] \&\& retido migration "\$MIG"/true/' \
  s_retido 10 'RETIDO=migration:supabase/migrations/1_x\.sql' "$FRONT"
# o ar vira no meio da espera, mas a cópia lê o ar uma vez só → TIMEOUT
# shellcheck disable=SC2016
sabota rele 's/if AR=\$(ar_lido); then/if AR=${AR0:=$(ar_lido)}; then/' s_vira 0 "NO_AR=$FRONT2" "$FRONT"

[ "$fail" = 0 ] && echo "test-lovable-publish: OK"
exit "$fail"
