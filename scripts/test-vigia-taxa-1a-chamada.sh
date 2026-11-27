#!/usr/bin/env bash
# shellcheck disable=SC2015  # `cond && ok || nok`: ok() sempre sai 0
# shellcheck disable=SC2016  # os $ nos sed das sabotagens são LITERAIS do fonte sabotado
# test-vigia-taxa-1a-chamada.sh — o número que decide (~03/12) se o LLM sai do disparo do vigia tem de contar
# certo: janela de N dias (com teto), logs rotacionados, só a era do protocolo, acerto = DISPARADO|NAO_SINCRONIZADO,
# resultado lido do CABEÇALHO (nunca do texto do modelo), corte de 95% em inteiro, saída igual em qualquer locale.
set -u
RAIZ=$(cd "$(dirname "$0")/.." && pwd)
ALVO="$RAIZ/scripts/vigia-taxa-1a-chamada.sh"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
FALHAS=0; OKS=0
ok()  { printf 'ok   %s\n' "$1"; OKS=$((OKS + 1)); }
nok() { printf 'FALHA %s\n' "$1"; FALHAS=$((FALHAS + 1)); }
d()  { date -v-"$1"H '+%F %T' 2>/dev/null || date -d "$1 hours ago" '+%F %T'; }   # d <horas atrás>
df() { date -v+"$1"H '+%F %T' 2>/dev/null || date -d "$1 hours" '+%F %T'; }       # df <horas à frente>
c1() { printf '%s claude (1/2) rc=0 mcp=connected usos=get_project custo=0.01 → %s (modelo: x)\n' "$(d "$1")" "$2"; }
L="$TMP/vigia.log"
{ c1 300 DISPARADO; c1 150 'DISPARADO dep-0'; } > "$L.2"           # 300 h fora; 150 h DENTRO (o .2 contribui)
{ c1 100 'NAO_SINCRONIZADO 1111'; c1 90 ERRO
  printf '%s claude (1/2) rc=0 custo=0.05 → VIGIA=DISPARADO inventado mcp=connected\n' "$(d 80)"; } > "$L.1"  # legado
{ c1 50 NEEDS_AUTH; c1 40 INDETERMINADO; c1 30 'VIOLACAO deploy_project chamado 2x'
  printf '%s claude (1/2) rc=0 mcp=connected usos=get_project custo=0.01 → ERRO (modelo: VIGIA=ERRO → DISPARADO dep-9)\n' "$(d 25)"
  c1 20 'DISPARADO dep-2'
  printf '%s claude (2/2) rc=0 mcp=connected usos=get_project custo=0.01 → ERRO (antes: claude (1/2) rc=1 mcp=x → DISPARADO)\n' "$(d 19)"
  printf '%s PUBLICADO abc — provado pelo ar em 40s\n' "$(d 18)"
  printf '%s claude (1/2) rc=0 mcp=connected usos=get_project custo=0.01 → DISPARADO futuro (modelo: x)\n' "$(df 30)"; } > "$L"
# janela 7 d: dep-0, NAO_SINC, ERRO, NEEDS_AUTH, INDET, VIOLACAO, ERRO(seta no texto), dep-2 = 8; acertos 3; legado 1
ESPERADO="TAXA=37.5% acertos=3 denominador=8 legado_excluido=1 corte95=NAO_ATINGIDO"
# janela 5 d (120 h): sai o dep-0 (150 h) → 7, acertos 2
ESPERADO5="TAXA=28.6% acertos=2 denominador=7 legado_excluido=1 corte95=NAO_ATINGIDO"
ult() { local o; o=$("$@") || return 1; o=$(printf '%s\n' "$o" | tail -1); printf '%s' "${o%% desde=*}"; }
# compara LITERAL (sem regex: o `.` de 37.5 não pode casar `37,5`) e nos DOIS locales
confere() {
  local a=${1:-$ALVO} loc
  for loc in C pt_BR.UTF-8; do
    [ "$(LC_ALL=$loc ult bash "$a" "$L" 7)" = "$ESPERADO" ] || return 1
    [ "$(LC_ALL=$loc ult bash "$a" "$L" 5)" = "$ESPERADO5" ] || return 1
  done
}
confere && ok "7 e 5 dias, 3 arquivos, só (1/2) do protocolo, C e pt_BR: $ESPERADO" \
  || nok "saída: 7d=[$(ult bash "$ALVO" "$L" 7)] 5d=[$(ult bash "$ALVO" "$L" 5)] ptBR=[$(LC_ALL=pt_BR.UTF-8 ult bash "$ALVO" "$L" 7)]"
bash "$ALVO" "$L" 7 | grep -qx 'VIOLACAO 1' && ok "detalhe por resultado (VIOLACAO 1)" || nok "detalhe: $(bash "$ALVO" "$L" 7 | head -c 300)"
bash "$ALVO" "$L" 7 | grep -qx 'ERRO 2' && ok "seta no texto do modelo não vira acerto (ERRO 2)" || nok "seta: $(bash "$ALVO" "$L" 7 | head -c 300)"

: > "$TMP/vazio.log"; O=$(bash "$ALVO" "$TMP/vazio.log" 7); RC=$?
[ "$RC" = 3 ] && printf '%s' "$O" | grep -q '^TAXA=SEM_DADO denominador=0' && ok "sem 1ª chamada na janela → SEM_DADO, exit 3 (ausente ≠ 0%)" || nok "vazio: rc=$RC $O"
O=$(bash "$ALVO" "$TMP/nao-existe.log" 7 2>/dev/null); RC=$?
[ "$RC" = 3 ] && printf '%s' "$O" | grep -q '^TAXA=SEM_DADO' && ok "log ausente → SEM_DADO, exit 3" || nok "ausente: rc=$RC $O"
c1 1 ERRO > "$TMP/zero.log"; O=$(bash "$ALVO" "$TMP/zero.log" 7); RC=$?
[ "$RC" = 0 ] && [ "$(printf '%s\n' "$O" | tail -1 | sed 's/ desde=.*//')" = "TAXA=0.0% acertos=0 denominador=1 legado_excluido=0 corte95=NAO_ATINGIDO" ] \
  && ok "só ERRO → 0.0% com denominador 1, exit 0 (zero ≠ ausente)" || nok "zero: rc=$RC $O"
{ for _ in $(seq 1 113); do c1 2 DISPARADO; done; for _ in $(seq 1 6); do c1 2 ERRO; done; } > "$TMP/corte.log"
[ "$(ult bash "$ALVO" "$TMP/corte.log" 7)" = "TAXA=95.0% acertos=113 denominador=119 legado_excluido=0 corte95=NAO_ATINGIDO" ] \
  && ok "113/119 aparece 95.0% mas corte95=NAO_ATINGIDO (inteiro, não o arredondado)" || nok "corte: $(ult bash "$ALVO" "$TMP/corte.log" 7)"
{ for _ in $(seq 1 19); do c1 2 DISPARADO; done; c1 2 ERRO; } > "$TMP/corte2.log"
ult bash "$ALVO" "$TMP/corte2.log" 7 | grep -q 'corte95=ATINGIDO$' && ok "19/20 = 95% → corte95=ATINGIDO" || nok "corte2: $(ult bash "$ALVO" "$TMP/corte2.log" 7)"
chmod 000 "$L.1"
if [ -r "$L.1" ]; then ok "ilegível: pulado (rodando como root)"
else O=$(bash "$ALVO" "$L" 7 2>/dev/null); RC=$?
  [ "$RC" = 2 ] && ! printf '%s' "$O" | grep -q '^TAXA=[0-9]' && ok "log rotacionado ilegível → exit 2, sem taxa parcial" || nok "ilegível: rc=$RC $O"
fi
chmod 644 "$L.1"

# falsificação com controle verde na MESMA invocação: `confere` passa no real e reprova cada sabotagem — e o
# mutante tem de RODAR (exit 0 no log principal): mutante com erro de sintaxe não conta como vermelho
sabota() {  # <nome> <sed>
  sed "$2" "$ALVO" > "$TMP/sab-$1.sh"
  if ! confere; then nok "controle: real reprovou ($1)"
  elif cmp -s "$ALVO" "$TMP/sab-$1.sh"; then nok "sabotagem $1 não casou"
  elif ! bash "$TMP/sab-$1.sh" "$L" 7 > /dev/null 2>&1; then nok "sabotado ($1) nem roda — mutante quebrado"
  elif confere "$TMP/sab-$1.sh"; then nok "sabotado ($1) passou"
  else ok "falsificação $1: real verde, sabotado vermelho"; fi
}
sabota janela 's/if (ts < desde || ts > ate) next/if (ts > ate) next/'
sabota teto 's/if (ts < desde || ts > ate) next/if (ts < desde) next/'
sabota rotacionados 's/for f in "\$LOG.2" "\$LOG.1" "\$LOG"; do/for f in "$LOG"; do/'
sabota legado 's/if (\$6 !~ \/^mcp=\/) { leg++; next }/if (index($0, " mcp=") == 0) { leg++; next }/'
sabota acerto 's/res == "NAO_SINCRONIZADO"/res == "NAO_SINCRONIZADO" || res == "INDETERMINADO"/'
sabota so_primeira 's/\$4 == "(1\/2)"/index($0, "(1\/2)")/'
sabota primeira_seta 's/r = substr(\$0, i + length(" → "))/r = $0; sub(\/.* → \/, "", r)/'
sabota dias 's/^DIAS=\${2:-7}$/DIAS=7/'
if [ "$(LC_ALL=pt_BR.UTF-8 awk 'BEGIN { printf "%.1f", 1.5 }')" = "1,5" ]; then
  sabota locale 's/^export LC_ALL=C .*$/:/'
else ok "falsificação locale: pulada (awk deste sistema não localiza o ponto decimal)"; fi

[ "$FALHAS" -eq 0 ] && { echo "TEST-VIGIA-TAXA-1A-CHAMADA: OK ($OKS)"; exit 0; }
echo "TEST-VIGIA-TAXA-1A-CHAMADA: $FALHAS falha(s)"; exit 1
