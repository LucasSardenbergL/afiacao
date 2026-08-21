#!/usr/bin/env bash
# test-wt-prune.sh — TDD do scripts/wt-prune.sh com `git`/`du`/`lsof`/`md5`
# STUBADOS. NADA aqui toca worktree real: o `git worktree list` vem de um
# fixture em `mktemp -d` e o `git worktree remove` é um stub que só registra
# num log — o `--yes` é exercitado de verdade, mas contra diretórios de mentira.
#
# Contrato testado — este script REMOVE worktrees, então a assimetria com o
# `wt:status` é o ponto: lá uma leitura que falta degrada a seção e a vida
# segue; aqui a mesma leitura que falta vira REMOÇÃO INDEVIDA.
#
#   1. Sonda de segurança que não responde é FAIL-CLOSED. Medido contra a
#      origin/main de 2026-08-21: com `lsof` devolvendo 127, a worktree de
#      sessão VIVA passava de "skip (sessão/processo ativo)" para
#      "would … -250 MB", calada. E com `md5` ausente, os dois lados da
#      comparação viravam string vazia, `[ "" = "" ]` dava VERDADEIRO e o
#      `.env` com segredo único — o exato caso que a allowlist existe para
#      bloquear — era classificado como descartável.
#      Checar `command -v` NÃO basta: a ferramenta presente-porém-quebrada
#      esvazia o `active_file` igual. Por isso o caso 5 stuba um `lsof` que
#      EXISTE e falha.
#
#   2. `sz="$(du -sm "$wt" | cut -f1)"` sob `set -e`+`pipefail`, em `handle()`
#      (chamada solta ⇒ `set -e` ativo), matava o script: medido EXIT=1 com a
#      varredura parando na 1ª worktree — e, no `--yes`, isso acontecia DEPOIS
#      de já ter removido, sem imprimir o resumo do que fez. O `${sz:-0}`
#      fabricava ZERO para o não-medido (money-path §2: ausente ≠ zero).
#
#   3. Nenhum leitor que fecha o pipe cedo (`| head`) — regra 1 do #1838. O
#      `| head -3` do `ignored_blockers` sobrevivia por ACIDENTE: `classify` só
#      é chamada dentro de `if !`, e isso suspende o `set -e` (o mesmo pipeline
#      solto sai 141 e mata). O caso 11 trava o comportamento com muitos
#      blockers para o próximo refactor não reintroduzir a morte.
#
# Uso: bash scripts/test-wt-prune.sh   (exit 0 = tudo verde)
set -u

here="$(cd "$(dirname "$0")" && pwd)"
ALVO="${WT_PRUNE_ALVO:-$here/wt-prune.sh}"

stub="$(mktemp -d)"
fix="$(mktemp -d)"
semhash="$(mktemp -d)"
trap 'rm -rf "$stub" "$fix" "$semhash"' EXIT

falhas=0
ok() { printf '  \033[32mok\033[0m   %s\n' "$1"; }
falha() {
  printf '  \033[31mFALHA\033[0m %s\n' "$1"
  falhas=$((falhas + 1))
}

# ── fixture: a worktree "atual" + 4 candidatas ──────────────────────────────
mkdir -p "$fix/self"
echo "SEGREDO_DA_REFERENCIA=abc" >"$fix/self/.env"
{
  echo "worktree $fix/self"
  echo
} >"$fix/worktrees.txt"
for w in alfa bravo charlie delta; do
  mkdir -p "$fix/wt-$w"
  {
    echo "worktree $fix/wt-$w"
    echo
  } >>"$fix/worktrees.txt"
done
# alfa tem .env DIFERENTE (segredo único); bravo tem .env IDÊNTICO ao de referência
echo "SEGREDO_UNICO_DA_ALFA=xyz" >"$fix/wt-alfa/.env"
echo "SEGREDO_DA_REFERENCIA=abc" >"$fix/wt-bravo/.env"

# ── stubs ───────────────────────────────────────────────────────────────────
# git: worktree list do fixture; `worktree remove` só REGISTRA (nada é apagado).
# BLOCKERS=N faz o `status --ignored` emitir N ignorados não-descartáveis;
# ENVBLOCK=1 acrescenta o `.env` à lista de ignorados.
cat >"$stub/git" <<STUB
#!/bin/sh
case "\$1 \$2" in
  "worktree list")   cat "$fix/worktrees.txt"; exit 0 ;;
  "worktree remove") echo "\$3" >> "$fix/removidas.log"; exit 0 ;;
  "worktree prune")  exit 0 ;;
  "fetch origin")    exit 0 ;;
esac
alvo=""
if [ "\$1" = "-C" ]; then alvo="\$2"; shift 2; fi
case "\$1 \$2" in
  "rev-parse --verify")        exit 0 ;;
  "rev-parse --abbrev-ref")    echo "claude/fake-branch"; exit 0 ;;
  "merge-base --is-ancestor")  exit 0 ;;
esac
case "\$1" in
  status)
    for a in "\$@"; do [ "\$a" = "--ignored" ] && ign=1; done
    if [ "\${ign:-0}" = 1 ]; then
      i=0
      while [ "\$i" -lt "\${BLOCKERS:-0}" ]; do i=\$((i+1)); echo "!! segredo-\$i.pem"; done
      [ "\${ENVBLOCK:-0}" = 1 ] && [ -f "\$alvo/.env" ] && echo "!! .env"
    fi
    exit 0 ;;
  rev-parse) echo "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"; exit 0 ;;
esac
exit 0
STUB

# du: DU_MODO = ok | falha | lento
cat >"$stub/du" <<'STUB'
#!/bin/sh
alvo="$2"
case "${DU_MODO:-ok}" in
  falha) exit 1 ;;
  lento) sleep 30; printf '111\t%s\n' "$alvo" ;;
  *)     printf '250\t%s\n' "$alvo" ;;
esac
STUB

# lsof: LSOF_MODO = ok | ativo (alfa com sessão viva) | quebrado (existe e falha)
# A consulta de CONTROLE (`-p <pid>`) é a que prova que a sonda responde — um
# lsof funcional sempre sabe o cwd do próprio processo.
cat >"$stub/lsof" <<STUB
#!/bin/sh
[ "\${LSOF_MODO:-ok}" = "quebrado" ] && exit 127
case "\$*" in
  *-p*) echo "n$fix/self"; exit 0 ;;   # controle: a sonda está viva
esac
[ "\${LSOF_MODO:-ok}" = "ativo" ] && echo "n$fix/wt-alfa"
exit 0
STUB

# md5 com hash de verdade (cksum basta: só precisa distinguir conteúdo).
cat >"$stub/md5" <<'STUB'
#!/bin/sh
shift  # -q
cksum "$1" 2>/dev/null | awk '{print $1}'
STUB

chmod +x "$stub/git" "$stub/du" "$stub/lsof" "$stub/md5"

# Diretório de stubs SEM sonda de hash nenhuma: as três saem 127. Entra no PATH
# só nos casos 9 e 10 — nos demais o hash é medido de verdade (no macOS pelo
# stub `md5`, no CI Ubuntu pelo `md5sum` do sistema).
for c in md5 md5sum shasum; do
  printf '#!/bin/sh\nexit 127\n' >"$semhash/$c"
  chmod +x "$semhash/$c"
done

# roda o script com os stubs na frente do PATH; ecoa "EXIT=<rc>" na última linha
roda() {
  : >"$fix/removidas.log"
  PATH="$stub:$PATH" bash "$ALVO" "$@" 2>&1
  echo "EXIT=$?"
}
# idem, mas com as tres sondas de hash saindo 127 (só o dry-run precisa disso)
roda_sem_hash() {
  : >"$fix/removidas.log"
  PATH="$semhash:$stub:$PATH" bash "$ALVO" 2>&1
  echo "EXIT=$?"
}
linha_de() { command grep -- "$1" 2>/dev/null; }

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
# MOTIVO CERTO: aqui o du falhou de verdade — não pode ser creditado ao teto.
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
if [ "$gasto" -le 15 ]; then
  ok "du lento → respeitou o teto (${gasto}s, 4 worktrees x 30s de du)"
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

# ── caso 5 — lsof QUEBRADO no --yes: ABORTA sem remover nada ────────────────
# A ferramenta EXISTE e falha: `command -v` acharia. Só a sonda de controle pega.
saida="$(LSOF_MODO=quebrado roda --yes)"
if [ "${saida##*EXIT=}" = "1" ]; then
  ok "lsof quebrado + --yes → aborta (EXIT=1)"
else
  falha "lsof quebrado + --yes → esperava EXIT=1, veio EXIT=${saida##*EXIT=}"
fi
if [ ! -s "$fix/removidas.log" ]; then
  ok "lsof quebrado + --yes → NAO removeu worktree nenhuma"
else
  falha "lsof quebrado + --yes → removeu $(command grep -c . "$fix/removidas.log") worktree(s) as cegas"
fi

# ── caso 6 — caminho FELIZ do guard: sessao viva e poupada ──────────────────
saida="$(LSOF_MODO=ativo roda)"
if printf '%s' "$saida" | linha_de 'wt-alfa' | command grep -q 'sessão/processo ativo'; then
  ok "lsof ok → worktree com sessao viva e poupada"
else
  falha "lsof ok → a worktree ativa nao foi poupada"
fi

# ── caso 7 — .env DIFERENTE bloqueia a remocao ──────────────────────────────
saida="$(ENVBLOCK=1 roda)"
if printf '%s' "$saida" | linha_de 'wt-alfa' | command grep -q 'KEEP'; then
  ok ".env com segredo unico → BLOQUEIA a remocao"
else
  falha ".env com segredo unico → deixou passar"
fi

# ── caso 8 — .env IDENTICO segue descartavel (nao quebrei o caminho feliz) ──
if printf '%s' "$saida" | linha_de 'wt-bravo' | command grep -q 'would'; then
  ok ".env identico ao de referencia → segue descartavel"
else
  falha ".env identico → virou bloqueio (fail-closed cego demais)"
fi

# ── caso 9 — SEM sonda de hash: .env diferente bloqueia (fail-closed) ───────
saida="$(ENVBLOCK=1 roda_sem_hash)"
if printf '%s' "$saida" | linha_de 'wt-alfa' | command grep -q 'KEEP'; then
  ok "sem sonda de hash → .env diferente BLOQUEIA"
else
  falha "sem sonda de hash → .env com segredo unico passou como descartavel"
fi

# ── caso 10 — SEM sonda de hash: ate o .env IDENTICO bloqueia ───────────────
# "Não sei" tem de virar bloqueio, não descarte: sem hash não há como afirmar
# que são iguais, e o custo de errar é perder um .env com segredo único.
if printf '%s' "$saida" | linha_de 'wt-bravo' | command grep -q 'KEEP'; then
  ok "sem sonda de hash → ate o .env identico bloqueia ('nao sei' ≠ 'igual')"
else
  falha "sem sonda de hash → concluiu 'identico' sem ter medido"
fi

# ── caso 11 — muitos ignorados: nao morre e o veredito continua KEEP ────────
# Trava o `awk 'NR<=3'`: o `| head -3` daqui só sobrevivia porque `classify` é
# chamada dentro de `if !`, o que suspende o `set -e`. Qualquer refactor que a
# chame solta reintroduz o SIGPIPE(141) — e este caso fica vermelho.
saida="$(BLOCKERS=5000 roda)"
if [ "${saida##*EXIT=}" = "0" ]; then
  ok "5000 ignorados → sai 0 (sem SIGPIPE)"
else
  falha "5000 ignorados → EXIT=${saida##*EXIT=} (141 = SIGPIPE do leitor que fecha o pipe)"
fi
if [ "$(printf '%s' "$saida" | linha_de 'KEEP' | command grep -c .)" = "4" ]; then
  ok "5000 ignorados → as 4 worktrees viram KEEP"
else
  falha "5000 ignorados → a varredura nao classificou as 4"
fi
if printf '%s' "$saida" | linha_de 'wt-alfa' | command grep -q 'segredo-3.pem'; then
  ok "5000 ignorados → mostra os 3 primeiros no motivo"
else
  falha "5000 ignorados → perdeu a amostra de blockers no motivo"
fi

# ── caso 12 — --yes com tudo saudavel: remove e fecha o resumo ──────────────
saida="$(roda --yes)"
if [ "${saida##*EXIT=}" = "0" ]; then
  ok "--yes saudavel → sai 0"
else
  falha "--yes saudavel → EXIT=${saida##*EXIT=}"
fi
if [ "$(command grep -c . "$fix/removidas.log")" = "4" ]; then
  ok "--yes saudavel → removeu as 4 candidatas"
else
  falha "--yes saudavel → removeu $(command grep -c . "$fix/removidas.log") de 4"
fi
if printf '%s' "$saida" | command grep -q '✅ removidas 4'; then
  ok "--yes saudavel → imprime o resumo do que fez"
else
  falha "--yes saudavel → morreu antes do resumo (o dano fica invisivel)"
fi

echo
if [ "$falhas" -eq 0 ]; then
  echo "✅ test-wt-prune: tudo verde"
  exit 0
fi
echo "❌ test-wt-prune: $falhas falha(s)"
exit 1
