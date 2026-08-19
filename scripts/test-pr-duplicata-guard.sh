#!/usr/bin/env bash
# test-pr-duplicata-guard.sh — TDD do hook pr-duplicata-guard.sh (git STUBADO, sem rede).
#
# Regra (gatilho 1 — `gh pr create`): um símbolo (a) AUSENTE do arquivo na merge-base, (b)
#        introduzido por mim e (c) JÁ no mesmo arquivo na origin/main → AVISA via
#        additionalContext (permissionDecision=allow), SEM bloquear. Qualquer via faltando,
#        comando fora do gatilho, ou erro de infra → stdout mudo. Fail-open.
#
# Regra (gatilho 2 — `git commit`, 2026-08-18): mesma prova no chokepoint ANTERIOR, porque no
#        create o trabalho JÁ está pronto — a rede evita o merge duplicado, não o DESPERDÍCIO
#        (#1757: 6 arq/+270; #1764: 1 arq/+29, morto 36s após criado). No commit o trabalho ainda
#        não está commitado: o alvo do diff passa a ser o ÍNDICE (mb..index = STAGED ∪ commits da
#        branch numa expressão só), e a ÁRVORE em `git commit -a`. Olhar só o mb..HEAD seria
#        TEATRO — no PRIMEIRO commit ele é VAZIO, e o #1764 tinha 1 commit só (caso 9).
#        Anti-alarm-fatigue: 1 aviso por (branch, conjunto colidente); achado NOVO fura o
#        silêncio e o `gh pr create` NUNCA é silenciado (último portão) — casos 12 e 13.
#
# O caso 8 é o que dá sentido ao desenho: ele codifica a MEDIÇÃO que escolheu o escopo por
# ARQUIVO em vez de repo-wide (reposicao_pos_marcador já existia em 10 arquivos na merge-base;
# repo-wide o excluiria como "não é novo" → falso negativo em 1 das 3 ocorrências reais).
#
# Uso: bash scripts/test-pr-duplicata-guard.sh   (exit 0 = tudo verde)
set -u

here="$(cd "$(dirname "$0")" && pwd)"
HOOK="$here/../.claude/hooks/pr-duplicata-guard.sh"

stub="$(mktemp -d)"
trap 'rm -rf "$stub"' EXIT
export STUBDIR="$stub"

# stub de git. O ALVO do diff é o que distingue os gatilhos e por isso o stub responde DIFERENTE
# para cada um — se respondesse igual, os casos 9/10/11 passariam mesmo com o hook ignorando o
# staged, e seriam teatro.  HEAD = create · --cached = commit · nenhum = commit -a (árvore).
cat >"$stub/git" <<'STUB'
#!/bin/sh
_slug() { printf '%s' "$1" | tr '/.' '__'; }
_alvo() {
  case " $* " in
    *" --cached "*) echo cached ;;
    *" HEAD "*)     echo head ;;
    *)              echo wt ;;
  esac
}
case "$1" in
  fetch) exit 0 ;;
  merge-base) [ -n "${GIT_STUB_NO_MB:-}" ] && exit 128; echo MB ;;
  branch) printf '%s\n' "${GIT_STUB_BRANCH-minha-branch}" ;;
  diff)
    a="$(_alvo "$@")"
    case "$*" in
      *--name-only*)
        case "$a" in
          head)   cat "${GIT_STUB_MINE_FILE:-/dev/null}" ;;
          cached) cat "${GIT_STUB_STAGED_FILE:-/dev/null}" ;;
          wt)     cat "${GIT_STUB_WT_FILE:-/dev/null}" ;;
        esac ;;
      *)
        f=""
        for x in "$@"; do f="$x"; done
        case "$a" in
          head)   cat "$STUBDIR/diff_$(_slug "$f")"    2>/dev/null || true ;;
          cached) cat "$STUBDIR/dcached_$(_slug "$f")" 2>/dev/null || true ;;
          wt)     cat "$STUBDIR/dwt_$(_slug "$f")"     2>/dev/null || true ;;
        esac ;;
    esac ;;
  show)
    case "$2" in
      origin/main:*) file="$STUBDIR/main_$(_slug "${2#origin/main:}")" ;;
      MB:*)          file="$STUBDIR/base_$(_slug "${2#MB:}")" ;;
      *) exit 128 ;;
    esac
    [ -f "$file" ] || exit 128
    cat "$file" ;;
  *) exit 0 ;;
esac
STUB
chmod +x "$stub/git"
export PATH="$stub:$PATH"

# cache do dedupe ISOLADO por execução — senão o teste herda marcas de uma rodada anterior
# (falso "mudo") ou suja o TMPDIR do founder.
CACHE="$stub/cache"
DEDUPE="PRDG_CACHE_DIR=$CACHE"

fail=0
# _hook "<envs>" "<cmd>" → stdout do hook
_hook() {
  local envs="$1" cmd="$2" json
  json="$(jq -n --arg c "$cmd" '{tool_name:"Bash",tool_input:{command:$c}}')"
  # shellcheck disable=SC2086  # envs é lista KEY=VAL, precisa expandir em palavras
  printf '%s' "$json" | env $envs bash "${HOOK_ATUAL:-$HOOK}" 2>/dev/null
}
_ok()   { printf '  ✓ %s\n' "$1"; }
_bad()  { printf '  ✗ %s\n' "$1"; fail=1; }
_avisa()  { [ -n "$1" ] && printf '%s' "$1" | grep -q 'DUPLICATA por OBJETIVO'; }
# if/then explícito: A && B || C roda C mesmo com A verdadeiro se B falhar (SC2015).
_deve_avisar() { if _avisa "$2"; then _ok "$1"; else _bad "$1"; fi; }
_deve_calar()  { if _avisa "$2"; then _bad "$1"; else _ok "$1"; fi; }

# ---------- cenário base: eu adiciono `reposicao_pos_marcador` ao manifesto ----------
CRIAR='gh pr create --title x --body y'
COMITAR='git commit -m "wip"'
COMITAR_A='git commit -am "wip"'
printf 'scripts/authz-manifest.ts\n' > "$stub/mine.txt"
: > "$stub/vazio.txt"
MINE="GIT_STUB_MINE_FILE=$stub/mine.txt"

# meu diff introduz o símbolo — mesmo conteúdo servido nos três alvos, para que a DIFERENÇA
# entre os casos venha de QUAL alvo o hook pede, não do conteúdo.
DIFF='+++ b/scripts/authz-manifest.ts\n+  reposicao_pos_marcador: { requiredGate: "compras" },\n'
# shellcheck disable=SC2059  # DIFF é formato controlado deste teste, com \n intencional
printf "$DIFF" > "$stub/diff_scripts_authz-manifest_ts"
# shellcheck disable=SC2059
printf "$DIFF" > "$stub/dcached_scripts_authz-manifest_ts"
# shellcheck disable=SC2059
printf "$DIFF" > "$stub/dwt_scripts_authz-manifest_ts"
# na merge-base o arquivo NÃO tinha o símbolo
BASE='export const AUTHZ_MANIFEST = {\n  reposicao_pos_candidatos: { requiredGate: "compras" },\n}\n'
# na origin/main o símbolo JÁ ESTÁ (outra sessão entregou)
MAIN='export const AUTHZ_MANIFEST = {\n  reposicao_pos_candidatos: { requiredGate: "compras" },\n  reposicao_pos_marcador: { requiredGate: "compras" },\n}\n'
# shellcheck disable=SC2059
_base() { printf "$BASE" > "$stub/base_scripts_authz-manifest_ts"; }
# shellcheck disable=SC2059
_main() { printf "$MAIN" > "$stub/main_scripts_authz-manifest_ts"; }
_base; _main

echo "== 1. as três vias satisfeitas → AVISA =="
out="$(_hook "$MINE" "$CRIAR")"
_deve_avisar "avisa na assinatura da duplicata" "$out"
if printf '%s' "$out" | jq -e '.hookSpecificOutput.permissionDecision=="allow"' >/dev/null 2>&1; then
  _ok "permissionDecision=allow (avisa, não bloqueia)"; else _bad "deveria ser allow"; fi
if printf '%s' "$out" | grep -q 'reposicao_pos_marcador'; then
  _ok "nomeia o símbolo culpado"; else _bad "deveria nomear o símbolo"; fi

echo "== 2. símbolo JÁ existia na merge-base → mudo (uso normal, não criação) =="
cp "$stub/main_scripts_authz-manifest_ts" "$stub/base_scripts_authz-manifest_ts"
out="$(_hook "$MINE" "$CRIAR")"
_deve_calar "mudo quando o símbolo é pré-existente" "$out"
_base

echo "== 3. símbolo novo AUSENTE da main → mudo (trabalho genuinamente novo) =="
cp "$stub/base_scripts_authz-manifest_ts" "$stub/main_scripts_authz-manifest_ts"
out="$(_hook "$MINE" "$CRIAR")"
_deve_calar "mudo no caminho feliz (ninguém entregou)" "$out"
_main

echo "== 4. comando fora dos DOIS gatilhos → mudo =="
# `git commit` agora É gatilho — o que tem de continuar mudo é a MENÇÃO (aspas/heredoc) e
# comandos vizinhos de nome parecido.
for c in 'echo "gh pr create"' 'echo "git commit -m x"' 'gh pr list' 'git commit-tree -m x' 'git log --grep=commit'; do
  out="$(_hook "$MINE $DEDUPE" "$c")"
  _deve_calar "mudo em: $c" "$out"
done

echo "== 5. arquivo ausente da origin/main → mudo =="
rm -f "$stub/main_scripts_authz-manifest_ts"
out="$(_hook "$MINE" "$CRIAR")"
_deve_calar "mudo sem o arquivo na main (nada a duplicar)" "$out"
_main

echo "== 6. fail-open: sem merge-base → mudo =="
out="$(_hook "$MINE GIT_STUB_NO_MB=1" "$CRIAR")"
if [ -z "$out" ]; then _ok "silencioso sem merge-base"; else _bad "devia ser mudo"; fi

echo "== 7. filtro de forma: prosa .md não vira candidato =="
printf 'docs/nota.md\n' > "$stub/mine_md.txt"
printf '+++ b/docs/nota.md\n+A regra vale imediatamente para toda implementacao subsequente.\n' \
  > "$stub/diff_docs_nota_md"
printf 'Documento.\n' > "$stub/base_docs_nota_md"
printf 'Documento. A regra vale imediatamente para toda implementacao subsequente.\n' \
  > "$stub/main_docs_nota_md"
out="$(_hook "GIT_STUB_MINE_FILE=$stub/mine_md.txt" "$CRIAR")"
_deve_calar "prosa portuguesa não dispara" "$out"

echo "== 8. REGRESSÃO do escopo: símbolo existe repo-wide, mas é novo NO ARQUIVO → AVISA =="
# É a ocorrência 1 real: reposicao_pos_marcador vivia em 10 arquivos (migrations) na merge-base.
# O escopo por arquivo tem de disparar mesmo assim; repo-wide daria falso negativo.
printf 'supabase/migrations/x.sql\nscripts/authz-manifest.ts\n' > "$stub/mine8.txt"
printf 'CREATE FUNCTION reposicao_pos_marcador() ...\n' > "$stub/base_supabase_migrations_x_sql"
printf 'CREATE FUNCTION reposicao_pos_marcador() ...\n' > "$stub/main_supabase_migrations_x_sql"
: > "$stub/diff_supabase_migrations_x_sql"
out="$(_hook "GIT_STUB_MINE_FILE=$stub/mine8.txt" "$CRIAR")"
_deve_avisar "dispara apesar do símbolo existir noutro arquivo na base" "$out"

# =======================================================================================
# GATILHO 2 — `git commit`. O que estes casos provam é que a FONTE do conjunto muda por modo.
# =======================================================================================
echo "== 9. #1764: mb..HEAD VAZIO (primeiro commit) mas STAGED tem o símbolo → AVISA =="
# O caso cego do diff de 3 pontos: 1 commit só. Se o hook olhasse mb..HEAD no commit, calaria.
out="$(_hook "GIT_STUB_MINE_FILE=$stub/vazio.txt GIT_STUB_STAGED_FILE=$stub/mine.txt $DEDUPE" "$COMITAR")"
_deve_avisar "avisa no commit com o trabalho só no índice" "$out"
if printf '%s' "$out" | grep -q 'ANTES de commitar'; then
  _ok "mensagem do commit fala em decidir ANTES de escrever mais"; else _bad "mensagem devia ser a do commit"; fi

echo "== 10. cada modo lê a SUA fonte (create=HEAD, commit=índice) =="
rm -rf "$CACHE"
out="$(_hook "GIT_STUB_MINE_FILE=$stub/mine.txt GIT_STUB_STAGED_FILE=$stub/vazio.txt $DEDUPE" "$COMITAR")"
_deve_calar "commit ignora o mb..HEAD (nada staged = nada a avisar)" "$out"
out="$(_hook "GIT_STUB_MINE_FILE=$stub/mine.txt GIT_STUB_STAGED_FILE=$stub/vazio.txt" "$CRIAR")"
_deve_avisar "create ignora o índice e usa o mb..HEAD" "$out"

echo "== 11. working-tree só entra em \`git commit -a\` =="
rm -rf "$CACHE"
WT="GIT_STUB_MINE_FILE=$stub/vazio.txt GIT_STUB_STAGED_FILE=$stub/vazio.txt GIT_STUB_WT_FILE=$stub/mine.txt"
out="$(_hook "$WT $DEDUPE" "$COMITAR")"
_deve_calar "commit sem -a não olha a árvore (o arquivo nem iria no commit)" "$out"
rm -rf "$CACHE"
out="$(_hook "$WT $DEDUPE" "$COMITAR_A")"
_deve_avisar "commit -a olha a árvore" "$out"

echo "== 12. anti-alarm-fatigue: mesmo achado não repete; achado NOVO fura o silêncio =="
rm -rf "$CACHE"
C9="GIT_STUB_MINE_FILE=$stub/vazio.txt GIT_STUB_STAGED_FILE=$stub/mine.txt $DEDUPE"
out="$(_hook "$C9" "$COMITAR")";  _deve_avisar "1º commit avisa" "$out"
out="$(_hook "$C9" "$COMITAR")";  _deve_calar  "2º commit com o MESMO achado é mudo" "$out"
# achado NOVO (outro arquivo/símbolo) tem de furar o silêncio
printf 'src/lib/novo.ts\n' > "$stub/mine12.txt"
printf '+++ b/src/lib/novo.ts\n+export const calcularMargemFaixa = 1\n' > "$stub/dcached_src_lib_novo_ts"
printf 'export const outraCoisaQualquer = 0\n' > "$stub/base_src_lib_novo_ts"
printf 'export const outraCoisaQualquer = 0\nexport const calcularMargemFaixa = 1\n' > "$stub/main_src_lib_novo_ts"
out="$(_hook "GIT_STUB_MINE_FILE=$stub/vazio.txt GIT_STUB_STAGED_FILE=$stub/mine12.txt $DEDUPE" "$COMITAR")"
_deve_avisar "colisão NOVA fura o silêncio do dedupe" "$out"
# ...e a branch faz parte da assinatura: outra branch com o MESMO achado volta a avisar
out="$(_hook "$C9 GIT_STUB_BRANCH=outra-branch" "$COMITAR")"
_deve_avisar "outra branch com o mesmo achado avisa (assinatura inclui a branch)" "$out"

echo "== 13. o \`gh pr create\` NUNCA é silenciado pelo dedupe (último portão) =="
out="$(_hook "$MINE $DEDUPE" "$CRIAR")"; _deve_avisar "create avisa a 1ª vez" "$out"
out="$(_hook "$MINE $DEDUPE" "$CRIAR")"; _deve_avisar "create avisa DE NOVO — nunca é silenciado" "$out"

# ---------------------------------------------------------------------------------------
# 14. FALSIFICAÇÃO — sabotar e EXIGIR vermelho. Sem isto os casos acima são teatro: um hook
# que nunca avisasse passaria em 2,3,4,5,6,7,10a,11a,12b e um que sempre avisasse passaria no resto.
# A sabotagem é aplicada numa CÓPIA (nunca no original) — restaurar por `git checkout --`
# destruiria trabalho não-commitado, armadilha já registrada no §9 do money-path.
# ---------------------------------------------------------------------------------------
echo "== 14. falsificação: cada via/decisão tem de ser LOAD-BEARING =="

_sabota() { # $1=nome  $2=expr sed  $3=envs do cenário  $4=cmd  $5=veredito esperado da SABOTADA
  local nome="$1" expr="$2" envs="$3" cmd="$4" esperado="$5" out
  sed "$expr" "$HOOK" > "$stub/sabotado.sh"
  if cmp -s "$HOOK" "$stub/sabotado.sh"; then
    _bad "sabotagem '$nome' não mudou nada (padrão sed obsoleto — o teste estaria cego)"
    return
  fi
  rm -rf "$CACHE"
  out="$(HOOK_ATUAL=$stub/sabotado.sh _hook "$envs" "$cmd")"
  if [ "$esperado" = avisa ]; then
    if _avisa "$out"; then _ok "sabotagem '$nome' → vermelho como esperado (é load-bearing)"
    else _bad "sabotagem '$nome' NÃO mudou o veredito — não está sendo testada"; fi
  else
    if _avisa "$out"; then _bad "sabotagem '$nome' NÃO mudou o veredito — não está sendo testada"
    else _ok "sabotagem '$nome' → vermelho como esperado (é load-bearing)"; fi
  fi
}

# (A) remover a via 1 (ausência na merge-base): o cenário 2 — símbolo PRÉ-EXISTENTE — passa a avisar.
cp "$stub/main_scripts_authz-manifest_ts" "$stub/base_scripts_authz-manifest_ts"
# shellcheck disable=SC2016  # sed: o padrão é literal do hook, expandir aqui o quebraria
_sabota "sem a via 1 (ausencia na base)" 's|^  novos=.*|  novos="$add_ids"|' "$MINE" "$CRIAR" avisa
_base

# (C) remover a via 3 (presença na main): o cenário 3 — ninguém entregou — passa a avisar.
cp "$stub/base_scripts_authz-manifest_ts" "$stub/main_scripts_authz-manifest_ts"
# shellcheck disable=SC2016  # sed: o padrão é literal do hook, expandir aqui o quebraria
_sabota "sem a via 3 (presenca na main)" 's|^  dup=.*|  dup="$novos"|' "$MINE" "$CRIAR" avisa
_main

# (B) trocar o ESCOPO por repo-wide (acumular a base de todos os arquivos): o cenário 8 emudece.
# É a variante que a medição rejeitou — 1 falso negativo em 3 ocorrências reais.
# shellcheck disable=SC2016  # sed: o padrão é literal do hook, expandir aqui o quebraria
_sabota "escopo repo-wide em vez de por arquivo" \
  's|^  base_c=.*|  base_c="${acc:-}$(git show "$mb:$f" 2>/dev/null)"; acc="$base_c"|' \
  "GIT_STUB_MINE_FILE=$stub/mine8.txt" "$CRIAR" cala

# (D) TEATRO do 3 pontos: se o commit olhasse mb..HEAD em vez do índice, o #1764 (caso 9) emudece.
# É a falsificação que dá sentido ao gatilho 2 inteiro.
_sabota "commit olhando mb..HEAD (o 3 pontos TEATRO)" 's|^  alvo=--cached$|  alvo=HEAD|' \
  "GIT_STUB_MINE_FILE=$stub/vazio.txt GIT_STUB_STAGED_FILE=$stub/mine.txt $DEDUPE" "$COMITAR" cala

# (E) matar o dedupe: o 2º commit idêntico do caso 12 volta a avisar (o silêncio é REAL, não sorte).
sed 's|^      exit 0 .*|      :|' "$HOOK" > "$stub/sem-dedupe.sh"
if cmp -s "$HOOK" "$stub/sem-dedupe.sh"; then
  _bad "sabotagem 'sem dedupe' não mudou nada (padrão sed obsoleto)"
else
  rm -rf "$CACHE"
  C9="GIT_STUB_MINE_FILE=$stub/vazio.txt GIT_STUB_STAGED_FILE=$stub/mine.txt $DEDUPE"
  HOOK_ATUAL=$stub/sem-dedupe.sh _hook "$C9" "$COMITAR" >/dev/null
  out="$(HOOK_ATUAL=$stub/sem-dedupe.sh _hook "$C9" "$COMITAR")"
  if _avisa "$out"; then _ok "sabotagem 'sem dedupe' → 2º commit volta a avisar (dedupe é load-bearing)"
  else _bad "sabotagem 'sem dedupe' NÃO mudou o veredito — o silêncio do caso 12 não é do dedupe"; fi
fi

echo
if [ "$fail" -eq 0 ]; then echo "✅ pr-duplicata-guard: tudo verde"; else echo "❌ pr-duplicata-guard: FALHAS acima"; fi
exit "$fail"
