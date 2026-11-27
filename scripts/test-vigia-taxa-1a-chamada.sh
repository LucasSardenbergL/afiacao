#!/usr/bin/env bash
# shellcheck disable=SC2015  # `cond && ok || nok`: ok() sempre sai 0
# shellcheck disable=SC2016  # os $ nos sed das sabotagens são LITERAIS do fonte sabotado
# test-vigia-taxa-1a-chamada.sh — o número que decide (~03/12) se o LLM sai do disparo do vigia tem de contar
# certo: janela de N dias, logs rotacionados, só a era do protocolo, acerto = DISPARADO|NAO_SINCRONIZADO.
set -u
RAIZ=$(cd "$(dirname "$0")/.." && pwd)
ALVO="$RAIZ/scripts/vigia-taxa-1a-chamada.sh"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
FALHAS=0; OKS=0
ok()  { printf 'ok   %s\n' "$1"; OKS=$((OKS + 1)); }
nok() { printf 'FALHA %s\n' "$1"; FALHAS=$((FALHAS + 1)); }
d() { date -v-"$1"H '+%F %T' 2>/dev/null || date -d "$1 hours ago" '+%F %T'; }   # d <horas atrás>
c1() { printf '%s claude (1/2) rc=0 mcp=connected usos=get_project custo=0.01 → %s (modelo: x)\n' "$(d "$1")" "$2"; }
L="$TMP/vigia.log"
{ c1 300 DISPARADO; c1 200 'DISPARADO dep-1'; } > "$L.2"           # 300 h = fora da janela de 7 dias
{ c1 100 'NAO_SINCRONIZADO 1111'; c1 90 ERRO
  printf '%s claude (1/2) rc=0 custo=0.05 → VIGIA=DISPARADO inventado\n' "$(d 80)"; } > "$L.1"   # legado
{ c1 50 NEEDS_AUTH; c1 40 INDETERMINADO; c1 30 'VIOLACAO deploy_project chamado 2x'; c1 20 'DISPARADO dep-2'
  printf '%s claude (2/2) rc=0 mcp=connected usos=get_project custo=0.01 → DISPARADO dep-3 (modelo: x)\n' "$(d 19)"
  printf '%s PUBLICADO abc — provado pelo ar em 40s\n' "$(d 18)"; } > "$L"
# na janela: dep-1(200h? não: 200 h > 168 h, fora), NAO_SINC, ERRO, NEEDS_AUTH, INDET, VIOLACAO, DISPARADO dep-2 = 6; acertos 2
ESPERADO="TAXA=33.3% acertos=2 denominador=6 legado_excluido=1"
confere() { local o; o=$(bash "${1:-$ALVO}" "$L" 7) || return 1; printf '%s\n' "$o" | tail -1 | grep -q "^$ESPERADO desde="; }
confere && ok "7 dias, 3 arquivos, só (1/2) do protocolo: $ESPERADO" || nok "saída: $(bash "$ALVO" "$L" 7 | tail -1)"
bash "$ALVO" "$L" 7 | grep -qx 'VIOLACAO 1' && ok "detalhe por resultado (VIOLACAO 1)" || nok "detalhe: $(bash "$ALVO" "$L" 7 | head -c 300)"
: > "$TMP/vazio.log"; O=$(bash "$ALVO" "$TMP/vazio.log" 7); RC=$?
[ "$RC" = 3 ] && printf '%s' "$O" | grep -q '^TAXA=SEM_DADO denominador=0' && ok "sem 1ª chamada na janela → SEM_DADO, exit 3 (ausente ≠ 0%)" || nok "vazio: rc=$RC $O"
O=$(bash "$ALVO" "$TMP/nao-existe.log" 7 2>/dev/null); RC=$?
[ "$RC" = 3 ] && printf '%s' "$O" | grep -q '^TAXA=SEM_DADO' && ok "log ausente → SEM_DADO, exit 3" || nok "ausente: rc=$RC $O"

# falsificação com controle verde na MESMA invocação: `confere` passa no real (acima) e reprova cada sabotagem
sabota() {  # <nome> <sed>
  sed "$2" "$ALVO" > "$TMP/sab-$1.sh"
  if ! confere; then nok "controle: real reprovou ($1)"
  elif cmp -s "$ALVO" "$TMP/sab-$1.sh"; then nok "sabotagem $1 não casou"
  elif confere "$TMP/sab-$1.sh"; then nok "sabotado ($1) passou"
  else ok "falsificação $1: real verde, sabotado vermelho"; fi
}
sabota janela 's/substr(\$0, 1, 19) >= desde \&\& //'
sabota rotacionados 's/for f in "\$LOG.2" "\$LOG.1" "\$LOG"; do/for f in "$LOG"; do/'
sabota legado 's/if (index(\$0, " mcp=") == 0) { leg++; next }//'
sabota acerto 's/res == "NAO_SINCRONIZADO"/res == "NAO_SINCRONIZADO" || res == "INDETERMINADO"/'
sabota so_primeira 's/index(\$0, " claude (1\/2) rc=")/index($0, " claude (")/'

[ "$FALHAS" -eq 0 ] && { echo "TEST-VIGIA-TAXA-1A-CHAMADA: OK ($OKS)"; exit 0; }
echo "TEST-VIGIA-TAXA-1A-CHAMADA: $FALHAS falha(s)"; exit 1
