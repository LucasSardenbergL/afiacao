#!/usr/bin/env bash
# stop-moneypath-nudge.sh — Stop: lembrete NÃO-bloqueante se a sessão tocou money-path.
#
# Barato DE PROPÓSITO: só `git diff --name-only` + ls-files (zero typecheck/test/lint). Rodar pesado
# no Stop brigaria com o semáforo `heavy`/RAM (M2 8GB × ~30 worktrees) e com a latência por turno.
# NÃO bloqueia (sempre exit 0) — emite um systemMessage com o checklist money-path no fim do turno.
# O CI segue sendo o gate bloqueante; isto é rede de segurança contra esquecimento, não um gate.
# Testes em scripts/test-stop-moneypath-nudge.sh.
set -u

command -v git >/dev/null 2>&1 || exit 0
command -v jq  >/dev/null 2>&1 || exit 0
root="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"
top="$(git -C "$root" rev-parse --show-toplevel 2>/dev/null)" || exit 0

# trabalho uncommitted da sessão (modificados vs HEAD + novos não-rastreados). Pathspec `-- supabase
# src` barateia em árvore grande de untracked (Codex 2026-06-24) — money-path só vive nesses dois.
changed="$( { git -C "$top" diff --name-only HEAD -- supabase src 2>/dev/null; git -C "$top" ls-files --others --exclude-standard -- supabase src 2>/dev/null; } )"
[ -n "$changed" ] || exit 0

# filtra money-path: supabase/ + src/ financeiro/pricing/reposição/estoque/positivação/caixa
mp="$(printf '%s\n' "$changed" | grep -iE 'supabase/|src/.*(financ|fatur|dre|pric|preco|reposic|estoque|compra|pedido|positiva|comiss|caixa|funding)' | sort -u)"
[ -n "$mp" ] || exit 0

n="$(printf '%s\n' "$mp" | grep -c .)"
list="$(printf '%s\n' "$mp" | head -8 | sed 's/^/• /')"
msg="🟡 Money-path tocado nesta sessão ($n arquivo(s) uncommitted). Antes de pedir review / tirar PR do draft:
$list
→ typecheck/teste: heavy bun run typecheck · heavy bun run test
→ migration/RPC/trigger/policy nova? prove-sql-money-path (PG17 + falsificação)
(lembrete não-bloqueante — docs/agent/money-path.md)"

jq -n --arg m "$msg" '{systemMessage:$m}'
exit 0
