#!/usr/bin/env bash
# verify-edge-escrita-eval.sh — rede de regressão do N3 PASSIVO por ESCRITA DE APLICAÇÃO
# (scripts/verify-edge-escrita.sh).
#
# Determinístico e offline: um `psql` FALSO devolve fixtures por cenário, discriminando as queries
# pelos marcadores de comentário SQL que o script emite (-- ESCRITA_PING / _ROWS / _QUEM / _PURGA).
#
# O caso que dá nome ao arquivo é o `controle_nao_materializa`: a receita em prosa mandava ler
# `GROUP BY funcao` sobre a tabela de eventos e AFIRMAVA que as vizinhas "saem em zero na mesma
# leitura". `GROUP BY` só produz grupos que TÊM linhas — em prod a query devolveu UMA linha e as
# três vizinhas não apareceram nem como zero. O controle prometido nunca existiu, e o operador
# registrava "passou" sem ter observado nada. Aqui o universo é `limites UNION alvo`, e o caso
# `so_o_alvo` prova que o script DIZ quando o controle não pôde ser observado, em vez de calar.
set -uo pipefail
cd "$(dirname "$0")" || exit 2
SCRIPT="../scripts/verify-edge-escrita.sh"
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

# ── psql falso ──────────────────────────────────────────────────────────────────────────────────
cat > "$TMP/psql-fake" <<'FAKE'
#!/usr/bin/env bash
# Varre TODOS os args atrás do marcador: o script usa tanto `-At -c` quanto `-Atc` (flag
# combinada), e um fake que só olhasse o argumento após `-c` ficaria cego para o segundo —
# devolvendo vazio para toda query e fazendo TODO cenário recusar. Foi o que aconteceu na
# primeira rodada deste eval: 16 casos, 16 exit 3, e as 4 sabotagens "verdes" por cegueira.
q=""
for a in "$@"; do case "$a" in *ESCRITA_*) q="$a" ;; esac; done
case "${CENARIO:-}" in
  psql_morto) exit 1 ;;
esac
if [[ "$q" == *ESCRITA_PING* ]]; then
  # psql_mudo: presente-porém-QUEBRADO — sai 0 e não imprime nada. É o caso que dá dente ao ping:
  # com a via totalmente MORTA o guard do universo vazio já recusa sozinho, então a sabotagem do
  # ping sairia inócua ali (mesma lição medida no eval do verify-edge-eco).
  case "${CENARIO:-}" in psql_mudo|psql_mudo_parcial) exit 0 ;; esac
  echo "1"; exit 0
fi
if [[ "$q" == *ESCRITA_PURGA* ]]; then
  case "$CENARIO" in
    corte_antigo) echo "1" ;;
    *)            echo "0" ;;
  esac
  exit 0
fi
if [[ "$q" == *ESCRITA_ROWS* ]]; then
  case "$CENARIO" in
    psql_mudo) : ;;                       # vazio, sem erro
    psql_mudo_parcial)
      # A via cala no ping mas AINDA devolve linhas — e o alvo vem zerado. É aqui que o ping é o
      # ÚNICO guard: sem ele o script leria uma via quebrada como "ninguém usou a feature"
      # (exit 2, INDETERMINADO honesto) em vez de RECUSA. Ausência de dado se passando por
      # medição — a mesma família que a skill inteira existe para impedir. Com a via TOTALMENTE
      # muda a sabotagem sai inócua, porque o guard do universo vazio recusa sozinho (medido).
      echo "elevenlabs-transcribe|0|0"
      echo "analyze-services|0|0" ;;
    observado|corte_antigo)
      echo "elevenlabs-transcribe|4|4"
      echo "analyze-services|0|0"
      echo "copilot-analyze|0|0" ;;
    ninguem_usou)
      echo "elevenlabs-transcribe|0|0"
      echo "analyze-services|0|0" ;;
    so_pre_merge)                          # tem escrita, mas TODA anterior ao corte
      echo "elevenlabs-transcribe|9|0"
      echo "analyze-services|0|0" ;;
    so_o_alvo)                             # universo sem vizinha: controle não observável
      echo "elevenlabs-transcribe|4|4" ;;
    correlacao_quebrada)                   # filtro solto: TODA função com o mesmo total
      echo "elevenlabs-transcribe|4|4"
      echo "analyze-services|4|0"
      echo "copilot-analyge|4|0" ;;
    controle_fraco)                        # nenhuma zera, mas os totais divergem
      echo "elevenlabs-transcribe|4|4"
      echo "analyze-services|7|0"
      echo "copilot-analyze|2|0" ;;
    alvo_sumiu)                            # leitura devolveu linhas, mas nenhuma é o alvo
      echo "analyze-services|0|0" ;;
  esac
  exit 0
fi
if [[ "$q" == *ESCRITA_QUEM* ]]; then
  echo "2026-08-29 00:32:26|Lucas Sardenberg|master"
  exit 0
fi
exit 0
FAKE
chmod +x "$TMP/psql-fake"

rc=0
caso() { # nome cenario exit_esperado descricao [marcador_de_saida]
  local nome="$1" cen="$2" esp="$3" desc="$4" marc="${5:-}" got
  CENARIO="$cen" PSQL_RO="$TMP/psql-fake" bash "$SCRIPT" --desde '2026-08-29 00:17:10+00' \
    --funcao elevenlabs-transcribe >"$TMP/out" 2>&1; got=$?
  if [ "$got" -ne "$esp" ]; then
    printf '  [XX ] %-24s exit %s (esperado %s) — %s\n' "$nome" "$got" "$esp" "$desc"; rc=1; return
  fi
  if [ -n "$marc" ] && ! command grep -q "$marc" "$TMP/out"; then
    printf '  [XX ] %-24s exit %s ok, mas a marca "%s" não saiu — %s\n' "$nome" "$got" "$marc" "$desc"; rc=1; return
  fi
  printf '  [ok ] %-24s exit %s — %s\n' "$nome" "$got" "$desc"
}

echo "== verify-edge-escrita — N3 passivo por escrita de aplicação =="
caso observado            observado            0 "escrita pós-corte + vizinhas zeradas ⇒ observado em T" "BUNDLE_NOVO_OBSERVADO_EM_T"
caso rebaixa_veredito     observado            0 "o exit 0 DIZ que não prova estado atual (redeploy/revert)" "NÃO prova que ele"
caso controle_materializa observado            0 "o controle que a prosa prometia agora SAI na leitura" "CONTROLE_CRUZADO_OK"
caso ninguem_usou         ninguem_usou         2 "zero escritas ⇒ INDETERMINADO, nunca 'deploy pendente'" "INDETERMINADO"
caso so_pre_merge         so_pre_merge         2 "tem escrita, mas toda PRÉ-corte ⇒ INDETERMINADO"
caso nunca_diz_velho      ninguem_usou         2 "ausência não vira exit 1: a via é unidirecional"
caso so_o_alvo            so_o_alvo            0 "universo sem vizinha: DIZ que o controle não foi observado" "CONTROLE_CRUZADO_NAO_OBSERVADO"
caso controle_fraco       controle_fraco       0 "nenhuma zera mas os totais divergem ⇒ correlação viva, e dito" "CONTROLE_CRUZADO_FRACO"
caso correlacao_quebrada  correlacao_quebrada  3 "todas as vizinhas com o MESMO total ⇒ RECUSA (não discrimina)" "CORRELACAO_SUSPEITA"
caso corte_antigo         corte_antigo         0 "corte além dos 7 dias ⇒ avisa que a purga pode ter comido" "CORTE_ALEM_DA_PURGA"
caso alvo_sumiu           alvo_sumiu           3 "alvo ausente da leitura ⇒ RECUSA, não 'zero escritas'"
caso psql_morto           psql_morto           3 "via de leitura morta ⇒ RECUSA fail-closed"
caso psql_mudo            psql_mudo            3 "via presente-porém-QUEBRADA (vazio sem erro) ⇒ RECUSA"
caso psql_mudo_parcial    psql_mudo_parcial    3 "via muda que ainda devolve linhas ⇒ RECUSA, não 'ninguém usou'"

# ── uso inválido (não chega a tocar a via) ──────────────────────────────────────────────────────
uso_invalido() { # nome descricao args...
  local nome="$1" desc="$2"; shift 2; local got
  PSQL_RO="$TMP/psql-fake" bash "$SCRIPT" "$@" >/dev/null 2>&1; got=$?
  if [ "$got" -eq 3 ]; then printf '  [ok ] %-24s exit 3 — %s\n' "$nome" "$desc"
  else printf '  [XX ] %-24s exit %s (esperado 3) — %s\n' "$nome" "$got" "$desc"; rc=1; fi
}
uso_invalido falta_desde  "sem --desde não há corte a guardar"  --funcao x
uso_invalido falta_funcao "sem --funcao não há edge a nomear"   --desde '2026-08-29 00:17:10+00'
uso_invalido arg_estranho "argumento desconhecido ⇒ RECUSA"     --desde '2026-08-29 00:17:10+00' --funcao x --wat

# ── falsificação: sabota o guard EM CÓPIA e exige o vermelho PREVISTO ───────────────────────────
# Cada sabotagem DECLARA o desfecho que a acusa: o exit E a marca do ramo que o caso-alvo tem de
# imprimir. "Divergiu do exit normal" (o juiz de antes) aceitava crash, sintaxe quebrada e erro
# alheio — e aqui duas sabotagens (ping, alvo) caem no INDETERMINADO, exit 2, o MESMO exit de um
# script que morre de sintaxe: sem a marca, o crash e o julgamento são o mesmo número.
# → docs/historico/falsificacao-exit-nao-e-dente.md · referência: monitor-deploy-eval.sh.
# O exit do caso ÍNTEGRO segue MEDIDO na mesma invocação (controle), nunca só declarado. (Furo
# achado no harness irmão: sabotagem escrita antes da feature ficava verde sem sabotar nada.)
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
    CENARIO="$2" PSQL_RO="$TMP/psql-fake" LC_ALL="$3" LANG="$3" bash "$1" --desde '2026-08-29 00:17:10+00' \
      --funcao elevenlabs-transcribe >"$TMP/out" 2>&1
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
      printf '  [XX ] %-20s a sabotagem NÃO aplicou (%s) — o eval não testaria nada\n' "$id" "$(tr '\n' ' ' < "$TMP/aplica.err")"
      rc=1; return
    fi
    if ! bash -n "$TMP/sab.sh" 2>/dev/null; then
      printf '  [XX ] %-20s a sabotagem quebrou a SINTAXE do script — vermelho pelo motivo errado\n' "$id"; rc=1; return
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
      printf '  [ok ] %-20s -> %-19s exit %s + "%s" em %d locale(s)\n' "$id" "$cen" "$pexit" "$pmarca" "$n_loc"
    else
      printf '  [XX ] %-20s -> %s NÃO saiu pelo previsto (exit %s + "%s"; obtido%s)\n' "$id" "$cen" "$pexit" "$pmarca" "$errado"
      sed 's/^/        | /' "$TMP/out" | head -4
      rc=1
    fi
  }

  # (1) a via unidirecional quebrada: ausência passaria a significar "bundle velho" (exit 1)
  sabota ausencia_vira_velho ninguem_usou 2 1 "nenhuma escrita de" \
    '  exit 2
fi
' '  exit 1
fi
'
  # (2) fail-closed do ping removido: a via muda deixa de recusar e vira "ninguém usou" (exit 2)
  # shellcheck disable=SC2016  # literais do script-alvo, não devem expandir aqui
  sabota ping_sem_dente psql_mudo_parcial 3 2 "nenhuma escrita de" \
    '[ "${PING:-0}" -ge 1 ] || recusa' '[ 1 -ge 0 ] || recusa'
  # (3) guard da correlação arrancado: a query que não discrimina passa a APROVAR o alvo
  sabota correlacao_sem_guard correlacao_quebrada 3 0 "BUNDLE_NOVO_OBSERVADO_EM_T" \
    '    recusa "CORRELACAO_SUSPEITA' '    : "CORRELACAO_SUSPEITA'
  # (4) guard do alvo ausente invertido: leitura sem o alvo vira "zero escritas" (exit 2)
  # shellcheck disable=SC2016
  sabota alvo_sem_guard alvo_sumiu 3 2 "nenhuma escrita de" \
    '[ -n "${ALVO_TOTAL:-}" ] || recusa' '[ -z "${ALVO_TOTAL:-}" ] || recusa'

  echo "  falsificações que pegaram pelo previsto: $fals/$total"
  [ "$total" -ge 4 ] && [ "$fals" -eq "$total" ] || rc=1

  # CONTROLE NEGATIVO DO JUIZ — o gate de reintrodução. Uma sabotagem que sai com o exit PREVISTO da
  # (4) — 2 — SEM passar pelo ramo (um `exit 2` no lugar do guard) tem de ser RECUSADA: só a MARCA a
  # separa do julgamento, então um juiz que regredir a "exit ≠ normal" OU a "só o exit" a credita.
  fals_ok=$fals; total_ok=$total; rc_ok=$rc
  # shellcheck disable=SC2016
  sabota juiz-negativo alvo_sumiu 3 2 "nenhuma escrita de" \
    '[ -n "${ALVO_TOTAL:-}" ] || recusa' 'exit 2; [ -z "${ALVO_TOTAL:-}" ] || recusa' > "$TMP/juiz.out"
  if [ "$fals" -ne "$fals_ok" ]; then
    echo "  [XX ] controle negativo do juiz: um CRASH foi creditado como dente — o juiz perdeu a identidade"; rc=1
  else
    echo "  [ok ] controle negativo do juiz: a sabotagem que só derruba o script foi RECUSADA"; rc=$rc_ok
  fi
  fals=$fals_ok; total=$total_ok
fi

[ "$rc" -eq 0 ] && echo "OK — verify-edge-escrita" || echo "FALHOU — verify-edge-escrita"
exit "$rc"
