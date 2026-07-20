#!/usr/bin/env bash
# vigia-worktree.sh — SessionStart(startup): worktree pronto-pra-uso + sinais de RAM.
#
# 1) node_modules ausente → dispara `bun install` em BACKGROUND e avisa a sessão
#    (senão o 1º typecheck dá "Cannot find module" — FALSO vermelho; o CI real
#    se confere com `gh pr checks`). Já custou 3× bun install manual + falso
#    alarme de CI (diagnóstico 2026-07).
# 2) swap alto / muitas sessões Claude vivas → aviso de higiene (a alavanca real
#    de RAM na M2 8GB é FECHAR sessões — wt:status mostra as ociosas).
#
# Melhor-esforço: nunca bloqueia; qualquer falha interna vira silêncio ('{}').
set -u

avisos=""

# --- 1) deps da worktree ------------------------------------------------------
if [ -f package.json ] && [ ! -d node_modules ] && command -v bun >/dev/null 2>&1; then
  log="${TMPDIR:-/tmp}/bun-install-wt-$$.log"
  (bun install >"$log" 2>&1 &)
  avisos="${avisos}node_modules AUSENTE → 'bun install' já disparado em background (log: $log). Aguarde-o antes de test/typecheck — 'Cannot find module' agora seria falso vermelho (CI real: gh pr checks). "
fi

# --- 2) swap (macOS: "total = 10240.00M  used = 9100.00M  ...") ---------------
swap_used_mb="$(sysctl -n vm.swapusage 2>/dev/null | sed -E 's/.*used = ([0-9]+)[.,].*/\1/')"
case "$swap_used_mb" in
  ''|*[!0-9]*) swap_used_mb=0 ;;
esac
if [ "$swap_used_mb" -gt 6144 ]; then
  avisos="${avisos}Swap em ${swap_used_mb}MB (M2 8GB sufocando) → sugira ao founder 'bun run wt:status' + fechar sessões ociosas / wt:clean / wt:reap. "
fi

# --- 3) sessões Claude vivas --------------------------------------------------
n_sessoes="$(pgrep -f 'claude.app/Contents/MacOS/claude' 2>/dev/null | wc -l | tr -d ' ')"
case "$n_sessoes" in
  ''|*[!0-9]*) n_sessoes=0 ;;
esac
if [ "$n_sessoes" -gt 6 ]; then
  avisos="${avisos}${n_sessoes} sessões Claude vivas → a alavanca real de RAM é FECHAR sessões (wt:status lista as ociosas). "
fi

# --- 4) semáforo `heavy` desatualizado ou ausente -----------------------------
# ~/.local/bin/heavy é CÓPIA de scripts/heavy.sh: mergear na main NÃO atualiza o
# semáforo em uso (#1459 ficou inerte). Só AVISA — não instala: o CI é ubuntu e
# nunca prova o heavy (test-heavy.sh é macOS-only), então auto-instalar propagaria
# para todas as sessões um script não validado, sem ninguém no circuito.
# A comparação NÃO é reimplementada aqui: quem define "divergente" é o
# heavy-install.sh --status, num lugar só. Script ausente (worktree antiga) → silêncio.
#
# Teto de 3s no --status: é o único bloco deste hook que roda subprocess
# não-trivial (heavy-install.sh chama `git show`). Sem teto, um `git show` lento
# — justo o cenário de swap alto/I-O sufocado, quando os avisos 2)/3) MAIS
# importam — pode consumir o timeout:10 do SessionStart (settings.json) inteiro;
# como a saída só é emitida no fim do script, o hook inteiro morre e NENHUM
# aviso sai, nem os de 2)/3) já prontos antes deste bloco. `timeout(1)` não é
# nativo do macOS — nesta máquina só existe via Homebrew (/opt/homebrew/bin).
# Sem ele: roda direto, sem proteção de teto (mesmo risco que já existia antes
# deste bloco — não piora nada) — nunca pula nem quebra por causa disso.
if [ -x scripts/heavy-install.sh ]; then
  if command -v timeout >/dev/null 2>&1; then
    if ! st="$(timeout 3 bash scripts/heavy-install.sh --status 2>/dev/null)"; then
      avisos="${avisos}${st:-heavy divergente} → rode 'bun run heavy:install' (o heavy em uso é CÓPIA de scripts/heavy.sh; merge na main não atualiza o semáforo). "
    fi
  else
    if ! st="$(bash scripts/heavy-install.sh --status 2>/dev/null)"; then
      avisos="${avisos}${st:-heavy divergente} → rode 'bun run heavy:install' (o heavy em uso é CÓPIA de scripts/heavy.sh; merge na main não atualiza o semáforo). "
    fi
  fi
fi

# --- saída --------------------------------------------------------------------
if [ -n "$avisos" ] && command -v jq >/dev/null 2>&1; then
  jq -n --arg c "Vigia do worktree: $avisos" \
    '{hookSpecificOutput:{hookEventName:"SessionStart",additionalContext:$c}}'
else
  echo '{}'
fi
