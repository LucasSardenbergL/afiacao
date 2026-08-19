#!/usr/bin/env bash
# edge-guardrail-nudge.sh — PreToolUse(Write|Edit): quem LÊ esta edge?
#
# Ao editar arquivo sob supabase/functions/, injeta a lista dos guardrails de FORMA do vitest que
# leem AQUELE arquivo como texto (motor: scripts/edges-guardrails-afetados.ts).
#
# A classe (PR #1772): a sonda de versão em 5 edges saiu com os TRÊS comandos de edge verdes —
# `test:edges`, `edges:typecheck` e `bun lint`, exit 0 capturado em cada um — e o `validate`
# vermelho. Quem reprovou foi `src/__tests__/edge-money-path-invariants.test.ts`, que lê
# `supabase/functions/omie-cliente/index.ts` como TEXTO. "Comando por tecnologia" é um mapa errado
# do CI: a pergunta não é qual runtime é este arquivo, é quem o LÊ. O #1777 registrou a regra em
# texto; pela meta-regra do /matar-classe, contramedida textual reincide e gate estrutural para.
#
# Só AVISA — nunca nega. O CI já pega (foi ele que reprovou o #1772); o buraco fechado aqui é o
# LOOP DE FEEDBACK LOCAL, descobrir antes do push em vez de depois.
#
# Escopo estreito: só tool Write/Edit COM file_path sob supabase/functions/. `menção ≠ edição` —
# um comando Bash que cita o path (heredoc, grep) não passa pelo matcher e, se passasse, morre na
# checagem de tool_name (a armadilha do #1778, onde o heavy-guard casou padrão DENTRO de heredoc e
# gravou `heavy` no ci.yml). Uma vez por (sessão, arquivo): nudge repetido vira ruído, e gate que
# vira ruído morre. Fail-open: sem jq/bun, ou motor mudo → exit 0.
# Testes em scripts/test-edge-guardrail-nudge.sh.
set -u

# ANTES de qualquer coisa (inclusive do `cat` do stdin, que é externo): sem as ferramentas não há
# o que fazer com segurança → no-op.
command -v jq >/dev/null 2>&1 || exit 0
command -v bun >/dev/null 2>&1 || exit 0

entrada="$(cat)"

# uma única chamada de jq (cada `printf | jq` custa um fork ~10ms; este hook roda a cada edição)
campos="$(printf '%s' "$entrada" | jq -r '[(.tool_name // ""), (.session_id // "sem-id"),
  (.tool_input.file_path // "")] | @tsv' 2>/dev/null)"
[ -n "$campos" ] || exit 0
IFS="$(printf '\t')" read -r tool sessao arquivo <<EOF
$campos
EOF

# defesa se o matcher do settings.json mudar: só EDIÇÃO conta. Ler/citar/gravar-em-texto não é
# editar a edge — é exatamente a confusão que quebrou o CI no #1778.
case "$tool" in Write | Edit | MultiEdit) ;; *) exit 0 ;; esac
case "${arquivo:-}" in
  */supabase/functions/* | supabase/functions/*) ;;
  *) exit 0 ;;
esac

# marca da sessão: um aviso por arquivo. Gravada ANTES de chamar o motor — a semântica é "já
# processei este arquivo nesta sessão", e assim edição repetida nem paga o fork do bun.
sessao="$(printf '%s' "$sessao" | tr -c 'A-Za-z0-9._-' '_')"
marca="${TMPDIR:-/tmp}/afiacao-edgeguard-${sessao}"
chave="${arquivo#*supabase/functions/}"
if [ -f "$marca" ] && command grep -Fxq -- "$chave" "$marca" 2>/dev/null; then exit 0; fi
printf '%s\n' "$chave" >> "$marca" 2>/dev/null || true

raiz="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"
motor="$raiz/scripts/edges-guardrails-afetados.ts"
[ -f "$motor" ] || exit 0

ctx="$(bun "$motor" "$arquivo" 2>/dev/null)"
[ -n "$ctx" ] || exit 0   # nenhum guardrail alcança este arquivo → nada a dizer

# systemMessage curto (é o que o founder lê na linha do hook); o texto completo vai no contexto.
curto="${arquivo%/*}"; curto="${curto##*/}/${arquivo##*/}"
# a contagem sai da 1ª linha do motor ("GUARDRAIL-DE-FORMA: N teste(s) …"), não de contar as linhas
# listadas: a lista trunca em 8 + uma linha de resumo, então contá-las diria "9" para 20 guardrails.
# Expansão de parâmetro, sem fork e sem depender de caractere não-ASCII em locale nenhum.
primeira="${ctx%%$'\n'*}"; qtd="${primeira#*: }"; qtd="${qtd%% *}"
case "$qtd" in '' | *[!0-9]*) qtd='?' ;; esac
msg="🧪 $qtd guardrail(s) de FORMA do vitest leem $curto — rode-os antes de entregar (o test:edges/edges:typecheck/lint não os cobre)"

jq -n --arg m "$msg" --arg c "$ctx" \
  '{systemMessage:$m, hookSpecificOutput:{hookEventName:"PreToolUse", additionalContext:$c}}'
exit 0
