#!/usr/bin/env bash
# test-wt-clean.sh — TDD do scripts/wt-clean.sh com `git`/`du`/`lsof` STUBADOS.
# NADA aqui toca worktree real: o `git worktree list` vem de um fixture em
# `mktemp -d`. O `--yes` é exercitado de verdade — e apaga de verdade — mas só
# node_modules de mentira dentro do fixture.
#
# Contrato testado. Como o script APAGA, as asserções do `--yes` são FÍSICAS
# (o diretório ainda está lá?), não textuais: uma mensagem de "skip" não prova
# que nada foi apagado.
#
#   1. Sonda de segurança que não responde é FAIL-CLOSED. Medido contra a
#      origin/main de 2026-08-21: com `lsof` devolvendo 127, `active_file` fica
#      vazio, `is_active` responde "não" para todo mundo e a worktree de sessão
#      VIVA passava de "skip (sessão/processo ativo)" para "would … -250 MB",
#      calada. Checar `command -v` não basta — a ferramenta presente-porém-
#      quebrada esvazia o `active_file` igual —, por isso o caso 4 stuba um
#      `lsof` que EXISTE e falha.
#
#   2. `sz="$(du -sm "$nm" | cut -f1)"` sob `set -e`+`pipefail` matava o script
#      quando o `du` falhava (medido: EXIT=1, varredura parando na 1ª worktree),
#      e o `${sz:-0}` fabricava ZERO para o não-medido (money-path §2: ausente ≠
#      zero). Sem teto, ainda: node_modules em máquina saturada custa 6-8s cada.
#
# Uso: bash scripts/test-wt-clean.sh   (exit 0 = tudo verde)
set -u

here="$(cd "$(dirname "$0")" && pwd)"
ALVO="${WT_CLEAN_ALVO:-$here/wt-clean.sh}"

stub="$(mktemp -d)"
fix="$(mktemp -d)"
trap 'rm -rf "$stub" "$fix"' EXIT

falhas=0
ok() { printf '  \033[32mok\033[0m   %s\n' "$1"; }
falha() {
  printf '  \033[31mFALHA\033[0m %s\n' "$1"
  falhas=$((falhas + 1))
}

# ── fixture: a worktree "atual" + 4 candidatas, todas com node_modules ──────
mkdir -p "$fix/self/node_modules"
{
  echo "worktree $fix/self"
  echo
} >"$fix/worktrees.txt"
for w in alfa bravo charlie delta; do
  {
    echo "worktree $fix/wt-$w"
    echo
  } >>"$fix/worktrees.txt"
done
# recria os node_modules antes de cada rodada que apaga
semear() {
  for w in alfa bravo charlie delta; do
    mkdir -p "$fix/wt-$w/node_modules"
    echo conteudo >"$fix/wt-$w/node_modules/pacote.txt"
  done
}
semear

# ── stubs ───────────────────────────────────────────────────────────────────
cat >"$stub/git" <<STUB
#!/bin/sh
[ "\$1 \$2" = "worktree list" ] && { cat "$fix/worktrees.txt"; exit 0; }
exit 0
STUB

# du: DU_MODO = ok | falha | lento
cat >"$stub/du" <<'STUB'
#!/bin/sh
alvo="$2"
case "${DU_MODO:-ok}" in
  falha) exit 1 ;;
  lento) sleep 20; printf '111\t%s\n' "$alvo" ;;
  *)     printf '250\t%s\n' "$alvo" ;;
esac
STUB

# lsof: LSOF_MODO = ok | ativo (alfa com sessão viva) | quebrado (existe e falha)
# A consulta de CONTROLE (`-p <pid>`) é a que prova que a sonda responde.
cat >"$stub/lsof" <<STUB
#!/bin/sh
[ "\${LSOF_MODO:-ok}" = "quebrado" ] && exit 127
case "\$*" in
  *-p*) echo "n$fix/self"; exit 0 ;;   # controle: a sonda está viva
esac
[ "\${LSOF_MODO:-ok}" = "ativo" ] && echo "n$fix/wt-alfa"
exit 0
STUB

chmod +x "$stub/git" "$stub/du" "$stub/lsof"

roda() {
  PATH="$stub:$PATH" bash "$ALVO" "$@" 2>&1
  echo "EXIT=$?"
}
linha_de() { command grep -- "$1" 2>/dev/null; }
# quantos node_modules do fixture continuam de pé
nm_vivos() {
  local n=0 w
  for w in alfa bravo charlie delta; do
    [ -d "$fix/wt-$w/node_modules" ] && n=$((n + 1))
  done
  printf '%s' "$n"
}

cd "$fix/self" || exit 1

# ── caso 1 — `du` que FALHA não mata o script nem some com as worktrees ─────
saida="$(DU_MODO=falha roda)"
if [ "${saida##*EXIT=}" = "0" ]; then
  ok "du falhando → script segue e sai 0"
else
  falha "du falhando → esperava EXIT=0, veio EXIT=${saida##*EXIT=}"
fi
if [ "$(printf '%s' "$saida" | linha_de 'would' | command grep -c .)" = "4" ]; then
  ok "du falhando → as 4 worktrees ainda sao classificadas"
else
  falha "du falhando → a varredura parou no meio (set -e matou o script)"
fi
if printf '%s' "$saida" | command grep -q 'sem medida (erro do du)'; then
  ok "du falhando → declara 'sem medida', nao 0 MB"
else
  falha "du falhando → nao declarou 'sem medida' (ausente virou zero)"
fi
if printf '%s' "$saida" | command grep -q 'sem medida (teto'; then
  falha "du falhando → creditou o RELOGIO por um erro do du"
else
  ok "du falhando → motivo correto (nao creditou o teto)"
fi
if printf '%s' "$saida" | command grep -q 'piso'; then
  ok "total parcial marcado como PISO"
else
  falha "total parcial nao foi marcado como piso — le-se como total fechado"
fi

# ── caso 2 — `du` LENTO estoura o teto e degrada em vez de pendurar ─────────
ini="$SECONDS"
saida="$(DU_MODO=lento WT_CAP_ITEM=1 roda)"
gasto=$((SECONDS - ini))
if [ "${saida##*EXIT=}" = "0" ]; then
  ok "du lento → sai 0 (degradacao nao e falha)"
else
  falha "du lento → esperava EXIT=0, veio EXIT=${saida##*EXIT=}"
fi
if [ "$gasto" -le 40 ]; then
  ok "du lento → respeitou o teto (${gasto}s, 4 worktrees x 20s de du)"
else
  falha "du lento → pendurou ${gasto}s; o teto nao segurou"
fi
if printf '%s' "$saida" | command grep -q 'sem medida (teto'; then
  ok "du lento → motivo correto ('teto', nao 'erro do du')"
else
  falha "du lento → atribuiu o motivo errado ao nao-medido"
fi

# ── caso 3 — caminho FELIZ: o valor medido aparece e soma no total ──────────
saida="$(roda)"
if printf '%s' "$saida" | command grep -q -- '-250 MB'; then
  ok "du ok → o valor medido aparece de verdade"
else
  falha "du ok → perdeu o valor medido"
fi
if printf '%s' "$saida" | command grep -q '~1000 MB'; then
  ok "du ok → soma os 4 x 250 MB no total"
else
  falha "du ok → total nao fechou com as medidas"
fi
if printf '%s' "$saida" | command grep -q 'piso'; then
  falha "du ok → marcou PISO sem ter nada sem medida"
else
  ok "du ok → nao marca piso quando mediu tudo"
fi

# ── caso 4 — lsof QUEBRADO no dry-run: avisa que o veredito nao vale ────────
saida="$(LSOF_MODO=quebrado roda)"
if printf '%s' "$saida" | command grep -q 'lsof não respondeu'; then
  ok "lsof quebrado + dry-run → avisa que o dry-run nao e confiavel"
else
  falha "lsof quebrado + dry-run → seguiu calado (guard que emudece)"
fi

# ── caso 5 — lsof QUEBRADO no --yes: ABORTA e nao apaga NADA (fisico) ───────
semear
saida="$(LSOF_MODO=quebrado roda --yes)"
if [ "${saida##*EXIT=}" = "1" ]; then
  ok "lsof quebrado + --yes → aborta (EXIT=1)"
else
  falha "lsof quebrado + --yes → esperava EXIT=1, veio EXIT=${saida##*EXIT=}"
fi
if [ "$(nm_vivos)" = "4" ]; then
  ok "lsof quebrado + --yes → os 4 node_modules continuam INTACTOS"
else
  falha "lsof quebrado + --yes → apagou $((4 - $(nm_vivos))) node_modules as cegas"
fi

# ── caso 6 — caminho FELIZ do guard: sessao viva e poupada ──────────────────
saida="$(LSOF_MODO=ativo roda)"
if printf '%s' "$saida" | linha_de 'wt-alfa' | command grep -q 'sessão/processo ativo'; then
  ok "lsof ok → worktree com sessao viva e poupada"
else
  falha "lsof ok → a worktree ativa nao foi poupada"
fi

# ── caso 7 — --yes com tudo saudavel: apaga de verdade e fecha o resumo ─────
semear
saida="$(roda --yes)"
if [ "${saida##*EXIT=}" = "0" ]; then
  ok "--yes saudavel → sai 0"
else
  falha "--yes saudavel → EXIT=${saida##*EXIT=}"
fi
if [ "$(nm_vivos)" = "0" ]; then
  ok "--yes saudavel → apagou os 4 node_modules"
else
  falha "--yes saudavel → sobraram $(nm_vivos) node_modules"
fi
if printf '%s' "$saida" | command grep -q '✅ liberados'; then
  ok "--yes saudavel → imprime o resumo do que fez"
else
  falha "--yes saudavel → morreu antes do resumo (o dano fica invisivel)"
fi

# ── caso 8 — --yes com `du` FALHANDO ainda apaga e ainda fecha o resumo ─────
# O `du` aqui é ORNAMENTAL: a decisão de apagar não depende dele. Antes, um `du`
# falho matava o script no MEIO do --yes — depois de já ter apagado —, então o
# founder não via o que tinha sido feito.
semear
saida="$(DU_MODO=falha roda --yes)"
if [ "${saida##*EXIT=}" = "0" ]; then
  ok "--yes + du falho → sai 0"
else
  falha "--yes + du falho → EXIT=${saida##*EXIT=} (morreu no meio da limpeza)"
fi
if [ "$(nm_vivos)" = "0" ]; then
  ok "--yes + du falho → apagou os 4 assim mesmo (o du e ornamental)"
else
  falha "--yes + du falho → parou no meio: sobraram $(nm_vivos) node_modules"
fi
if printf '%s' "$saida" | command grep -q '✅ liberados'; then
  ok "--yes + du falho → ainda imprime o resumo do que fez"
else
  falha "--yes + du falho → apagou e nao contou (dano invisivel)"
fi

echo
if [ "$falhas" -eq 0 ]; then
  echo "✅ test-wt-clean: tudo verde"
  exit 0
fi
echo "❌ test-wt-clean: $falhas falha(s)"
exit 1
