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

# ── falsificação: sabota o guard EM CÓPIA e exige vermelho ──────────────────────────────────────
# O `exit_normal` é MEDIDO no script real antes de comparar — nunca o declarado. (Furo achado no
# harness irmão: sabotagem escrita antes da feature ficava verde sem sabotar nada.)
if [ "${1:-}" = "--falsify" ]; then
  echo ""
  echo "== falsificação (sabota o guard, exige vermelho) =="
  fals=0; total=0

  sabota() { # nome cenario sed_expr marca_de_aplicacao descricao
    local nome="$1" cen="$2" expr="$3" marca="$4" desc="$5" normal sabrc
    total=$((total+1))
    CENARIO="$cen" PSQL_RO="$TMP/psql-fake" bash "$SCRIPT" --desde '2026-08-29 00:17:10+00' \
      --funcao elevenlabs-transcribe >/dev/null 2>&1; normal=$?
    sed "$expr" "$SCRIPT" > "$TMP/sab.sh"
    if ! command grep -q "$marca" "$TMP/sab.sh"; then
      printf '  [XX ] %-26s sabotagem NÃO aplicou — o eval não testaria nada\n' "$nome"; rc=1; return
    fi
    CENARIO="$cen" PSQL_RO="$TMP/psql-fake" bash "$TMP/sab.sh" --desde '2026-08-29 00:17:10+00' \
      --funcao elevenlabs-transcribe >/dev/null 2>&1; sabrc=$?
    if [ "$sabrc" -ne "$normal" ]; then
      printf '  [ok ] %-26s %s (exit %s -> %s)\n' "$nome" "$desc" "$normal" "$sabrc"; fals=$((fals+1))
    else
      printf '  [XX ] %-26s sabotado e o caso seguiu VERDE (exit %s) — eval CEGO\n' "$nome" "$sabrc"; rc=1
    fi
  }

  # (1) a via unidirecional quebrada: ausência passaria a significar "bundle velho"
  sabota ausencia_vira_velho ninguem_usou 's/^  exit 2$/  exit 1/' '^  exit 1$' \
    "ausência virando exit 1 -> VIRA vermelho"
  # (2) fail-closed do ping removido: via muda deixaria de recusar
  # shellcheck disable=SC2016  # literal do script-alvo, não deve expandir aqui
  sabota ping_sem_dente psql_mudo_parcial 's/\[ "${PING:-0}" -ge 1 \] || recusa/[ 1 -ge 0 ] || recusa/' \
    '\[ 1 -ge 0 \]' "ping desarmado -> VIRA vermelho (vira 'ninguém usou')"
  # (3) guard da correlação arrancado: query que não discrimina passaria batido
  sabota correlacao_sem_guard correlacao_quebrada 's/^    recusa "CORRELACAO_SUSPEITA/    : "CORRELACAO_SUSPEITA/' \
    '^    : "CORRELACAO_SUSPEITA' "guard de correlação arrancado -> VIRA vermelho"
  # shellcheck disable=SC2016  # literal do script-alvo, não deve expandir aqui
  # (4) guard do alvo ausente removido: leitura sem o alvo viraria "zero escritas"
  sabota alvo_sem_guard alvo_sumiu 's/^\[ -n "${ALVO_TOTAL:-}" \] || recusa/[ -z "${ALVO_TOTAL:-}" ] || recusa/' \
    '\[ -z "${ALVO_TOTAL:-}" \]' "guard do alvo invertido -> VIRA vermelho"

  echo "  falsificações efetivas: $fals/$total"
  [ "$fals" -eq "$total" ] || rc=1
fi

[ "$rc" -eq 0 ] && echo "OK — verify-edge-escrita" || echo "FALHOU — verify-edge-escrita"
exit "$rc"
