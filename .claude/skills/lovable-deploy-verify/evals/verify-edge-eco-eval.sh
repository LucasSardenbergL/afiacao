#!/usr/bin/env bash
# verify-edge-eco-eval.sh — rede de regressão do GUARD TEMPORAL (scripts/verify-edge-eco.sh).
#
# Determinístico e offline: um `psql` FALSO devolve fixtures por cenário, discriminando as queries
# pelos marcadores de comentário SQL que o script emite (-- SONDA_PING / _COUNT / _COUNT_ANT / _ROWS).
#
# O caso que dá nome ao arquivo é o `sem_tick_posterior`: é a situação real de 2026-08-29 às 23:41Z
# verificando o #2079 — TTL cheio de ticks, todos ANTERIORES ao merge. Sem guard, o marcador velho
# deles vira "deploy pendente" e manda redeployar 5 edges money-path à toa.
set -uo pipefail
cd "$(dirname "$0")" || exit 2
SCRIPT="../scripts/verify-edge-eco.sh"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

# ── psql falso ──────────────────────────────────────────────────────────────────────────────────
cat > "$TMP/psql-fake" <<'FAKE'
#!/usr/bin/env bash
q=""; prev=""
for a in "$@"; do [ "$prev" = "-c" ] && q="$a"; prev="$a"; done
case "${CENARIO:-}" in
  psql_morto) exit 1 ;;
esac
if [[ "$q" == *SONDA_PING* ]]; then
  # psql_mudo: presente-porém-QUEBRADO — sai 0 e não imprime nada. É o caso que dá dente ao
  # ping: o guard do COUNT não o pega, porque o COUNT responde "0" normalmente, e "0 ticks"
  # de uma via quebrada se leria como INDETERMINADO (degradar) em vez de RECUSA (guardar).
  [ "${CENARIO:-}" = "psql_mudo" ] && exit 0
  echo "PONG_ECO"; exit 0
fi
if [[ "$q" == *SONDA_COUNT_ANT* ]]; then echo "3"; exit 0; fi
if [[ "$q" == *SONDA_COUNT* ]]; then
  case "$CENARIO" in
    sem_tick_posterior|psql_mudo) echo "0" ;;
    leva_mista) echo "1" ;;
    count_lixo)         echo "isto-nao-e-numero" ;;
    leva_mista)
      # o caso REAL do #2079: nfes foi a v1.2 e as outras a v1.1. Marcador único aqui reprovaria
      # a nfes como "bundle velho" — o falso negativo que o script existe para impedir.
      echo "62431|ctes|respondido|v1.1-eco-identidade-fonte|omie-sync-ctes-recebidos"
      echo "62431|nfes|respondido|v1.2-eco-identidade-fonte|omie-sync-nfes-recebidas" ;;
    tick_intermediario) echo "2" ;;
    *)                  echo "1" ;;
  esac
  exit 0
fi
if [[ "$q" == *SONDA_ROWS* ]]; then
  case "$CENARIO" in
    no_ar)
      echo "62431|ctes|respondido|v1.1-eco-identidade-fonte|omie-sync-ctes-recebidos"
      echo "62431|nfes|background|-|-" ;;
    bundle_velho)
      echo "62431|ctes|respondido|v1.0-eco-versao-passivo|omie-sync-ctes-recebidos"
      echo "62431|vendas|respondido|v1.0-eco-versao-passivo|omie-sync-vendas-items" ;;
    todos_background)
      echo "62431|nfes|background|-|-"
      echo "62431|pedidos|background|-|-" ;;
    leva_mista)
      # o caso REAL do #2079: nfes foi a v1.2 e as outras a v1.1. Marcador único aqui reprovaria
      # a nfes como "bundle velho" — o falso negativo que o script existe para impedir.
      echo "62431|ctes|respondido|v1.1-eco-identidade-fonte|omie-sync-ctes-recebidos"
      echo "62431|nfes|respondido|v1.2-eco-identidade-fonte|omie-sync-nfes-recebidas" ;;
    tick_intermediario)
      # ORDER BY id DESC: o mais RECENTE (62431, novo) vem primeiro; o intermediário (62400,
      # velho) é história — foi gravado entre o merge e o deploy e não pode virar veredito.
      echo "62431|ctes|respondido|v1.1-eco-identidade-fonte|omie-sync-ctes-recebidos"
      echo "62400|ctes|respondido|v1.0-eco-versao-passivo|omie-sync-ctes-recebidos" ;;
  esac
  exit 0
fi
exit 0
FAKE
chmod +x "$TMP/psql-fake"

rc=0
caso() { # nome cenario exit_esperado descricao [marcador]
  local nome="$1" cen="$2" esp="$3" desc="$4" marc="${5:-v1.1-eco-identidade-fonte}" got
  CENARIO="$cen" PSQL_RO="$TMP/psql-fake" bash "$SCRIPT" --desde '2026-08-28 22:32:00+00' \
    --esperado "$marc" >"$TMP/out" 2>&1; got=$?
  if [ "$got" -eq "$esp" ]; then printf '  [ok ] %-22s exit %s — %s\n' "$nome" "$got" "$desc"
  else printf '  [XX ] %-22s exit %s (esperado %s) — %s\n' "$nome" "$got" "$esp" "$desc"; rc=1; fi
}

echo "== verify-edge-eco — guard temporal =="
caso sem_tick_posterior  sem_tick_posterior  2 "TTL só com ticks PRÉ-merge ⇒ INDETERMINADO, nunca 'pendente'"
caso no_ar               no_ar               0 "marcador esperado num step respondido"
caso bundle_velho        bundle_velho        1 "marcador VELHO respondido ⇒ deploy realmente pendente" \
  'ctes=v1.1-eco-identidade-fonte,vendas=v1.1-eco-identidade-fonte'
caso todos_background    todos_background    2 "houve tick, mas nenhum corpo coletado ⇒ INDETERMINADO"
caso tick_intermediario  tick_intermediario  0 "tick velho intermediário é história; veredito é o mais recente"
caso psql_morto          psql_morto          3 "via de leitura morta ⇒ RECUSA fail-closed, nunca veredito"
caso count_lixo          count_lixo          3 "contagem não-numérica ⇒ RECUSA (vazio se leria como 'nenhum tick')"
caso psql_mudo           psql_mudo           3 "via presente-porém-QUEBRADA (responde vazio) ⇒ RECUSA, não 'indeterminado'"
caso leva_mista_lote     leva_mista          3 "marcador ÚNICO com 2 steps úteis ⇒ RECUSA ('o bump do lote' reprova)"
caso leva_mista_mapa     leva_mista          0 "mapa por edge: nfes=v1.2 e ctes=v1.1 batem" \
  'ctes=v1.1-eco-identidade-fonte,nfes=v1.2-eco-identidade-fonte'
caso leva_mista_incompl  leva_mista          3 "mapa sem a nfes ⇒ RECUSA (comparar contra nada fabrica veredito)" \
  'ctes=v1.1-eco-identidade-fonte'
caso leva_mista_por_edge leva_mista          0 "chave do mapa pode ser a EDGE ecoada, não só o step" \
  'omie-sync-ctes-recebidos=v1.1-eco-identidade-fonte,omie-sync-nfes-recebidas=v1.2-eco-identidade-fonte'

# ── falsificação: sabota o guard EM CÓPIA e exige vermelho ──────────────────────────────────────
if [ "${1:-}" = "--falsify" ]; then
  echo ""
  echo "== falsificação (sabota o guard, exige vermelho) =="
  fals=0; total=0

  # (1) guard temporal arrancado: count==0 passa a concluir "pendente" em vez de indeterminado
  total=$((total+1))
  sed 's/^  exit 2$/  exit 1/' "$SCRIPT" > "$TMP/sab1.sh"
  if ! command grep -q '^  exit 1$' "$TMP/sab1.sh"; then
    echo "  [XX ] sabotagem 1 não aplicou — o eval não estaria testando nada"; rc=1
  else
    CENARIO=sem_tick_posterior PSQL_RO="$TMP/psql-fake" bash "$TMP/sab1.sh" \
      --desde '2026-08-28 22:32:00+00' --esperado 'v1.1-eco-identidade-fonte' >/dev/null 2>&1; sabrc=$?
    if [ "$sabrc" -ne 2 ]; then echo "  [ok ] guard temporal arrancado -> o caso VIRA vermelho"; fals=$((fals+1))
    else echo "  [XX ] guard arrancado e o caso seguiu verde — eval CEGO"; rc=1; fi
  fi

  # (2) fail-closed do ping removido: psql morto deixaria de recusar
  total=$((total+1))
  # shellcheck disable=SC2016  # literal do script-alvo, não deve expandir aqui
  sed 's/\[ "${PING:-0}" -ge 1 \] || recusa/[ 1 -ge 0 ] || recusa/' "$SCRIPT" > "$TMP/sab2.sh"
  if ! command grep -q '\[ 1 -ge 0 \]' "$TMP/sab2.sh"; then
    echo "  [XX ] sabotagem 2 não aplicou"; rc=1
  else
    # psql_morto NÃO serve aqui: com a via morta o guard do COUNT recusa sozinho e a sabotagem
    # sai inócua (medido). O ping só é o ÚNICO guard quando a via responde vazio SEM erro.
    CENARIO=psql_mudo PSQL_RO="$TMP/psql-fake" bash "$TMP/sab2.sh" \
      --desde '2026-08-28 22:32:00+00' --esperado 'v1.1-eco-identidade-fonte' >/dev/null 2>&1; sabrc=$?
    if [ "$sabrc" -ne 3 ]; then echo "  [ok ] fail-closed do ping removido -> o caso VIRA vermelho (vira indeterminado)"; fals=$((fals+1))
    else echo "  [XX ] ping sabotado e ainda recusou — sabotagem inócua"; rc=1; fi
  fi

  # (3) veredito pelo tick QUALQUER em vez do mais recente: o intermediário volta a reprovar
  total=$((total+1))
  sed 's/^ID_VEREDITO=.*/ID_VEREDITO=""/' "$SCRIPT" > "$TMP/sab3.sh"
  if ! command grep -q '^ID_VEREDITO=""$' "$TMP/sab3.sh"; then
    echo "  [XX ] sabotagem 3 não aplicou"; rc=1
  else
    CENARIO=tick_intermediario PSQL_RO="$TMP/psql-fake" bash "$TMP/sab3.sh" \
      --desde '2026-08-28 22:32:00+00' --esperado 'v1.1-eco-identidade-fonte' >/dev/null 2>&1; sabrc=$?
    if [ "$sabrc" -ne 0 ]; then echo "  [ok ] veredito por tick qualquer -> o caso VIRA vermelho"; fals=$((fals+1))
    else echo "  [XX ] tick intermediário ignorado mesmo sem o filtro — caso não discrimina"; rc=1; fi
  fi

  # (4) recusa do "marcador do lote" arrancada: a leva mista voltaria a reprovar a nfes
  total=$((total+1))
  # shellcheck disable=SC2016  # literal do script-alvo, não deve expandir aqui
  sed 's/^  \*) \[ "$N_UTEIS_PRE" -le 1 \].*/  *) : ;;/' "$SCRIPT" > "$TMP/sab4.sh"
  if ! command grep -qE '^\s+\*\) : ;;$' "$TMP/sab4.sh"; then
    echo "  [XX ] sabotagem 4 não aplicou"; rc=1
  else
    CENARIO=leva_mista PSQL_RO="$TMP/psql-fake" bash "$TMP/sab4.sh" \
      --desde '2026-08-28 22:32:00+00' --esperado 'v1.1-eco-identidade-fonte' >/dev/null 2>&1; sabrc=$?
    if [ "$sabrc" -ne 3 ]; then echo "  [ok ] recusa do marcador-de-lote arrancada -> a leva mista VIRA vermelha (exit $sabrc)"; fals=$((fals+1))
    else echo "  [XX ] lote sabotado e ainda recusou — sabotagem inócua"; rc=1; fi
  fi

  echo "  falsificações que pegaram: $fals/$total"
  [ "$fals" -eq "$total" ] || rc=1
fi

echo ""
[ "$rc" -eq 0 ] && echo "✅ verify-edge-eco: OK" || echo "❌ verify-edge-eco: FALHOU"
exit "$rc"
