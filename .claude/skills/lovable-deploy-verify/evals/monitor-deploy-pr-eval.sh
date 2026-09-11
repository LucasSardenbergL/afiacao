#!/usr/bin/env bash
# monitor-deploy-pr-eval.sh — harness LOCAL e DETERMINÍSTICO do `monitor-deploy.sh --pr` e do que
# cerca a pergunta "o PR N está no ar?": o estado do deploy-novo por checkout, o fallback de
# sentinela e o uso inválido. A IGUALDADE e o alcance do delta ar→main têm o harness próprio
# (monitor-deploy-eval.sh); este não os repete.
#
# Por que existe: `--pr` responde por ANCESTRALIDADE, e as armadilhas medidas fabricam "fora do ar"
# com cara de veredito — rc 128 do merge-base lido como rc 1; o head do branch no lugar do squash
# (rc 1 LIMPO num PR que está no ar — #2459); PR não mergeado; fetch que falha; clone raso; um branch
# chamado como o prefixo do carimbo sequestrando o `^{commit}`. Contra prod nada disso se reproduz
# sob demanda; aqui cada uma vira um caso, sem rede externa:
#   - origins git LOCAIS com a história que cada pergunta precisa;
#   - site falso (http.server em 127.0.0.1, porta efêmera) servindo um entry com __BUILD_SHA__;
#   - `gh` de mentira que devolve SÓ os campos pedidos e aplica o --jq com jq de verdade — é o filtro
#     que dá dente ao caso head × squash;
#   - verify-frontend.sh de mentira AO LADO do monitor, com o exit escolhido por caso; o classify.sh
#     e o alcance-bundle.py são os REAIS (a linha de alcance do PR reusa a tabela e a prova deles).
#
# Roda nos DOIS locales (C e um UTF-8); asserção = marca ASCII de caixa fixa casada pelo próprio
# shell — sem grep -i (o #1483 aprovou por acidente de locale) e sem `printf | grep -q` (sob pipefail
# o SIGPIPE já decidiu asserção por corrida neste repo).
#
# Uso:   bash monitor-deploy-pr-eval.sh            # os casos, nos 2 locales (exit 0 = todos ok)
#        bash monitor-deploy-pr-eval.sh --falsify  # CONTROLE verde nos 2 locales e, só então,
#                                                  # sabota CÓPIAS e exige o caso-alvo vermelho
# Exit 2 = a via de prova não subiu (python3, jq, git, locale, servidor) — nunca verde por falta dela.
set -uo pipefail
cd "$(dirname "$0")" || exit 2
EVALS_ABS="$(pwd)"
SCRIPT_ABS="$(cd ../scripts && pwd)/monitor-deploy.sh"
PROVA_ABS="$(cd ../scripts && pwd)/alcance-bundle.py"
FALSIFY=0
[ "${1:-}" = "--falsify" ] && FALSIFY=1

# O ambiente de quem chama não entra nos casos: estado sobrescrito, repo git herdado ou config de
# git do usuário/sistema mudariam o que o monitor mede.
unset DEPLOY_MONITOR_STATE DEPLOY_MONITOR_CLASSIFY GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE \
      GIT_OBJECT_DIRECTORY GIT_COMMON_DIR XDG_CONFIG_HOME
export GIT_CONFIG_NOSYSTEM=1

FIX=$(mktemp -d) && FIX=$(cd "$FIX" && pwd -P) || exit 2
SRV=""
trap '[ -n "$SRV" ] && kill "$SRV" 2>/dev/null; rm -rf "$FIX"' EXIT
export HOME="$FIX/home"
mkdir -p "$HOME"

via_caiu() { echo "❌ VIA_NAO_OBSERVAVEL: $1 — nenhum caso foi julgado, e isto NÃO é verde"; exit 2; }

# ── sondas POSITIVAS da via de prova ────────────────────────────────────────────────────────────
[ "$(python3 -c 'print("ok")' 2>/dev/null)" = "ok" ] || via_caiu "python3 não respondeu"
[ "$(printf '{"a":1}' | jq -r .a 2>/dev/null)" = "1" ] || via_caiu "jq não respondeu (o gh-stub aplica o --jq com ele)"
case "$(git --version 2>/dev/null)" in "git version "*) ;; *) via_caiu "git não respondeu" ;; esac
LOCS=$(locale -a 2>/dev/null)
LOC_UTF8=""
for cand in pt_BR.UTF-8 pt_BR.utf8 en_US.UTF-8 en_US.utf8 C.UTF-8 C.utf8; do
  case "
$LOCS
" in *"
$cand
"*) LOC_UTF8="$cand"; break ;; esac
done
[ -n "$LOC_UTF8" ] || via_caiu "nenhum locale UTF-8 (pt_BR/en_US/C) — a metade UTF-8 da suíte não rodaria"
LOCALES="C $LOC_UTF8"

# ── história git ─────────────────────────────────────────────────────────────────────────────────
G() { # dir args… — git com identidade fixa (o HOME do fixture não tem config)
  local d="$1"; shift
  git -C "$d" -c user.email=eval@local -c user.name=eval -c commit.gpgsign=false -c tag.gpgsign=false "$@"
}
escreve() { mkdir -p "$(dirname "$1")" && printf '%s\n' "$2" > "$1"; }
commit() { G "$1" add -A && G "$1" commit -q -m "$2" && git -C "$1" rev-parse HEAD; }
c8() { printf '%s' "$1" | cut -c1-8; }

A="$FIX/autor"
if ! { mkdir -p "$A" && git -c init.defaultBranch=main init -q "$A"; }; then via_caiu "git init"; fi
escreve "$A/src/app.tsx" 'export const App = () => "v1";'
escreve "$A/index.html" '<script type="module" src="/src/app.tsx"></script>'
escreve "$A/vite.config.ts" 'export default { plugins: [] };'
escreve "$A/package.json" '{"name":"fx","dependencies":{"react":"19.0.0"},"scripts":{"build":"vite build","test":"vitest"}}'
escreve "$A/docs/a.md" '# a'
escreve "$A/.github/workflows/ci.yml" 'on: push'
escreve "$A/scripts/x.sh" 'echo x'
escreve "$A/supabase/functions/x/index.ts" 'Deno.serve(() => new Response("v1"));'
C0=$(commit "$A" "base")
escreve "$A/docs/a.md" '# a v2'
C1=$(commit "$A" "docs")
escreve "$A/src/app.tsx" 'export const App = () => "v2";'
C2=$(commit "$A" "feat src (o squash do #1)")
escreve "$A/docs/c.md" '# c'
C3=$(commit "$A" "docs de novo")
escreve "$A/docs/d.md" '# d'
C4=$(commit "$A" "mais docs")
# C5 = o squash do #6: o delta MEDIDO do #2445 (CI, scripts/, docs, UMA entrada nova em
# package.json#scripts) e mais o que também não vai ao bundle servido — edge, skill, README.
escreve "$A/.github/workflows/ci.yml" 'on: [push, pull_request]'
escreve "$A/scripts/x.sh" 'echo xx'
escreve "$A/docs/b.md" '# b'
escreve "$A/package.json" '{"name":"fx","dependencies":{"react":"19.0.0"},"scripts":{"build":"vite build","test":"vitest","evals:x":"bash x.sh"}}'
escreve "$A/supabase/functions/x/index.ts" 'Deno.serve(() => new Response("v2"));'
escreve "$A/.claude/skills/y/SKILL.md" '# y'
escreve "$A/README.md" '# fx'
C5=$(commit "$A" "ci + docs + scripts + package.json#scripts (o delta do #2445)")
# O HEAD do branch do #1: mesma mudança do squash C2, commit DIFERENTE (outro pai).
G "$A" checkout -q -b feat "$C0"
escreve "$A/src/app.tsx" 'export const App = () => "v2";'
H1=$(commit "$A" "feat src (head do branch)")
G "$A" tag pr1 "$C2"
G "$A" checkout -q -B rev "$C5"     # o squash do #1 fica na história, mas o conteúdo é desfeito
G "$A" revert --no-edit "$C2" >/dev/null 2>&1 || via_caiu "git revert"
G "$A" commit -q --amend -m 'Revert "feat src" (#99)' -m "Reverts eval/fixture#1"
C9=$(git -C "$A" rev-parse HEAD)
G "$A" checkout -q -B build "$C5"   # o #8 muda o script de BUILD: inerte por NOME, não pela prova
escreve "$A/package.json" '{"name":"fx","dependencies":{"react":"19.0.0"},"scripts":{"build":"vite build --mode development","test":"vitest","evals:x":"bash x.sh"}}'
C8=$(commit "$A" "build em modo development")
for s in "$C0" "$C1" "$C2" "$C3" "$C4" "$C5" "$C8" "$C9" "$H1"; do
  case "$s" in [0-9a-f]*) ;; *) via_caiu "a história do fixture não subiu" ;; esac
done

origem() { # nome refspec…
  local o="$FIX/$1.git"; shift
  if ! { git -c init.defaultBranch=main init -q --bare "$o" && G "$A" push -q "$o" "$@" 2>/dev/null; }; then
    via_caiu "push para $o"
  fi
}
origem origin "$C5:refs/heads/main" "$H1:refs/heads/feat" "refs/tags/pr1" "$C8:refs/heads/build-alt"
origem origin-rev "$C9:refs/heads/main"
origem origin-velho "$C2:refs/heads/main" "$C5:refs/heads/adiante"

clona() { git clone -q "$@" 2>/dev/null || via_caiu "clone $*"; }
CLONE="$FIX/clone";         clona "$FIX/origin.git" "$CLONE"
EA="$FIX/estado-a";         clona "$FIX/origin.git" "$EA"
EB="$FIX/estado-b";         clona "$FIX/origin.git" "$EB"
CREV="$FIX/c-rev";          clona "$FIX/origin-rev.git" "$CREV"
# offline: o fetch falha, com o squash E o ar no clone — no --pr, isso tem de ser "não consegui".
OFF="$FIX/offline";         clona "$FIX/origin-velho.git" "$OFF"
git -C "$OFF" remote set-url origin "$FIX/nao-existe.git"
# raso: só C5 e o squash C2 (pela tag), sem a história entre eles — a ancestralidade para na borda.
RASO="$FIX/raso";           clona --depth 1 "file://$FIX/origin.git" "$RASO"
git -C "$RASO" fetch -q --depth 1 origin "refs/tags/pr1:refs/tags/pr1" 2>/dev/null || via_caiu "fetch da tag no raso"
DESC="a0a0a0a0"
# Um BRANCH chamado como o carimbo desconhecido: `a0a0a0a0^{commit}` passa a resolver (para C5) —
# só a checagem de prefixo impede o ar "desconhecido" de virar C5 e o PR sair "no ar".
G "$CLONE" branch "$DESC" "$C5" || via_caiu "branch $DESC"

# Pré-condições dos fixtures, MEDIDAS: sem elas o caso passaria sem a armadilha existir.
git -C "$CLONE" merge-base --is-ancestor "$C2" "$C5" || via_caiu "fixture: o squash não é ancestral da main"
if git -C "$CLONE" merge-base --is-ancestor "$H1" "$C5"; then via_caiu "fixture: o head É ancestral — head×squash sem dente"; fi
git -C "$CLONE" cat-file -e "$H1^{commit}" 2>/dev/null || via_caiu "fixture: o head não está no clone (no #2459 estava)"
[ "$(git -C "$RASO" rev-parse --is-shallow-repository)" = "true" ] || via_caiu "fixture: o raso não é raso"
git -C "$RASO" merge-base --is-ancestor "$C2" "$C5"; rc_raso=$?
[ "$rc_raso" = 1 ] || via_caiu "fixture: no raso a ancestralidade deu $rc_raso, não o rc 1 FALSO que o caso existe para pegar"
[ "$(git -C "$CLONE" rev-parse --verify --quiet "$DESC^{commit}")" = "$C5" ] \
  || via_caiu "fixture: o branch $DESC não sequestra o ^{commit} — a checagem de prefixo ficaria sem dente"
git -C "$OFF" cat-file -e "$C5^{commit}" 2>/dev/null || via_caiu "fixture: o offline não conhece C5"

# ── site falso ───────────────────────────────────────────────────────────────────────────────────
W="$FIX/www"
site() { # nome carimbo("-" = nenhum) entry [2º carimbo]
  mkdir -p "$W/$1/assets"
  printf '<!doctype html><script type="module" src="/assets/index-%s.js"></script>\n' "$3" > "$W/$1/index.html"
  if [ "$2" = "-" ]; then printf 'console.log("sem carimbo");\n' > "$W/$1/assets/index-$3.js"
  else printf 'window.__BUILD_SHA__="%s";console.log(1);\n' "$2" > "$W/$1/assets/index-$3.js"; fi
  [ -z "${4:-}" ] || printf 'const x={__BUILD_SHA__="%s"};\n' "$4" >> "$W/$1/assets/index-$3.js"
}
for s in "$C1" "$C2" "$C4" "$C5" "$C9"; do site "ar-$(c8 "$s")" "$(c8 "$s")" "$(c8 "$s")"; done
site "ar-$DESC" "$DESC" desc
site ar-dev dev dev1
site duplo "$(c8 "$C5")" duplo "$(c8 "$C1")"
mkdir -p "$W/entry404"
printf '<script type="module" src="/assets/index-sumiu.js"></script>\n' > "$W/entry404/index.html"

python3 -c '
import http.server, socketserver, sys, os
os.chdir(sys.argv[1])
H = http.server.SimpleHTTPRequestHandler
H.log_message = lambda *a, **k: None
with socketserver.TCPServer(("127.0.0.1", 0), H) as s:
    sys.stdout.write(str(s.server_address[1]) + "\n"); sys.stdout.flush()
    s.serve_forever()
' "$W" > "$FIX/porta" 2>/dev/null &
SRV=$!
disown "$SRV" 2>/dev/null   # sem isto o bash anuncia "Terminated" quando o trap mata o servidor
PORT=""
for _ in $(seq 1 100); do
  PORT=$(head -1 "$FIX/porta" 2>/dev/null | tr -d '[:space:]')
  [ -n "$PORT" ] && break
  sleep 0.05
done
[ -n "$PORT" ] || via_caiu "o servidor de fixtures não subiu"
BASE="http://127.0.0.1:$PORT"
U() { printf '%s/ar-%s' "$BASE" "$(c8 "$1")"; }

# ── stubs ────────────────────────────────────────────────────────────────────────────────────────
mkdir -p "$FIX/stubs" "$FIX/gh"
cat > "$FIX/stubs/gh" <<'SH'
#!/usr/bin/env bash
# gh de mentira: só `gh pr view <n> --json <campos> --jq <expr>`, sobre $GH_STUB_DIR/<n>.json,
# FILTRADO aos campos pedidos (como o gh real) e com o --jq aplicado por um jq de verdade. Pedir
# headRefOid e ler mergeCommit (ou o contrário) devolve null — nunca o valor certo por acaso.
[ "${1:-} ${2:-}" = "pr view" ] || { echo "gh-stub: chamada inesperada: $*" >&2; exit 64; }
n="$3"; shift 3; campos=""; expr=""
while [ $# -gt 0 ]; do
  case "$1" in
    --json) campos="$2"; shift 2 ;;
    --jq)   expr="$2"; shift 2 ;;
    *) echo "gh-stub: flag inesperada: $1" >&2; exit 64 ;;
  esac
done
f="$GH_STUB_DIR/$n.json"
[ -f "$f" ] || { echo "GraphQL: Could not resolve to a PullRequest with the number of $n." >&2; exit 1; }
filtro=$(printf '%s' "$campos" | tr ',' '\n' | awk 'NF { printf "%s%s: .%s", (n++ ? ", " : ""), $1, $1 }')
json=$(jq -c "{ $filtro }" "$f") || exit 70
if [ -n "$expr" ]; then printf '%s\n' "$json" | jq -r "$expr"; else printf '%s\n' "$json"; fi
SH
cat > "$FIX/vf-stub.sh" <<'SH'
#!/usr/bin/env bash
# verify-frontend.sh de mentira: o monitor só lê o exit dele. Forma errada de chamada = 99.
[ $# -eq 2 ] || { echo "vf-stub: esperava <sentinela> <url>, recebi $# arg(s)" >&2; exit 99; }
echo "vf-stub: sentinela='$1' rc=${STUB_VF_RC:-99}"
exit "${STUB_VF_RC:-99}"
SH
chmod +x "$FIX/stubs/gh" "$FIX/vf-stub.sh"
pr_json() { # n estado squash|null base
  local sq='null'
  [ "$3" = null ] || sq="{\"oid\":\"$3\"}"
  printf '{"number":%s,"state":"%s","mergeCommit":%s,"baseRefName":"%s","headRefOid":"%s"}\n' \
    "$1" "$2" "$sq" "$4" "$H1" > "$FIX/gh/$1.json"
}
pr_json 1 MERGED "$C2" main
pr_json 2 OPEN null main
pr_json 3 MERGED d3adb33fd3adb33fd3adb33fd3adb33fd3adb33f main
pr_json 4 MERGED "$C2" develop
pr_json 6 MERGED "$C5" main
pr_json 7 MERGED null main
pr_json 8 MERGED "$C8" main
# (o #5 não tem arquivo: o gh-stub responde como o GraphQL a um PR inexistente, exit 1)

# O monitor sob teste mora num layout IGUAL ao da skill: ele chama "$SELF_DIR/verify-frontend.sh"
# (o stub), "$SELF_DIR/alcance-bundle.py" e "$SELF_DIR/../evals/classify.sh" (os REAIS, por symlink).
mondir() { # destino fonte
  rm -rf "$1" && mkdir -p "$1/scripts" "$1/evals" \
    && cp "$2" "$1/scripts/monitor-deploy.sh" && cp "$FIX/vf-stub.sh" "$1/scripts/verify-frontend.sh" \
    && ln -s "$PROVA_ABS" "$1/scripts/alcance-bundle.py" && ln -s "$EVALS_ABS/classify.sh" "$1/evals/classify.sh" \
    && chmod +x "$1/scripts/monitor-deploy.sh" "$1/scripts/verify-frontend.sh"
}
CTL="$FIX/mon-ctl"
mondir "$CTL" "$SCRIPT_ABS" || via_caiu "cópia do monitor"
cmp -s "$SCRIPT_ABS" "$CTL/scripts/monitor-deploy.sh" || via_caiu "a cópia de controle difere do monitor real"
cp "$SCRIPT_ABS" "$FIX/monitor-original.sh"

# ── runner ───────────────────────────────────────────────────────────────────────────────────────
MON="$CTL"; LOC="C"; OUT=""; RC=0; PASS=0; FAIL=0; SO_CASO=""
CASO_ESTADO=""; CASO_VF_RC=""
roda() { # cwd args…
  local cwd="$1"; shift
  OUT=$(cd "$cwd" && env LC_ALL="$LOC" PATH="$FIX/stubs:$PATH" GH_STUB_DIR="$FIX/gh" \
        GIT_CEILING_DIRECTORIES="$FIX" STUB_VF_RC="${CASO_VF_RC:-99}" DEPLOY_MONITOR_STATE="$CASO_ESTADO" \
        bash "$MON/scripts/monitor-deploy.sh" "$@" 2>&1); RC=$?
}
tem_todas() { # saída marcas(;) → 0 se TODAS aparecem
  local s="$1" resto="$2" m
  while [ -n "$resto" ]; do
    m="${resto%%;*}"
    if [ "$m" = "$resto" ]; then resto=""; else resto="${resto#*;}"; fi
    [ -z "$m" ] && continue
    case "$s" in *"$m"*) ;; *) return 1 ;; esac
  done
  return 0
}
tem_nenhuma() { # saída marcas(;) → 0 se NENHUMA aparece
  local s="$1" resto="$2" m
  while [ -n "$resto" ]; do
    m="${resto%%;*}"
    if [ "$m" = "$resto" ]; then resto=""; else resto="${resto#*;}"; fi
    [ -z "$m" ] && continue
    case "$s" in *"$m"*) return 1 ;; esac
  done
  return 0
}
caso() { # id descrição cwd exit exigidas(;) proibidas(;) args…
  local id="$1" descr="$2" cwd="$3" exp="$4" want="$5" nao="$6" ok=1
  shift 6
  [ -z "$SO_CASO" ] || [ "$SO_CASO" = "$id" ] || return 0
  roda "$cwd" "$@"
  [ "$RC" = "$exp" ] || ok=0
  tem_todas "$OUT" "$want" || ok=0
  tem_nenhuma "$OUT" "$nao" || ok=0
  if [ "$ok" = 1 ]; then
    PASS=$((PASS + 1)); printf '  [ok ] %-12s %s (exit %s)\n' "$id" "$descr" "$RC"
  else
    FAIL=$((FAIL + 1))
    printf '  [XX ] %-12s %s (esperado exit %s + [%s] sem [%s]; obtido exit %s)\n' "$id" "$descr" "$exp" "$want" "$nao" "$RC"
    printf '        saída: %s\n' "$(printf '%s' "$OUT" | tr '\n' '|' | cut -c1-900)"
  fi
}
grupo() { [ -z "$SO_CASO" ] || [ "$SO_CASO" = "$1" ]; }   # passos com estado rodam juntos

suite() {
  echo "  --pr — o SQUASH do PR está na história do commit que o ar serve?"
  caso prnoar    "squash ancestral do ar (o head do branch NÃO é — o caso do #2459)" "$CLONE" 0 \
       "PR_NO_AR" "PR_FORA_DO_AR;AVISO_REVERT_POSTERIOR;NAO_CONSEGUI_MEDIR" --pr 1 "$(U "$C5")"
  caso prigual   "o ar É o squash" "$CLONE" 0 "PR_NO_AR" "" --pr 1 "$(U "$C2")"
  caso prfora    "ar de antes do squash, e o PR toca o bundle" "$CLONE" 3 \
       "PR_FORA_DO_AR;PR_TOCA_O_BUNDLE;src/app.tsx" "PR_SEM_ALCANCE_NO_BUNDLE" --pr 1 "$(U "$C1")"
  caso prsemalc  "fora do ar, mas o PR é o delta do #2445: publicar não muda nada para ele" "$CLONE" 3 \
       "PR_FORA_DO_AR;PR_SEM_ALCANCE_NO_BUNDLE" "PR_TOCA_O_BUNDLE;PR_ALCANCE_NAO_PROVADO" --pr 6 "$(U "$C4")"
  caso prbuild   "PR que só muda o script de BUILD: inerte por nome, refutado pela prova" "$CLONE" 3 \
       "PR_FORA_DO_AR;PR_ALCANCE_NAO_PROVADO" "PR_SEM_ALCANCE_NO_BUNDLE" --pr 8 "$(U "$C5")"
  caso praberto  "PR aberto (mergeCommit null): 'não consegui', nunca 'fora do ar'" "$CLONE" 6 \
       "NAO_CONSEGUI_MEDIR (PR_NAO_MERGEADO)" "PR_FORA_DO_AR" --pr 2 "$(U "$C5")"
  caso prsemsq   "MERGED sem mergeCommit" "$CLONE" 6 "NAO_CONSEGUI_MEDIR (PR_NAO_MERGEADO)" "PR_FORA_DO_AR" --pr 7 "$(U "$C5")"
  caso prsqdesc  "squash que o clone não conhece: rc 128 NÃO é rc 1" "$CLONE" 6 \
       "NAO_CONSEGUI_MEDIR (SHA_DESCONHECIDO)" "PR_FORA_DO_AR;PR_NO_AR" --pr 3 "$(U "$C5")"
  caso prbase    "PR mergeado em outra base" "$CLONE" 6 "NAO_CONSEGUI_MEDIR (PR_BASE_NAO_E_MAIN)" "PR_NO_AR" --pr 4 "$(U "$C5")"
  caso prgh      "gh falhou" "$CLONE" 6 "NAO_CONSEGUI_MEDIR (GH_FALHOU)" "PR_NAO_MERGEADO" --pr 5 "$(U "$C5")"
  caso prardesc  "carimbo desconhecido, e um BRANCH com o mesmo nome: o prefixo não confere" "$CLONE" 6 \
       "NAO_CONSEGUI_MEDIR (SHA_DESCONHECIDO)" "PR_NO_AR;PR_FORA_DO_AR" --pr 1 "$BASE/ar-$DESC"
  caso prdev     "ar sem carimbo: ancestralidade não se mede" "$CLONE" 6 "NAO_CONSEGUI_MEDIR (SEM_CARIMBO)" "" --pr 1 "$BASE/ar-dev"
  caso prduplo   "dois carimbos distintos: 'não consegui', nunca o 'ATRASADO' da igualdade" "$CLONE" 6 \
       "NAO_CONSEGUI_MEDIR (CARIMBO_AMBIGUO)" "ATRASADO;PR_NO_AR" --pr 1 "$BASE/duplo"
  caso proffline "fetch falho no --pr é fail-CLOSED, com os dois commits no clone" "$OFF" 6 \
       "NAO_CONSEGUI_MEDIR (FETCH_FALHOU)" "PR_NO_AR" --pr 1 "$(U "$C5")"
  caso praso     "clone raso: o rc 1 da borda NÃO vira 'fora do ar'" "$RASO" 6 \
       "NAO_CONSEGUI_MEDIR (CLONE_RASO)" "PR_FORA_DO_AR" --pr 1 "$(U "$C5")"
  caso prrevert  "squash na história, mas revertido depois: no ar, COM o aviso" "$CREV" 0 \
       "PR_NO_AR;AVISO_REVERT_POSTERIOR" "" --pr 1 "$(U "$C9")"
  echo "  USO — argumento que não se entende é exit 6, nunca veredito"
  caso usoabc    "--pr não numérico" "$CLONE" 6 "USO_INVALIDO" "" --pr abc "$(U "$C5")"
  caso usovazio  "--pr vazio não cai calado no modo igualdade" "$CLONE" 6 "USO_INVALIDO" "sincronizado" --pr "" "$(U "$C5")"
  caso usosozinho "--pr sem número" "$CLONE" 6 "USO_INVALIDO" "" --pr
  caso usosent   "--pr com sentinela" "$CLONE" 6 "USO_INVALIDO" "" --pr 1 "$(U "$C5")" alguma-sentinela
  caso semesquema "url sem https:// é uso inválido, não 'fora do ar'" "$CLONE" 6 "USO_INVALIDO" "fora do ar" \
       "127.0.0.1:$PORT/ar-$(c8 "$C5")"
  caso entry404  "entry que não baixa: exit 2, nunca 'sem carimbo'" "$CLONE" 2 "ENTRY_NAO_BAIXOU" "nada a relatar;deploy novo" "$BASE/entry404"
  echo "  SENTINELA — o verify-frontend tem QUATRO saídas, não duas"
  CASO_VF_RC=0; caso sentinela "rc 0 ⇒ presente" "$CLONE" 0 "SENTINELA_PRESENTE" "" "$BASE/ar-dev" s
  CASO_VF_RC=1; caso sentinela "rc 1 ⇒ ausente" "$CLONE" 3 "SENTINELA_AUSENTE" "SENTINELA_SEM_VEREDITO" "$BASE/ar-dev" s
  CASO_VF_RC=2; caso sentinela "rc 2 (sonda não confiável) NÃO é ausente" "$CLONE" 3 \
       "SENTINELA_SEM_VEREDITO" "SENTINELA_AUSENTE" "$BASE/ar-dev" s
  CASO_VF_RC=3; caso sentinela "rc 3 (recusa) NÃO é ausente" "$CLONE" 3 \
       "SENTINELA_SEM_VEREDITO" "SENTINELA_AUSENTE" "$BASE/ar-dev" s
  CASO_VF_RC=""
  echo "  SEM CARIMBO — a 1ª checagem é '?', nunca 'SIM (1a-vez)'"
  if grupo semcarimbo; then
    CASO_ESTADO="$FIX/semcarimbo.state"; rm -f "$CASO_ESTADO"; site semcarimbo dev dev1
    caso semcarimbo "1ª checagem" "$CLONE" 4 "deploy-novo=?;1a checagem deste checkout" "deploy-novo=SIM" "$BASE/semcarimbo"
    caso semcarimbo "nada mudou" "$CLONE" 0 "deploy-novo=nao;nada a relatar" "" "$BASE/semcarimbo"
    site semcarimbo - dev2
    caso semcarimbo "entry novo" "$CLONE" 4 "deploy-novo=SIM;deploy novo detectado" "" "$BASE/semcarimbo"
    CASO_ESTADO=""
  fi
  echo "  ESTADO — deploy-novo é relativo a ESTE checkout, nunca à máquina"
  if grupo estado; then
    rm -f "$(git -C "$EA" rev-parse --absolute-git-dir)/deploy-monitor.state" \
          "$(git -C "$EB" rev-parse --absolute-git-dir)/deploy-monitor.state" "$HOME/.config/afiacao/deploy-monitor.state"
    site estado "$(c8 "$C5")" e1
    caso estado "checkout A, 1ª vez" "$EA" 0 "sincronizado;deploy-novo=?" "" "$BASE/estado"
    caso estado "checkout A, de novo" "$EA" 0 "deploy-novo=nao" "" "$BASE/estado"
    caso estado "checkout B nunca olhou: '?', mesmo com A já tendo visto o entry" "$EB" 0 \
         "deploy-novo=?" "deploy-novo=nao" "$BASE/estado"
    site estado "$(c8 "$C5")" e2
    caso estado "checkout A vê o entry novo" "$EA" 0 "deploy-novo=SIM" "" "$BASE/estado"
    if [ -e "$HOME/.config/afiacao/deploy-monitor.state" ]; then
      FAIL=$((FAIL + 1)); echo "  [XX ] estado       o monitor gravou o estado GLOBAL da máquina (\$HOME/.config/afiacao)"
    fi
  fi
}

if [ "$FALSIFY" = 0 ]; then
  for LOC in $LOCALES; do
    echo "monitor-deploy --pr (harness local, LC_ALL=$LOC, $BASE):"
    suite
    echo ""
  done
  if [ "$FAIL" -eq 0 ]; then echo "monitor-deploy --pr: $PASS/$((PASS + FAIL)) passaram (2 locales)"; exit 0; fi
  echo "monitor-deploy --pr: $FAIL FALHA(S) de $((PASS + FAIL))"
  exit 1
fi

# ── --falsify ────────────────────────────────────────────────────────────────────────────────────
echo "monitor-deploy --pr --falsify (sabota CÓPIAS do monitor; o caso-alvo TEM de ficar vermelho):"
# (A) CONTROLE: a mesma invocação do laço de sabotagem — o mesmo layout, o mesmo runner — com a
#     sabotagem trocada por NADA, verde nos 2 locales, e aborta ANTES da 1ª sabotagem. Sem ele uma
#     suíte sempre-vermelha "pegaria" todas. → docs/historico/falsificacao-sem-linha-de-base.md
for LOC in $LOCALES; do
  PASS=0; FAIL=0; MON="$CTL"; SO_CASO=""
  suite > "$FIX/controle.out" 2>&1
  if [ "$FAIL" -ne 0 ] || [ "$PASS" -eq 0 ]; then
    echo "  [XX ] controle SEM sabotagem ja esta VERMELHO (LC_ALL=$LOC, $FAIL falha(s), $PASS ok) — nenhuma sabotagem foi tentada:"
    cat "$FIX/controle.out"
    exit 1
  fi
  echo "  [ok ] controle: $PASS casos verdes com o monitor ÍNTEGRO (LC_ALL=$LOC)"
done

aplica() { # destino (de para)… — cada `de` tem de aparecer EXATAMENTE 1 vez no monitor real
  python3 - "$SCRIPT_ABS" "$@" <<'PY'
import sys
src, dst, pares = sys.argv[1], sys.argv[2], sys.argv[3:]
txt = open(src, encoding="utf-8").read()
if len(pares) % 2:
    sys.exit("pares de/para incompletos")
for de, para in zip(pares[0::2], pares[1::2]):
    n = txt.count(de)
    if n != 1:
        sys.exit("o alvo aparece %d vez(es): %r" % (n, de[:90]))
    txt = txt.replace(de, para, 1)
open(dst, "w", encoding="utf-8").write(txt)
PY
}
CEGAS=0; PEGAS=0
sabota() { # nome caso-alvo (de para)…
  local nome="$1" alvo="$2" sab="$FIX/mon-sab" loc
  shift 2
  mondir "$sab" "$SCRIPT_ABS" || via_caiu "cópia para sabotar"
  if ! aplica "$sab/scripts/monitor-deploy.sh" "$@" 2> "$FIX/aplica.err"; then
    printf '  [XX ] sabotagem NO-OP/AMBÍGUA: %s — %s\n' "$nome" "$(tr '\n' ' ' < "$FIX/aplica.err")"
    CEGAS=$((CEGAS + 1)); return
  fi
  if cmp -s "$sab/scripts/monitor-deploy.sh" "$SCRIPT_ABS"; then
    printf '  [XX ] sabotagem não mudou byte nenhum: %s\n' "$nome"; CEGAS=$((CEGAS + 1)); return
  fi
  if ! bash -n "$sab/scripts/monitor-deploy.sh" 2>/dev/null; then   # vermelho por SINTAXE é motivo errado
    printf '  [XX ] sabotagem quebrou a sintaxe (vermelho pelo motivo errado): %s\n' "$nome"; CEGAS=$((CEGAS + 1)); return
  fi
  for loc in $LOCALES; do
    LOC="$loc"
    # baseline MEDIDA, na mesma invocação: o caso-alvo passa com o monitor íntegro
    PASS=0; FAIL=0; MON="$CTL"; SO_CASO="$alvo"; suite > /dev/null 2>&1
    if [ "$FAIL" -ne 0 ] || [ "$PASS" -eq 0 ]; then
      printf '  [XX ] o caso-alvo "%s" não passa com o monitor ÍNTEGRO (LC_ALL=%s): %s\n' "$alvo" "$loc" "$nome"
      CEGAS=$((CEGAS + 1)); SO_CASO=""; return
    fi
    PASS=0; FAIL=0; MON="$sab"; SO_CASO="$alvo"; suite > /dev/null 2>&1
    if [ "$FAIL" -eq 0 ]; then
      printf '  [XX ] sabotagem PASSOU DESPERCEBIDA (LC_ALL=%s): %s — caso %s\n' "$loc" "$nome" "$alvo"
      CEGAS=$((CEGAS + 1)); SO_CASO=""; return
    fi
  done
  SO_CASO=""; MON="$CTL"
  PEGAS=$((PEGAS + 1)); printf '  [ok ] pega nos 2 locales (caso %s): %s\n' "$alvo" "$nome"
}

# (B) as sabotagens — cada uma arranca UMA decisão do --pr, do estado, da sentinela ou do uso.
# SC2016 na função inteira: os `$` dos pares de/para são LITERAIS do monitor-deploy.sh — é o texto que
# se procura e o que se põe no lugar, e expandi-los aqui destruiria a sabotagem.
# shellcheck disable=SC2016
sabotagens() {
sabota "os 3 ramos colapsam: rc 128 (squash desconhecido) vira 'fora do ar'" prsqdesc \
  '    1) veredito_pr_fora_do_ar ;;' '    *) veredito_pr_fora_do_ar ;;'
sabota "headRefOid no lugar do mergeCommit (rc 1 LIMPO num PR no ar — #2459)" prnoar \
  '--json state,mergeCommit,baseRefName' '--json state,headRefOid,baseRefName' \
  '(.mergeCommit.oid // "-")' '(.headRefOid // "-")'
sabota "PR não mergeado deixa de ser checado" praberto \
  '  if [ "${PR_STATE:-}" != "MERGED" ] || ! eh_sha "${PR_SQUASH:-}"; then' '  if false; then'
sabota "gh que falha segue como se tivesse respondido" prgh \
  '  [ "$GH_RC" -eq 0 ] || nao_consegui GH_FALHOU' '  [ "$GH_RC" -eq 0 ] || : GH_FALHOU'
sabota "base != main deixa de ser checada" prbase \
  '  [ "${PR_BASE:-}" = "main" ] || nao_consegui PR_BASE_NAO_E_MAIN' '  : PR_BASE_NAO_E_MAIN'
sabota "fetch falho no --pr volta a ser engolido" proffline \
  '  [ "$FETCH_OK" = 1 ] || nao_consegui FETCH_FALHOU' '  [ "$FETCH_OK" = 1 ] || : FETCH_FALHOU'
sabota "clone raso deixa de ser recusado" praso \
  '[ "$(git rev-parse --is-shallow-repository 2>/dev/null)" = "false" ]' 'true'
sabota "carimbo ambíguo deixa de ser recusado no --pr" prduplo \
  '  [ "${N_CARIMBOS:-0}" -le 1 ] || nao_consegui CARIMBO_AMBIGUO' '  : CARIMBO_AMBIGUO'
sabota "o prefixo do carimbo deixa de ser conferido (um branch sequestra o ^{commit})" prardesc \
  'case "$AR_FULL" in "$AIR_SHA"?*) eh_sha "$AR_FULL" ;; *) false ;; esac' \
  'case "$AR_FULL" in ?*) eh_sha "$AR_FULL" ;; *) false ;; esac'
sabota "'sem alcance' sem a prova do alcance-bundle.py" prbuild \
  $'    "0:PROVA_INERCIA_OK "*)\n      echo "     PR_SEM_ALCANCE_NO_BUNDLE:' \
  $'    *)\n      echo "     PR_SEM_ALCANCE_NO_BUNDLE:'
sabota "arquivo ALCANCA do PR deixa de contar" prfora \
  '  if [ "$nb" -gt 0 ]; then' '  if false; then'
sabota "aviso de revert apagado" prrevert \
  'AVISO_REVERT_POSTERIOR:' 'XXXXX_REVERT_POSTERIOR:'
sabota "--pr vazio passa a validação" usovazio \
  "  case \"\$PR\" in ''|*[!0-9]*) uso" "  case \"\$PR\" in *[!0-9]*) uso"
sabota "url sem esquema aceita" semesquema \
  'case "$APP" in http://*|https://*) ;;' 'case "$APP" in *) ;;'
sabota "entry que não baixa vira 'sem carimbo'" entry404 \
  '[ -n "$BODY" ] || { echo' 'true || { echo'
sabota "sentinela: rc 2/3 (sonda não confiável/recusa) lidos como ausente" sentinela \
  '    1) sentinela_ausente ;;' '    *) sentinela_ausente ;;'
sabota "1ª checagem volta a se anunciar 'SIM (1a-vez)'" semcarimbo \
  'DEPLOY="? (1a checagem deste checkout nesta url)"' 'DEPLOY="SIM (1a-vez -> $ENTRY_HASH)"'
sabota "estado volta a ser GLOBAL da máquina" estado \
  '${GITDIR:+$GITDIR/deploy-monitor.state}' '$HOME/.config/afiacao/deploy-monitor.state'
}
sabotagens

# (C) CONTROLE DE SAÍDA: as sabotagens vivem em cópias em $FIX; o monitor real sai byte a byte igual.
if ! cmp -s "$SCRIPT_ABS" "$FIX/monitor-original.sh"; then
  echo "  ❌ o monitor REAL mudou durante a falsificação — as sabotagens deviam viver só em cópias"
  exit 1
fi
echo ""
echo "--falsify: $PEGAS pega(s), $CEGAS cegueira(s) (esperado: 0 cegueiras)"
[ "$CEGAS" -eq 0 ]
