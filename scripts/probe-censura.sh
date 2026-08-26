#!/usr/bin/env bash
# probe-censura.sh — reconcilia o probe de telemetria: quais `attempt_id` foram
# GRAVADOS (lado imune, PostgREST/Postgres) e NÃO CHEGARAM (lado censurável, PostHog).
#
# Por que existe: `us.i.posthog.com` está em EasyPrivacy/uBlock (#1984). Cliente
# bloqueado e cliente que não usou produzem o MESMO zero no PostHog — e nenhuma
# query sobre o PostHog separa os dois, porque o dado que separaria é o que não
# chega. O par tabela × evento resolve isso, mas só se o cruzamento for FEITO;
# cruzar dois sistemas na cabeça é exatamente onde este repo já fabricou veredito.
#
# O que o veredito significa (leia antes de agir sobre ele):
#   - 1 órfão num aparelho NÃO CONCLUI NADA. Fecho de aba entre o INSERT e o flush
#     do SDK produz o mesmo par, e também offline, e também SDK que não carregou.
#   - >=2 órfãos no MESMO aparelho, em sessões distintas, tornam censura persistente
#     a explicação plausível. Como o probe emite no máximo 1× por carga de página,
#     2 órfãos do mesmo device JÁ SÃO 2 sessões distintas — por construção.
#   - 0 evento `telemetria.probe` na janela inteira, com probes na tabela, não é
#     censura de um aparelho: é o canal inteiro mudo (config, key, ingest fora).
#     São diagnósticos DIFERENTES e o script os separa.
#
# FAIL-CLOSED: qualquer lado que não responda aborta com exit != 0. Um lado ausente
# jamais vira "0 órfãos" — essa é a falha que o #2016 documentou e a razão de este
# script existir em vez de dois blocos SQL soltos na doc.
#
# Uso:
#   scripts/probe-censura.sh                # carência 30min, janela 7 dias
#   scripts/probe-censura.sh 60 14          # carência 60min, janela 14 dias
#
# Overrides (existem para FALSIFICAR o script com stubs — um cruzamento que nunca
# foi exercido com dado conhecido é uma asserção sem teste):
#   PSQL_RO_BIN=... POSTHOG_QUERY_BIN=... scripts/probe-censura.sh
#
# Exit: 0=reconciliou (com ou sem órfãos) · 64=uso errado · 69=dependência ausente ·
#       70=lado imune (Postgres) não respondeu · 71=lado censurável (PostHog) não respondeu
set -u

CARENCIA_MIN="${1:-30}"
JANELA_DIAS="${2:-7}"

case "$CARENCIA_MIN" in ''|*[!0-9]*) echo "❌ carência deve ser inteiro de minutos" >&2; exit 64 ;; esac
case "$JANELA_DIAS" in ''|*[!0-9]*) echo "❌ janela deve ser inteiro de dias" >&2; exit 64 ;; esac

RAIZ="$(cd "$(dirname "$0")/.." && pwd)"
PSQL_RO="${PSQL_RO_BIN:-$HOME/.config/afiacao/psql-ro}"
POSTHOG="${POSTHOG_QUERY_BIN:-$RAIZ/scripts/posthog-query.sh}"

# Sondas exigem resposta POSITIVA: `command -v` não basta — binário presente-porém-
# quebrado esvaziaria o cruzamento e o resultado sairia como "sem censura".
if ! printf '{}' | jq -e . >/dev/null 2>&1; then
  echo "❌ jq ausente ou quebrado (não processou '{}')" >&2; exit 69
fi
[ -x "$PSQL_RO" ] || { echo "❌ psql-ro ausente/não-executável em $PSQL_RO" >&2; exit 69; }
[ -x "$POSTHOG" ] || { echo "❌ posthog-query.sh ausente/não-executável em $POSTHOG" >&2; exit 69; }

tmp="$(mktemp -d)" || { echo "❌ mktemp falhou" >&2; exit 69; }
trap 'rm -rf "$tmp"' EXIT

# ---------- lado IMUNE: o que o app conseguiu gravar no nosso domínio ----------
# Só probes FORA da carência: um probe de 2 minutos atrás ainda pode estar em
# trânsito no batch do SDK, e contá-lo como órfão inventaria censura.
"$PSQL_RO" -X -A -F'|' -t -q -c "
  SELECT attempt_id, device_id::text, to_char(criado_em,'YYYY-MM-DD\"T\"HH24:MI:SSZ')
  FROM public.telemetria_probes
  WHERE criado_em > now() - interval '$JANELA_DIAS days'
    AND criado_em < now() - interval '$CARENCIA_MIN minutes'
  ORDER BY criado_em;
" > "$tmp/tabela.txt" 2>"$tmp/tabela.err"
rc=$?
if [ "$rc" -ne 0 ]; then
  echo "❌ lado IMUNE não respondeu (psql-ro rc=$rc) — ausência de dado, NÃO zero." >&2
  head -c 600 "$tmp/tabela.err" >&2; echo >&2
  echo "   → se for 'relation does not exist', a migration telemetria_probes não foi aplicada." >&2
  exit 70
fi
command grep -c . "$tmp/tabela.txt" > "$tmp/n_tabela" 2>/dev/null || true
N_TABELA="$(cat "$tmp/n_tabela" 2>/dev/null || echo 0)"

if [ "$N_TABELA" -eq 0 ]; then
  echo "🟡 Nenhum probe gravado fora da carência (janela ${JANELA_DIAS}d, carência ${CARENCIA_MIN}min)."
  echo "   Isso é AUSÊNCIA DE OBSERVAÇÃO, não ausência de censura: sem probe não há o que reconciliar."
  echo "   Gate: o probe só grava em boot AUTENTICADO com telemetria ligada (produção)."
  exit 0
fi

# ---------- lado CENSURÁVEL: o que atravessou até o PostHog ----------
"$POSTHOG" "
SELECT DISTINCT properties.attempt_id AS attempt_id
FROM events
WHERE event = 'telemetria.probe'
  AND timestamp > now() - INTERVAL $JANELA_DIAS DAY
  AND notEmpty(toString(properties.attempt_id))
" > "$tmp/posthog.json" 2>"$tmp/posthog.err"
rc=$?
if [ "$rc" -ne 0 ]; then
  echo "❌ lado CENSURÁVEL não respondeu (posthog-query rc=$rc) — ausência de dado, NÃO zero." >&2
  head -c 600 "$tmp/posthog.err" >&2; echo >&2
  echo "   → rc=73 é HTTP 504 (query estourou o tempo). Repita; não interprete como 'sem eventos'." >&2
  exit 71
fi
jq -r '.results[][0] // empty' "$tmp/posthog.json" 2>/dev/null | LC_ALL=C sort -u > "$tmp/vistos.txt" || {
  echo "❌ resposta do PostHog não é o JSON esperado — não dá para cruzar." >&2
  head -c 400 "$tmp/posthog.json" >&2; echo >&2; exit 71; }
N_VISTOS="$(command grep -c . "$tmp/vistos.txt" || true)"

# ---------- cruzamento ----------
# LC_ALL=C nos DOIS lados: `comm` compara byte a byte e exige a mesma ordem que
# `sort` produziu. Locale diferente entre eles cruza errado e ainda avisa em stderr.
cut -d'|' -f1 "$tmp/tabela.txt" | LC_ALL=C sort -u > "$tmp/gravados.txt"
LC_ALL=C comm -23 "$tmp/gravados.txt" "$tmp/vistos.txt" > "$tmp/orfaos.txt"
N_ORFAOS="$(command grep -c . "$tmp/orfaos.txt" || true)"

echo "═══ Reconciliação do probe de censura ═══"
echo "janela=${JANELA_DIAS}d  carência=${CARENCIA_MIN}min"
echo "gravados (lado imune): $N_TABELA   ·   vistos no PostHog: $N_VISTOS   ·   ÓRFÃOS: $N_ORFAOS"
echo

if [ "$N_ORFAOS" -eq 0 ]; then
  echo "🟢 Todo attempt_id gravado atravessou. Nenhum sinal de censura nesta janela."
  exit 0
fi

if [ "$N_VISTOS" -eq 0 ]; then
  echo "🔴 CANAL INTEIRO MUDO — $N_TABELA probes gravados, ZERO eventos no PostHog."
  echo "   Este NÃO é o diagnóstico de bloqueador por aparelho: nenhum aparelho entregou."
  echo "   Investigue config/key/ingest ANTES de concluir censura (o #1967 é essa lição)."
  exit 0
fi

# Órfãos por APARELHO — o eixo sem o qual o pareamento é cego (o #2016).
# Denominador junto: "2 órfãos" sem "de quantos" é a fabricação que a §6 proíbe.
echo "Por aparelho (órfãos / total gravado):"
awk -F'|' 'NR==FNR { orfao[$1]=1; next }
           { total[$2]++; if ($1 in orfao) { n[$2]++; if (!(($2) in prim)) prim[$2]=$3; ult[$2]=$3 } }
     END { for (d in total) if (n[d] > 0)
             printf "  %s  %d/%d  primeiro=%s  ultimo=%s\n", d, n[d], total[d], prim[d], ult[d] }' \
    "$tmp/orfaos.txt" "$tmp/tabela.txt" | sort -k2 -r
echo

CONCLUSIVOS="$(awk -F'|' 'NR==FNR { orfao[$1]=1; next }
                          { if ($1 in orfao) n[$2]++ }
                    END { c=0; for (d in n) if (n[d] >= 2) c++; print c }' \
                 "$tmp/orfaos.txt" "$tmp/tabela.txt")"

if [ "$CONCLUSIVOS" -gt 0 ]; then
  echo "🔴 $CONCLUSIVOS aparelho(s) com >=2 órfãos em sessões distintas."
  echo "   Censura persistente é explicação PLAUSÍVEL nesses aparelhos."
  echo "   → condição (2) do gatilho da §6 SATISFEITA (a (1) é a query de customer aprovado)."
else
  echo "🟡 Órfãos existem, mas nenhum aparelho tem 2 em sessões distintas."
  echo "   INCONCLUSIVO por desenho: 1 órfão é compatível com fecho de aba, offline"
  echo "   e SDK que não carregou. Não reporte como censura."
fi
