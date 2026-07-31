#!/usr/bin/env bash
# test-stop-contexto-caro.sh — TDD do hook .claude/hooks/stop-contexto-caro.sh
#
# Regra: contexto da sessão >= 250k tokens → emite systemMessage (aviso), UMA VEZ
# por degrau (250/350/500/700k). Abaixo de 250k, transcript ausente ou sem usage
# → silêncio (exit 0). NUNCA bloqueia (não emite decision:block).
#
# Uso: bash scripts/test-stop-contexto-caro.sh   (exit 0 = verde)
set -u

here="$(cd "$(dirname "$0")" && pwd)"
HOOK="$here/../.claude/hooks/stop-contexto-caro.sh"
command -v jq >/dev/null 2>&1 || { echo "SKIP — jq ausente"; exit 0; }

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
export TMPDIR="$tmp"          # isola as marcas de degrau deste teste

# transcript sintético: N linhas de usage, a última com o contexto alvo
mk_transcript() {  # $1=arquivo  $2=cache_read da última linha  $3=nº de linhas
  local f="$1" ctx="$2" n="${3:-3}" k=1
  : > "$f"
  while [ "$k" -lt "$n" ]; do
    printf '{"type":"assistant","message":{"usage":{"input_tokens":4,"cache_creation_input_tokens":100,"cache_read_input_tokens":1000}}}\n' >> "$f"
    k=$(( k + 1 ))
  done
  printf '{"type":"assistant","message":{"usage":{"input_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":%s}}}\n' "$ctx" >> "$f"
}

run() {  # $1=transcript  $2=session_id
  jq -nc --arg t "$1" --arg s "$2" \
    '{hook_event_name:"Stop", transcript_path:$t, session_id:$s}' | bash "$HOOK" 2>/dev/null
}

fail=0
ok()   { printf '  \033[32mok\033[0m   %s\n' "$1"; }
bad()  { printf '  \033[31mFALHA\033[0m %s\n' "$1"; fail=1; }
check(){ # $1=descrição $2=esperado(msg|silencio) $3=saída
  local desc="$1" esp="$2" out="$3"
  case "$esp" in
    msg)
      if printf '%s' "$out" | command grep -q 'systemMessage'; then ok "$desc"
      else bad "$desc (esperava aviso, veio: '${out:0:60}')"; fi ;;
    silencio)
      if [ -z "$out" ]; then ok "$desc"
      else bad "$desc (esperava silêncio, veio: '${out:0:60}')"; fi ;;
  esac
}

echo "== stop-contexto-caro =="

# 1. abaixo do primeiro degrau → silêncio
mk_transcript "$tmp/t1.jsonl" 100000 3
check "contexto 100k → silêncio" silencio "$(run "$tmp/t1.jsonl" s1)"

# 2. cruzou 250k → avisa
mk_transcript "$tmp/t2.jsonl" 260000 5
out2="$(run "$tmp/t2.jsonl" s2)"
check "contexto 260k → avisa" msg "$out2"

# 3. JSON de saída é válido e bem-formado (printf, não echo: echo interpreta o \n
#    escapado e corrompe o JSON — armadilha registrada no CLAUDE.md)
if printf '%s' "$out2" | jq -e '.systemMessage and .hookSpecificOutput.additionalContext' >/dev/null 2>&1
then ok "JSON válido com systemMessage + additionalContext"
else bad "JSON inválido ou incompleto"; fi

if printf '%s' "$out2" | jq -e '.hookSpecificOutput.hookEventName == "Stop"' >/dev/null 2>&1
then ok "hookEventName = Stop"
else bad "hookEventName errado"; fi

# 4. NUNCA bloqueia
if printf '%s' "$out2" | command grep -q '"decision"'
then bad "emitiu decision (não pode bloquear)"
else ok "não bloqueia"; fi

# 5. mesmo degrau de novo → silêncio (não repete a cada turno)
check "mesmo degrau, 2ª vez → silêncio" silencio "$(run "$tmp/t2.jsonl" s2)"

# 6. subiu de degrau (260k → 520k) → avisa de novo
mk_transcript "$tmp/t3.jsonl" 520000 9
check "subiu para 520k → avisa de novo" msg "$(run "$tmp/t3.jsonl" s2)"

# 7. sessão DIFERENTE no mesmo degrau → avisa (marca é por sessão)
check "outra sessão, 260k → avisa" msg "$(run "$tmp/t2.jsonl" s99)"

# 8. transcript inexistente → silêncio
check "transcript ausente → silêncio" silencio "$(run "$tmp/nao-existe.jsonl" s3)"

# 9. transcript sem nenhum usage → silêncio
printf '{"type":"user","message":{"content":"oi"}}\n' > "$tmp/t4.jsonl"
check "transcript sem usage → silêncio" silencio "$(run "$tmp/t4.jsonl" s4)"

# 10. FALSIFICAÇÃO — o teste precisa saber ficar vermelho. Um hook que avisasse
#     SEMPRE passaria nos casos 2/6/7; é o caso 1 (silêncio abaixo do degrau)
#     que separa "funciona" de "grita sempre". Confirma que aquele caso é real:
mk_transcript "$tmp/t5.jsonl" 249000 3
saida_abaixo="$(run "$tmp/t5.jsonl" s5)"
if [ -z "$saida_abaixo" ]
then ok "falsificação: 249k (1 abaixo do degrau) permanece em silêncio"
else bad "falsificação: avisou a 249k — o degrau não está sendo respeitado"; fi

echo
if [ "$fail" -eq 0 ]; then echo "VERDE — todos os casos passaram"; exit 0; fi
echo "VERMELHO — ha casos falhando"; exit 1
