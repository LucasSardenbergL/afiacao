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
const k="TOKEN_LONGO_DE_FIXTURE_NAO_E_SEGREDO_0123456789abcdef0123456789";
console.log("entry");
JS

# PageA: guarda o mapDeps do 2º nível (lazy-dentro-de-página) — o entry sozinho perde isto
cat > "$FIX/site/assets/PageA-BBB222.js" <<'JS'
__vite__mapDeps(["assets/deep-DDD444.js"]);
JS

# PageB: folha do 1º nível, sem deps — carrega um marcador renderizado
cat > "$FIX/site/assets/PageB-CCC333.js" <<'JS'
export const b="PAGEB_MARKER";
export const o={LIB_OPTION_MARKER:!0};
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
printf 'export const s="SENTINELA_DEEP_XYZ";\nexport const o={LIB_OPTION_MARKER:!0};\n' >> "$REPO/src/app.ts"
gitq add -A; gitq commit -m novo
SHA_NOVO=$(git -C "$REPO" rev-parse HEAD 2>/dev/null)
[ -n "$SHA_PAI" ] && [ -n "$SHA_NOVO" ] || { echo "❌ fixture git não subiu"; exit 2; }

# ---- node_modules fixture: a sonda do SEGUNDO EMISSOR (SENTINELA_TAMBEM_NA_LIB) ----
# Criado DEPOIS dos commits de propósito: `git add -A` versionaria node_modules e o fixture viraria
# outra coisa. LIB_OPTION_MARKER imita o caso real medido (docs/historico/sentinela-segundo-emissor.md):
# nome de opção de API que a LIB emite no próprio código E que também está no nosso src/ e no bundle
# — o `git grep` do --pai não vê esse 2º emissor, a sonda vê.
mkdir -p "$REPO/node_modules/fake-lib/dist"
printf 'export const o={LIB_OPTION_MARKER:!0,x:1};\n' > "$REPO/node_modules/fake-lib/dist/lib.js"
# SENTINELA_DEEP_XYZ (a sentinela LIMPA do harness) aparece aqui num .md DE PROPÓSITO: o universo da
# sonda é código JS, então isto NÃO pode virar hit. Medido na node_modules real: sem o filtro de
# extensão o "valor nosso" acusava readme.md/preflight.css e o aviso disparava contra a sentinela
# CERTA. É o que a sabotagem J falsifica.
printf 'exemplo de uso: SENTINELA_DEEP_XYZ\n' > "$REPO/node_modules/fake-lib/readme.md"

# cwd NEUTRO dos casos que não exercitam git/node_modules: fora de repo git e sem node_modules, a
# sonda responde LIB_NAO_CONSULTADA de forma determinística e a custo zero. Sem isto os casos
# herdariam o node_modules REAL da máquina — ~2s cada e saída que varia por host, num harness cujo
# cabeçalho promete ser DETERMINÍSTICO.
mkdir -p "$FIX/neutro"

# site-broken: HTML sem entry /assets/index-*.js -> enumeração quebrada (exit 2)
cat > "$FIX/site-broken/index.html" <<'HTML'
<!doctype html><html><body><h1>sem entry aqui</h1></body></html>
HTML

# site-cego: index.html e /sw.js VIVOS, /assets/* inexistente (404) — é o CDN devolvendo 403/404
# só nos chunks, ou a rede caindo DEPOIS do HTML. A varredura fica vazia e lê IDÊNTICO a "Publish
# pendente"; sem controle POSITIVO o script afirma ausência sem ter enxergado byte nenhum.
mkdir -p "$FIX/site-cego"
cat > "$FIX/site-cego/index.html" <<'HTML'
<!doctype html><html><head>
<script type="module" crossorigin src="/assets/index-AAA111.js"></script>
</head><body></body></html>
HTML
# precache com 3 chunks: mantém N>=2, então o guard de enumeração NÃO pega este caso — de
# propósito, senão o fixture provaria o guard velho em vez do controle novo.
cat > "$FIX/site-cego/sw.js" <<'JS'
self.__WB_MANIFEST=[{"url":"/assets/index-AAA111.js"},{"url":"/assets/orphan-EEE555.js"},{"url":"/assets/PageB-CCC333.js"}];
JS

# site-fallback: /assets/* responde 200 com o HTML do SPA (fallback catch-all do CDN) em vez do JS.
# O `-f` do curl não pega isto — o corpo VEM, só não é o chunk. Uma agulha derivada desse corpo
# casaria em si mesma: verde por CEGUEIRA. O marcador de 29 chars existe pra que o caso reprove
# pelo motivo CERTO (é HTML) e não por falta de token longo.
mkdir -p "$FIX/site-fallback/assets"
cat > "$FIX/site-fallback/index.html" <<'HTML'
<!doctype html><html><head>
<meta name="generator" content="FALLBACK_SPA_CONSTANTE_MARKER">
<script type="module" crossorigin src="/assets/index-AAA111.js"></script>
</head><body></body></html>
HTML
cp "$FIX/site-fallback/index.html" "$FIX/site-fallback/assets/index-AAA111.js"
cp "$FIX/site-fallback/index.html" "$FIX/site-fallback/assets/orphan-EEE555.js"
cat > "$FIX/site-fallback/sw.js" <<'JS'
self.__WB_MANIFEST=[{"url":"/assets/index-AAA111.js"},{"url":"/assets/orphan-EEE555.js"}];
JS

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
  out=$(cd "$FIX/neutro" && bash "$SCRIPT_ABS" "$alvo" "$url" 2>&1); got=$?
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

# run_case_cwd: descr, cwd, exit_esperado, substring_esperada, substring_PROIBIDA, args...
# O cwd escolhe DOIS universos de uma vez: o git que o guard --pai consulta e o node_modules que a
# sonda do 2º emissor consulta. Por isso ela também precisa da substring proibida — distinguir
# "LIB_SEM_A_SENTINELA" de "SENTINELA_TAMBEM_NA_LIB" exige negar a outra, não só afirmar a sua.
run_case_cwd() {
  local descr="$1" cwd="$2" exp="$3" want="$4" nao="$5"; shift 5
  local out got ok=1
  out=$(cd "$cwd" && bash "$SCRIPT_ABS" "$@" 2>&1); got=$?
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
  echo "  controle POSITIVO embutido (o ramo AUSENTE prova que ainda enxerga — +1 request, exit 2 se cega):"
  run_case "ausente com a sonda ENXERGANDO: prova a visão ANTES de afirmar ausência" \
           "$BASE/site" "NAO_EXISTE_NO_BUNDLE_123" 1 "CONTROLE_POSITIVO_OK"
  run_case "sonda CEGA (chunks 404, index.html vivo): não afirma ausência, recusa com exit 2" \
           "$BASE/site-cego" "NAO_EXISTE_NO_BUNDLE_123" 2 "SONDA_CEGA" "CONTROLE_POSITIVO_OK"
  run_case "fallback SPA (chunk devolve HTML com 200): agulha casaria em si mesma -> exit 2" \
           "$BASE/site-fallback" "NAO_EXISTE_NO_BUNDLE_123" 2 "ENTRY_NAO_E_JS" "CONTROLE_POSITIVO_OK"
  run_case "alvo presente: o positivo NÃO roda — o próprio HIT já é a evidência de que enxerga" \
           "$BASE/site" "SENTINELA_DEEP_XYZ" 0 "CONTROLE_NEGATIVO_OK" "CONTROLE_POSITIVO_OK"
  run_case "agulha longa sai TRUNCADA: em prod o maior token do entry é a anon key (pública, mas com cara de credencial)" \
           "$BASE/site" "NAO_EXISTE_NO_BUNDLE_123" 1 "CONTROLE_POSITIVO_OK" \
           "TOKEN_LONGO_DE_FIXTURE_NAO_E_SEGREDO_0123456789abcdef0123456789"

  echo ""
  echo "  --pai (prova de exclusividade da sentinela — fail-closed, exit 3):"
  run_case_cwd "sentinela NÃO-exclusiva: já existia no pai -> RECUSA (mesmo estando no bundle)" \
               "$REPO" 3 "SENTINELA_NAO_EXCLUSIVA" "" --pai "$SHA_PAI" "PAGEB_MARKER" "$BASE/site"
  run_case_cwd "sentinela exclusiva do PR: 0 no pai e >=1 no novo -> segue e prova pelos bytes" \
               "$REPO" 0 "deep-DDD444" "" --pai "$SHA_PAI" "SENTINELA_DEEP_XYZ" "$BASE/site"
  run_case_cwd "ausente TAMBÉM no commit novo (sha/pathspec errado) -> RECUSA, o 0 no pai não vale" \
               "$REPO" 3 "SENTINELA_AUSENTE_NO_COMMIT_NOVO" "" --pai "$SHA_PAI" "NAO_EXISTE_EM_LUGAR_NENHUM_123" "$BASE/site"
  run_case_cwd "sha do pai inexistente -> RECUSA (não degrada para 'não provei')" \
               "$REPO" 3 "" "" --pai "0000000000000000000000000000000000000000" "SENTINELA_DEEP_XYZ" "$BASE/site"
  run_case_cwd "fora de repositório git -> RECUSA (guard exige resposta POSITIVA do git)" \
               "$FIX/site" 3 "" "" --pai "$SHA_PAI" "SENTINELA_DEEP_XYZ" "$BASE/site"
  run_case_cwd "--pai com valor vazio -> RECUSA (uso incorreto não degrada para varredura)" \
               "$REPO" 3 "" "" --pai "" "SENTINELA_DEEP_XYZ" "$BASE/site"
  run_case_cwd "guard --pai E controle negativo no MESMO run (um prova a sentinela, o outro a sonda)" \
               "$REPO" 0 "CONTROLE_NEGATIVO_OK" "" --pai "$SHA_PAI" "SENTINELA_DEEP_XYZ" "$BASE/site"
  run_case_cwd "sem --pai: varre igual, mas AVISA que a exclusividade não foi provada" \
               "$REPO" 0 "EXCLUSIVIDADE_NAO_PROVADA" "" "SENTINELA_DEEP_XYZ" "$BASE/site"

  echo ""
  echo "  sonda do SEGUNDO EMISSOR (a sentinela também vem da LIB? avisa, NUNCA recusa):"
  run_case_cwd "sentinela é opção da LIB: node_modules/ também a emite -> AVISA (e o exit NÃO muda)" \
               "$REPO" 0 "SENTINELA_TAMBEM_NA_LIB" "LIB_SEM_A_SENTINELA" "LIB_OPTION_MARKER" "$BASE/site"
  run_case_cwd "sentinela LIMPA: nenhum código JS de node_modules/ a emite -> sem aviso" \
               "$REPO" 0 "LIB_SEM_A_SENTINELA" "SENTINELA_TAMBEM_NA_LIB" "SENTINELA_DEEP_XYZ" "$BASE/site"
  run_case_cwd "node_modules AUSENTE (worktree sem 'bun install'): diz que NÃO CONSULTOU, não cala" \
               "$FIX/neutro" 0 "LIB_NAO_CONSULTADA" "LIB_SEM_A_SENTINELA" "LIB_OPTION_MARKER" "$BASE/site"
  # O caso da classe inteira (docs/historico/sentinela-segundo-emissor.md): exclusiva NO GIT e com 2º
  # emissor FORA dele são compatíveis — o --pai passa e o verde ainda pode ser bytes da lib.
  run_case_cwd "exclusiva no git E com 2º emissor na lib: --pai aprova, a sonda avisa, exit segue 0" \
               "$REPO" 0 "SENTINELA_TAMBEM_NA_LIB" "SENTINELA_NAO_EXCLUSIVA" --pai "$SHA_PAI" "LIB_OPTION_MARKER" "$BASE/site"
  # ---- sonda do DELIMITADOR: fonte e bundle são universos com REPRESENTAÇÕES diferentes ----
  # Medido em prod 2026-08-27 (chunk StaffDashboard servido): 'oculta' = 0 ocorrências e "oculta" = 1.
  # O guard --pai mede a FONTE e APROVA; a varredura mede o BUNDLE e não acha => exit 1 FALSO, com os
  # três guards verdes (exclusiva + LIB_SEM_A_SENTINELA + CONTROLE_POSITIVO_OK). O controle positivo
  # não cobre isso por construção: prova que a rede e o grep funcionam, não que a sentinela seja
  # REPRESENTÁVEL. Sem sabotagem própria porque a sonda AVISA e nunca move o exit (igual à de lib) —
  # a rede aqui é BIDIRECIONAL: detector sempre-falso derruba o 1º caso, sempre-verdadeiro os outros.
  run_case_cwd "sentinela DELIMITADA ausente do bundle: avisa que a ausência pode ser de REPRESENTAÇÃO" \
               "$FIX/neutro" 1 "SENTINELA_DELIMITADA" "" "'SENTINELA_DEEP_XYZ'" "$BASE/site"
  run_case_cwd "sentinela SEM delimitador: a sonda CALA (não vira ruído no caso comum)" \
               "$FIX/neutro" 0 "deep-DDD444" "SENTINELA_DELIMITADA" "SENTINELA_DEEP_XYZ" "$BASE/site"
  # Aspas no MEIO são CONTEÚDO e sobrevivem à minificação — input[type="checkbox"] é justamente a
  # sentinela que o Passo 4 recomenda. Aviso que disparasse nela estaria desarmado no primeiro dia.
  run_case_cwd "aspas no MEIO (o 'valor nosso' do Passo 4): a sonda CALA" \
               "$FIX/neutro" 1 "" "SENTINELA_DELIMITADA" 'a[type="x"]b' "$BASE/site"
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
sed 's#\[ -s "\$TMP/frontier\.txt" \]#[ -s "/tmp/__falsify_nunca_existe__" ]#' "$SCRIPT_ABS" > "$SAB_A"
# Sabotagem B: mata a fonte precache da UNIÃO (curl no sw.js -> path inexistente)
SAB_B="$FIX/sab_precache.sh"
# shellcheck disable=SC2016
sed 's#\$APP/sw\.js#\$APP/sw-INEXISTENTE-falsify.js#' "$SCRIPT_ABS" > "$SAB_B"

# falsify_case: descr, script_sabotado, alvo, exit_normal, [exit_exigido], [marca_exigida], [url]
# Sem exit/marca basta divergir do normal. COM eles a asserção casa a MARCA DO RAMO — "divergiu"
# aceitaria um exit 1 vindo de outro defeito da sabotagem, que não prova nada.
# A url é o 7º e tem default LOCAL: sabotagem que caísse em produção varreria prod de verdade.
falsify_case() {
  local descr="$1" scr="$2" alvo="$3" normal="$4" exato="${5:-}" marca="${6:-}" url="${7:-$BASE/site}" got out base
  # O `normal` DECLARADO pode mentir — quem escreve a sabotagem antes da feature declara o exit do
  # script que ainda vai existir, e "divergiu do que eu disse" viraria verde sem sabotagem nenhuma.
  # Mede-se o script REAL na mesma url antes de comparar: evidência positiva, não declaração.
  ( cd "$FIX/neutro" && bash "$SCRIPT_ABS" "$alvo" "$url" ) >/dev/null 2>&1; base=$?
  if [ "$base" != "$normal" ]; then
    printf '  [XX ] normal DECLARADO não bate com o medido: %s (declarado %s, script real %s)\n' "$descr" "$normal" "$base"
    FAIL=$((FAIL+1)); return
  fi
  out=$(cd "$FIX/neutro" && bash "$scr" "$alvo" "$url" 2>&1); got=$?
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

# Sabotagem G: mata o VEREDITO de cegueira (o guard que converte "não enxerguei" em exit 2).
# Contra o site-cego (chunks 404, index.html vivo) o script sabotado volta a AFIRMAR ausência —
# que é o falso NEGATIVO que faz o operador pedir um Publish desnecessário.
SAB_G="$FIX/sab_controle_positivo.sh"
# shellcheck disable=SC2016
sed 's#^if \[ -n "\$_cego" \]; then#if [ 1 = 0 ]; then#' "$SCRIPT_ABS" > "$SAB_G"
falsify_case "veredito de cegueira morto -> volta a AFIRMAR ausência com os chunks em 404" \
             "$SAB_G" "NAO_EXISTE_NO_BUNDLE_123" 2 1 "" "$BASE/site-cego"

# Sabotagem H: troca a agulha DERIVADA por uma que não está em lugar nenhum. Espelha a F do lado
# negativo: se o controle positivo fosse um `echo ✓` decorativo, uma agulha impossível continuaria
# dando exit 1. Roda no site BOM — o que muda é só a agulha.
SAB_H="$FIX/sab_agulha_impossivel.sh"
# shellcheck disable=SC2016
sed 's#^_agulha=\$(tr .*#_agulha="agulha_impossivel_zzz9999_falsify"#' "$SCRIPT_ABS" > "$SAB_H"
falsify_case "agulha trocada por uma impossível -> exit 2 (logo o controle vai à rede de verdade)" \
             "$SAB_H" "NAO_EXISTE_NO_BUNDLE_123" 1 2 "AGULHA_NAO_CASOU"

# Sabotagem I: mata o check "o entry é JS, não HTML". Sem ele a agulha nasce do próprio fallback
# do SPA e casa em si mesma -> CONTROLE_POSITIVO_OK mentiroso e exit 1. É o furo circular que o
# check existe pra fechar, e o caso normal do site-fallback só prova isso se esta sabotagem virar.
SAB_I="$FIX/sab_entry_html.sh"
sed "s#^  '<') _cego=#  '<XXX') _cego=#" "$SCRIPT_ABS" > "$SAB_I"
falsify_case "check de HTML morto -> fallback do SPA vira 'ausente' provado por si mesmo" \
             "$SAB_I" "NAO_EXISTE_NO_BUNDLE_123" 2 1 "" "$BASE/site-fallback"

# falsify_marca: descr, script_sabotado, cwd, alvo, marca_que_DEVE_SUMIR, [marca_que_DEVE_SURGIR]
# A sonda do 2º emissor AVISA e não recusa — de propósito, e medido. Logo ela não mexe no exit code,
# e falsify_case (que compara exits) é CEGO a ela: sabotá-la deixaria todos os exits idênticos e o
# harness diria "não divergiu" sem nunca ter olhado a asserção certa. Aqui a asserção é a MARCA.
# Mede-se o script REAL primeiro — a marca tem de estar lá ANTES de sabotar, senão "sumiu" é uma
# marca que nunca existiu, que é o teatro que a regra de evidência positiva proíbe.
falsify_marca() {
  local descr="$1" scr="$2" cwd="$3" alvo="$4" some="$5" surge="${6:-}" out
  out=$(cd "$cwd" && bash "$SCRIPT_ABS" "$alvo" "$BASE/site" 2>&1)
  if ! printf '%s' "$out" | grep -q -- "$some"; then
    printf '  [XX ] marca ausente no script REAL: %s (esperava %s ANTES de sabotar)\n' "$descr" "$some"
    FAIL=$((FAIL+1)); return
  fi
  out=$(cd "$cwd" && bash "$scr" "$alvo" "$BASE/site" 2>&1)
  if printf '%s' "$out" | grep -q -- "$some"; then
    printf '  [XX ] NÃO divergiu (harness cego): %s (a marca %s sobreviveu à sabotagem)\n' "$descr" "$some"
    FAIL=$((FAIL+1)); return
  fi
  if [ -n "$surge" ] && ! printf '%s' "$out" | grep -q -- "$surge"; then
    printf '  [XX ] marca sumiu pelo motivo ERRADO: %s (esperava %s no lugar)\n' "$descr" "$surge"
    FAIL=$((FAIL+1)); return
  fi
  printf '  [ok ] divergiu: %s (%s sumiu)\n' "$descr" "$some"; PASS=$((PASS+1))
}

# Sabotagem J: tira o filtro de extensão da sonda -> o universo volta a ser a árvore INTEIRA e o
# readme.md do fake-lib passa a casar. É a regressão medida na node_modules real (637MB): sem filtro,
# o "valor nosso" acusava readme.md/preflight.css — o aviso disparando contra a sentinela CERTA, que
# é como um aviso é desarmado. E custava 38-63s em vez de ~2s.
SAB_J="$FIX/sab_filtro_extensao.sh"
sed "s#--include='\*\.js' --include='\*\.mjs' --include='\*\.cjs' ##" "$SCRIPT_ABS" > "$SAB_J"
falsify_marca "filtro de extensão removido -> o .md da lib vira hit e acusa a sentinela LIMPA" \
              "$SAB_J" "$REPO" "SENTINELA_DEEP_XYZ" "LIB_SEM_A_SENTINELA" "SENTINELA_TAMBEM_NA_LIB"

# Sabotagem K: aponta a sonda para um node_modules que não existe -> ela deixa de ver o 2º emissor.
# Prova que o hit vem de uma CONSULTA de verdade ao disco, não de um `echo` decorativo — e que o
# estado "não consultei" aparece exatamente onde a consulta não aconteceu.
SAB_K="$FIX/sab_sonda_lib_morta.sh"
# shellcheck disable=SC2016
sed 's#_nm="\$_raiz_nm/node_modules"#_nm="$_raiz_nm/node_modules_INEXISTENTE_falsify"#' "$SCRIPT_ABS" > "$SAB_K"
falsify_marca "sonda apontada para node_modules inexistente -> perde o 2º emissor que existia" \
              "$SAB_K" "$REPO" "LIB_OPTION_MARKER" "SENTINELA_TAMBEM_NA_LIB" "LIB_NAO_CONSULTADA"

# Sabotagem L: cala o ramo do node_modules AUSENTE (o printf vira `:`, que engole os argumentos).
# É a fabricação que o requisito existe pra impedir: sem node_modules a sonda não consultou nada, e
# silêncio nesse estado se lê como "limpo" — ausência de dado virando aprovação.
SAB_L="$FIX/sab_ausente_calado.sh"
# shellcheck disable=SC2016
sed '/^if \[ ! -d "\$_nm" \]; then$/,/^else$/ s/^  printf /  : /' "$SCRIPT_ABS" > "$SAB_L"
# O 6º arg não é decoração aqui: sem ele, um SAB_L com erro de SINTAXE também faria a marca sumir
# (nada rodou) e a sabotagem passaria por motivo errado. Exigir CONTROLE_NEGATIVO_OK prova que o
# script sabotado rodou ATÉ O FIM e deu verde — calado sobre não ter consultado, que é a fabricação.
falsify_marca "estado 'não consultei' silenciado -> worktree sem node_modules lê como limpa" \
              "$SAB_L" "$FIX/neutro" "LIB_OPTION_MARKER" "LIB_NAO_CONSULTADA" "CONTROLE_NEGATIVO_OK"

echo ""
if [ "$FAIL" -eq 0 ]; then echo "--falsify: $PASS/$((PASS+FAIL)) divergiram (harness tem dente)"; exit 0
else echo "--falsify: $FAIL sabotagem(ns) NÃO pega(s) — harness cego"; exit 1; fi
