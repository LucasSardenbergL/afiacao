#!/usr/bin/env bash
# migration-collision-guard.sh — PreToolUse(Write|Edit): colisão de migration multi-sessão.
#
# Bloqueia (warn-forte) quando a migration que vou escrever recria um objeto SQL que OUTRA
# worktree recria SEM ter commitado — concorrência real: "a última a rodar vence" sobrescreve
# a outra silenciosamente no apply manual do SQL Editor (docs/agent/database.md §2).
#
# Escopo estreito (barato): só file_path ~ supabase/migrations/*.sql. Local-scan, SEM rede
# (sem --full/fetch/gh). Só 🔴 (objeto perigoso EM VOO) nega; 🟡 (aditivo / já commitado) e 🟢
# passam — o ponto de máximo valor é o gate de apply na skill lovable-db-operator, não isto.
#
# Fail-open: sem jq/bun/CLI, ou qualquer erro/timeout → exit 0 (nunca trava trabalho por bug do
# próprio guard). Espelha o heavy-guard: exit 0 + JSON permissionDecision="deny".
# Testes em scripts/test-migration-collision-guard.sh.
set -u

command -v jq >/dev/null 2>&1 || exit 0   # sem jq não extraio o conteúdo com segurança → no-op
command -v bun >/dev/null 2>&1 || exit 0

input="$(cat)"
fpath="$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty' 2>/dev/null)"

# só age em migrations
case "$fpath" in
  */supabase/migrations/*.sql | supabase/migrations/*.sql) ;;
  *) exit 0 ;;
esac

# conteúdo que vou escrever (Write usa .content; Edit usa .new_string — sinal parcial, ok)
content="$(printf '%s' "$input" | jq -r '.tool_input.content // .tool_input.new_string // empty' 2>/dev/null)"
[ -n "$content" ] || exit 0

root="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"
cli="$root/scripts/wt-preflight-migration.ts"
[ -f "$cli" ] || exit 0

# preflight local (sem --full): passa o conteúdo via stdin (o arquivo ainda não existe no Write).
# NÃO usar `|| exit 0`: o CLI sai 1 em RED (veredito, não erro). Fail-open vem do grep abaixo
# não casar quando a saída é vazia/erro.
out="$(printf '%s' "$content" | bun "$cli" "$fpath" --stdin 2>/dev/null)"
printf '%s' "$out" | grep -q ': RED' || exit 0   # 🟡/🟢/erro → não bloqueia

reason="$out

Rode 'bun run wt:preflight $(basename "$fpath")' pra revisar. Coordene: a SUA migration por último no SQL Editor, ou consolide as duas. Se for intencional, reescreva ciente da ordem."
jq -n --arg r "$reason" \
  '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"deny",permissionDecisionReason:$r}}'
exit 0
