#!/usr/bin/env bash
# test-pr-duplicata-guard.sh — TDD do hook pr-duplicata-guard.sh (git STUBADO, sem rede).
#
# Regra: `gh pr create` em que um símbolo (a) era AUSENTE do arquivo na merge-base, (b) é
#        introduzido por mim e (c) JÁ ESTÁ no mesmo arquivo na origin/main → AVISA via
#        additionalContext (permissionDecision=allow), SEM bloquear. Qualquer via faltando,
#        comando ≠ `gh pr create`, ou erro de infra → stdout mudo. Fail-open.
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

cat >"$stub/git" <<'STUB'
#!/bin/sh
_slug() { printf '%s' "$1" | tr '/.' '__'; }
case "$1" in
  fetch) exit 0 ;;
  merge-base) [ -n "${GIT_STUB_NO_MB:-}" ] && exit 128; echo MB ;;
  diff)
    case "$*" in
      *--name-only*) cat "${GIT_STUB_MINE_FILE:-/dev/null}" ;;
      *)
        f=""
        for a in "$@"; do f="$a"; done
        cat "$STUBDIR/diff_$(_slug "$f")" 2>/dev/null || true ;;
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

fail=0
# _hook "<envs>" "<cmd>" → stdout do hook
_hook() {
  local envs="$1" cmd="$2" json
  json="$(jq -n --arg c "$cmd" '{tool_name:"Bash",tool_input:{command:$c}}')"
  # shellcheck disable=SC2086  # envs é lista KEY=VAL, precisa expandir em palavras
  printf '%s' "$json" | env $envs bash "$HOOK" 2>/dev/null
}
_ok()   { printf '  ✓ %s\n' "$1"; }
_bad()  { printf '  ✗ %s\n' "$1"; fail=1; }
_avisa()  { [ -n "$1" ] && printf '%s' "$1" | grep -q 'DUPLICATA por OBJETIVO'; }
# if/then explícito: A && B || C roda C mesmo com A verdadeiro se B falhar (SC2015).
_deve_avisar() { if _avisa "$2"; then _ok "$1"; else _bad "$1"; fi; }
_deve_calar()  { if _avisa "$2"; then _bad "$1"; else _ok "$1"; fi; }

# ---------- cenário base: eu adiciono `reposicao_pos_marcador` ao manifesto ----------
CRIAR='gh pr create --title x --body y'
printf 'scripts/authz-manifest.ts\n' > "$stub/mine.txt"
MINE="GIT_STUB_MINE_FILE=$stub/mine.txt"

# meu diff introduz o símbolo
printf '+++ b/scripts/authz-manifest.ts\n+  reposicao_pos_marcador: { requiredGate: "compras" },\n' \
  > "$stub/diff_scripts_authz-manifest_ts"
# na merge-base o arquivo NÃO tinha o símbolo
printf 'export const AUTHZ_MANIFEST = {\n  reposicao_pos_candidatos: { requiredGate: "compras" },\n}\n' \
  > "$stub/base_scripts_authz-manifest_ts"
# na origin/main o símbolo JÁ ESTÁ (outra sessão entregou)
printf 'export const AUTHZ_MANIFEST = {\n  reposicao_pos_candidatos: { requiredGate: "compras" },\n  reposicao_pos_marcador: { requiredGate: "compras" },\n}\n' \
  > "$stub/main_scripts_authz-manifest_ts"

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
printf 'export const AUTHZ_MANIFEST = {\n  reposicao_pos_candidatos: { requiredGate: "compras" },\n}\n' \
  > "$stub/base_scripts_authz-manifest_ts"

echo "== 3. símbolo novo AUSENTE da main → mudo (trabalho genuinamente novo) =="
cp "$stub/base_scripts_authz-manifest_ts" "$stub/main_scripts_authz-manifest_ts"
out="$(_hook "$MINE" "$CRIAR")"
_deve_calar "mudo no caminho feliz (ninguém entregou)" "$out"
printf 'export const AUTHZ_MANIFEST = {\n  reposicao_pos_candidatos: { requiredGate: "compras" },\n  reposicao_pos_marcador: { requiredGate: "compras" },\n}\n' \
  > "$stub/main_scripts_authz-manifest_ts"

echo "== 4. comando não é gh pr create → mudo =="
for c in 'echo "gh pr create"' 'gh pr list' 'git commit -m "fala de gh pr create"'; do
  out="$(_hook "$MINE" "$c")"
  _deve_calar "mudo em: $c" "$out"
done

echo "== 5. arquivo ausente da origin/main → mudo =="
rm -f "$stub/main_scripts_authz-manifest_ts"
out="$(_hook "$MINE" "$CRIAR")"
_deve_calar "mudo sem o arquivo na main (nada a duplicar)" "$out"
printf 'export const AUTHZ_MANIFEST = {\n  reposicao_pos_candidatos: { requiredGate: "compras" },\n  reposicao_pos_marcador: { requiredGate: "compras" },\n}\n' \
  > "$stub/main_scripts_authz-manifest_ts"

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

echo
if [ "$fail" -eq 0 ]; then echo "✅ pr-duplicata-guard: tudo verde"; else echo "❌ pr-duplicata-guard: FALHAS acima"; fi
exit "$fail"
