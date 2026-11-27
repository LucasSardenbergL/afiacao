#!/usr/bin/env bash
# vigia-taxa-1a-chamada.sh — taxa de acerto da 1ª chamada do `claude -p` do vigia Lovable (PR 5 do plano).
#
# Por que existe: o disparo ainda passa por um LLM (Haiku) que chama get_project+deploy_project. A decisão de
# tirar o modelo do disparo (chamar o MCP do Lovable direto) espera um NÚMERO: a taxa da 1ª chamada nos
# últimos 7 dias, com denominador. ≥95% → fica como está; abaixo → MCP direto sem LLM. Decisão por volta de
# 03/12/2026 — docs/historico/lovable-publish-automatico.md §PR 5.
#
# Lê o vigia.log + os rotacionados (.1/.2) e conta as linhas `claude (1/2) rc=… → <RESULTADO>`. Acerto = a 1ª
# chamada terminou em DISPARADO ou NAO_SINCRONIZADO (o protocolo andou e o veredito saiu do tool_result).
# Erro = ERRO, NEEDS_AUTH, INDETERMINADO, VIOLACAO ou qualquer outro.
# Só conta a era do PROTOCOLO (linha com ` mcp=`, desde o #4189 em 25/11): antes, o resultado `VIGIA=…` era o
# TEXTO do modelo (que chegou a fabricar DISPARADO) — essas linhas saem do denominador e são contadas à parte
# em `legado_excluido=`.
#
# Uso: scripts/vigia-taxa-1a-chamada.sh [log] [dias]   (default: ~/.local/state/afiacao/lovable-vigia/vigia.log, 7)
# Saída: uma linha por resultado e, por último, `TAXA=<pct>% acertos=<a> denominador=<n> desde=<data>`.
# Ausente ≠ zero: sem nenhuma 1ª chamada na janela → `TAXA=SEM_DADO denominador=0` e exit 3.
set -u
LOG=${1:-$HOME/.local/state/afiacao/lovable-vigia/vigia.log}
DIAS=${2:-7}
case "$DIAS" in ''|*[!0-9]*) echo "uso: $0 [log] [dias]" >&2; exit 2 ;; esac
DESDE=$(date -v-"${DIAS}"d '+%F %T' 2>/dev/null || date -d "$DIAS days ago" '+%F %T')
ARQS=()
for f in "$LOG.2" "$LOG.1" "$LOG"; do [ -f "$f" ] && ARQS+=("$f"); done
[ "${#ARQS[@]}" -gt 0 ] || { echo "sem log em $LOG" >&2; echo "TAXA=SEM_DADO denominador=0 desde=$DESDE"; exit 3; }
cat "${ARQS[@]}" | awk -v desde="$DESDE" '
  substr($0, 1, 19) >= desde && index($0, " claude (1/2) rc=") {
    if (index($0, " mcp=") == 0) { leg++; next }
    r = $0; sub(/.* → /, "", r); split(r, p, " "); res = p[1]
    n++; c[res]++
    if (res == "DISPARADO" || res == "NAO_SINCRONIZADO") a++
  }
  END {
    for (k in c) printf "%s %d\n", k, c[k]
    if (n == 0) { printf "TAXA=SEM_DADO denominador=0 legado_excluido=%d desde=%s\n", leg, desde; exit 3 }
    printf "TAXA=%.1f%% acertos=%d denominador=%d legado_excluido=%d desde=%s\n", 100 * a / n, a, n, leg, desde
  }'
