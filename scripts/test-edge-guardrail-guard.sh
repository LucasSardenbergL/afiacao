#!/usr/bin/env bash
# test-edge-guardrail-nudge.sh — TDD do hook .claude/hooks/edge-guardrail-nudge.sh
#
# Regra: Write/Edit de arquivo sob supabase/functions/ → injeta a lista dos guardrails de FORMA
# do vitest que leem AQUELE arquivo. Qualquer outra coisa → silêncio absoluto.
#
# As quatro sabotagens (a falsificação, não só a criação):
#   (a) edita edge                       → a lista sai
#   (b) edita arquivo fora de edges      → silêncio
#   (c) Bash com heredoc que MENCIONA um path de edge → silêncio (a armadilha do #1778: menção
#       ≠ execução; lá o heavy-guard casou o padrão DENTRO do heredoc e gravou `heavy` no ci.yml)
#   (d) sem jq / sem bun no PATH         → exit 0, sem travar e sem falar
#
# Os marcadores de resultado são ASCII e em CAIXA FIXA (`FALA`/`SILENCIO`) de propósito: quem
# falsifica precisa casar o ramo certo do vermelho com `grep -F`, e acento dobra entre locales
# (#1483). Falsificar em um locale só não prova a asserção.
#
# Uso: bash scripts/test-edge-guardrail-nudge.sh   (exit 0 = verde)
set -u

here="$(cd "$(dirname "$0")" && pwd)"
HOOK="$here/../.claude/hooks/edge-guardrail-nudge.sh"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

EDGE='supabase/functions/omie-cliente/index.ts'

# roda o hook com um payload montado; cada caso usa session_id próprio para não esbarrar na
# marca anti-repetição (que o caso "repetida" exercita de propósito).
run() { # <tool_name> <json do tool_input> <session_id> → stdout do hook
  TMPDIR="$tmp" printf '{"session_id":"%s","tool_name":"%s","tool_input":%s}' "$3" "$1" "$2" \
    | TMPDIR="$tmp" bash "$HOOK" 2>/dev/null
}

fail=0
saida=""
expect_fala() { # <descrição> <trecho esperado>
  if printf '%s' "$saida" | grep -q "additionalContext" && printf '%s' "$saida" | grep -q -- "$2"; then
    echo "  ok    FALA     | $1"
  else
    echo "  FAIL  want FALA ($2) | $1"; fail=1
  fi
}
expect_silencio() { # <descrição>
  if [ -z "$(printf '%s' "$saida" | tr -d '[:space:]')" ]; then
    echo "  ok    SILENCIO | $1"
  else
    echo "  FAIL  want SILENCIO, veio: $(printf '%s' "$saida" | head -c 120) | $1"; fail=1
  fi
}

echo "── (a) Write/Edit de edge → a lista sai ──"
saida="$(run Write "{\"file_path\":\"$EDGE\",\"content\":\"x\"}" sess-a)"
expect_fala "Write em $EDGE" "edge-money-path-invariants"
saida="$(run Edit "{\"file_path\":\"/Users/x/afiacao-wt/$EDGE\",\"new_string\":\"y\"}" sess-a2)"
expect_fala "Edit com caminho ABSOLUTO do worktree" "edge-money-path-invariants"

echo "── (b) fora de supabase/functions → silêncio ──"
saida="$(run Write '{"file_path":"src/pages/Home.tsx","content":"x"}' sess-b)"
expect_silencio "arquivo de src/"
saida="$(run Write '{"file_path":"supabase/migrations/20260101_x.sql","content":"x"}' sess-b2)"
expect_silencio "migration"

echo "── (c) MENÇÃO ≠ edição: Bash/heredoc citando path de edge → silêncio (#1778) ──"
saida="$(run Bash "{\"command\":\"cat > /tmp/nota.md <<EOF\\nvide $EDGE\\nEOF\"}" sess-c)"
expect_silencio "heredoc que menciona o path"
saida="$(run Bash "{\"command\":\"grep -n jsonRes $EDGE\"}" sess-c2)"
expect_silencio "grep no path (leitura, não edição)"
saida="$(run Read "{\"file_path\":\"$EDGE\"}" sess-c3)"
expect_silencio "Read do arquivo (defesa se o matcher do settings.json mudar)"

echo "── (d) sem jq / sem bun → fail-open, exit 0 e silêncio ──"
# o próprio bash tem de ser resolvido ANTES de estreitar o PATH (senão o teste mede 127 do
# interpretador, não o fail-open do hook — foi o que aconteceu na 1ª rodada desta suíte).
BASH_BIN="$(command -v bash)"
mkdir -p "$tmp/vazio" "$tmp/sojq"
ln -sf "$(command -v jq)" "$tmp/sojq/jq" 2>/dev/null || true

fail_open() { # <descrição> <PATH a usar>
  local out rc
  out="$(printf '{"session_id":"sess-d","tool_name":"Write","tool_input":{"file_path":"%s","content":"x"}}' "$EDGE" \
    | TMPDIR="$tmp" PATH="$2" "$BASH_BIN" "$HOOK" 2>/dev/null)"; rc=$?
  if [ "$rc" -eq 0 ] && [ -z "$out" ]; then echo "  ok    fail-open | $1"
  else echo "  FAIL  fail-open | $1 → rc=$rc out=$(printf '%s' "$out" | head -c 80)"; fail=1; fi
}
fail_open "PATH sem jq (nem chega a ler o stdin)" "$tmp/vazio"
fail_open "PATH com jq e sem bun" "$tmp/sojq"

echo "── (e) anti-ruído: 2ª edição do MESMO arquivo na MESMA sessão → silêncio ──"
saida="$(run Write "{\"file_path\":\"$EDGE\",\"content\":\"1\"}" sess-e)"
expect_fala "1ª edição fala" "edge-money-path-invariants"
saida="$(run Write "{\"file_path\":\"$EDGE\",\"content\":\"2\"}" sess-e)"
expect_silencio "2ª edição do mesmo arquivo na mesma sessão"
saida="$(run Write '{"file_path":"supabase/functions/omie-sync/index.ts","content":"1"}' sess-e)"
expect_fala "OUTRA edge na mesma sessão volta a falar" "vitest"

echo "── (f) o número do resumo é o TOTAL, não o que coube na lista ──"
# A lista trunca em 8 + uma linha "+N", então contar linhas mentiria assim que o total passasse de
# 9 (medido: 3 alvos → 11 guardrails, 9 linhas). A asserção compara o número do systemMessage com
# os testes do comando final — invariante, sem fixar um número que envelhece a cada guardrail novo.
saida="$(run Write "{\"file_path\":\"$EDGE\",\"content\":\"x\"}" sess-f)"
n_msg="$(printf '%s' "$saida" | jq -r '.systemMessage' | tr -dc '0-9' | head -c 3)"
n_cmd="$(printf '%s' "$saida" | jq -r '.hookSpecificOutput.additionalContext' | tail -1 | tr ' ' '\n' | grep -c '\.test\.ts$')"
if [ -n "$n_msg" ] && [ "$n_msg" = "$n_cmd" ]; then echo "  ok    FALA     | resumo diz $n_msg e o comando roda $n_cmd"
else echo "  FAIL  want FALA (resumo=$n_msg comando=$n_cmd)"; fail=1; fi

echo
if [ "$fail" -eq 0 ]; then echo "PASS — edge-guardrail-nudge"; else echo "FALHOU"; fi
exit "$fail"
