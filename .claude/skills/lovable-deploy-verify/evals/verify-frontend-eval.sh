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
SCRIPT_ABS="$(cd "$(dirname "$SCRIPT_REL")" && pwd)/$(basename "$SCRIPT_REL")"
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

# ---- repo git fixture: prova de exclusividade da sentinela (--pai) ----
# PAI já contém PAGEB_MARKER (sentinela NÃO-exclusiva: existe antes do PR).
# NOVO acrescenta SENTINELA_DEEP_XYZ (exclusiva do PR). Ambas existem no bundle fake acima,
# então o que separa os dois casos é SÓ o guard — não a varredura.
REPO="$FIX/repo"
mkdir -p "$REPO/src"
git init -q "$REPO" 2>/dev/null
gitq() { git -C "$REPO" -c user.email=eval@local -c user.name=eval -c commit.gpgsign=false "$@" >/dev/null 2>&1; }
printf 'export const b="PAGEB_MARKER";\n' > "$REPO/src/app.ts"
gitq add -A; gitq commit -m pai
SHA_PAI=$(git -C "$REPO" rev-parse HEAD 2>/dev/null)
printf 'export const s="SENTINELA_DEEP_XYZ";\n' >> "$REPO/src/app.ts"
gitq add -A; gitq commit -m novo
SHA_NOVO=$(git -C "$REPO" rev-parse HEAD 2>/dev/null)
[ -n "$SHA_PAI" ] && [ -n "$SHA_NOVO" ] || { echo "❌ fixture git não subiu"; exit 2; }

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

# run_case: descr, url, alvo, exit_esperado, [substring_esperada], [substring_PROIBIDA]
# As substrings são marcas ASCII de caixa fixa (CONTROLE_NEGATIVO_OK, …) de propósito: o grep
# daqui é shim e dobra acento — casar "✓ controle negativo" seria casar sorte, não a asserção.
run_case() {
  local descr="$1" url="$2" alvo="$3" exp="$4" want="${5:-}" nao="${6:-}" out got ok=1
  out=$(bash "$SCRIPT_REL" "$alvo" "$url" 2>&1); got=$?
  [ "$got" = "$exp" ] || ok=0
  if [ -n "$want" ]; then printf '%s' "$out" | grep -q -- "$want" || ok=0; fi
  if [ -n "$nao" ]; then printf '%s' "$out" | grep -q -- "$nao" && ok=0; fi
  if [ "$ok" = 1 ]; then
    printf '  [ok ] %s (exit %s)\n' "$descr" "$got"; PASS=$((PASS+1))
  else
    printf '  [XX ] %s (esperado exit %s%s, obtido exit %s)\n' \
      "$descr" "$exp" "${want:+ + \"$want\"}" "$got"; FAIL=$((FAIL+1))
    printf '        saída: %s\n' "$(printf '%s' "$out" | tr '\n' '|')"
  fi
}

# run_case_pai: descr, cwd, exit_esperado, substring_esperada, args... (para o script)
# Roda com cwd DENTRO do repo fixture — o guard --pai consulta o git do diretório corrente.
run_case_pai() {
  local descr="$1" cwd="$2" exp="$3" want="$4"; shift 4
  local out got ok=1
  out=$(cd "$cwd" && bash "$SCRIPT_ABS" "$@" 2>&1); got=$?
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
  echo "  controle negativo EMBUTIDO (o verde audita a si mesmo — +1 request, exit 2 se cego):"
  run_case "alvo presente: o controle RODA no chunk que casou e a sonda discrimina" \
           "$BASE/site" "SENTINELA_DEEP_XYZ" 0 "CONTROLE_NEGATIVO_OK"
  run_case "alvo presente via precache: idem no ramo do órfão (o controle não depende da fonte)" \
           "$BASE/site" "ORPHAN_MARKER" 0 "CONTROLE_NEGATIVO_OK"
  run_case "alvo AUSENTE: o controle NÃO roda — ele audita o falso POSITIVO, e este ramo é o outro" \
           "$BASE/site" "NAO_EXISTE_NO_BUNDLE_123" 1 "CONTROLE_NEGATIVO_NAO_SE_APLICA" "CONTROLE_NEGATIVO_OK"

  echo ""
  echo "  --pai (prova de exclusividade da sentinela — fail-closed, exit 3):"
  run_case_pai "sentinela NÃO-exclusiva: já existia no pai -> RECUSA (mesmo estando no bundle)" \
               "$REPO" 3 "SENTINELA_NAO_EXCLUSIVA" --pai "$SHA_PAI" "PAGEB_MARKER" "$BASE/site"
  run_case_pai "sentinela exclusiva do PR: 0 no pai e >=1 no novo -> segue e prova pelos bytes" \
               "$REPO" 0 "deep-DDD444" --pai "$SHA_PAI" "SENTINELA_DEEP_XYZ" "$BASE/site"
  run_case_pai "ausente TAMBÉM no commit novo (sha/pathspec errado) -> RECUSA, o 0 no pai não vale" \
               "$REPO" 3 "SENTINELA_AUSENTE_NO_COMMIT_NOVO" --pai "$SHA_PAI" "NAO_EXISTE_EM_LUGAR_NENHUM_123" "$BASE/site"
  run_case_pai "sha do pai inexistente -> RECUSA (não degrada para 'não provei')" \
               "$REPO" 3 "" --pai "0000000000000000000000000000000000000000" "SENTINELA_DEEP_XYZ" "$BASE/site"
  run_case_pai "fora de repositório git -> RECUSA (guard exige resposta POSITIVA do git)" \
               "$FIX/site" 3 "" --pai "$SHA_PAI" "SENTINELA_DEEP_XYZ" "$BASE/site"
  run_case_pai "--pai com valor vazio -> RECUSA (uso incorreto não degrada para varredura)" \
               "$REPO" 3 "" --pai "" "SENTINELA_DEEP_XYZ" "$BASE/site"
  run_case_pai "guard --pai E controle negativo no MESMO run (um prova a sentinela, o outro a sonda)" \
               "$REPO" 0 "CONTROLE_NEGATIVO_OK" --pai "$SHA_PAI" "SENTINELA_DEEP_XYZ" "$BASE/site"
  run_case_pai "sem --pai: varre igual, mas AVISA que a exclusividade não foi provada" \
               "$REPO" 0 "EXCLUSIVIDADE_NAO_PROVADA" "SENTINELA_DEEP_XYZ" "$BASE/site"
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

# falsify_case: descr, script_sabotado, alvo, exit_normal, [exit_exigido], [marca_exigida]
# Sem os dois últimos basta divergir do normal. COM eles a asserção casa a MARCA DO RAMO —
# "divergiu" aceitaria um exit 1 vindo de outro defeito da sabotagem, que não prova nada.
falsify_case() {
  local descr="$1" scr="$2" alvo="$3" normal="$4" exato="${5:-}" marca="${6:-}" got out
  out=$(bash "$scr" "$alvo" "$BASE/site" 2>&1); got=$?
  if [ -n "$exato" ] && [ "$got" != "$exato" ]; then
    printf '  [XX ] divergiu pelo motivo ERRADO: %s (exigido exit %s, obtido %s)\n' "$descr" "$exato" "$got"
    FAIL=$((FAIL+1)); return
  fi
  if [ -n "$marca" ] && ! printf '%s' "$out" | grep -q -- "$marca"; then
    printf '  [XX ] exit certo, marca ausente: %s (exigida a marca %s)\n' "$descr" "$marca"
    FAIL=$((FAIL+1)); return
  fi
  if [ "$got" != "$normal" ]; then
    printf '  [ok ] divergiu: %s (normal %s -> sabotado %s)\n' "$descr" "$normal" "$got"; PASS=$((PASS+1))
  else
    printf '  [XX ] NÃO divergiu (harness cego): %s (continuou %s)\n' "$descr" "$got"; FAIL=$((FAIL+1))
  fi
}
falsify_case "sem fechamento transitivo -> perde o alvo de 2º nível" "$SAB_A" "SENTINELA_DEEP_XYZ" 0
falsify_case "sem precache -> perde o alvo órfão"                    "$SAB_B" "ORPHAN_MARKER" 0

# Sabotagem C: afrouxa o guard de exclusividade (o `-ne 0` do lado NEGATIVO vira `-lt 0`,
# que nunca é verdade) -> a sentinela não-exclusiva passaria a ser aceita.
SAB_C="$FIX/sab_exclusividade.sh"
sed 's#-ne 0 \]; then#-lt 0 ]; then#' "$SCRIPT_ABS" > "$SAB_C"
got_c=$( cd "$REPO" && bash "$SAB_C" --pai "$SHA_PAI" "PAGEB_MARKER" "$BASE/site" >/dev/null 2>&1; echo $? )
if [ "$got_c" != 3 ]; then
  printf '  [ok ] divergiu: guard de exclusividade afrouxado -> aceita a NÃO-exclusiva (normal 3 -> sabotado %s)\n' "$got_c"; PASS=$((PASS+1))
else
  printf '  [XX ] NÃO divergiu (harness cego): guard afrouxado continuou recusando (%s)\n' "$got_c"; FAIL=$((FAIL+1))
fi

# Sabotagem D: mata o lado POSITIVO do guard (o `!= 0` do commit NOVO vira tautologia) -> um
# sha/pathspec errado passaria a "provar" exclusividade com um zero que é ausência de dado.
# Falsificar um ramo não prova o outro: o negativo é a sabotagem C, este é o positivo.
SAB_D="$FIX/sab_lado_positivo.sh"
# shellcheck disable=SC2016
sed 's#\[ "\$_n_novo" != 0 \]#[ 1 = 1 ]#' "$SCRIPT_ABS" > "$SAB_D"
got_d=$( cd "$REPO" && bash "$SAB_D" --pai "$SHA_PAI" "NAO_EXISTE_EM_LUGAR_NENHUM_123" "$BASE/site" >/dev/null 2>&1; echo $? )
if [ "$got_d" != 3 ]; then
  printf '  [ok ] divergiu: lado positivo do guard morto -> aceita sentinela ausente no commit novo (normal 3 -> sabotado %s)\n' "$got_d"; PASS=$((PASS+1))
else
  printf '  [XX ] NÃO divergiu (harness cego): lado positivo morto continuou recusando (%s)\n' "$got_d"; FAIL=$((FAIL+1))
fi

# Sabotagem E: DEGENERA o casamento (o padrão do grep do worker vira "" -> casa toda linha).
# É a sonda-cega de verdade: o alvo "acha" no 1º chunk... e o controle negativo TAMBÉM acha,
# que é como ele denuncia. Sem o controle embutido isto sairia exit 0 e ninguém veria.
SAB_E="$FIX/sab_sonda_cega.sh"
# shellcheck disable=SC2016
sed 's#grep -q -- "\$3"#grep -q -- ""#' "$SCRIPT_ABS" > "$SAB_E"
falsify_case "grep degenerado (casa tudo) -> controle acusa SONDA_NAO_DISCRIMINA" "$SAB_E" "SENTINELA_DEEP_XYZ" 0 2 "SONDA_NAO_DISCRIMINA"

# Sabotagem F: troca a string do controle pelo PRÓPRIO alvo — que comprovadamente está no chunk.
# Prova que o controle EXERCITA a rede de verdade (curl+grep no chunk), e não é um `echo ✓`
# decorativo: se fosse decorativo, um controle impossível-de-passar continuaria dando exit 0.
SAB_F="$FIX/sab_controle_decorativo.sh"
# O `$ALVO` do replacement é LITERAL: ele vai PARA o script sabotado, não expande aqui.
# shellcheck disable=SC2016
sed 's#^CONTROLE="controle_negativo_.*#CONTROLE="$ALVO"#' "$SCRIPT_ABS" > "$SAB_F"
falsify_case "controle que DEVERIA casar -> exit 2 (logo o controle roda mesmo, não é enfeite)" "$SAB_F" "SENTINELA_DEEP_XYZ" 0 2 "SONDA_NAO_DISCRIMINA"

echo ""
if [ "$FAIL" -eq 0 ]; then echo "--falsify: $PASS/$((PASS+FAIL)) divergiram (harness tem dente)"; exit 0
else echo "--falsify: $FAIL sabotagem(ns) NÃO pega(s) — harness cego"; exit 1; fi
