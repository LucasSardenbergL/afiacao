#!/usr/bin/env bash
# falsifica.sh — cada guarda do claude-mem-reanimar.sh e sabotada UMA por vez: o lab tem de ficar
# VERMELHO no cenario que vigia aquela guarda, pelo MOTIVO CERTO, em cada locale disponivel.
#
# Travas (vermelho pelo motivo errado conta como verde mentiroso):
#  (0) CONTROLE antes do 1o sed: a MESMA invocacao — copia do alvo, os mesmos cenarios, os mesmos
#      locales — tem de sair LAB-VERDE. Sem linha de base, sabotar nao prova nada (um lab
#      sempre-vermelho "detectaria" todas as sabotagens). Controle vermelho = aborta aqui.
#  (1) sed invalido · (2) sed que nao mudou o arquivo · (3) sintaxe de shell quebrada
#  (4) o vermelho tem de trazer a FALHA ESPERADA daquela guarda (nao uma FALHA qualquer) e o
#      marcador LAB-VERMELHO (o lab terminou; nao morreu no meio).
# Locales: C sempre; pt_BR.UTF-8 quando ele EXISTE no sistema (#1483). No runner Ubuntu ele nao
#   existe e a saida DIZ isso — rodar "pt_BR" la seria rodar C duas vezes e chamar de prova.
#
# Uso: bash falsifica.sh     (no Linux, sob python3 subreaper.py — o wrapper do CI faz isso)
# Env: ALVO (o script sabotado; default ../claude-mem-reanimar.sh) · LAB_FAIXAS (4)
# shellcheck disable=SC2016  # aspas simples de proposito no arquivo todo: os `$` das expressoes
# sed sao o TEXTO que elas procuram DENTRO do alvo. Expandir escreveria um padrao que nao casa — a
# trava (2) pega, mas so depois de custar uma rodada.
set -u
L="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
ORIG="${ALVO:-$L/../claude-mem-reanimar.sh}"
FAIXAS="${LAB_FAIXAS:-4}"
tmpbase="${TMPDIR:-/tmp}"
TMP="$(mktemp -d "${tmpbase%/}/fals-reanimar.XXXXXX")" || { echo "FALSIFICACAO-VERMELHA: mktemp falhou"; exit 1; }
trap 'case "$TMP" in */fals-reanimar.?*) rm -rf "$TMP" ;; esac' EXIT

LOCALES="C"
if locale -a 2>/dev/null | grep -qiE '^pt_BR\.utf-?8$'; then
  LOCALES="C pt_BR.UTF-8"
else
  echo "(pt_BR.UTF-8 nao existe neste sistema: so o locale C roda aqui — o 2o locale NAO foi provado nesta maquina)"
fi

N=0
sabota() { # nome · cenario · expressao sed · texto que TEM de aparecer numa linha FALHA
  NOME[N]="$1"; CEN[N]="$2"; EXPR[N]="$3"; ESPERADO[N]="$4"; N=$((N + 1))
}
sabota ordenacao-lexicografica c_saudavel 's/sort -t\. -k1,1nr -k2,2nr -k3,3nr/sort -r/' \
  'NAO diz: versao ativa: 13.15.3'
sabota ignora-orphaned-at c_saudavel 's|\[ -e "\$CACHE/\$v/.orphaned_at" \] \&\& continue|true|' \
  'NAO diz: versao ativa: 13.15.3'
sabota porta-alheia-vira-nossa c_alheio 's/^  return 1$/  return 0/' \
  'diz (nao devia): vou encerrar'
sabota arvore-so-a-raiz c_surdo_sim 's/alvo\[r\]=1; mudou=1/alvo[r]=1; mudou=0/' \
  '(chroma (mesmo pgid)) segue VIVO'
sabota confirmacao-ignorada c_surdo_nao 's/\*) return 1 ;; esac/*) return 0 ;; esac/' \
  'NAO diz: Cancelado'
sabota so-olhar-ignorado c_so_olhar 's/\[ "\${1:-}" = "--so-olhar" \] \&\& SO_OLHAR=1/true/' \
  'diz (nao devia): vou encerrar'
sabota sem-guarda-subindo c_subindo 's/-lt "\$IDADE_MIN" \]/-lt 0 ]/g' \
  'NAO diz: SUBINDO — worker com'
sabota prova-frouxa c_hook_falha 's/^if \[ "\$HRC" = 0 \] \&\& .*then$/if true; then/' \
  'diz (nao devia): RECUPERADO'
sabota curl-quebrado-vira-surdo c_nao_sondei 's/    \*) echo nao-sondei ;;/    *) echo surdo ;;/' \
  'NAO diz: NAO SONDEI'
sabota sonda-ignora-host c_host_config 's|http://\$HOST:\$PORT\$1|http://127.0.0.1:$PORT$1|' \
  'NAO diz: SAUDAVEL'
sabota sem-trava-incoerente c_incoerente 's/^  if \[ -n "\$DONOS" \]; then$/  if false; then/' \
  'diz (nao devia): VIVO-SEM-PORTA'
sabota tempo-invalido-vira-fail-open c_tempo_invalido 's/^  \[ "\$v" -ge "\$3" \] 2>\/dev\/null || return 1 .*$/  true/' \
  "NAO diz: PAREI: REANIMAR_TESTE_IDADE_MIN_S='abc'"

# ---------------------------------------------------------------------- (0) controle
CENS=""
i=0
while [ "$i" -lt "$N" ]; do
  case " $CENS " in *" ${CEN[i]} "*) ;; *) CENS="$CENS ${CEN[i]}" ;; esac
  i=$((i + 1))
done
cp "$ORIG" "$TMP/controle.sh"
echo "== controle (sem sabotagem, mesma invocacao das sabotagens):$CENS"
for loc in $LOCALES; do
  # shellcheck disable=SC2086  # split intencional: lista de cenarios
  LC_ALL="$loc" SCRIPT="$TMP/controle.sh" LAB_FAIXAS="$FAIXAS" bash "$L/lab.sh" $CENS >"$TMP/controle-$loc.txt" 2>&1
  rc=$?
  if [ "$rc" -eq 0 ] && grep -qx 'LAB-VERDE' "$TMP/controle-$loc.txt"; then
    echo "  ok    [$loc] controle VERDE ($(grep '^RESULTADO' "$TMP/controle-$loc.txt"))"
  else
    echo "  FALHA [$loc] controle SEM sabotagem ja esta VERMELHO (rc=$rc) — sem linha de base, sabotar nao prova nada:"
    grep -E '  FALHA |NAO terminou' "$TMP/controle-$loc.txt" | head -10
    echo "FALSIFICACAO-VERMELHA"
    exit 1
  fi
done

# ---------------------------------------------------------------------- (1)-(3) as copias
BOAS=0; PROBLEMAS=0
PRONTAS=""
i=0
while [ "$i" -lt "$N" ]; do
  copia="$TMP/sabotado-${NOME[i]}.sh"
  erro="$(sed "${EXPR[i]}" "$ORIG" 2>&1 >"$copia")"
  if [ -n "$erro" ]; then
    echo "  PROBLEMA [${NOME[i]}] sed invalido (${erro:0:60}) — falsificacao vazia"; PROBLEMAS=$((PROBLEMAS + 1))
  elif cmp -s "$ORIG" "$copia"; then
    echo "  PROBLEMA [${NOME[i]}] o sed nao mudou nada — falsificacao vazia (o alvo mudou de forma?)"; PROBLEMAS=$((PROBLEMAS + 1))
  elif ! bash -n "$copia" 2>/dev/null; then
    echo "  PROBLEMA [${NOME[i]}] o sed quebrou a SINTAXE do shell — vermelho pelo motivo errado"; PROBLEMAS=$((PROBLEMAS + 1))
  else
    PRONTAS="$PRONTAS $i"
  fi
  i=$((i + 1))
done

# ---------------------------------------------------------------------- sabotagens em paralelo
# Cada execucao e UM cenario com base de porta propria (execucoes simultaneas nao colidem).
# Pool sem `wait -n` (o bash do macOS e o 3.2).
echo "== sabotagens (cada uma exige vermelho, com a FALHA esperada, em: $LOCALES)"
job=0
for i in $PRONTAS; do
  for loc in $LOCALES; do
    while [ "$(jobs -rp | wc -l | tr -d ' ')" -ge "$FAIXAS" ]; do sleep 0.3; done
    base=$((38000 + job * 100))
    (
      LC_ALL="$loc" SCRIPT="$TMP/sabotado-${NOME[i]}.sh" LAB_PORTA_BASE="$base" LAB_FAIXAS=1 \
        bash "$L/lab.sh" "${CEN[i]}" >"$TMP/res-$i-$loc.txt" 2>&1
      echo "RC=$?" >>"$TMP/res-$i-$loc.txt"
    ) &
    job=$((job + 1))
  done
done
wait

# ---------------------------------------------------------------------- (4) veredito
for i in $PRONTAS; do
  problema=""
  for loc in $LOCALES; do
    r="$TMP/res-$i-$loc.txt"
    if ! grep -qx 'RC=[1-9][0-9]*' "$r"; then
      problema="$problema [$loc] ficou VERDE (a suite nao cobre esta guarda)"
    elif ! grep -qx 'LAB-VERMELHO' "$r"; then
      problema="$problema [$loc] saiu sem o marcador LAB-VERMELHO (o lab nao terminou: $(tail -1 "$r"))"
    elif ! grep -F '  FALHA ' "$r" | grep -qF -- "${ESPERADO[i]}"; then
      problema="$problema [$loc] vermelho pelo MOTIVO ERRADO: $(grep -m1 -F '  FALHA ' "$r" | sed 's/^ *//' | cut -c1-90)"
    fi
  done
  if [ -z "$problema" ]; then
    echo "  ok    [${NOME[i]}] vermelho pelo motivo certo ($(printf '%s' "${ESPERADO[i]}" | cut -c1-60))"
    BOAS=$((BOAS + 1))
  else
    echo "  PROBLEMA [${NOME[i]}]$problema"
    PROBLEMAS=$((PROBLEMAS + 1))
  fi
done

echo
echo "FALSIFICACAO: $BOAS guardas provadas · $PROBLEMAS problema(s) · locales: $LOCALES"
if [ "$PROBLEMAS" = 0 ] && [ "$BOAS" = "$N" ]; then echo "FALSIFICACAO-VERDE"; else echo "FALSIFICACAO-VERMELHA"; fi
[ "$PROBLEMAS" = 0 ] && [ "$BOAS" = "$N" ]
