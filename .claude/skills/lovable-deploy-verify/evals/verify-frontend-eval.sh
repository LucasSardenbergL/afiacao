#!/usr/bin/env bash
# verify-frontend-eval.sh — harness LOCAL e DETERMINÍSTICO do Passo 4 (verify-frontend.sh).
#
# Por que existe: a prova-por-bytes varre ~274 chunks contra prod — lento e FLAKY (uma sessão
# rendeu 4 timeouts + 4 exit 143). Isso não serve de rede de regressão pra mexer no script
# (paralelismo, halt-on-hit): uma regressão sutil na ENUMERAÇÃO (perder o 2º nível do closure,
# ou a fonte precache da UNIÃO) passaria despercebida contra prod. Aqui subimos um mini-bundle
# fake via http.server e exercitamos a enumeração + os 3 exit codes SEM tocar a rede.
#
# O fixture reproduz as duas armadilhas que a UNIÃO existe pra cobrir (ver SKILL.md Passo 4):
#   - lazy-dentro-de-página: o alvo `deep` só é alcançável pelo FECHAMENTO TRANSITIVO
#     (index -> PageA -> deep). Se o crawl parar no 1º nível, some.
#   - órfão do crawl: o alvo `orphan` só existe no PRECACHE do /sw.js, fora do closure.
#     Se a fonte precache da UNIÃO cair, some.
#
# Uso:   bash verify-frontend-eval.sh            # roda os casos (exit 0 = todos ok)
#        bash verify-frontend-eval.sh --falsify  # sabota o script e EXIGE vermelho (dente)
set -uo pipefail
cd "$(dirname "$0")" || exit 2

SCRIPT_REL="../scripts/verify-frontend.sh"
FALSIFY=0
[ "${1:-}" = "--falsify" ] && FALSIFY=1

FIX=$(mktemp -d)
PORTFILE=$(mktemp)
SRV=""
trap 'rm -rf "$FIX" "$PORTFILE"; [ -n "$SRV" ] && kill "$SRV" 2>/dev/null' EXIT

# ---- mini-bundle fake (formato Vite: mapDeps cita "assets/x.js" sem barra, entre aspas) ----
mkdir -p "$FIX/site/assets" "$FIX/site-broken"

cat > "$FIX/site/index.html" <<'HTML'
<!doctype html><html><head>
<script type="module" crossorigin src="/assets/index-AAA111.js"></script>
</head><body></body></html>
HTML

# entry: lista o 1º nível (PageA, PageB) via mapDeps
cat > "$FIX/site/assets/index-AAA111.js" <<'JS'
const __vite__mapDeps=(i)=>i.map(i=>d[i]);
const d=["assets/PageA-BBB222.js","assets/PageB-CCC333.js"];
console.log("entry");
JS

# PageA: guarda o mapDeps do 2º nível (lazy-dentro-de-página) — o entry sozinho perde isto
cat > "$FIX/site/assets/PageA-BBB222.js" <<'JS'
__vite__mapDeps(["assets/deep-DDD444.js"]);
JS

# PageB: folha do 1º nível, sem deps — carrega um marcador renderizado
cat > "$FIX/site/assets/PageB-CCC333.js" <<'JS'
export const b="PAGEB_MARKER";
JS

# deep: alvo SÓ alcançável pelo fechamento transitivo de 2º nível
cat > "$FIX/site/assets/deep-DDD444.js" <<'JS'
export const s="SENTINELA_DEEP_XYZ";
JS

# orphan: alvo que só vive no PRECACHE do Workbox (fora do closure do crawl)
cat > "$FIX/site/assets/orphan-EEE555.js" <<'JS'
export const o="ORPHAN_MARKER";
JS

# sw.js: precache lista o entry + o órfão (omite os demais, como o Workbox real via globIgnores)
cat > "$FIX/site/sw.js" <<'JS'
self.__WB_MANIFEST=[{"url":"/assets/index-AAA111.js"},{"url":"/assets/orphan-EEE555.js"}];
JS

# site-broken: HTML sem entry /assets/index-*.js -> enumeração quebrada (exit 2)
cat > "$FIX/site-broken/index.html" <<'HTML'
<!doctype html><html><body><h1>sem entry aqui</h1></body></html>
HTML

# ---- http.server em porta efêmera (não depende de porta fixa livre) ----
python3 -c '
import http.server, socketserver, sys, os
os.chdir(sys.argv[1])
H = http.server.SimpleHTTPRequestHandler
H.log_message = lambda *a, **k: None
with socketserver.TCPServer(("127.0.0.1", 0), H) as s:
    sys.stdout.write(str(s.server_address[1]) + "\n"); sys.stdout.flush()
    s.serve_forever()
' "$FIX" > "$PORTFILE" 2>/dev/null &
SRV=$!

PORT=""
for _ in $(seq 1 100); do
  PORT=$(head -1 "$PORTFILE" 2>/dev/null | tr -d '[:space:]')
  [ -n "$PORT" ] && break
  sleep 0.05
done
[ -n "$PORT" ] || { echo "❌ servidor de fixtures não subiu"; exit 2; }
BASE="http://127.0.0.1:$PORT"

PASS=0; FAIL=0

# run_case: descr, url, alvo, exit_esperado, [substring_esperada_na_saída]
run_case() {
  local descr="$1" url="$2" alvo="$3" exp="$4" want="${5:-}" out got ok=1
  out=$(bash "$SCRIPT_REL" "$alvo" "$url" 2>&1); got=$?
  [ "$got" = "$exp" ] || ok=0
  if [ -n "$want" ]; then printf '%s' "$out" | grep -q -- "$want" || ok=0; fi
  if [ "$ok" = 1 ]; then
    printf '  [ok ] %s (exit %s)\n' "$descr" "$got"; PASS=$((PASS+1))
  else
    printf '  [XX ] %s (esperado exit %s%s, obtido exit %s)\n' \
      "$descr" "$exp" "${want:+ + \"$want\"}" "$got"; FAIL=$((FAIL+1))
    printf '        saída: %s\n' "$(printf '%s' "$out" | tr '\n' '|')"
  fi
}

if [ "$FALSIFY" = 0 ]; then
  echo "verify-frontend (harness local, $BASE):"
  run_case "2º nível: alvo em chunk lazy-dentro-de-página (fechamento transitivo)" \
           "$BASE/site" "SENTINELA_DEEP_XYZ" 0 "deep-DDD444"
  run_case "união c/ precache: alvo em chunk órfão só no /sw.js" \
           "$BASE/site" "ORPHAN_MARKER" 0 "orphan-EEE555"
  run_case "1º nível: alvo em página direta do entry" \
           "$BASE/site" "PAGEB_MARKER" 0 "PageB-CCC333"
  run_case "ausente: alvo não está em nenhum chunk (Publish pendente / não-literal)" \
           "$BASE/site" "NAO_EXISTE_NO_BUNDLE_123" 1
  run_case "enumeração quebrada: HTML sem entry" \
           "$BASE/site-broken" "qualquer" 2
  echo ""
  if [ "$FAIL" -eq 0 ]; then echo "verify-frontend: $PASS/$((PASS+FAIL)) passaram"; exit 0
  else echo "verify-frontend: $FAIL FALHA(S) de $((PASS+FAIL))"; exit 1; fi
fi

# --falsify: sabota a ENUMERAÇÃO e exige que o caso que a protege fique VERMELHO.
# Prova que o harness pega regressão real (não é teatro que passa com qualquer script).
echo "verify-frontend --falsify (sabota o script; cada caso DEVE divergir do exit normal):"

# Sabotagem A: mata o fechamento transitivo (frontier nunca satisfaz -> só 1º nível).
# O `\$TMP`/`\$APP` nos seds são LITERAIS (casam a string no script alvo) — aspas simples de propósito.
SAB_A="$FIX/sab_transitivo.sh"
# shellcheck disable=SC2016
sed 's#\[ -s "\$TMP/frontier\.txt" \]#[ -s "/tmp/__falsify_nunca_existe__" ]#' "$SCRIPT_REL" > "$SAB_A"
# Sabotagem B: mata a fonte precache da UNIÃO (curl no sw.js -> path inexistente)
SAB_B="$FIX/sab_precache.sh"
# shellcheck disable=SC2016
sed 's#\$APP/sw\.js#\$APP/sw-INEXISTENTE-falsify.js#' "$SCRIPT_REL" > "$SAB_B"

# falsify_case: descr, script_sabotado, alvo, exit_normal (esperamos got != normal)
falsify_case() {
  local descr="$1" scr="$2" alvo="$3" normal="$4" got
  bash "$scr" "$alvo" "$BASE/site" >/dev/null 2>&1; got=$?
  if [ "$got" != "$normal" ]; then
    printf '  [ok ] divergiu: %s (normal %s -> sabotado %s)\n' "$descr" "$normal" "$got"; PASS=$((PASS+1))
  else
    printf '  [XX ] NÃO divergiu (harness cego): %s (continuou %s)\n' "$descr" "$got"; FAIL=$((FAIL+1))
  fi
}
falsify_case "sem fechamento transitivo -> perde o alvo de 2º nível" "$SAB_A" "SENTINELA_DEEP_XYZ" 0
falsify_case "sem precache -> perde o alvo órfão"                    "$SAB_B" "ORPHAN_MARKER" 0

echo ""
if [ "$FAIL" -eq 0 ]; then echo "--falsify: $PASS/$((PASS+FAIL)) divergiram (harness tem dente)"; exit 0
else echo "--falsify: $FAIL sabotagem(ns) NÃO pega(s) — harness cego"; exit 1; fi
