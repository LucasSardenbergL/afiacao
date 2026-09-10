#!/usr/bin/env bash
# monitor-deploy-eval.sh — rede de regressão do "SHA atrás ≠ bundle atrás" (scripts/monitor-deploy.sh).
#
# Determinístico e offline: um repo-fixture com um origin BARE local no papel do GitHub, e um
# `curl` falso que serve o HTML + o entry com o carimbo `__BUILD_SHA__` do cenário. Cada cenário
# aponta a main do origin para um commit e o carimbo para outro, roda o monitor REAL e confere o
# exit E a MARCA do ramo. Só o exit não basta: ALCANCA_BUNDLE e SEM_CLASSIFICACAO saem os dois 3,
# e trocar um pelo outro é perder o motivo sem ficar vermelho.
#
# O caso que dá nome ao arquivo é o `caso_2445`: o delta REAL de 2026-09-10 (ar eee71c80f, main
# 70fc305f3) — docs, scripts, db, CI, eval de skill e UMA entrada de `scripts` no package.json.
#
# --falsify: sabota cada elo da prova em CÓPIA (árvore-espelho scripts/ + evals/, na mesma
# profundidade da skill; o versionado nunca é mutado), um por vez, e exige que o cenário que o
# guarda fique VERMELHO. Antes da primeira sabotagem roda o CONTROLE — a mesma invocação do laço,
# sem sabotagem, nos 2 locales — e aborta se ele não estiver verde. No fim, o CONTROLE DE SAÍDA
# confere pelo conteúdo que os arquivos versionados não mudaram
# (docs/historico/falsificacao-sem-linha-de-base.md).
set -uo pipefail
cd "$(dirname "$0")" || exit 2
SKILL="$(cd .. && pwd)"
FALSIFY=0
[ "${1:-}" = "--falsify" ] && FALSIFY=1

REAL_GIT=$(command -v git) || { echo "❌ git ausente — o eval não observa nada"; exit 2; }
PY=$(command -v python3) || { echo "❌ python3 ausente — o eval não observa nada"; exit 2; }
export REAL_GIT
TMP=$(mktemp -d) || exit 2
trap 'rm -rf "$TMP"' EXIT

# Isola o git de quem roda: config global (diff.renames, diff.relative, quotePath, gpgsign, hooks)
# mudaria o que o fixture grava e o que o monitor enxerga.
export HOME="$TMP/home" XDG_CONFIG_HOME="$TMP/home/.config" GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=eval GIT_AUTHOR_EMAIL=eval@fixture.invalid
export GIT_COMMITTER_NAME=eval GIT_COMMITTER_EMAIL=eval@fixture.invalid
mkdir -p "$HOME" "$TMP/bin" "$TMP/bin-git" "$TMP/bin-py"

# ── binários falsos ─────────────────────────────────────────────────────────────────────────────
cat > "$TMP/bin/curl" <<'FAKE'
#!/usr/bin/env bash
url=""; for a in "$@"; do url="$a"; done
case "$url" in
  */assets/index-*.js) printf 'var a=1;window.__BUILD_SHA__="%s";\n' "${FAKE_AR_SHA:?}" ;;
  */) printf '<html><script type="module" src="/assets/index-Fx1234.js"></script></html>\n' ;;
  *) exit 22 ;;
esac
FAKE
# git que mente SÓ no `diff`: "quebrado" morre no meio com saída plausível; "mudo" sai 0 sem listar
# nada (presente-porém-quebrado). Os dois fabricariam verde se o rc ou o vazio fossem ignorados.
cat > "$TMP/bin-git/git" <<'FAKE'
#!/usr/bin/env bash
for a in "$@"; do
  if [ "$a" = diff ]; then
    case "${GIT_DIFF_MODO:-}" in
      quebrado) echo "docs/a.md"; exit 128 ;;
      mudo) exit 0 ;;
    esac
  fi
done
exec "${REAL_GIT:?}" "$@"
FAKE
printf '#!/usr/bin/env bash\nexit 0\n' > "$TMP/bin-py/python3"
printf '#!/usr/bin/env bash\ncat > /dev/null\nexit 0\n' > "$TMP/classify-mudo.sh"
chmod +x "$TMP/bin/curl" "$TMP/bin-git/git" "$TMP/bin-py/python3" "$TMP/classify-mudo.sh"

# ── repo-fixture ────────────────────────────────────────────────────────────────────────────────
R="$TMP/repo"
O="$TMP/origin.git"
g() { git -C "$R" "$@"; }
escreve() { mkdir -p "$(dirname "$R/$1")" && printf '%s\n' "$2" > "$R/$1"; }
commit() { g add -A && g commit -q -m "$1" && g tag "fx-$1" && g rev-parse HEAD; }
parte_de() { g checkout -q --detach "$1"; }
pkg() { # $1 = scripts extras (JSON com vírgula inicial) · $2 = versão do react · $3 = script build
  printf '{ "name": "fixture", "private": true, "type": "module",\n'
  printf '  "scripts": { "build": "%s", "build:dev": "vite build --mode development", "lint": "eslint ."%s },\n' \
    "${3:-vite build}" "${1:-}"
  printf '  "dependencies": { "react": "%s" } }\n' "${2:-18.3.1}"
}

if ! { git init -q --bare "$O" && git init -q -b main "$R"; }; then echo "❌ git init falhou"; exit 2; fi
escreve index.html '<!doctype html><html><head><link rel="icon" href="/favicon.ico"><link rel="manifest" href="/manifest.webmanifest"></head><body><script type="module" src="/src/main.tsx"></script></body></html>'
escreve public/favicon.ico 'ico'
escreve src/main.tsx 'import { App } from "./App"; import "./index.css"; App();'
escreve src/App.tsx 'import { util } from "@/lib/util"; export const App = () => new URL("/api/saude", location.origin) && util();'
escreve src/lib/util.ts 'export const util = () => 1;'
escreve src/index.css '@tailwind base; .logo { background: url("/favicon.ico"); }'
# teste importando helper de edge: o padrão REAL do repo (janela-pedidos-compra.test.ts) — teste
# não vai para o bundle, e o fechamento não pode tratá-lo como vazamento.
escreve src/lib/__tests__/janela.test.ts 'import { j } from "../../../supabase/functions/_shared/janela.ts"; test("espelho", () => j);'
escreve vite.config.ts 'import path from "path"; export default { resolve: { alias: { "@": path.resolve(__dirname, "./src") } } };'
escreve tailwind.config.ts 'export default { content: ["./pages/**/*.{ts,tsx}", "./src/**/*.{ts,tsx}"] };'
escreve package.json "$(pkg)"
escreve docs/a.md 'a'
escreve docs/b.md 'b'
escreve scripts/x.sh 'echo x'
escreve db/t.sh 'echo t'
escreve .github/workflows/ci.yml 'on: push'
escreve .claude/skills/s/evals/e.sh 'echo e'
escreve supabase/functions/_shared/janela.ts 'export const j = 1;'
escreve CLAUDE.md 'regras'
BASE=$(commit base) || { echo "❌ commit base falhou"; exit 2; }

parte_de "$BASE"; escreve docs/a.md 'a2'; SO_DOCS=$(commit so-docs)
parte_de "$BASE"
escreve docs/a.md 'a3'; escreve scripts/x.sh 'echo x2'; escreve db/t.sh 'echo t2'
escreve .github/workflows/ci.yml 'on: [push]'; escreve .claude/skills/s/evals/e.sh 'echo e2'
escreve package.json "$(pkg ', "sonda:autentica": "bun scripts/gate-sonda-autentica.ts"')"
C2445=$(commit caso-2445)
parte_de "$BASE"; escreve src/App.tsx 'export const App = () => 2;'; SRC=$(commit src)
parte_de "$BASE"; escreve package.json "$(pkg '' 18.3.2)"; PKG_DEPS=$(commit pkg-deps)
parte_de "$BASE"; escreve package.json "$(pkg ', "lint:x": "eslint src"')"; PKG_SCRIPTS=$(commit pkg-scripts)
parte_de "$BASE"; escreve package.json "$(pkg '' 18.3.1 'vite build --mode staging')"; PKG_BUILD=$(commit pkg-build)
parte_de "$BASE"
"$PY" -c 'import json,sys; d=json.load(open(sys.argv[1])); open(sys.argv[1],"w").write(json.dumps(d,indent=4)+"\n")' \
  "$R/package.json"
PKG_FMT=$(commit pkg-fmt)
parte_de "$BASE"; escreve docs/b.md 'b-lateral'; LATERAL=$(commit lateral)
parte_de "$BASE"; g mv src/lib/util.ts docs/util.ts; RENAME=$(commit rename)
parte_de "$BASE"; escreve .lovable/plan.md 'plano'; DESC=$(commit desconhecido)
parte_de "$BASE"; escreve supabase/functions/_shared/janela.ts 'export const j = 2;'; EDGE=$(commit edge-so-teste)
parte_de "$BASE"
escreve src/lib/usa-edge.ts 'import { j } from "../../supabase/functions/_shared/janela"; export const u = j;'
VAZA_BASE=$(commit vaza-base)
escreve supabase/functions/_shared/janela.ts 'export const j = 3;'; VAZA=$(commit vaza)
parte_de "$BASE"
escreve package.json "$(pkg '' 18.3.1 'vite build && node scripts/gera.js')"; escreve scripts/gera.js 'console.log(1)'
SUJO_BASE=$(commit build-sujo-base)
escreve scripts/gera.js 'console.log(2)'; SUJO=$(commit build-sujo)
g branch deadbee1 "$BASE"   # ref com cara de SHA: `deadbee1^{commit}` resolve o BRANCH
if ! { g remote add origin "$O" && g push -q origin 'refs/tags/*:refs/tags/*'; }; then
  echo "❌ push do fixture falhou"; exit 2
fi
for v in BASE SO_DOCS C2445 SRC PKG_DEPS PKG_SCRIPTS PKG_BUILD PKG_FMT LATERAL RENAME DESC EDGE VAZA_BASE VAZA SUJO_BASE SUJO; do
  val=${!v:-}
  [ "${#val}" -eq 40 ] || [ "${#val}" -eq 64 ] || { echo "❌ fixture incompleto: $v='$val'"; exit 2; }
done

# ── cenários: nome → "AR MAIN EXTRA" ─────────────────────────────────────────────────────────────
cenario() {
  case "$1" in
    mesmo_commit)     echo "$SO_DOCS $SO_DOCS -" ;;
    carimbo_curto)    echo "${SO_DOCS:0:7} $SO_DOCS -" ;;
    so_docs)          echo "$BASE $SO_DOCS -" ;;
    caso_2445)        echo "$BASE $C2445 -" ;;
    pkg_so_scripts)   echo "$BASE $PKG_SCRIPTS -" ;;
    pkg_formatacao)   echo "$BASE $PKG_FMT -" ;;
    edge_so_teste)    echo "$BASE $EDGE -" ;;
    src)              echo "$BASE $SRC -" ;;
    pkg_deps)         echo "$BASE $PKG_DEPS -" ;;
    pkg_script_build) echo "$BASE $PKG_BUILD -" ;;
    rename_src_docs)  echo "$BASE $RENAME -" ;;
    desconhecido)     echo "$BASE $DESC -" ;;
    vazamento)        echo "$VAZA_BASE $VAZA -" ;;
    build_sujo)       echo "$SUJO_BASE $SUJO -" ;;
    nao_ancestral)    echo "$LATERAL $SO_DOCS -" ;;
    diff_quebrado)    echo "$BASE $SRC git_quebrado" ;;
    diff_mudo)        echo "$BASE $SRC git_mudo" ;;
    classify_mudo)    echo "$BASE $SO_DOCS classify_mudo" ;;
    python_mudo)      echo "$BASE $SO_DOCS python_mudo" ;;
    fetch_falhou)     echo "$BASE $SO_DOCS fetch_falhou" ;;
    carimbo_alheio)   echo "deadbee2 $SO_DOCS -" ;;
    carimbo_e_branch) echo "deadbee1 $SO_DOCS -" ;;
  esac
}

# nome|exit|marca — marca ASCII, caixa fixa, casada com grep -F sem -i
CASOS='mesmo_commit|0|sincronizado: ar serve
carimbo_curto|0|sincronizado: ar serve
so_docs|5|SINCRONIZADO_EM_BUNDLE
caso_2445|5|SINCRONIZADO_EM_BUNDLE
pkg_so_scripts|5|SINCRONIZADO_EM_BUNDLE
pkg_formatacao|5|SINCRONIZADO_EM_BUNDLE
edge_so_teste|5|SINCRONIZADO_EM_BUNDLE
src|3|motivo: ALCANCA_BUNDLE
pkg_deps|3|motivo: PACKAGE_JSON_ALCANCA
pkg_script_build|3|motivo: PACKAGE_JSON_ALCANCA
rename_src_docs|3|motivo: ALCANCA_BUNDLE
desconhecido|3|motivo: SEM_CLASSIFICACAO
vazamento|3|motivo: ALCANCE_VAZA
build_sujo|3|motivo: BUILD_NAO_RECONHECIDO
nao_ancestral|3|motivo: NAO_ANCESTRAL
diff_quebrado|3|motivo: DIFF_FALHOU
diff_mudo|3|motivo: DELTA_VAZIO
classify_mudo|3|motivo: CLASSIFY_FALHOU
python_mudo|3|motivo: PROVA_INDISPONIVEL
fetch_falhou|3|motivo: FETCH_FALHOU
carimbo_alheio|3|motivo: CARIMBO_NAO_RESOLVE
carimbo_e_branch|3|motivo: CARIMBO_NAO_RESOLVE'

esperado_de() { printf '%s\n' "$CASOS" | awk -F'|' -v c="$1" '$1 == c { print $2 "|" $3; achou = 1 } END { exit !achou }'; }

# roda <raiz da skill> <cenário> <saída> [locale] → exit do monitor
roda() {
  local skill="$1" cen="$2" out="$3" loc="${4:-}" ar main extra carimbo caminho="$TMP/bin:$PATH" envs
  read -r ar main extra <<< "$(cenario "$cen")"
  [ -n "${main:-}" ] || { echo "cenário desconhecido: $cen" > "$out"; return 99; }
  case "${#ar}" in 40 | 64) carimbo=${ar:0:8} ;; *) carimbo=$ar ;; esac
  if ! { git -C "$O" update-ref refs/heads/main "$main" && g remote set-url origin "$O"; }; then
    echo "fixture: não apontei a main" > "$out"; return 98
  fi
  envs=(FAKE_AR_SHA="$carimbo" DEPLOY_MONITOR_STATE="$TMP/estado")
  [ -n "$loc" ] && envs+=(LC_ALL="$loc")
  case "$extra" in
    git_quebrado)  caminho="$TMP/bin-git:$caminho"; envs+=(GIT_DIFF_MODO=quebrado) ;;
    git_mudo)      caminho="$TMP/bin-git:$caminho"; envs+=(GIT_DIFF_MODO=mudo) ;;
    python_mudo)   caminho="$TMP/bin-py:$caminho" ;;
    classify_mudo) envs+=(DEPLOY_MONITOR_CLASSIFY="$TMP/classify-mudo.sh") ;;
    fetch_falhou)  g remote set-url origin "$TMP/origem-que-nao-existe.git"
                   g update-ref refs/remotes/origin/main "$main" ;;
  esac
  (cd "$R" && env PATH="$caminho" "${envs[@]}" bash "$skill/scripts/monitor-deploy.sh" "http://fixture.invalid") \
    > "$out" 2>&1
}

# confere <saída> <exit obtido> <cenário> → 0 se o exit E a marca batem, e as marcas não se misturam
confere() {
  local exp esp marca
  exp=$(esperado_de "$3") || return 1
  esp=${exp%%|*}; marca=${exp#*|}
  [ "$2" -eq "$esp" ] || return 1
  command grep -F -q -- "$marca" "$1" || return 1
  case "$esp" in
    5) ! command grep -F -q -- "ATRASADO" "$1" ;;
    3) ! command grep -F -q -- "SINCRONIZADO_EM_BUNDLE" "$1" ;;
    0) ! command grep -F -q -e "ATRASADO" -e "SINCRONIZADO_EM_BUNDLE" "$1" ;;
  esac
}

rc=0
echo "== monitor-deploy — tabela do classify.sh --bundle =="
TABELA='ALCANCA	src/lib/x.ts
ALCANCA	public/favicon.ico
ALCANCA	index.html
ALCANCA	vite.config.ts
ALCANCA	tailwind.config.ts
ALCANCA	postcss.config.js
ALCANCA	components.json
ALCANCA	tsconfig.app.json
ALCANCA	tsconfig.scripts.json
ALCANCA	.env
ALCANCA	bun.lock
ALCANCA	bun.lockb
ALCANCA	package-lock.json
ALCANCA	patches/react.patch
ALCANCA	pages/Index.tsx
ALCANCA	src/docs/ajuda.md
PACKAGE_JSON	package.json
INERTE	docs/historico/x.md
INERTE	scripts/gate.ts
INERTE	db/test-x.sh
INERTE	supabase/functions/x/index.ts
INERTE	supabase/migrations/20260910_x.sql
INERTE	.claude/skills/y/SKILL.md
INERTE	.github/workflows/ci.yml
INERTE	connector/sayersync/main.go
INERTE	CLAUDE.md
INERTE	vitest.config.ts
INERTE	eslint.config.js
INERTE	knip.json
INERTE	docs/src/x.ts
DESCONHECIDO	.lovable/plan.md
DESCONHECIDO	playwright.config.ts
DESCONHECIDO	src
DESCONHECIDO	"src/com\"aspas.ts"'
printf '%s\n' "$TABELA" | cut -f2 | bash "$SKILL/evals/classify.sh" --bundle > "$TMP/tabela.out" 2>&1
trc=$?
n_tab=$(printf '%s\n' "$TABELA" | awk 'END { print NR }')
if [ "$trc" -eq 0 ] && [ "$(printf '%s\nFIM_CLASSIFICACAO_BUNDLE %s\n' "$TABELA" "$n_tab")" = "$(cat "$TMP/tabela.out")" ]; then
  echo "  [ok ] $n_tab caminhos com a classe esperada + marca de fim com a contagem"
else
  echo "  [XX ] tabela divergiu (rc $trc):"; diff <(printf '%s\nFIM_CLASSIFICACAO_BUNDLE %s\n' "$TABELA" "$n_tab") "$TMP/tabela.out" | head -20
  rc=1
fi

echo ""
echo "== monitor-deploy — SHA atrás não é bundle atrás =="
n_ok=0; n_tot=0
while IFS='|' read -r nome esp marca; do
  [ -n "$nome" ] || continue
  n_tot=$((n_tot + 1))
  roda "$SKILL" "$nome" "$TMP/out"; got=$?
  if confere "$TMP/out" "$got" "$nome"; then
    n_ok=$((n_ok + 1)); printf '  [ok ] %-17s exit %s  %s\n' "$nome" "$got" "$marca"
  else
    printf '  [XX ] %-17s exit %s (esperado %s + "%s")\n' "$nome" "$got" "$esp" "$marca"
    sed 's/^/        | /' "$TMP/out" | head -8
    rc=1
  fi
done <<< "$CASOS"
echo "$n_ok/$n_tot cenários passaram"
[ "$n_tot" -ge 22 ] || { echo "  [XX ] só $n_tot cenário(s) rodaram — a rede encolheu"; rc=1; }

# ── falsificação ────────────────────────────────────────────────────────────────────────────────
if [ "$FALSIFY" = 1 ]; then
  echo ""
  echo "== falsificação (sabota cada elo em CÓPIA, exige vermelho) =="
  # locales: sonda POSITIVA — "setei LC_ALL" não prova que o locale existe (glibc cai em C calado)
  LOCALES="C"
  for cand in pt_BR.UTF-8 pt_BR.utf8 en_US.UTF-8 en_US.utf8 C.UTF-8 C.utf8; do
    if [ "$(LC_ALL="$cand" locale charmap 2>/dev/null)" = "UTF-8" ]; then LOCALES="C $cand"; break; fi
  done
  [ "$LOCALES" = "C" ] && echo "  ⚠️  nenhum locale UTF-8 disponível — falsificação só em C (metade da prova)"

  VERSIONADOS="$SKILL/scripts/monitor-deploy.sh $SKILL/scripts/alcance-bundle.py $SKILL/evals/classify.sh"
  # shellcheck disable=SC2086  # lista de caminhos sem espaço, dividida de propósito
  CK_ANTES=$(cksum $VERSIONADOS)
  espelho() { # cópia fiel da skill na MESMA profundidade: o monitor acha classify/helper por $0
    mkdir -p "$1/scripts" "$1/evals" &&
      cp "$SKILL/scripts/monitor-deploy.sh" "$SKILL/scripts/alcance-bundle.py" "$1/scripts/" &&
      cp "$SKILL/evals/classify.sh" "$1/evals/"
  }
  sabota() { # arquivo · de · para — substituição LITERAL, exige exatamente 1 ocorrência do alvo
    "$PY" - "$1" "$2" "$3" <<'PY'
import sys
arq, de, para = sys.argv[1:4]
s = open(arq, encoding="utf-8").read()
if s.count(de) != 1:
    print("alvo aparece %d vez(es) em %s" % (s.count(de), arq))
    sys.exit(1)
open(arq, "w", encoding="utf-8").write(s.replace(de, para))
PY
  }

  # Arrays paralelos, não tabela com separador: metade dos alvos contém `|` e `||`.
  SAB_ID=(); SAB_ARQ=(); SAB_CEN=(); SAB_DE=(); SAB_PARA=()
  sab() { SAB_ID+=("$1"); SAB_ARQ+=("$2"); SAB_CEN+=("$3"); SAB_DE+=("$4"); SAB_PARA+=("$5"); }
  # id · arquivo (relativo à skill) · cenário que guarda o elo · de · para
  # shellcheck disable=SC2016  # literais do alvo, não devem expandir aqui
  {
    sab ancestral scripts/monitor-deploy.sh nao_ancestral \
      '    1) atrasado NAO_ANCESTRAL' '    1) true || atrasado NAO_ANCESTRAL'
    sab rc-do-diff scripts/monitor-deploy.sh diff_quebrado \
      '[ "$drc" -eq 0 ] || atrasado DIFF_FALHOU' '[ "$drc" -ge 0 ] || atrasado DIFF_FALHOU'
    sab delta-vazio scripts/monitor-deploy.sh diff_mudo \
      '[ "$narq" -gt 0 ] 2>/dev/null' '[ "$narq" -ge 0 ] 2>/dev/null'
    sab no-renames scripts/monitor-deploy.sh rename_src_docs \
      '--no-renames --no-relative' '--find-renames --no-relative'
    sab fetch scripts/monitor-deploy.sh fetch_falhou \
      '[ "$FETCH_OK" = 1 ] || atrasado FETCH_FALHOU' '[ "$FETCH_OK" = 1 ] || true || atrasado FETCH_FALHOU'
    sab prefixo-do-carimbo scripts/monitor-deploy.sh carimbo_e_branch \
      'case "$ar_full" in "$AIR_SHA"?*)' 'case "$ar_full" in ?*)'
    sab marca-positiva scripts/monitor-deploy.sh python_mudo \
      '"0:PROVA_INERCIA_OK "*) ;;' '"0:"*) ;;'
    sab fim-do-classify scripts/monitor-deploy.sh classify_mudo \
      'if (fim != 1 || lixo || n != esperado)' 'if (0)'
    sab tabela-src evals/classify.sh src \
      'if (p ~ /^(src|public|' 'if (p ~ /^(public|'
    sab desconhecido-segura evals/classify.sh desconhecido \
      '  return "DESCONHECIDO"' '  return "INERTE"'
    sab package-json scripts/alcance-bundle.py pkg_deps \
      '    if a != b:' '    if False:'
    sab scripts-do-pipeline scripts/alcance-bundle.py pkg_script_build \
      'return chave in GANCHOS_INSTALL or RE_BUILD.fullmatch(chave) is not None' 'return False'
    sab build-puro scripts/alcance-bundle.py build_sujo \
      'if not isinstance(v, str) or not RE_BUILD_PURO.fullmatch(v.strip()):' 'if False:'
    sab fechamento scripts/alcance-bundle.py vazamento \
      '    if vazamentos:' '    if False:'
    sab teste-fora-do-bundle scripts/alcance-bundle.py edge_so_teste \
      'and not RE_TESTE.search(p)' 'and True'
  }

  # (A) CONTROLE — a mesma invocação do laço (espelho, cenário, locale), sabotagem trocada por
  #     NADA. Vermelho aqui ⇒ aborta ANTES da primeira sabotagem: sem linha de base verde, todo
  #     "ficou vermelho" abaixo seria fabricado.
  espelho "$TMP/controle" || { echo "  [XX ] espelho do controle falhou"; exit 1; }
  for f in scripts/monitor-deploy.sh scripts/alcance-bundle.py evals/classify.sh; do
    cmp -s "$SKILL/$f" "$TMP/controle/$f" || { echo "  [XX ] espelho difere do versionado: $f"; exit 1; }
  done
  n_ctl=0
  for loc in $LOCALES; do
    for i in "${!SAB_ID[@]}"; do
      cen=${SAB_CEN[$i]}
      roda "$TMP/controle" "$cen" "$TMP/out" "$loc"; got=$?
      if ! confere "$TMP/out" "$got" "$cen"; then
        echo "  [XX ] controle SEM sabotagem ja esta VERMELHO: $cen (LC_ALL=$loc, exit $got) — abortando antes da 1a sabotagem"
        sed 's/^/        | /' "$TMP/out" | head -8
        exit 1
      fi
      n_ctl=$((n_ctl + 1))
    done
  done
  echo "  controle: $n_ctl execuções VERDES sem sabotagem (locales: $LOCALES)"

  # (B) SABOTAGEM — uma por vez, cópia fresca; o cenário que guarda o elo tem que ficar vermelho
  #     em CADA locale (vermelho num só não prova a asserção).
  fals=0; total=0
  for i in "${!SAB_ID[@]}"; do
    id=${SAB_ID[$i]} arq=${SAB_ARQ[$i]} cen=${SAB_CEN[$i]} de=${SAB_DE[$i]} para=${SAB_PARA[$i]}
    total=$((total + 1))
    rm -rf "$TMP/sab"
    espelho "$TMP/sab" || { echo "  [XX ] $id: espelho falhou"; rc=1; continue; }
    if ! sabota "$TMP/sab/$arq" "$de" "$para" > "$TMP/sab.err" 2>&1 || cmp -s "$SKILL/$arq" "$TMP/sab/$arq"; then
      echo "  [XX ] $id: a sabotagem NÃO aplicou ($(cat "$TMP/sab.err")) — o eval não estaria testando nada"
      rc=1; continue
    fi
    pegou=0; n_loc=0
    for loc in $LOCALES; do
      n_loc=$((n_loc + 1))
      roda "$TMP/sab" "$cen" "$TMP/out" "$loc"; got=$?
      confere "$TMP/out" "$got" "$cen" || pegou=$((pegou + 1))
    done
    if [ "$pegou" -eq "$n_loc" ]; then
      fals=$((fals + 1)); printf '  [ok ] %-21s arrancado -> %-16s VERMELHO em %d locale(s)\n' "$id" "$cen" "$n_loc"
    else
      printf '  [XX ] %-21s arrancado e %s seguiu VERDE em %d de %d locale(s) — elo sem dente\n' \
        "$id" "$cen" "$((n_loc - pegou))" "$n_loc"
      rc=1
    fi
  done
  echo "  falsificações que pegaram: $fals/$total"
  [ "$total" -ge 15 ] && [ "$fals" -eq "$total" ] || rc=1

  # (C) CONTROLE DE SAÍDA — pelo CONTEÚDO: o laço nunca mutou o versionado.
  # shellcheck disable=SC2086
  if [ "$(cksum $VERSIONADOS)" = "$CK_ANTES" ]; then
    echo "  controle de saída: versionados intactos (cksum igual ao do início)"
  else
    echo "  [XX ] um arquivo versionado MUDOU durante a falsificação"; rc=1
  fi
fi

echo ""
[ "$rc" -eq 0 ] && echo "✅ monitor-deploy: OK" || echo "❌ monitor-deploy: FALHOU"
exit "$rc"
