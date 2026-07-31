#!/usr/bin/env bash
# stop-contexto-caro.sh — Stop: avisa quando a sessão fica CARA de reler.
#
# POR QUÊ: 82% do custo de token é entrada de contexto, e 80 sessões longas
# concentraram 62% do gasto medido (scripts/tokens-report.sh). O custo cresce
# ~quadraticamente: o request N relê tudo que os N-1 acumularam, então uma
# sessão de 2.000 turnos custa MUITO mais que 4 de 500 fazendo o mesmo.
# O founder não tem como ver isso acontecendo — este hook torna visível.
#
# BARATO DE PROPÓSITO: lê `tail` do transcript + um `grep -c`. Zero parse do
# arquivo inteiro (transcripts chegam a 70MB) e zero typecheck/test — rodar
# pesado no Stop brigaria com o semáforo `heavy` (M2 8GB) e com a latência.
# NUNCA bloqueia (sempre exit 0). Avisa uma vez POR DEGRAU, não a cada turno.
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

# Degraus: só avisa ao CRUZAR um novo. p75 medido = 330k, p90 = 452k.
if   [ "$ctx" -ge 700000 ]; then degrau=700; acao="pare e faça o split AGORA"
elif [ "$ctx" -ge 500000 ]; then degrau=500; acao="split recomendado"
elif [ "$ctx" -ge 350000 ]; then degrau=350; acao="hora de decidir"
elif [ "$ctx" -ge 250000 ]; then degrau=250; acao="atenção"
else exit 0
fi

marca="${TMPDIR:-/tmp}/afiacao-ctx-${sessao}"
anterior=0
[ -f "$marca" ] && anterior="$(cat "$marca" 2>/dev/null || echo 0)"
case "$anterior" in ''|*[!0-9]*) anterior=0 ;; esac
[ "$degrau" -gt "$anterior" ] || exit 0     # já avisei neste degrau (ou acima)
printf '%s' "$degrau" > "$marca" 2>/dev/null || true

# Custo estimado desta sessão. `command grep` porque o `grep` do shell é shim
# p/ ugrep. Calibração conferida contra o custo real de uma sessão (US$ 31,79
# medidos vs 29,6 estimados = 7% de erro); a 1ª versão errava 2,4x porque só
# contava cache_read — write + output são 47% do custo e não podem sair da conta.
reqs="$(command grep -c '"usage"' "$transcript" 2>/dev/null || echo 0)"
case "$reqs" in ''|*[!0-9]*) reqs=0 ;; esac

# 1) contexto médio da sessão ≈ (piso + atual)/2 — o piso medido é ~61k, não 0,
#    então partir de zero subestima. 2) preço de cache_read por MTok conforme a
#    família do modelo. 3) cache_read é 52% do custo total (medido): dividir por
#    isso recompõe write + output sem precisar somar o transcript inteiro.
preco_read=0.5
case "$modelo" in *fable*|*mythos*) preco_read=1.0 ;; *haiku*) preco_read=0.1 ;; *sonnet*) preco_read=0.3 ;; esac
custo="$(awk -v r="$reqs" -v c="$ctx" -v p="$preco_read" \
  'BEGIN{ printf "%.0f", (r * ((61000 + c)/2) * p / 1000000) / 0.52 }')"
ctx_k=$(( ctx / 1000 ))

msg="🔴 Contexto desta sessão: ${ctx_k}k tokens (~${reqs} requests, ~US\$ ${custo} já relidos) — ${acao}.
Cada novo turno relê esses ${ctx_k}k. O custo cresce ~quadraticamente no comprimento da sessão.
→ /compact foco: <próximo passo>   (preserva mal sem o foco)
→ /handoff-sessao                  (1 entrega = 1 sessão — no 2º compact, prefira este)
(aviso não-bloqueante · medir: scripts/tokens-report.sh)"

ctx_agente="O contexto desta sessão chegou a ${ctx_k}k tokens (~${reqs} requests). Cada turno seguinte relê tudo isso, e o custo cresce quadraticamente no comprimento da sessão. Se a entrega atual estiver concluída, proponha ao Lucas encerrar aqui e abrir sessão nova com /handoff-sessao em vez de emendar a próxima tarefa. Se ainda está no meio de uma entrega, sugira '/compact foco: <próximo passo>'. Não interrompa trabalho em andamento por causa deste aviso — apenas proponha."

jq -n --arg m "$msg" --arg c "$ctx_agente" \
  '{systemMessage:$m, hookSpecificOutput:{hookEventName:"Stop", additionalContext:$c}}'
exit 0
