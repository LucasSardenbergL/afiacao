#!/usr/bin/env bash
# test-wt-status.sh — TDD do scripts/wt-status.sh com `du`/`ps`/`git`/`lsof`
# STUBADOS (sem tocar o disco de verdade, sem esperar minuto nenhum).
#
# Contrato testado — o sensor tem de MEDIR JUSTO QUANDO IMPORTA (máquina
# saturada). Os dois defeitos medidos em 2026-08-20 (M2 8GB em swap, 66
# worktrees):
#
#   1. `ps ... | sort -rn | head -10` → o `head` fecha o pipe enquanto o `sort`
#      ainda escreve ⇒ SIGPIPE(141) no `sort`; `pipefail` promove o 141 a status
#      do pipeline e `set -e` aborta. Como era a ÚLTIMA seção, o 141 virava o
#      exit code do script inteiro e `bun run wt:status` lia VERMELHO num
#      caminho de sucesso. Limiar medido: 0/5 em 62 KB · 2/5 em 126 KB · 5/5 em
#      318 KB (buffer de pipe ~64 KB no macOS) — por isso só aparece com a
#      máquina cheia de processos.
#
#   2. `sz="$(du -sm "$nm" 2>/dev/null | cut -f1)"` sob `set -e`+`pipefail`: UM
#      `du` que falhe (arquivo sumindo numa worktree viva) matava o script
#      inteiro — seção com CABEÇALHO e nenhuma linha. E o `${sz:-0}` fabricava
#      ZERO pra quem não foi medido (money-path §2: ausente ≠ zero).
#
# A asserção central é a do §13 do money-path: worktree não medida entra como
# COBERTURA declarada ("sem medida: N"), nunca como 0 MB e nunca como silêncio.
#
# Uso: bash scripts/test-wt-status.sh   (exit 0 = tudo verde)
set -u

here="$(cd "$(dirname "$0")" && pwd)"
ALVO="${WT_STATUS_ALVO:-$here/wt-status.sh}"

stub="$(mktemp -d)"
fix="$(mktemp -d)"
trap 'rm -rf "$stub" "$fix"' EXIT

falhas=0
ok()   { printf '  \033[32mok\033[0m   %s\n' "$1"; }
falha() { printf '  \033[31mFALHA\033[0m %s\n' "$1"; falhas=$((falhas + 1)); }

# ── fixture: 4 worktrees, todas com node_modules ────────────────────────────
: > "$fix/worktrees.txt"
for w in alfa bravo charlie delta; do
  mkdir -p "$fix/wt-$w/node_modules"
  echo "worktree $fix/wt-$w" >> "$fix/worktrees.txt"
done

# ── stubs ───────────────────────────────────────────────────────────────────
cat > "$stub/git" <<STUB
#!/bin/sh
[ "\$1" = "worktree" ] || exit 0
cat "$fix/worktrees.txt"
STUB

# DU_MODO: ok | falha | lento | primeiro-ok (o 1º mede, os demais falham)
cat > "$stub/du" <<STUB
#!/bin/sh
alvo="\$3"
case "\${DU_MODO:-ok}" in
  falha)  exit 1 ;;
  lento)  sleep 30; printf '111\t%s\n' "\$alvo" ;;
  primeiro-ok)
    n="\$(cat "$fix/du.n" 2>/dev/null || echo 0)"
    echo \$((n + 1)) > "$fix/du.n"
    [ "\$n" -eq 0 ] || exit 1
    printf '4321\t%s\n' "\$alvo" ;;
  *) printf '250\t%s\n' "\$alvo" ;;
esac
STUB

# PS_MODO: normal | gigante (acima do limiar medido de 318 KB → SIGPIPE 5/5)
cat > "$stub/ps" <<'STUB'
#!/bin/sh
# A varredura de órfãos pede `ppid`; a de RSS, não. Só assim um `ps` que falha
# na consulta de órfãos (ORFAOS_PS_RC) não contamina a seção de RSS — que é o
# que o caso 8 precisa isolar.
for a in "$@"; do
  case "$a" in
    *ppid*)
      [ "${ORFAOS_PS_RC:-0}" = "0" ] || exit "$ORFAOS_PS_RC"
      printf '91234     1  1015:22.33  68.4 /bin/zsh -c while :; do :; done\n'
      exit 0 ;;
  esac
done
case "${PS_MODO:-normal}" in
  gigante) awk 'BEGIN { for (i = 1; i <= 6000; i++)
             printf "%d /Applications/Um/Caminho/Bem/Longo/Que/Imita/O/comm/Do/macOS/processo-%d\n", i, i }' ;;
  *) printf '100000 /usr/bin/algo\n200000 /usr/bin/outro\n' ;;
esac
STUB

cat > "$stub/lsof" <<'STUB'
#!/bin/sh
exit 0
STUB

chmod +x "$stub/git" "$stub/du" "$stub/ps" "$stub/lsof"

# Stubs do ambiente NÃO-macOS, num diretório à parte: entram no PATH só no
# caso que simula o CI Ubuntu, pros demais seguirem lendo a RAM de verdade.
# 127 é o código de "command not found" — foi exatamente o que o CI do #1838
# devolveu, matando o script na PRIMEIRA seção.
naomac="$(mktemp -d)"
trap 'rm -rf "$stub" "$fix" "$naomac"' EXIT
for c in vm_stat sysctl; do
  printf '#!/bin/sh\nexit 127\n' > "$naomac/$c"
  chmod +x "$naomac/$c"
done

# roda o script com os stubs na frente do PATH; ecoa "EXIT=<rc>" na última linha
roda() {
  PATH="$stub:$PATH" bash "$ALVO" 2>/dev/null
  echo "EXIT=$?"
}

secao_nm() { sed -n '/node_modules por worktree/,/^$/p'; }

# ── caso 1 — `du` que FALHA não mata o script nem some com a seção ──────────
saida="$(DU_MODO=falha roda)"
if [ "${saida##*EXIT=}" = "0" ]; then
  ok "du falhando → script segue e sai 0"
else
  falha "du falhando → esperava EXIT=0, veio EXIT=${saida##*EXIT=}"
fi
if printf '%s' "$saida" | command grep -q 'top consumidores'; then
  ok "du falhando → seções POSTERIORES ainda saem"
else
  falha "du falhando → a seção seguinte sumiu (set -e matou o script)"
fi
if printf '%s' "$saida" | secao_nm | command grep -q 'sem medida: 4'; then
  ok "du falhando → declara 'sem medida: 4' (nao e silencio)"
else
  falha "du falhando → nao declarou as 4 worktrees como sem medida"
fi
# MOTIVO CERTO: aqui o du falhou de verdade — não pode ser creditado ao teto.
if printf '%s' "$saida" | secao_nm | command grep -q 'por erro do du'; then
  ok "du falhando → motivo correto ('erro do du', nao 'teto')"
else
  falha "du falhando → atribuiu o motivo errado"
fi

# ── caso 2 — ausente ≠ zero: quem não foi medido NÃO vira 0 MB ─────────────
rm -f "$fix/du.n"
saida="$(DU_MODO=primeiro-ok roda)"
nm="$(printf '%s' "$saida" | secao_nm)"
if printf '%s' "$nm" | command grep -q 'medidos: 1 de 4'; then
  ok "cobertura explicita: 'medidos: 1 de 4'"
else
  falha "nao reportou cobertura medidos/total"
fi
if printf '%s' "$nm" | command grep -q 'sem medida: 3'; then
  ok "os 3 nao medidos aparecem como 'sem medida'"
else
  falha "os 3 nao medidos sumiram da saida"
fi
if printf '%s' "$nm" | command grep -q 'piso'; then
  ok "total parcial marcado como PISO (nao como total)"
else
  falha "total parcial nao foi marcado como piso — le-se como se fosse o total"
fi
# o piso tem de ser o que FOI medido (4321), nunca 4321 + 0 + 0 + 0 apresentado
# como total fechado: a marca 'piso' acima é o que impede a leitura errada.
if printf '%s' "$nm" | command grep -q '4321'; then
  ok "o que foi medido aparece com o valor real"
else
  falha "perdeu o valor medido"
fi

# ── caso 3 — `du` LENTO estoura o teto e degrada em vez de pendurar ────────
ini="$SECONDS"
saida="$(DU_MODO=lento WT_STATUS_TETO_S=1 roda)"
gasto=$((SECONDS - ini))
if [ "${saida##*EXIT=}" = "0" ]; then
  ok "du lento → sai 0 (degradacao nao e falha)"
else
  falha "du lento → esperava EXIT=0, veio EXIT=${saida##*EXIT=}"
fi
if [ "$gasto" -le 12 ]; then
  ok "du lento → respeitou o teto (${gasto}s, 4 worktrees x 30s de du)"
else
  falha "du lento → pendurou ${gasto}s; o teto nao segurou"
fi
if printf '%s' "$saida" | secao_nm | command grep -q 'sem medida: 4'; then
  ok "du lento → declara as 4 como sem medida"
else
  falha "du lento → nao declarou 'sem medida'"
fi
if printf '%s' "$saida" | secao_nm | command grep -q 'pelo teto'; then
  ok "du lento → diz que o TETO foi o motivo"
else
  falha "du lento → nao disse o motivo (teto)"
fi
# ── caso 3b — teto POR ITEM estourado com orçamento global de sobra ───────
# Este caso discrimina o defeito REAL que o próprio conserto teve: creditar o
# timeout por item como "erro do du", porque o motivo era INFERIDO do orçamento
# global em vez de vir do exit code (124) do timeout. Ele só separa os dois
# mundos quando cap_item < teto_s — daí o WT_STATUS_CAP_ITEM.
saida="$(DU_MODO=lento WT_STATUS_TETO_S=8 WT_STATUS_CAP_ITEM=1 roda)"
nm="$(printf '%s' "$saida" | secao_nm)"
if printf '%s' "$nm" | command grep -q 'por erro do du'; then
  falha "cap por item → creditou o RELOGIO como 'erro do du' (motivo inferido)"
else
  ok "cap por item → nao credita o relogio como erro do du"
fi
if printf '%s' "$nm" | command grep -q '4 pelo teto'; then
  ok "cap por item → as 4 saem 'pelo teto', com orcamento global de sobra"
else
  falha "cap por item → nao atribuiu as 4 ao teto"
fi

# ── caso 4 — o mesmo teto vale SEM o coreutils `timeout` ───────────────────
ini="$SECONDS"
saida="$(DU_MODO=lento WT_STATUS_TETO_S=1 WT_STATUS_SEM_TIMEOUT=1 roda)"
gasto=$((SECONDS - ini))
if [ "$gasto" -le 12 ] && [ "${saida##*EXIT=}" = "0" ]; then
  ok "sem 'timeout' no PATH → o fallback tambem segura (${gasto}s)"
else
  falha "sem 'timeout' → gastou ${gasto}s / EXIT=${saida##*EXIT=}"
fi

# ── caso 5 — saída gigante do `ps` não pode virar 141 (SIGPIPE) ────────────
saida="$(PS_MODO=gigante roda)"
if [ "${saida##*EXIT=}" = "0" ]; then
  ok "ps gigante (>318 KB) → sai 0, sem SIGPIPE"
else
  falha "ps gigante → EXIT=${saida##*EXIT=} (141 = SIGPIPE do sort contra o head)"
fi
n_rss="$(printf '%s' "$saida" | sed -n '/top consumidores/,$p' | command grep -c ' MB  ')"
if [ "$n_rss" -eq 10 ]; then
  ok "ps gigante → ainda lista exatamente 10 processos"
else
  falha "ps gigante → listou $n_rss processos (esperado 10)"
fi

# ── caso 6 — caminho feliz continua feliz ─────────────────────────────────
saida="$(roda)"
if [ "${saida##*EXIT=}" = "0" ] &&
   printf '%s' "$saida" | secao_nm | command grep -q 'medidos: 4 de 4'; then
  ok "caminho feliz → EXIT=0 e cobertura 4 de 4"
else
  falha "caminho feliz quebrou: EXIT=${saida##*EXIT=}"
fi
if printf '%s' "$saida" | secao_nm | command grep -q 'sem medida'; then
  falha "caminho feliz nao pode falar em 'sem medida'"
else
  ok "caminho feliz nao inventa degradacao"
fi

# ── caso 7 — sonda de RAM ausente (não-macOS) não derruba o script ────────
# Regressão do CI do #1838: `vm_stat` não existe no Ubuntu ⇒ 127 ⇒ pipefail
# ⇒ set -e matava tudo na 1ª seção. Uma sonda que falta tem de degradar a SUA
# seção, não o sensor inteiro — é a tese deste arquivo aplicada a ele mesmo.
saida="$(PATH="$naomac:$stub:$PATH" bash "$ALVO" 2>/dev/null; echo "EXIT=$?")"
if [ "${saida##*EXIT=}" = "0" ]; then
  ok "sem vm_stat/sysctl → script sai 0 (nao morre na 1a secao)"
else
  falha "sem vm_stat/sysctl → EXIT=${saida##*EXIT=} (127 = command not found matando o set -e)"
fi
if printf '%s' "$saida" | command grep -q 'sem medida: sysctl/vm_stat'; then
  ok "sem vm_stat/sysctl → declara a RAM como sem medida"
else
  falha "sem vm_stat/sysctl → nao declarou a RAM como sem medida"
fi
if printf '%s' "$saida" | secao_nm | command grep -q 'medidos: 4 de 4'; then
  ok "sem vm_stat/sysctl → as secoes POSTERIORES ainda medem"
else
  falha "sem vm_stat/sysctl → perdeu as secoes seguintes"
fi

# ── caso 8 — órfão custoso: a seção existe E não derruba o script ─────────
# O vigia era CEGO ao que de fato matou a máquina em 2026-08-23 (8 zsh órfãos
# em ~5,5 dos 8 cores por 16h55min): media SESSÕES e worktrees, nunca ppid/pcpu.
# Aqui só se prova a INTEGRAÇÃO — o critério em si é do test-orfaos-custosos.sh,
# e duplicá-lo aqui seria dívida.
saida="$(roda)"
if printf '%s' "$saida" | command grep -q '91234'; then
  ok "orfao custoso aparece no wt:status"
else
  falha "orfao custoso NAO aparece — a secao nao foi integrada"
fi

# O irmão do #1838, e o que mais dói: wt-status.sh roda sob `set -euo pipefail`,
# e a sonda de órfãos sai 3 quando NÃO consegue varrer. Sem guarda no ponto de
# chamada, esse 3 mata o wt-status inteiro — a sonda nova derrubaria o sensor
# velho, justo na máquina saturada em que os dois existem pra falar.
saida="$(ORFAOS_PS_RC=1 roda)"
if [ "${saida##*EXIT=}" = "0" ]; then
  ok "sonda de orfaos falhando (exit 3) NAO derruba o wt:status"
else
  falha "sonda de orfaos falhando levou o script junto: EXIT=${saida##*EXIT=}"
fi
if printf '%s' "$saida" | secao_nm | command grep -q 'medidos: 4 de 4'; then
  ok "sonda de orfaos falhando → secoes POSTERIORES ainda medem"
else
  falha "sonda de orfaos falhando → perdeu as secoes seguintes"
fi
if printf '%s' "$saida" | command grep -q 'SEM-MEDIDA'; then
  ok "sonda de orfaos falhando → declara falta de dado (nao 'esta limpo')"
else
  falha "sonda de orfaos falhando → silenciou; ausencia de dado virou aprovacao"
fi

echo
if [ "$falhas" -eq 0 ]; then
  echo "✅ test-wt-status: tudo verde"
else
  echo "❌ test-wt-status: $falhas falha(s)"
  exit 1
fi
