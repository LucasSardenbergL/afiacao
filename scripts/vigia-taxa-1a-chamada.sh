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
# Saída: uma linha por resultado e, por último, `TAXA=<pct>% acertos=<a> denominador=<n> legado_excluido=<l>
# corte95=ATINGIDO|NAO_ATINGIDO desde=<data>`. O corte é em INTEIRO (100·a ≥ 95·n): o % impresso é arredondado
# (113/119 = 94,96% aparece 95.0%) — quem decide é `corte95=`, não o %.
# Ausente ≠ zero: sem nenhuma 1ª chamada na janela → `TAXA=SEM_DADO denominador=0` e exit 3.
set -u
export LC_ALL=C   # ponto decimal fixo e awk/sort por byte — em pt_BR o awk do macOS imprime 33,3
LOG=${1:-$HOME/.local/state/afiacao/lovable-vigia/vigia.log}
DIAS=${2:-7}
case "$DIAS" in ''|*[!0-9]*) echo "uso: $0 [log] [dias]" >&2; exit 2 ;; esac
[ "${#DIAS}" -le 4 ] || { echo "dias fora de faixa: $DIAS" >&2; exit 2; }
DESDE=$(date -v-"${DIAS}"d '+%F %T' 2>/dev/null || date -d "$DIAS days ago" '+%F %T' 2>/dev/null)
ATE=$(date '+%F %T')
# data que não converteu (GNU date com N enorme) deixaria `desde` vazio = TODO o histórico
case "$DESDE" in [0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]\ [0-9][0-9]:[0-9][0-9]:[0-9][0-9]) ;;
  *) echo "não consegui calcular o início da janela (${DESDE:-vazio})" >&2; exit 2 ;; esac
ARQS=()
for f in "$LOG.2" "$LOG.1" "$LOG"; do [ -e "$f" ] && ARQS+=("$f"); done
[ "${#ARQS[@]}" -gt 0 ] || { echo "sem log em $LOG" >&2; echo "TAXA=SEM_DADO denominador=0 desde=$DESDE"; exit 3; }
JUNTO=$(mktemp) || exit 2
trap 'rm -f "$JUNTO"' EXIT
# leitura que falha (arquivo ilegível) aborta — taxa PARCIAL com exit 0 seria número fabricado; rotação no meio
# da leitura (inode de algum arquivo mudou) → relê, até 3x
# shellcheck disable=SC2012  # nomes fixos (vigia.log[.1|.2]); `ls -i` é o único inode portável macOS/Linux
inodes() { ls -i "$LOG.2" "$LOG.1" "$LOG" 2>/dev/null | awk '{print $1}'; }
LIDO=0
for _ in 1 2 3; do
  ANTES=$(inodes)
  cat "${ARQS[@]}" > "$JUNTO" || { echo "falha ao ler ${ARQS[*]}" >&2; exit 2; }
  [ "$(inodes)" = "$ANTES" ] && { LIDO=1; break; }
done
[ "$LIDO" = 1 ] || { echo "log rotacionou durante a leitura 3x" >&2; exit 2; }
# cabeçalho reconhecido por CAMPO (texto livre do modelo no fim da linha não conta): `<data> <hora> claude (1/2)
# rc=<n> mcp=<estado> … → <RESULTADO> …`. Resultado = 1ª palavra após a 1ª seta (a do cabeçalho).
awk -v desde="$DESDE" -v ate="$ATE" '
  $3 == "claude" && $4 == "(1/2)" && $5 ~ /^rc=/ {
    ts = $1 " " $2
    if (ts < desde || ts > ate) next
    if ($6 !~ /^mcp=/) { leg++; next }
    i = index($0, " → ")
    if (i == 0) res = "SEM_RESULTADO"
    else { r = substr($0, i + length(" → ")); split(r, p, " "); res = p[1] }
    n++; c[res]++
    if (res == "DISPARADO" || res == "NAO_SINCRONIZADO") a++
  }
  END {
    for (k in c) printf "%s %d\n", k, c[k]
    if (n == 0) { printf "TAXA=SEM_DADO denominador=0 legado_excluido=%d desde=%s\n", leg, desde; exit 3 }
    printf "TAXA=%.1f%% acertos=%d denominador=%d legado_excluido=%d corte95=%s desde=%s\n", 100 * a / n, a, n, leg,
      (100 * a >= 95 * n ? "ATINGIDO" : "NAO_ATINGIDO"), desde
  }' "$JUNTO"
