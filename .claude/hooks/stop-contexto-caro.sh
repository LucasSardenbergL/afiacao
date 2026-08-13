#!/usr/bin/env bash
# stop-contexto-caro.sh — Stop: avisa quando a sessão fica CARA de reler.
#
# POR QUÊ: 89,6% do custo de token é entrada de contexto, e 39 sessões (as de
# 50+ requests) concentraram 96% do gasto medido — números já DEDUPLICADOS
# (scripts/tokens-report.sh; a régua contava cada request 2-5x até 2026-08-06).
# O custo cresce ~quadraticamente: o request N relê tudo que os N-1 acumularam,
# então uma sessão de 2.000 turnos custa MUITO mais que 4 de 500 fazendo o mesmo.
# O founder não tem como ver isso acontecendo — este hook torna visível.
#
# BARATO DE PROPÓSITO: lê `tail` do transcript + um `grep -c`. Zero parse do
# arquivo inteiro (transcripts chegam a 70MB) e zero typecheck/test — rodar
# pesado no Stop brigaria com o semáforo `heavy` (M2 8GB) e com a latência.
# NUNCA bloqueia (sempre exit 0). Avisa uma vez POR DEGRAU, não a cada turno —
# e o degrau é de CUSTO, não de token cru (ver `ctx_custo` abaixo): a mesma
# quantia é atingida na metade do contexto num modelo que custa o dobro.
# Testes em scripts/test-stop-contexto-caro.sh.
set -u

command -v jq >/dev/null 2>&1 || exit 0

entrada="$(cat)"
transcript="$(printf '%s' "$entrada" | jq -r '.transcript_path // empty' 2>/dev/null)"
sessao="$(printf '%s' "$entrada" | jq -r '.session_id // "sem-id"' 2>/dev/null)"
[ -n "$transcript" ] && [ -f "$transcript" ] || exit 0

# Contexto ATUAL = último usage do transcript. `tail` evita varrer o arquivo
# inteiro; 400 linhas cobrem com folga o último turno mesmo com muita tool call.
ultimo="$(tail -n 400 "$transcript" 2>/dev/null \
  | jq -rs 'map(select(.message.usage != null)) | last
            | if . == null then "0 x" else
                ( ((.message.usage.input_tokens // 0)
                 + (.message.usage.cache_creation_input_tokens // 0)
                 + (.message.usage.cache_read_input_tokens // 0)) | tostring )
                + " " + (.message.model // "x")
              end' 2>/dev/null)"
ctx="${ultimo%% *}"
modelo="${ultimo##* }"
case "$ctx" in ''|*[!0-9]*) exit 0 ;; esac
[ "$ctx" -gt 0 ] || exit 0

# Preço de cache_read por MTok conforme a família do modelo. Opus é a REFERÊNCIA
# (0.5) porque foi nele que os degraus abaixo foram calibrados.
preco_read=0.5
case "$modelo" in *fable*|*mythos*) preco_read=1.0 ;; *haiku*) preco_read=0.1 ;; *sonnet*) preco_read=0.3 ;; esac

# O degrau é de CUSTO, não de token. Medido em 48 dias: Fable é 34% do custo com
# 18% dos requests, porque custa 2x Opus (US$10/50 vs 5/25 por MTok). Comparar o
# contexto cru contra 250k trataria 250k em Fable e 250k em Opus como o mesmo
# aviso — mas o primeiro já gastou o DOBRO. `ctx_custo` converte o contexto para
# "tokens-Opus" equivalentes, então a sessão Fable é avisada na metade do
# caminho (125k) e a Haiku, praticamente nunca. Em Opus o fator é 1: os degraus
# calibrados (p75 medido = 330k, p90 = 452k) ficam intactos.
ctx_custo="$(awk -v c="$ctx" -v p="$preco_read" 'BEGIN{ printf "%.0f", c * p / 0.5 }')"
case "$ctx_custo" in ''|*[!0-9]*) exit 0 ;; esac

# Só avisa ao CRUZAR um degrau novo.
#
# O PRIMEIRO degrau é 150k, não 250k. Medido em 2026-08-06 sobre dados já
# deduplicados (ver piso-de-contexto.md), perguntando "quando o degrau dispara,
# quanto da sessão JÁ foi gasto?" — a métrica que decide se o aviso tem alavanca:
#
#   degrau | sessões | % do custo coberto | % já gasto | sessões triviais (<US$1)
#    120k  |   46    |       99,1%        |   12,3%    |  0
#    150k  |   44    |       98,8%        |   16,2%    |  0
#    250k  |   35    |       94,3%        |   29,1%    |  0
#
# 250k avisava com 29,1% do custo já gasto e deixava 16 sessões CARAS mudas
# (ctx_max 159k-248k, US$ 85 = 5,3% da semana). 150k cobre 98,8% do custo e
# dobra a alavanca — e o ruído medido é ZERO: nenhuma sessão trivial chega a
# 150k, porque o piso já é ~81k e 150k exige conversa acumulada de verdade.
# 120k cobre marginalmente mais (99,1%), mas fica a só 39k acima do piso: o
# aviso chegaria antes de haver trabalho a dividir.
if   [ "$ctx_custo" -ge 700000 ]; then degrau=700; acao="pare e faça o split AGORA"
elif [ "$ctx_custo" -ge 500000 ]; then degrau=500; acao="split fortemente recomendado"
elif [ "$ctx_custo" -ge 350000 ]; then degrau=350; acao="split recomendado"
elif [ "$ctx_custo" -ge 250000 ]; then degrau=250; acao="hora de decidir"
elif [ "$ctx_custo" -ge 150000 ]; then degrau=150; acao="atenção — ainda dá para dividir barato"
else exit 0
fi

marca="${TMPDIR:-/tmp}/afiacao-ctx-${sessao}"
anterior=0
[ -f "$marca" ] && anterior="$(cat "$marca" 2>/dev/null || echo 0)"
case "$anterior" in ''|*[!0-9]*) anterior=0 ;; esac
[ "$degrau" -gt "$anterior" ] || exit 0     # já avisei neste degrau (ou acima)
printf '%s' "$degrau" > "$marca" 2>/dev/null || true

# Custo estimado desta sessão. `command grep` porque o `grep` do shell é shim
# p/ ugrep.
#
# ⚠️ `grep -c '"usage"'` contava LINHAS, não requests: uma resposta com vários
# blocos (texto + tool_use) vira várias linhas no JSONL, todas repetindo o mesmo
# usage. Medido: 2,18x de inflação. A "calibração" antiga (US$ 31,79 reais vs
# 29,6 estimados, 7% de erro) era o encontro de DOIS erros — o custo "real" vinha
# do tokens-report.sh, que tinha exatamente a mesma dupla contagem. Agora conta
# requestId DISTINTO (`awk '!a[$0]++'` em vez de `sort -u`: uma passada, sem
# ordenar 70MB). Fallback para a contagem de linhas se o transcript não tiver
# requestId — melhor superestimar que zerar o aviso.
reqs="$(command grep -o '"requestId":"[^"]*"' "$transcript" 2>/dev/null \
        | command awk '!a[$0]++' | command wc -l | command tr -d ' ')"
case "$reqs" in ''|*[!0-9]*) reqs=0 ;; esac
if [ "$reqs" -eq 0 ]; then
  reqs="$(command grep -c '"usage"' "$transcript" 2>/dev/null || echo 0)"
  case "$reqs" in ''|*[!0-9]*) reqs=0 ;; esac
fi

# 1) contexto médio da sessão ≈ (piso + atual)/2 — o piso medido (deduplicado)
#    é ~81k, não 0, então partir de zero subestima. 2) `preco_read` da família do
#    modelo, já definido acima. 3) cache_read é 70,1% do custo total (medido
#    2026-08-06, deduplicado — era 52% com a contagem inflada): dividir por isso
#    recompõe write + output sem precisar somar o transcript inteiro.
custo="$(awk -v r="$reqs" -v c="$ctx" -v p="$preco_read" \
  'BEGIN{ printf "%.0f", (r * ((81000 + c)/2) * p / 1000000) / 0.701 }')"
ctx_k=$(( ctx / 1000 ))

# Nota de MODELO — só quando ele custa mais que a referência (hoje: Fable). Não
# é para sugerir descer sempre: 75% do uso de Fable medido se justifica
# (auditoria ampla, money-path, long-horizon autônomo). É para o caso oposto,
# medido: sessão exploratória que herdou Fable por inércia — 91% das sessões que
# trocaram de modelo COMEÇARAM nele. Trocar sai por ~US$ 0,17 (US$ 15 em 48 dias).
nota_msg=""
nota_agente=""
if awk -v p="$preco_read" 'BEGIN{ exit !(p > 0.5) }'; then
  nota_msg="
⚠️  Esta sessão está em ${modelo} — cada token custa 2x o de Opus 5. Se o que resta é
    exploratório (brainstorm, leitura, explicação), '/model opus' corta o resto pela metade.
    Se é auditoria ampla / money-path / long-horizon, FIQUE onde está — aí o modelo se paga."
  nota_agente=" Esta sessão está rodando em ${modelo}, que custa 2x o Opus 5 por token. Se o trabalho que RESTA é exploratório (brainstorm, leitura de material, explicação, gap analysis), sugira ao Lucas '/model opus' — corta o custo do restante pela metade e trocar de modelo é barato (~US\$ 0,17). Se o que resta é auditoria ampla, money-path ou long-horizon autônomo, NÃO sugira descer: nesses casos o modelo se justifica."
fi

msg="🔴 Contexto desta sessão: ${ctx_k}k tokens (~${reqs} requests, ~US\$ ${custo} já relidos) — ${acao}.
Cada novo turno relê esses ${ctx_k}k. O custo cresce ~quadraticamente no comprimento da sessão.
→ /compact foco: <próximo passo>   (preserva mal sem o foco)
→ /handoff-sessao                  (1 entrega = 1 sessão — no 2º compact, prefira este)${nota_msg}
(aviso não-bloqueante · medir: scripts/tokens-report.sh)"

ctx_agente="O contexto desta sessão chegou a ${ctx_k}k tokens (~${reqs} requests). Cada turno seguinte relê tudo isso, e o custo cresce quadraticamente no comprimento da sessão. Se a entrega atual estiver concluída, proponha ao Lucas encerrar aqui e abrir sessão nova com /handoff-sessao em vez de emendar a próxima tarefa. Se ainda está no meio de uma entrega, sugira '/compact foco: <próximo passo>'. Não interrompa trabalho em andamento por causa deste aviso — apenas proponha.${nota_agente}"

jq -n --arg m "$msg" --arg c "$ctx_agente" \
  '{systemMessage:$m, hookSpecificOutput:{hookEventName:"Stop", additionalContext:$c}}'
exit 0
