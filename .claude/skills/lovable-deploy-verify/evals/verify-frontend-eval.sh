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

# --falsify: sabota o script EM CÓPIA e exige que o caso que protege cada elo saia pelo desfecho
# PREVISTO: cada sabotagem DECLARA o exit E as marcas (exigidas/proibidas) do ramo que a acusa, e o
# juiz exige exatamente isso nos 2 locales, sobre o script ÍNTEGRO medido na mesma invocação.
# "Divergiu do exit normal" (o juiz de antes, nas A-D, G e I) aceitava crash, sintaxe quebrada e
# erro alheio: com a A trocada por uma que só QUEBRA o script, ele saía 2 ≠ 0 e contava dente.
# → docs/historico/falsificacao-exit-nao-e-dente.md · referência: monitor-deploy-eval.sh.
echo "verify-frontend --falsify (sabota o script em CÓPIA; cada caso DEVE sair pelo desfecho PREVISTO):"

# locales: sonda POSITIVA — "setei LC_ALL" não prova que o locale existe (glibc cai em C calado)
LOCALES="C"
for cand in pt_BR.UTF-8 pt_BR.utf8 en_US.UTF-8 en_US.utf8 C.UTF-8 C.utf8; do
  if [ "$(LC_ALL="$cand" locale charmap 2>/dev/null)" = "UTF-8" ]; then LOCALES="C $cand"; break; fi
done
[ "$LOCALES" = "C" ] && echo "  ⚠️  nenhum locale UTF-8 disponível — falsificação só em C (metade da prova)"

SAB="$FIX/sabotado.sh"
roda_vf() { # script cwd locale args… → exit do script; saída (stdout+stderr) em $FIX/out
  local scr="$1" cwd="$2" loc="$3"; shift 3
  ( cd "$cwd" && LC_ALL="$loc" LANG="$loc" bash "$scr" "$@" ) >"$FIX/out" 2>&1
}
# bate <exit obtido> <exit previsto> <exigidas;…> <proibidas;…> → 0 só se o exit bate, TODAS as
# exigidas estão na saída e NENHUMA proibida. `case` do próprio shell, não `grep`: o grep daqui é
# shim e dobra acento (ver run_case); as marcas são ASCII de caixa fixa.
bate() {
  local s m resto
  [ "$1" -eq "$2" ] || return 1
  s=$(cat "$FIX/out")
  resto="$3"
  while [ -n "$resto" ]; do
    m=${resto%%;*}
    case "$s" in *"$m"*) ;; *) return 1 ;; esac
    [ "$m" = "$resto" ] && break
    resto=${resto#*;}
  done
  resto="$4"
  while [ -n "$resto" ]; do
    m=${resto%%;*}
    case "$s" in *"$m"*) return 1 ;; esac
    [ "$m" = "$resto" ] && break
    resto=${resto#*;}
  done
  return 0
}
aplica() { # de para — substituição LITERAL em cópia; o alvo tem de aparecer EXATAMENTE 1 vez
  python3 - "$SCRIPT_ABS" "$SAB" "$1" "$2" <<'PY'
import sys
src, dst, de, para = sys.argv[1:5]
s = open(src, encoding="utf-8").read()
if s.count(de) != 1:
    sys.exit("o alvo aparece %d vez(es): %r" % (s.count(de), de[:70]))
open(dst, "w", encoding="utf-8").write(s.replace(de, para, 1))
PY
}
# sabota <id> <de> <para> <cwd> <exit ÍNTEGRO> <exit previsto> <exigidas;…> <proibidas;…> <args…>
# O cwd escolhe os DOIS universos do script (o git do --pai e o node_modules da sonda do 2º emissor).
sabota() {
  local id="$1" de="$2" para="$3" cwd="$4" normal="$5" pexit="$6" quer="$7" nao="$8" loc got pegou=0 n_loc=0 errado=""
  shift 8
  if ! aplica "$de" "$para" 2>"$FIX/aplica.err" || cmp -s "$SCRIPT_ABS" "$SAB"; then
    printf '  [XX ] %s: a sabotagem NÃO aplicou (%s) — o eval não testaria nada\n' "$id" "$(tr '\n' ' ' < "$FIX/aplica.err")"
    FAIL=$((FAIL+1)); return
  fi
  if ! bash -n "$SAB" 2>/dev/null; then
    printf '  [XX ] %s: a sabotagem quebrou a SINTAXE do script — vermelho pelo motivo errado\n' "$id"
    FAIL=$((FAIL+1)); return
  fi
  for loc in $LOCALES; do
    n_loc=$((n_loc+1))
    # CONTROLE na mesma invocação e locale. O exit ÍNTEGRO é MEDIDO, não só declarado — quem
    # escreve a sabotagem antes da feature declara o exit do script que ainda vai existir, e
    # "divergiu do que eu disse" viraria verde sem sabotagem nenhuma. E o previsto NÃO pode
    # descrever o controle: senão "bateu o previsto" não distinguiria sabotagem de nada.
    roda_vf "$SCRIPT_ABS" "$cwd" "$loc" "$@"; got=$?
    if [ "$got" -ne "$normal" ]; then errado="$errado $loc:CONTROLE-exit$got-declarado$normal"; continue; fi
    if bate "$got" "$pexit" "$quer" "$nao"; then errado="$errado $loc:o-PREVISTO-casa-o-CONTROLE"; continue; fi
    roda_vf "$SAB" "$cwd" "$loc" "$@"; got=$?
    if bate "$got" "$pexit" "$quer" "$nao"; then pegou=$((pegou+1)); else errado="$errado $loc:exit$got"; fi
  done
  if [ "$pegou" -eq "$n_loc" ]; then
    printf '  [ok ] %s: exit %s + "%s" em %d locale(s) (íntegro: exit %s)\n' "$id" "$pexit" "$quer" "$n_loc" "$normal"
    PASS=$((PASS+1))
  else
    printf '  [XX ] %s: NÃO saiu pelo previsto (exit %s + "%s"%s; obtido%s)\n' \
      "$id" "$pexit" "$quer" "${nao:+, sem \"$nao\"}" "$errado"
    sed 's/^/        | /' "$FIX/out" | head -6
    FAIL=$((FAIL+1))
  fi
}

# O ramo do "ausente" imprime CONTROLE_POSITIVO_OK antes do veredito — é a marca de que a sonda
# ENXERGAVA quando afirmou a ausência. Exigi-la junto separa o furo sabotado de um script morto.
AUSENTE="CONTROLE_POSITIVO_OK;ALVO ausente nos"

# A: mata o fechamento transitivo (frontier nunca satisfaz -> só 1º nível): o alvo de 2º nível some.
# shellcheck disable=SC2016  # literais do script-alvo, não devem expandir aqui
sabota A-transitivo '[ -s "$TMP/frontier.txt" ]' '[ -s "/tmp/__falsify_nunca_existe__" ]' \
  "$FIX/neutro" 0 1 "$AUSENTE" "" SENTINELA_DEEP_XYZ "$BASE/site"
# B: mata a fonte precache da UNIÃO (curl no sw.js -> path inexistente): o órfão some.
# shellcheck disable=SC2016
sabota B-precache '$APP/sw.js' '$APP/sw-INEXISTENTE-falsify.js' \
  "$FIX/neutro" 0 1 "$AUSENTE" "" ORPHAN_MARKER "$BASE/site"

# C: afrouxa o guard de exclusividade (o `-ne 0` do lado NEGATIVO vira `-lt 0`, que nunca é
# verdade) -> a sentinela não-exclusiva passa a ser ACEITA e varrida: sai "no ar" no chunk dela.
sabota C-exclusividade '-ne 0 ]; then' '-lt 0 ]; then' \
  "$REPO" 3 0 "PageB-CCC333;CONTROLE_NEGATIVO_OK" "" --pai "$SHA_PAI" PAGEB_MARKER "$BASE/site"

# D: mata o lado POSITIVO do guard (o `!= 0` do commit NOVO vira tautologia) -> um sha/pathspec
# errado passaria a "provar" exclusividade com um zero que é ausência de dado — e a sentinela que
# não existe em lugar nenhum vira "ausente no bundle". Falsificar um ramo não prova o outro: o
# negativo é a sabotagem C, este é o positivo.
# shellcheck disable=SC2016
sabota D-lado-positivo '[ "$_n_novo" != 0 ]' '[ 1 = 1 ]' \
  "$REPO" 3 1 "$AUSENTE" "" --pai "$SHA_PAI" NAO_EXISTE_EM_LUGAR_NENHUM_123 "$BASE/site"

# E: DEGENERA o casamento (o padrão do grep do worker vira "" -> casa toda linha). É a sonda-cega
# de verdade: o alvo "acha" no 1º chunk... e o controle negativo TAMBÉM acha, que é como ele
# denuncia. Sem o controle embutido isto sairia exit 0 e ninguém veria.
# shellcheck disable=SC2016
sabota E-grep-degenerado 'grep -q -- "$3"' 'grep -q -- ""' \
  "$FIX/neutro" 0 2 "SONDA_NAO_DISCRIMINA" "" SENTINELA_DEEP_XYZ "$BASE/site"

# F: troca a string do controle pelo PRÓPRIO alvo — que comprovadamente está no chunk. Prova que o
# controle EXERCITA a rede de verdade (curl+grep no chunk), e não é um `echo ✓` decorativo: se
# fosse decorativo, um controle impossível-de-passar continuaria dando exit 0. O `$ALVO` do
# replacement é LITERAL: ele vai PARA o script sabotado, não expande aqui.
# shellcheck disable=SC2016
sabota F-controle-decorativo 'CONTROLE="controle_negativo_${_ent}"' 'CONTROLE="$ALVO"' \
  "$FIX/neutro" 0 2 "SONDA_NAO_DISCRIMINA" "" SENTINELA_DEEP_XYZ "$BASE/site"

# G: mata o VEREDITO de cegueira (o guard que converte "não enxerguei" em exit 2). Contra o
# site-cego (chunks 404, index.html vivo) o script sabotado volta a AFIRMAR ausência — que é o
# falso NEGATIVO que faz o operador pedir um Publish desnecessário — e com um CONTROLE_POSITIVO_OK
# que mente, porque o ramo que o desmentiria foi o arrancado.
# shellcheck disable=SC2016
sabota G-veredito-de-cegueira 'if [ -n "$_cego" ]; then' 'if [ 1 = 0 ]; then' \
  "$FIX/neutro" 2 1 "$AUSENTE" "" NAO_EXISTE_NO_BUNDLE_123 "$BASE/site-cego"

# H: troca a agulha DERIVADA por uma que não está em lugar nenhum. Espelha a F do lado negativo:
# se o controle positivo fosse um `echo ✓` decorativo, uma agulha impossível continuaria dando
# exit 1. Roda no site BOM — o que muda é só a agulha (o `: $(tr …)` segue rodando e é descartado).
# shellcheck disable=SC2016
sabota H-agulha-impossivel '_agulha=$(tr ' '_agulha="agulha_impossivel_zzz9999_falsify"; : $(tr ' \
  "$FIX/neutro" 1 2 "AGULHA_NAO_CASOU" "" NAO_EXISTE_NO_BUNDLE_123 "$BASE/site"

# I: mata o check "o entry é JS, não HTML". Sem ele a agulha nasce do próprio fallback do SPA e
# casa em si mesma -> CONTROLE_POSITIVO_OK mentiroso e exit 1. É o furo circular que o check existe
# pra fechar, e o caso normal do site-fallback só prova isso se esta sabotagem virar.
sabota I-entry-html "  '<') _cego=" "  '<XXX') _cego=" \
  "$FIX/neutro" 2 1 "$AUSENTE" "" NAO_EXISTE_NO_BUNDLE_123 "$BASE/site-fallback"

# J-M: a sonda do 2º emissor AVISA e não recusa — de propósito, e medido. Ela não mexe no exit
# code, então o previsto é o exit ÍNTEGRO com a marca que TEM de surgir e a que TEM de sumir: uma
# sabotagem com erro de SINTAXE também faria a marca sumir (nada rodou), e é a exigida que prova
# que o script sabotado rodou ATÉ O FIM pelo ramo certo.
#
# J: tira o filtro de extensão da sonda -> o universo volta a ser a árvore INTEIRA e o readme.md do
# fake-lib passa a casar. É a regressão medida na node_modules real (637MB): sem filtro, o "valor
# nosso" acusava readme.md/preflight.css — o aviso disparando contra a sentinela CERTA, que é como
# um aviso é desarmado. E custava 38-63s em vez de ~2s.
sabota J-filtro-de-extensao "--include='*.js' --include='*.mjs' --include='*.cjs' " "" \
  "$REPO" 0 0 "SENTINELA_TAMBEM_NA_LIB" "LIB_SEM_A_SENTINELA" SENTINELA_DEEP_XYZ "$BASE/site"
# K: aponta a sonda para um node_modules que não existe -> ela deixa de ver o 2º emissor. Prova que
# o hit vem de uma CONSULTA de verdade ao disco, não de um `echo` decorativo — e que o estado "não
# consultei" aparece exatamente onde a consulta não aconteceu.
# shellcheck disable=SC2016
sabota K-sonda-lib-morta '_nm="$_raiz_nm/node_modules"' '_nm="$_raiz_nm/node_modules_INEXISTENTE_falsify"' \
  "$REPO" 0 0 "LIB_NAO_CONSULTADA" "SENTINELA_TAMBEM_NA_LIB" LIB_OPTION_MARKER "$BASE/site"
# L: cala o ramo do node_modules AUSENTE (o printf vira `:`, que engole os argumentos). É a
# fabricação que o requisito existe pra impedir: sem node_modules a sonda não consultou nada, e
# silêncio nesse estado se lê como "limpo" — ausência de dado virando aprovação.
# shellcheck disable=SC2016
sabota L-ausente-calado 'if [ ! -d "$_nm" ]; then
  printf ' 'if [ ! -d "$_nm" ]; then
  : ' \
  "$FIX/neutro" 0 0 "CONTROLE_NEGATIVO_OK" "LIB_NAO_CONSULTADA" LIB_OPTION_MARKER "$BASE/site"
# M: mata a comparação das PONTAS do detector de delimitador (vira `false`) -> a sentinela
# delimitada volta a passar calada, e a ausência que ela causa se lê como "Publish pendente". É o
# falso NEGATIVO medido em prod 2026-08-27 no #2037: os três guards verdes e o veredito errado.
# shellcheck disable=SC2016
sabota M-delimitador-morto '[ "$_prim" = "$_ult" ]' 'false' \
  "$FIX/neutro" 1 1 "ALVO ausente nos" "SENTINELA_DELIMITADA" "'SENTINELA_DEEP_XYZ'" "$BASE/site"

# CONTROLE NEGATIVO DO JUIZ — o gate de reintrodução. A A trocada por uma variável não definida mata
# o script sob `set -u` com exit 1 — o MESMO exit que a A prevê — sem passar pelo ramo do "ausente".
# Ela tem de ser RECUSADA; se o juiz a creditar, ele voltou a contar crash como dente.
PASS_OK=$PASS; FAIL_OK=$FAIL
# shellcheck disable=SC2016
sabota juiz-negativo '[ -s "$TMP/frontier.txt" ]' '[ -s "$NADA_DEFINIDO_JUIZ_NEGATIVO" ]' \
  "$FIX/neutro" 0 1 "$AUSENTE" "" SENTINELA_DEEP_XYZ "$BASE/site" > /dev/null 2>&1
if [ "$PASS" -ne "$PASS_OK" ]; then
  echo "  [XX ] controle negativo do juiz: um CRASH foi creditado como dente — o juiz perdeu a identidade"
  PASS=$PASS_OK; FAIL=$((FAIL_OK + 1))
else
  echo "  [ok ] controle negativo do juiz: a sabotagem que só derruba o script foi RECUSADA"
  FAIL=$FAIL_OK
fi

echo ""
if [ "$FAIL" -eq 0 ] && [ "$PASS" -ge 13 ]; then echo "--falsify: $PASS/$((PASS+FAIL)) pegaram pelo previsto (harness tem dente)"; exit 0
else echo "--falsify: $FAIL sabotagem(ns) NÃO pega(s) pelo previsto em $((PASS+FAIL)) (esperado: 13) — harness cego"; exit 1; fi
