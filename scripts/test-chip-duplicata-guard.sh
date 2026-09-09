#!/usr/bin/env bash
# test-chip-duplicata-guard.sh — TDD do hook .claude/hooks/chip-duplicata-guard.sh
#
# Regra: PreToolUse(spawn_task) AVISA (nunca nega) em três eixos independentes —
#   1. ARTEFATO  — alvo compartilhado (edge/script) que OUTRA worktree já chipou na janela
#   2. MECÂNICA  — o chip se justifica por consulta que não respondeu (exit 2/inconsultável/…)
#   3. TEMPLATE  — as 2 primeiras palavras do título repetem leva aberta por ≥2 outras worktrees
# Fora disso: silêncio. E o ledger é escrito SEMPRE, inclusive no silêncio.
#
# Uso: bash scripts/test-chip-duplicata-guard.sh   (exit 0 = verde)
set -u

here="$(cd "$(dirname "$0")" && pwd)"
HOOK="$here/../.claude/hooks/chip-duplicata-guard.sh"
REPO="$(cd "$here/.." && pwd)"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
export CHIP_LEDGER="$tmp/ledger.tsv"
export CDG_CACHE_DIR="$tmp/cache"

# Worktrees FALSAS: o vocabulário sai do disco, então o teste controla o vocabulário em vez de
# depender do repo real (que muda toda semana e tornaria a suíte flaky por motivo alheio).
for wt in wtA wtB; do
  mkdir -p "$tmp/$wt/supabase/functions/omie-nfe-reconcile"
  # "build" (5 letras) é o que exercita o filtro GENERICOS: "test"/"wt" já morrem no filtro de
  # comprimento, então sem ele a mutação "GENERICOS vazio" sobrevivia (falsificação 2026-09-08).
  printf '{"scripts":{"pendencias:deploy":"x","mutcheck":"y","test":"z","wt":"w","build":"b"}}\n' >"$tmp/$wt/package.json"
done

falhas=0
ok()    { printf '  ✅ %s\n' "$1"; }
falha() { printf '  ❌ %s\n' "$1"; falhas=$((falhas + 1)); }
limpar(){ rm -f "$CHIP_LEDGER"; rm -rf "$CDG_CACHE_DIR"; }

chip() { # <titulo> [tldr] → JSON de entrada do hook
  jq -n --arg t "$1" --arg d "${2:-}" \
    '{tool_name:"mcp__ccd_session__spawn_task",tool_input:{title:$t,tldr:$d}}'
}
run() { # <worktree> <titulo> [tldr] → stdout do hook
  local wt="$1"; shift
  chip "$@" | CLAUDE_PROJECT_DIR="$tmp/$wt" bash "$HOOK" 2>/dev/null
}
# Casa o CONTRATO, não o texto solto: o host só entrega o aviso ao agente se vier
# additionalContext NÃO-VAZIO sob hookEventName PreToolUse — e permissionDecision TEM de ser
# "allow": este guard avisa, nunca nega (negar chip perde trabalho real). Grepar o JSON cru
# deixaria passar um hook que virasse "deny" por engano.
avisou() { # <stdout> <regex do motivo>
  printf '%s' "$1" | jq -e --arg re "$2" '
    .hookSpecificOutput.hookEventName == "PreToolUse"
    and .hookSpecificOutput.permissionDecision == "allow"
    and ((.hookSpecificOutput.additionalContext // "") | test($re))' >/dev/null 2>&1
}
calou() { # <stdout> — silêncio é saída VAZIA (nenhum JSON), não JSON sem contexto
  [ -z "$(printf '%s' "$1" | tr -d '[:space:]')" ]
}

echo "== eixo MECÂNICA =="
# O caso REAL de 2026-09-08. O texto chega ao hook com acento; a normalização sob LC_ALL=C
# transforma "não pôde ser consultada" em "n o p de ser consultada" — se alguém trocar os
# marcadores por versões acentuadas, NADA casa e o eixo aprova tudo calado. Este teste é o que
# torna essa regressão impossível de passar despercebida.
s="$(run wtA "Destravar ledger de deploy e provar 2 edges sem prova" \
  "O fecho não conseguiu provar se duas edges estão no ar: o comando que lê o ledger falhou por conta própria, então a prova durável não pôde ser consultada.")"
if avisou "$s" "MEC.NICA"; then
  ok "chip justificado por consulta que não respondeu → avisa"
else
  falha "chip do caso real de 08/09 NÃO avisou (marcador acentuado não casa a forma normalizada?)"
fi

s="$(run wtA "Corrigir o gate de authz que ficou vermelho na main" "Ajuste do manifesto.")"
if calou "$s"; then
  ok "chip de defeito REAL (sem marca de consulta muda) → silêncio"
else
  falha "falso positivo: 'vermelho na main' não é consulta que falhou"
fi

echo "== eixo ARTEFATO =="
limpar
s="$(run wtA "Confirmar deploy da edge omie-nfe-reconcile")"
if calou "$s"; then
  ok "1º chip do alvo → silêncio (não há com quem duplicar)"
else
  falha "1º chip avisou sem outra worktree no ledger"
fi

s="$(run wtA "Verificar deploy da edge omie-nfe-reconcile")"
if calou "$s"; then
  ok "MESMA worktree repetindo o alvo → silêncio (é a mesma linha de trabalho)"
else
  falha "avisou duplicata contra a própria worktree — o filtro de origem sumiu"
fi

s="$(run wtB "Verificar deploy da edge omie-nfe-reconcile")"
if avisou "$s" "omie-nfe-reconcile"; then
  ok "OUTRA worktree, mesmo alvo → avisa nomeando o alvo"
else
  falha "duplicata entre worktrees NÃO avisou"
fi

echo "== janela e vocabulário =="
limpar
# Entrada VELHA (30 dias) não conta: ledger é cache de janela, não histórico.
printf '%s\tantiga\tomie-nfe-reconcile\tconfirmar deploy\tvelho\n' "$(( $(date +%s) - 30 * 86400 ))" >"$CHIP_LEDGER"
s="$(run wtB "Confirmar deploy da edge omie-nfe-reconcile")"
if calou "$s"; then
  ok "chip de 30d atrás fora da janela → silêncio"
else
  falha "entrada expirada ainda dispara aviso — o corte da janela não é aplicado"
fi

limpar
run wtA "Rodar test e wt no build" >/dev/null
s="$(run wtB "Rodar test e wt no build")"
if calou "$s"; then
  ok "nomes genéricos (test/wt/build) não viram chave"
else
  falha "genérico virou chave — casaria em quase todo chip e cegaria o guard por fadiga"
fi

echo "== contrato de acionamento =="
limpar
# A entrada alheia carrega um `title` que DISPARARIA o eixo MECÂNICA se o hook a aceitasse —
# só assim o teste alcança a checagem de tool_name em vez de parar no título vazio.
s="$(jq -n '{tool_name:"OutraFerramenta",tool_input:{title:"Destravar ledger: exit 2, sem prova"}}' \
  | CLAUDE_PROJECT_DIR="$tmp/wtA" bash "$HOOK" 2>/dev/null)"
if calou "$s"; then
  ok "ferramenta que não é spawn_task → ignora"
else
  falha "hook opinou sobre ferramenta alheia"
fi
if [ ! -s "$CHIP_LEDGER" ]; then
  ok "e não sujou o ledger com chamada alheia"
else
  falha "gravou no ledger a partir de ferramenta que não é chip"
fi

echo "== ledger escrito no SILÊNCIO =="
limpar
s="$(run wtA "Fechar o TOCTOU de aprovar_pedido_sugerido" "Corrige corrida.")"
if ! calou "$s"; then
  falha "chip inocente avisou"
fi
if [ -s "$CHIP_LEDGER" ] && [ "$(LC_ALL=C wc -l < "$CHIP_LEDGER" | tr -d ' ')" = "1" ]; then
  ok "chip silencioso MESMO ASSIM entrou no ledger (senão a 2ª worktree não teria com o que casar)"
else
  falha "silêncio não gravou no ledger — o guard ficaria cego para a duplicata seguinte"
fi

echo "== anti-alarm-fatigue =="
limpar
run wtA "Confirmar deploy da edge omie-nfe-reconcile" >/dev/null
s1="$(run wtB "Confirmar deploy da edge omie-nfe-reconcile")"
s2="$(run wtB "Confirmar deploy da edge omie-nfe-reconcile")"
if avisou "$s1" "omie-nfe-reconcile" && calou "$s2"; then
  ok "mesmo achado, mesma worktree → avisa 1x e cala na repetição"
else
  falha "repetiu o MESMO aviso (fadiga) ou não avisou na 1ª"
fi

echo "== vocabulário do repo REAL =="
# Os testes acima usam worktrees falsas de propósito; este prova que o leitor casa o layout de
# verdade (supabase/functions + package.json do repo), que é onde ele vai rodar.
limpar
alvo_real="$(basename "$(find "$REPO/supabase/functions" -maxdepth 1 -mindepth 1 -type d -not -name '_*' 2>/dev/null | LC_ALL=C sort | head -1)")"
if [ -n "$alvo_real" ]; then
  printf '%s\toutra-worktree\t%s\tconfirmar deploy\tx\n' "$(date +%s)" "$alvo_real" >"$CHIP_LEDGER"
  s="$(chip "Confirmar deploy da edge $alvo_real" | CLAUDE_PROJECT_DIR="$REPO" bash "$HOOK" 2>/dev/null)"
  if avisou "$s" "$alvo_real"; then
    ok "vocabulário lido do repo real casa a edge '$alvo_real'"
  else
    falha "não casou edge REAL do repo — o leitor de vocabulário não serve onde vai rodar"
  fi
else
  falha "não achei nenhuma edge em supabase/functions para o teste de vocabulário real"
fi

echo
if [ "$falhas" -eq 0 ]; then
  echo "✅ chip-duplicata-guard: todos os casos passaram"
  exit 0
fi
echo "❌ chip-duplicata-guard: $falhas caso(s) falharam"
exit 1
