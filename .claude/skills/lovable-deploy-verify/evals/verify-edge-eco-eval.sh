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

# ── falsificação: sabota o guard EM CÓPIA e exige o vermelho PREVISTO ───────────────────────────
# Cada sabotagem DECLARA o desfecho que a acusa: o exit E a marca do ramo que o caso-alvo tem de
# imprimir. "Divergiu do exit normal" (o juiz de antes) aceitava crash, sintaxe quebrada e erro
# alheio: com a (2) trocada por `[ 1 -ge 0 ] || ( recusa` o script morria de SINTAXE com exit 2 —
# o MESMO exit do ramo previsto — e o laço contava dente. → docs/historico/falsificacao-exit-nao-e-dente.md
# Referência no mesmo diretório: monitor-deploy-eval.sh (sabota/bate/controle por locale).
if [ "${1:-}" = "--falsify" ]; then
  echo ""
  echo "== falsificação (sabota o guard em CÓPIA, exige o vermelho PREVISTO) =="
  # locales: sonda POSITIVA — "setei LC_ALL" não prova que o locale existe (glibc cai em C calado)
  LOCALES="C"
  for cand in pt_BR.UTF-8 pt_BR.utf8 en_US.UTF-8 en_US.utf8 C.UTF-8 C.utf8; do
    if [ "$(LC_ALL="$cand" locale charmap 2>/dev/null)" = "UTF-8" ]; then LOCALES="C $cand"; break; fi
  done
  [ "$LOCALES" = "C" ] && echo "  ⚠️  nenhum locale UTF-8 disponível — falsificação só em C (metade da prova)"

  roda() { # script cenario locale → exit do script; saída em $TMP/out
    CENARIO="$2" PSQL_RO="$TMP/psql-fake" LC_ALL="$3" LANG="$3" bash "$1" --desde '2026-08-28 22:32:00+00' \
      --esperado 'v1.1-eco-identidade-fonte' >"$TMP/out" 2>&1
  }
  # bate <exit obtido> <exit previsto> <marca> → 0 só se o exit E a marca batem. `case` do próprio
  # shell, não `grep`: sem fork, sem shim que dobra acento; a marca é ASCII de caixa fixa (#1483).
  bate() {
    local s
    [ "$1" -eq "$2" ] || return 1
    s=$(cat "$TMP/out")
    case "$s" in *"$3"*) return 0 ;; esac
    return 1
  }
  aplica() { # de para — substituição LITERAL em cópia; o alvo tem de aparecer EXATAMENTE 1 vez
    python3 - "$SCRIPT" "$TMP/sab.sh" "$1" "$2" <<'PY'
import sys
src, dst, de, para = sys.argv[1:5]
s = open(src, encoding="utf-8").read()
if s.count(de) != 1:
    sys.exit("o alvo aparece %d vez(es): %r" % (s.count(de), de[:70]))
open(dst, "w", encoding="utf-8").write(s.replace(de, para, 1))
PY
  }
  fals=0; total=0
  # sabota <id> <cenario> <exit do caso ÍNTEGRO> <exit previsto> <marca prevista> <de> <para>
  sabota() {
    local id="$1" cen="$2" normal="$3" pexit="$4" pmarca="$5" loc got pegou=0 n_loc=0 errado=""
    total=$((total+1))
    if ! aplica "$6" "$7" 2>"$TMP/aplica.err" || cmp -s "$SCRIPT" "$TMP/sab.sh"; then
      printf '  [XX ] %-18s a sabotagem NÃO aplicou (%s) — o eval não testaria nada\n' "$id" "$(tr '\n' ' ' < "$TMP/aplica.err")"
      rc=1; return
    fi
    if ! bash -n "$TMP/sab.sh" 2>/dev/null; then
      printf '  [XX ] %-18s a sabotagem quebrou a SINTAXE do script — vermelho pelo motivo errado\n' "$id"; rc=1; return
    fi
    for loc in $LOCALES; do
      n_loc=$((n_loc+1))
      # CONTROLE na mesma invocação e locale: o caso-alvo passa com o script ÍNTEGRO, e o desfecho
      # previsto NÃO o descreve — senão "bateu o previsto" não distinguiria sabotagem de nada.
      roda "$SCRIPT" "$cen" "$loc"; got=$?
      if [ "$got" -ne "$normal" ]; then errado="$errado $loc:CONTROLE-VERMELHO-exit$got"; continue; fi
      if bate "$got" "$pexit" "$pmarca"; then errado="$errado $loc:o-PREVISTO-casa-o-CONTROLE"; continue; fi
      roda "$TMP/sab.sh" "$cen" "$loc"; got=$?
      if bate "$got" "$pexit" "$pmarca"; then pegou=$((pegou+1))
      else errado="$errado $loc:exit$got"; fi
    done
    if [ "$pegou" -eq "$n_loc" ]; then
      fals=$((fals+1))
      printf '  [ok ] %-18s -> %-18s exit %s + "%s" em %d locale(s)\n' "$id" "$cen" "$pexit" "$pmarca" "$n_loc"
    else
      printf '  [XX ] %-18s -> %s NÃO saiu pelo previsto (exit %s + "%s"; obtido%s)\n' "$id" "$cen" "$pexit" "$pmarca" "$errado"
      sed 's/^/        | /' "$TMP/out" | head -4
      rc=1
    fi
  }

  # (1) guard temporal arrancado: count==0 passa a concluir "pendente" (exit 1) em vez de
  #     indeterminado. O alvo é o `exit 2` DESTE ramo — o script tem dois (o 2º é o do background).
  sabota guard-temporal sem_tick_posterior 2 1 "nenhum tick POSTERIOR" \
    '  exit 2
fi

# O veredito sai do tick MAIS RECENTE' \
    '  exit 1
fi

# O veredito sai do tick MAIS RECENTE'
  # (2) fail-closed do ping removido. psql_morto NÃO serve aqui: com a via morta o guard do COUNT
  #     recusa sozinho e a sabotagem sai inócua (medido). O ping só é o ÚNICO guard quando a via
  #     responde vazio SEM erro — e então ela cai no INDETERMINADO, exit 2, o MESMO exit de um
  #     script que morre de sintaxe: aqui só a marca separa o julgamento do crash.
  # shellcheck disable=SC2016  # literais do script-alvo, não devem expandir aqui
  sabota ping psql_mudo 3 2 "nenhum tick POSTERIOR" \
    '[ "${PING:-0}" -ge 1 ] || recusa' '[ 1 -ge 0 ] || recusa'
  # (3) veredito pelo tick QUALQUER em vez do mais recente: o intermediário volta a reprovar
  # shellcheck disable=SC2016
  sabota tick-mais-recente tick_intermediario 0 1 "BUNDLE VELHO provado" \
    'ID_VEREDITO=$(printf' 'ID_VEREDITO=""; : $(printf'
  # (4) recusa do "marcador do lote" arrancada: a leva mista volta a reprovar a nfes
  # shellcheck disable=SC2016
  sabota marcador-do-lote leva_mista 3 1 "BUNDLE VELHO provado" \
    '*) [ "$N_UTEIS_PRE" -le 1 ] || recusa' '*) true || recusa'

  echo "  falsificações que pegaram pelo previsto: $fals/$total"
  [ "$total" -ge 4 ] && [ "$fals" -eq "$total" ] || rc=1
fi

echo ""
[ "$rc" -eq 0 ] && echo "✅ verify-edge-eco: OK" || echo "❌ verify-edge-eco: FALHOU"
exit "$rc"
