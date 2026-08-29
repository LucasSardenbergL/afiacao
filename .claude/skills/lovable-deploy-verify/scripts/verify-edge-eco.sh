#!/usr/bin/env bash
# verify-edge-eco.sh — lê o N3 PASSIVO (eco de `versao` no corpo que o cron já gravou em
# `net._http_response`) COM O GUARD TEMPORAL que faltava.
#
# POR QUE ESTE SCRIPT EXISTE (2026-08-29, verificando o #2079)
# ------------------------------------------------------------
# O N3 passivo lê respostas dentro do TTL do pg_net (6 h). A skill já registrava o limite no
# sentido "o run é velho demais e SUMIU ⇒ volta ao N3 ativo" — ausência honesta, que se percebe.
# O sentido INVERSO não estava coberto e é estritamente pior:
#
#     os ticks presentes são todos ANTERIORES ao merge.
#
# Aí a query roda com exit 0 e devolve linhas perfeitamente legíveis, com o marcador VELHO — que
# se lê como "deploy pendente". É falso NEGATIVO com cara de veredito confiante, e o preço é
# mandar o founder redeployar edge money-path à toa. Verificando o #2079 os três ticks do TTL
# eram 18:15, 20:15 e 22:15Z contra um merge às 22:32Z: todos pré-merge, todos ecoando o marcador
# velho, e nenhum deles dizia coisa alguma sobre o deploy. O tick seguinte (00:15Z) provou que a
# edge JÁ estava no ar.
#
# É a família "ausente ≠ zero" na dimensão TEMPO: **anterior ≠ ausência de deploy**. E é o irmão
# da regra do `background` que a skill já tem — lá a coluna `modo` separa "não subiu" de "não deu
# tempo de coletar"; aqui a coluna `created` separa "não subiu" de "ainda não foi medido".
#
# EXIT CODES (mesma gramática do verify-frontend.sh)
#   0 = PROVADO NO AR   — ≥1 step respondido com o marcador esperado
#   1 = PROVADO VELHO   — ≥1 step respondido com marcador != esperado (aí sim, deploy pendente)
#   2 = INDETERMINADO   — não dá para concluir NADA: nenhum tick posterior ao corte, ou todos os
#                         steps posteriores vieram `background` (corpo não coletado). NUNCA leia
#                         isto como "não está no ar".
#   3 = RECUSA          — uso inválido ou via de leitura não provada (fail-CLOSED)
set -uo pipefail

PSQL_RO="${PSQL_RO:-$HOME/.config/afiacao/psql-ro}"
DESDE=""; ESPERADO=""; STEPS=""

recusa() { printf '❌ RECUSA: %s\n' "$1" >&2; exit 3; }

while [ $# -gt 0 ]; do
  case "$1" in
    --desde)    [ $# -ge 2 ] && [ -n "${2:-}" ] || recusa "--desde exige um timestamp"; DESDE="$2"; shift 2 ;;
    --esperado) [ $# -ge 2 ] && [ -n "${2:-}" ] || recusa "--esperado exige um marcador"; ESPERADO="$2"; shift 2 ;;
    --steps)    [ $# -ge 2 ] && [ -n "${2:-}" ] || recusa "--steps exige uma lista"; STEPS="$2"; shift 2 ;;
    *) recusa "argumento desconhecido '$1'" ;;
  esac
done

[ -n "$DESDE" ]    || recusa "falta --desde '<timestamp do merge, UTC>' — sem corte temporal este script não tem como guardar nada"
[ -n "$ESPERADO" ] || recusa "falta --esperado '<marcador VERSAO da main>'"

# ── O marcador esperado é POR EDGE, nunca "o do lote" ───────────────────────────────────────────
# Edges de uma mesma leva partem de marcadores DIFERENTES: no #2079 quatro foram a
# v1.1-eco-identidade-fonte e a `nfes` a v1.2 (ela vinha de v1.1-deadline-relogio). Um `--esperado`
# único aplicado a vários steps classificaria a `nfes` como bundle VELHO — o falso negativo que
# este script existe para impedir, cometido pelo próprio script. Ver o adendo "o marcador esperado
# é POR EDGE, não 'o bump do lote'" em docs/historico/verificabilidade-do-conjunto-orquestrado.md.
# Forma canônica: --esperado 'ctes=v1.1-eco-identidade-fonte,nfes=v1.2-eco-identidade-fonte'
# (a chave casa o STEP do orquestrador ou a EDGE ecoada). Valor único só é aceito para UM step.
esperado_de() { # $1=step  $2=edge ecoada
  local par k v
  case "$ESPERADO" in
    *=*)
      local IFS=','
      for par in $ESPERADO; do
        k="${par%%=*}"; v="${par#*=}"
        if [ "$k" = "$1" ] || [ "$k" = "$2" ]; then printf '%s' "$v"; return 0; fi
      done
      return 1 ;;
    *) printf '%s' "$ESPERADO"; return 0 ;;
  esac
}

# ── fail-CLOSED na via de leitura ───────────────────────────────────────────────────────────────
# `command -v` não basta: presente-porém-quebrado esvazia o guard igual. Exigimos resposta POSITIVA.
PING=$("$PSQL_RO" -At -c "SELECT 'PONG_ECO'; -- SONDA_PING" 2>/dev/null | command grep -c '^PONG_ECO$' || true)
[ "${PING:-0}" -ge 1 ] || recusa "a via de leitura não respondeu POSITIVAMENTE ($PSQL_RO). Sem ela, 'não achei tick' seria ausência de dado se passando por veredito."

FORMA="r.status_code = 200 AND r.content IS NOT NULL AND left(ltrim(r.content),1) = '{' AND (r.content::jsonb) ? 'resultados' AND jsonb_typeof((r.content::jsonb)->'resultados') = 'object'"
FILTRO_STEPS=""
[ -n "$STEPS" ] && FILTRO_STEPS=" AND k = ANY (string_to_array('$STEPS', ','))"

# ── O GUARD TEMPORAL ────────────────────────────────────────────────────────────────────────────
N_POS=$("$PSQL_RO" -At -c "SELECT count(*) FROM net._http_response r WHERE r.created > '$DESDE'::timestamptz AND $FORMA; -- SONDA_COUNT" 2>/dev/null | command grep -E '^[0-9]+$' | head -1)
[ -n "${N_POS:-}" ] || recusa "a contagem de ticks não devolveu número — leitura inutilizável, e um vazio aqui se leria como 'nenhum tick'."

if [ "$N_POS" -eq 0 ]; then
  N_ANT=$("$PSQL_RO" -At -c "SELECT count(*) FROM net._http_response r WHERE r.created <= '$DESDE'::timestamptz AND $FORMA; -- SONDA_COUNT_ANT" 2>/dev/null | command grep -E '^[0-9]+$' | head -1)
  printf '⏳ INDETERMINADO — nenhum tick POSTERIOR a %s dentro do TTL.\n' "$DESDE"
  printf '   Ticks anteriores na janela: %s. Eles ecoam o bundle de ANTES do corte e NÃO dizem nada\n' "${N_ANT:-?}"
  printf '   sobre este deploy: ler o marcador velho deles como "deploy pendente" é falso NEGATIVO.\n'
  printf '   Espere o próximo tick do cron, ou caia no N3 ATIVO (sonda gated).\n'
  exit 2
fi

# O veredito sai do tick MAIS RECENTE com step utilizável — nunca de um tick intermediário.
# O deploy pode ter acontecido DEPOIS do merge: um tick entre os dois ecoa o marcador velho com
# toda a razão, e é história, não veredito. Julgar por ele reprova deploy correto.
LINHAS=$("$PSQL_RO" -At -F '|' -c "SELECT r.id, k, coalesce((r.content::jsonb)->'resultados'->k->>'modo','-'), coalesce((r.content::jsonb)->'resultados'->k->'body'->>'versao','-'), coalesce((r.content::jsonb)->'resultados'->k->'body'->>'edge','-') FROM net._http_response r, jsonb_object_keys((r.content::jsonb)->'resultados') k WHERE r.created > '$DESDE'::timestamptz AND $FORMA$FILTRO_STEPS ORDER BY r.id DESC, k; -- SONDA_ROWS" 2>/dev/null | command grep -v '^SET$')

# id do tick mais recente que traz ao menos um step respondido com marcador
ID_VEREDITO=$(printf '%s\n' "$LINHAS" | awk -F'|' '$3=="respondido" && $4!="-" && $4!="" {print $1; exit}')

# 1ª passada: quantos steps ÚTEIS o tick do veredito traz — decide se o marcador único é legítimo
N_UTEIS_PRE=$(printf '%s\n' "$LINHAS" | awk -F'|' -v id="${ID_VEREDITO:-}" \
  '$1==id && $3=="respondido" && $4!="-" && $4!="" {n++} END {print n+0}')
case "$ESPERADO" in
  *=*) : ;;
  *) [ "$N_UTEIS_PRE" -le 1 ] || recusa "--esperado veio como marcador ÚNICO, mas o tick traz $N_UTEIS_PRE steps úteis. Edges de uma mesma leva partem de marcadores DIFERENTES (no #2079 a nfes foi a v1.2 e as outras a v1.1): um valor único aqui classificaria a divergente como bundle VELHO — o falso negativo que este script existe para impedir. Use o mapa: --esperado 'ctes=v1.1-...,nfes=v1.2-...' (chave = step ou edge), ou restrinja com --steps." ;;
esac

UTEIS=0; NOVOS=0; VELHOS=0; MUDOS=0
while IFS='|' read -r tid step modo versao edge; do
  [ -z "${step:-}" ] && continue
  # fora do tick do veredito = história; só conta se ainda não há veredito (aí tudo é mudo)
  [ -n "${ID_VEREDITO:-}" ] && [ "$tid" != "$ID_VEREDITO" ] && continue
  if [ "$modo" = "respondido" ] && [ "$versao" != "-" ] && [ -n "$versao" ]; then
    UTEIS=$((UTEIS+1))
    ESP_STEP=$(esperado_de "$step" "$edge") || recusa "o step '$step' (edge '$edge') veio no tick mas não tem marcador em --esperado. Comparar contra nada fabrica veredito: nomeie-o no mapa ou exclua-o com --steps."
    if [ "$versao" = "$ESP_STEP" ]; then
      NOVOS=$((NOVOS+1)); printf '  ✅ %-16s %s  (edge ecoada: %s)\n' "$step" "$versao" "$edge"
    else
      VELHOS=$((VELHOS+1)); printf '  ❌ %-16s %s  ← marcador VELHO (esperado %s)\n' "$step" "$versao" "$ESP_STEP"
    fi
  else
    MUDOS=$((MUDOS+1)); printf '  ⏳ %-16s modo=%s — corpo NÃO coletado: linha inutilizável, não é "não subiu"\n' "$step" "$modo"
  fi
done <<< "$LINHAS"

printf '\n  ticks posteriores ao corte: %s · tick do veredito: %s · steps úteis: %s (novos %s / velhos %s) · mudos: %s\n' "$N_POS" "${ID_VEREDITO:-nenhum}" "$UTEIS" "$NOVOS" "$VELHOS" "$MUDOS"

if [ "$UTEIS" -eq 0 ]; then
  # shellcheck disable=SC2016  # crases são texto citado, não expansão
  printf '⏳ INDETERMINADO — houve tick posterior, mas TODO step veio `background`/sem corpo.\n'
  # shellcheck disable=SC2016  # crases são texto citado, não expansão
  printf '   O vazio do `background` é byte a byte o vazio do bundle pré-sensor; só `modo` os separa,\n'
  printf '   e ele diz que é o primeiro. Acumule ticks antes de pagar a sonda ativa.\n'
  exit 2
fi
if [ "$VELHOS" -gt 0 ]; then
  printf '❌ BUNDLE VELHO provado em %s step(s) respondido(s) — deploy REALMENTE pendente.\n' "$VELHOS"
  exit 1
fi
printf '✅ NO AR — %s step(s) respondido(s) ecoando o marcador esperado de CADA edge.\n' "$NOVOS"
exit 0
