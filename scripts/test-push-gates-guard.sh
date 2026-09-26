#!/usr/bin/env bash
# test-push-gates-guard.sh — TDD do hook push-gates-guard.sh: repo git FIXTURE com os 3 gates
# STUBADOS (package.json → stub.sh), sem rede e sem depender do estado dos gates reais.
#
# Regra: `git push` do HEAD atual, árvore limpa, gate reprovando com EVIDÊNCIA (exit 1 + marca)
#        → NEGA (permissionDecision=deny). Árvore suja → só AVISA (allow + additionalContext).
#        Qualquer outro caso (não é push do HEAD, --no-verify, gate que quebrou, sem bun, repo
#        sem os gates) → NÃO interfere (stdout mudo).
# Sentinela de deriva: as marcas que o hook casa têm de continuar saindo dos gates REAIS — marca
# que muda de texto deixaria o hook em fail-open CALADO (nunca mais nega, e ninguém vê).
#
# Uso: bash scripts/test-push-gates-guard.sh   (exit 0 = tudo verde)
set -u

here="$(cd "$(dirname "$0")" && pwd)"
raiz="$(cd "$here/.." && pwd)"
HOOK="$raiz/.claude/hooks/push-gates-guard.sh"

for dep in jq git bun; do
  command -v "$dep" >/dev/null 2>&1 || { echo "✗ dependência ausente: $dep — o teste não mede nada sem ela"; exit 2; }
done

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
fx="$tmp/repo"; log="$tmp/gates.log"; fail=0; casos=0

# ── fixture: os .ts só precisam EXISTIR (o hook confere); quem responde é o stub ──────────────
mkdir -p "$fx/scripts" "$fx/docs/historico" "$fx/supabase/functions/x"
: >"$fx/scripts/docs-indice-gate-check.ts"
: >"$fx/scripts/docs-citacoes-gate-check.ts"
: >"$fx/scripts/sonda-fingerprint.ts"
printf '# índice\n' >"$fx/docs/historico/README.md"
cat >"$fx/package.json" <<'JSON'
{ "name": "fx", "private": true, "scripts": {
  "docs:indice": "sh stub.sh indice",
  "docs:citacoes": "sh stub.sh citacoes",
  "sonda:fingerprint": "sh stub.sh fingerprint" } }
JSON
# stub.sh <gate> — modo por env STUB_<GATE>: ok | falha | crash | marca-exit2 | lento
cat >"$fx/stub.sh" <<'STUB'
#!/bin/sh
printf '%s\n' "$1" >>"$STUB_LOG"
case "$1" in
  indice) modo="${STUB_INDICE:-ok}" ;;
  citacoes) modo="${STUB_CITACOES:-ok}" ;;
  fingerprint) modo="${STUB_FINGERPRINT:-ok}" ;;
esac
case "$1:$modo" in
  *:ok) echo "$1: ok"; exit 0 ;;
  indice:falha) echo "x docs/historico/x.md sem linha no indice" >&2; echo "docs-indice-gate: 1 problema(s)." >&2; exit 1 ;;
  citacoes:falha) echo "docs-citacoes-gate: 2 citacao(oes) quebrada(s). 10 citacoes." >&2; exit 1 ;;
  fingerprint:falha) echo "sonda-fingerprint: o mapa nao corresponde a fonte." >&2; exit 1 ;;
  *:crash) echo "TypeError: undefined is not an object" >&2; exit 1 ;;
  *:marca-exit2) echo "docs-indice-gate: 1 problema(s). quebrada(s) sonda-fingerprint: o mapa" >&2; exit 2 ;;
  *:lento) sleep 5; echo "docs-indice-gate: 1 problema(s)." >&2; exit 1 ;;
esac
exit 3
STUB
git -C "$fx" init -q -b claude/teste 2>/dev/null || { git -C "$fx" init -q && git -C "$fx" checkout -q -b claude/teste; }
git -C "$fx" add -A
git -C "$fx" -c user.name=t -c user.email=t@t -c commit.gpgsign=false commit -q -m fixture || { echo "✗ fixture: commit falhou"; exit 2; }
[ -z "$(git -C "$fx" status --porcelain)" ] || { echo "✗ fixture nasceu suja — os casos de árvore limpa não medem nada"; exit 2; }

# repo SEM os gates (o hook tem de ficar inerte)
outro="$tmp/outro"; mkdir -p "$outro"; git -C "$outro" init -q; : >"$outro/a"
git -C "$outro" add -A && git -C "$outro" -c user.name=t -c user.email=t@t -c commit.gpgsign=false commit -q -m x

# ── harness ───────────────────────────────────────────────────────────────────────────────────
_hook() {  # _hook "<envs KEY=VAL…>" "<cmd>" [cwd] → stdout do hook
  local envs="$1" c="$2" d="${3:-$fx}" json
  json="$(jq -n --arg c "$c" --arg d "$d" '{tool_name:"Bash",tool_input:{command:$c},cwd:$d}')"
  : >"$log"
  # shellcheck disable=SC2086  # envs é lista KEY=VAL controlada (valores sem espaço) — split intencional
  printf '%s' "$json" | env STUB_LOG="$log" $envs bash "$HOOK" 2>/dev/null
}
_campo() { printf '%s' "$1" | jq -r "$2 // empty" 2>/dev/null; }
_gates() { if [ -f "$log" ]; then grep -c . "$log"; else echo 0; fi; }
_ok() { casos=$((casos + 1)); }
_ko() { casos=$((casos + 1)); fail=1; echo "✗ $1"; }

expect_deny() {  # nome envs cmd trecho-na-razão [cwd]
  local out razao
  out="$(_hook "$2" "$3" "${5:-$fx}")"
  razao="$(_campo "$out" .hookSpecificOutput.permissionDecisionReason)"
  if [ "$(_campo "$out" .hookSpecificOutput.permissionDecision)" = deny ] \
     && [ "$(_campo "$out" .hookSpecificOutput.hookEventName)" = PreToolUse ] \
     && case "$razao" in *"$4"*) true ;; *) false ;; esac; then _ok
  else _ko "$1: esperava DENY citando '$4' — saiu: ${out:0:300}"; fi
}
expect_warn() {  # nome envs cmd trecho-no-contexto [cwd]
  local out ctx
  out="$(_hook "$2" "$3" "${5:-$fx}")"
  ctx="$(_campo "$out" .hookSpecificOutput.additionalContext)"
  if [ "$(_campo "$out" .hookSpecificOutput.permissionDecision)" = allow ] \
     && [ "$(_campo "$out" .hookSpecificOutput.hookEventName)" = PreToolUse ] \
     && case "$ctx" in *"$4"*) true ;; *) false ;; esac; then _ok
  else _ko "$1: esperava AVISO citando '$4' — saiu: ${out:0:300}"; fi
}
expect_mudo() {  # nome envs cmd gates-esperados [cwd] — stdout vazio E nº exato de gates invocados
  local out n
  out="$(_hook "$2" "$3" "${5:-$fx}")"
  n="$(_gates)"
  if [ -z "$out" ] && [ "$n" = "$4" ]; then _ok
  else _ko "$1: esperava MUDO com $4 gate(s) invocado(s) — saiu $n gate(s) e: ${out:0:300}"; fi
}

# ── o controle VERDE vem primeiro: stubs ligados e invocados (sem ele, todo "mudo" abaixo
#    passaria com o hook morto) ──────────────────────────────────────────────────────────────
expect_mudo "controle: push limpo com gates ok roda os 3" "" "git push" 3
[ "$(_gates)" = 3 ] || { echo "✗ controle verde não invocou os 3 gates — os casos seguintes não medem nada"; exit 1; }

# ── NEGA: árvore limpa + evidência positiva ────────────────────────────────────────────────────
expect_deny "indice reprova"              "STUB_INDICE=falha"      "git push"                          "docs:indice"
expect_deny "a razão traz a saída do gate" "STUB_INDICE=falha"      "git push"                          "problema(s)"
expect_deny "citacoes reprova"            "STUB_CITACOES=falha"    "git push -u origin claude/teste"   "docs:citacoes"
expect_deny "fingerprint reprova"         "STUB_FINGERPRINT=falha" "git push origin HEAD"              "sonda:fingerprint"
expect_deny "dois reprovam: os dois na razão" "STUB_INDICE=falha STUB_FINGERPRINT=falha" "git push" "docs:indice, sonda:fingerprint"
expect_deny "HEAD:destino publica o HEAD" "STUB_INDICE=falha"      "git push origin HEAD:refs/heads/x" "docs:indice"
expect_deny "+branch-atual (force)"       "STUB_INDICE=falha"      "git push -f origin +claude/teste"  "docs:indice"
expect_deny "branch-atual:destino"        "STUB_INDICE=falha"      "git push origin claude/teste:outra" "docs:indice"
expect_deny "--force-with-lease"          "STUB_INDICE=falha"      "git push --force-with-lease origin claude/teste" "docs:indice"
expect_deny "laço de retry"               "STUB_INDICE=falha"      "for i in 1 2; do git push -u origin claude/teste && break; sleep 1; done" "docs:indice"
expect_deny "cd <repo> && git push (cwd fora)" "STUB_INDICE=falha" "cd $fx && git push -u origin claude/teste" "docs:indice" "$tmp"
expect_deny "git -C <repo> push (cwd fora)"    "STUB_INDICE=falha" "git -C $fx push" "docs:indice" "$tmp"
expect_deny "não rastreado FORA de docs/edges não suja" "STUB_INDICE=falha" "git push" "docs:indice"

: >"$fx/lixo.log"
expect_deny "lixo.log não rastreado na raiz" "STUB_INDICE=falha" "git push" "docs:indice"
rm -f "$fx/lixo.log"

# ── AVISA: árvore suja (o veredito do disco pode não ser o do push) ────────────────────────────
printf 'mudou\n' >>"$fx/docs/historico/README.md"
expect_warn "rastreado modificado"                 "STUB_INDICE=falha" "git push" "docs:indice"
expect_warn "add+commit+push num comando só"       "STUB_INDICE=falha" "git add -A && git commit -m x && git push" "docs:indice"
git -C "$fx" checkout -q -- docs/historico/README.md
: >"$fx/docs/historico/novo.md"
expect_warn "doc novo não rastreado em docs/"      "STUB_INDICE=falha" "git push" "docs:indice"
rm -f "$fx/docs/historico/novo.md"
: >"$fx/supabase/functions/x/novo.ts"
expect_warn "arquivo novo em supabase/functions/"  "STUB_FINGERPRINT=falha" "git push" "sonda:fingerprint"
rm -f "$fx/supabase/functions/x/novo.ts"
[ -z "$(git -C "$fx" status --porcelain)" ] || { echo "✗ fixture ficou suja após os casos de aviso"; exit 1; }

# ── MUDO: gate que não deu veredito (fail-open) ────────────────────────────────────────────────
expect_mudo "exit 1 sem a marca = crash"       "STUB_INDICE=crash"       "git push" 3
expect_mudo "marca com exit 2 não é veredito"  "STUB_INDICE=marca-exit2" "git push" 3
expect_mudo "bun ausente"                      "STUB_INDICE=falha PGG_BUN=/nao/existe/bun" "git push" 0
if command -v timeout >/dev/null 2>&1 || command -v gtimeout >/dev/null 2>&1; then
  expect_mudo "gate lento estoura o timeout"   "STUB_INDICE=lento PGG_TIMEOUT=1" "git push" 3
else
  echo "· PULADO: gate lento (sem timeout/gtimeout nesta máquina)"
fi

# ── MUDO sem rodar gate nenhum: não é push do HEAD ─────────────────────────────────────────────
expect_mudo "não é push"                  "STUB_INDICE=falha" "git status" 0
expect_mudo "git stash push"              "STUB_INDICE=falha" "git stash push -m x" 0
expect_mudo "menção entre aspas"          "STUB_INDICE=falha" 'echo "git push origin x"' 0
expect_mudo "menção em heredoc"           "STUB_INDICE=falha" "$(printf 'cat <<EOF\ngit push\nEOF')" 0
expect_mudo "--no-verify (válvula)"       "STUB_INDICE=falha" "git push --no-verify" 0
expect_mudo "outra branch"                "STUB_INDICE=falha" "git push origin outra-branch" 0
expect_mudo ":branch apaga"               "STUB_INDICE=falha" "git push origin :claude/teste" 0
expect_mudo "--delete"                    "STUB_INDICE=falha" "git push --delete origin x" 0
expect_mudo "--tags"                      "STUB_INDICE=falha" "git push --tags" 0
expect_mudo "--dry-run"                   "STUB_INDICE=falha" "git push -n origin claude/teste" 0
expect_mudo "opção desconhecida (--repo=)" "STUB_INDICE=falha" "git push --repo=outro" 0
expect_mudo "refspec entre aspas"         "STUB_INDICE=falha" 'git push origin "claude/teste"' 0
# shellcheck disable=SC2016  # o `$BRANCH` LITERAL é o caso: o hook recebe o comando sem expandir
expect_mudo "refspec por expansão"        "STUB_INDICE=falha" 'git push origin $BRANCH' 0
expect_mudo "mais de 2 posicionais"       "STUB_INDICE=falha" "git push origin a b" 0
expect_mudo "cd entre aspas (dir incerto)" "STUB_INDICE=falha" "cd \"$fx\" && git push" 0 "$tmp"
expect_mudo "pushd (dir incerto)"         "STUB_INDICE=falha" "pushd $fx && git push" 0 "$tmp"
expect_mudo "GIT_DIR por env"             "STUB_INDICE=falha" "GIT_DIR=$fx/.git git push" 0
expect_mudo "--git-dir"                   "STUB_INDICE=falha" "git --git-dir=$fx/.git push" 0
expect_mudo "repo sem os gates"           "STUB_INDICE=falha" "git push" 0 "$outro"
expect_mudo "fora de repo git"            "STUB_INDICE=falha" "git push" 0 "$tmp"

# ── sentinela de deriva: a marca que o hook casa sai MESMO do gate real ───────────────────────
# (1) comportamental no docs:indice — o único que roda fora do repo sem montar edge/mapa:
#     controle verde e sabotagem na MESMA invocação, no mesmo diretório.
ind="$tmp/indice"; mkdir -p "$ind/docs/historico"
printf '# h\n\n| doc | resumo |\n|---|---|\n| [x.md](x.md) | fixture do teste do push-gates-guard (#0, 1 caso) |\n' >"$ind/docs/historico/README.md"
: >"$ind/docs/historico/x.md"
saida_ok="$(cd "$ind" && bun "$raiz/scripts/docs-indice-gate-check.ts" 2>&1)"; rc_ok=$?
: >"$ind/docs/historico/y.md"
saida_ko="$(cd "$ind" && bun "$raiz/scripts/docs-indice-gate-check.ts" 2>&1)"; rc_ko=$?
if [ "$rc_ok" -eq 0 ] && [ "$rc_ko" -eq 1 ] && case "$saida_ko" in *"problema(s)"*) true ;; *) false ;; esac; then _ok
else _ko "deriva: docs:indice real não deu (0 no controle, 1+marca na sabotagem): rc_ok=$rc_ok rc_ko=$rc_ko — ${saida_ok:0:200} | ${saida_ko:0:200}"; fi

# (2) textual nos outros dois: a marca tem de estar numa linha de console.error do fonte (e não
#     só num comentário), e o hook tem de casar exatamente a mesma string.
marca_no_fonte() {  # arquivo marca
  if grep -F 'console.error' "$raiz/$1" | grep -qF -- "$2"; then _ok
  else _ko "deriva: a marca '$2' sumiu do console.error de $1 — o hook ficaria cego (fail-open calado)"; fi
}
marca_no_fonte scripts/docs-indice-gate-check.ts 'problema(s)'
marca_no_fonte scripts/docs-citacoes-gate-check.ts 'quebrada(s)'
marca_no_fonte scripts/sonda-fingerprint.ts 'sonda-fingerprint: o mapa'
for par in 'docs:indice|problema(s)' 'docs:citacoes|quebrada(s)' 'sonda:fingerprint|sonda-fingerprint: o mapa'; do
  if grep -qF -- "'$par'" "$HOOK"; then _ok; else _ko "deriva: o hook não casa mais '$par'"; fi
  if grep -qF -- "\"${par%%|*}\":" "$raiz/package.json"; then _ok; else _ko "deriva: package.json sem o script ${par%%|*}"; fi
done

if [ "$fail" -eq 0 ]; then echo "✓ push-gates-guard: $casos casos verdes"; exit 0; fi
echo "✗ push-gates-guard: falhas acima ($casos casos)"; exit 1
