#!/usr/bin/env bash
# test-stop-contexto-caro.sh — TDD do hook .claude/hooks/stop-contexto-caro.sh
#
# Regra: contexto da sessão >= 150k tokens-OPUS → emite systemMessage (aviso), UMA
# VEZ por degrau (150/250/350/500/700k). Abaixo do degrau, transcript ausente ou
# sem usage → silêncio (exit 0). NUNCA bloqueia (não emite decision:block).
#
# O primeiro degrau era 250k e virou 150k em 2026-08-06: medido sobre dados já
# deduplicados, 250k avisava com 29,1% do custo da sessão JÁ gasto e deixava 16
# sessões caras mudas (5,3% da semana); 150k cobre 98,8% do custo, avisa com
# 16,2% gasto e o ruído medido é ZERO (nenhuma sessão trivial chega a 150k, pois
# o piso já é ~81k). Detalhe em docs/historico/piso-de-contexto.md.
#
# "tokens-OPUS" = o degrau é de CUSTO, não de token cru: o contexto é multiplicado
# pelo preço da família do modelo sobre o do Opus (a referência da calibração).
# Fable custa 2x → avisa na METADE do contexto (75k); Haiku custa 1/5 → 750k.
#
# Uso: bash scripts/test-stop-contexto-caro.sh   (exit 0 = verde)
set -u

here="$(cd "$(dirname "$0")" && pwd)"
HOOK="$here/../.claude/hooks/stop-contexto-caro.sh"
command -v jq >/dev/null 2>&1 || { echo "SKIP — jq ausente"; exit 0; }

tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
export TMPDIR="$tmp"          # isola as marcas de degrau deste teste

# transcript sintético: N linhas de usage, a última com o contexto alvo.
# $4 (modelo) é OPCIONAL: omitido, a linha sai sem o campo `model` — que é o caso
# real de um transcript sem modelo declarado e cai no preço de referência (Opus).
mk_transcript() {  # $1=arquivo  $2=cache_read da última linha  $3=nº de linhas  $4=modelo
  local f="$1" ctx="$2" n="${3:-3}" modelo="${4:-}" k=1 campo=""
  [ -n "$modelo" ] && campo="\"model\":\"$modelo\","
  : > "$f"
  while [ "$k" -lt "$n" ]; do
    printf '{"type":"assistant","message":{%s"usage":{"input_tokens":4,"cache_creation_input_tokens":100,"cache_read_input_tokens":1000}}}\n' "$campo" >> "$f"
    k=$(( k + 1 ))
  done
  printf '{"type":"assistant","message":{%s"usage":{"input_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":%s}}}\n' "$campo" "$ctx" >> "$f"
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
mk_transcript "$tmp/t5.jsonl" 149000 3
saida_abaixo="$(run "$tmp/t5.jsonl" s5)"
if [ -z "$saida_abaixo" ]
then ok "falsificação: 149k (1 abaixo do degrau) permanece em silêncio"
else bad "falsificação: avisou a 149k — o degrau não está sendo respeitado"; fi

# 10b. 150k e 250k são degraus SEPARADOS: cruzar o primeiro não consome o segundo.
#      Sem isto, colar um degrau novo no topo da escada poderia calar o antigo.
mk_transcript "$tmp/t6.jsonl" 160000 3
check "cruzou o degrau novo de 150k → avisa" msg "$(run "$tmp/t6.jsonl" s6)"
mk_transcript "$tmp/t7.jsonl" 260000 5
check "mesma sessão sobe 150k→250k → avisa DE NOVO (degraus separados)" msg "$(run "$tmp/t7.jsonl" s6)"

echo "== degrau normalizado por CUSTO (o degrau é em tokens-Opus) =="

# 11. Opus explícito: fator 1 → os degraus calibrados ficam INTACTOS (não-regressão)
mk_transcript "$tmp/o1.jsonl" 260000 5 claude-opus-5
check "opus 260k → avisa (fator 1, degrau intacto)" msg "$(run "$tmp/o1.jsonl" so1)"
mk_transcript "$tmp/o2.jsonl" 140000 5 claude-opus-5
check "opus 140k → silêncio (fator 1, degrau intacto)" silencio "$(run "$tmp/o2.jsonl" so2)"

# 12. Fable custa 2x → 80k de contexto = 160k tokens-Opus, cruza o degrau novo
mk_transcript "$tmp/f1.jsonl" 80000 5 claude-fable-5
out_fable="$(run "$tmp/f1.jsonl" sf1)"
check "fable 80k → avisa (=160k tokens-Opus, metade do caminho)" msg "$out_fable"

# 13. FALSIFICAÇÃO da normalização: 70k em Fable = 140k tokens-Opus, ABAIXO do
#     degrau. Sem a conversão o hook ficaria mudo aqui e no caso 12 — este par é
#     o que separa "normalizou por preço" de "só baixou o degrau para todo mundo".
#     O par está colado na fronteira (70k/80k) de propósito: é onde a conversão
#     decide, e um par frouxo passaria mesmo com o fator errado.
mk_transcript "$tmp/f2.jsonl" 70000 5 claude-fable-5
if [ -z "$(run "$tmp/f2.jsonl" sf2)" ]
then ok "falsificação: fable 70k (=140k tokens-Opus) permanece em silêncio"
else bad "falsificação: avisou a 70k em fable — o degrau virou 70k para todos"; fi

# 14. Haiku custa 1/5 do Opus → 600k de contexto ainda é só 120k tokens-Opus
mk_transcript "$tmp/h1.jsonl" 600000 5 claude-haiku-4-5-20251001
check "haiku 600k → silêncio (=120k tokens-Opus)" silencio "$(run "$tmp/h1.jsonl" sh1)"

echo "== custo estimado conta REQUEST, não linha do transcript =="

# Uma resposta com vários blocos vira várias linhas no JSONL repetindo o MESMO
# usage. O hook contava linhas (`grep -c '"usage"'`) e inflava o US$ em ~2,2x —
# a mesma dupla contagem que o tokens-report.sh tinha. Aqui: dois transcripts com
# o MESMO nº de linhas e o MESMO contexto, um com 1 requestId e outro com 12.
mk_req() {  # $1=arquivo $2=cache_read final $3=nº linhas $4=modo(mesmo|distinto)
  local f="$1" ctx="$2" n="$3" modo="$4" k=1 rid
  : > "$f"
  while [ "$k" -lt "$n" ]; do
    [ "$modo" = mesmo ] && rid="req_UNICO" || rid="req_$k"
    printf '{"type":"assistant","requestId":"%s","message":{"usage":{"input_tokens":4,"cache_creation_input_tokens":100,"cache_read_input_tokens":1000}}}\n' "$rid" >> "$f"
    k=$(( k + 1 ))
  done
  [ "$modo" = mesmo ] && rid="req_UNICO" || rid="req_FINAL"
  printf '{"type":"assistant","requestId":"%s","message":{"usage":{"input_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":%s}}}\n' "$rid" "$ctx" >> "$f"
}
usd() { printf '%s' "$1" | command grep -o 'US\$ [0-9]*' | command head -1 | command tr -cd '0-9'; }

mk_req "$tmp/r1.jsonl" 300000 12 mesmo
mk_req "$tmp/r2.jsonl" 300000 12 distinto
u1="$(usd "$(run "$tmp/r1.jsonl" sr1)")"
u2="$(usd "$(run "$tmp/r2.jsonl" sr2)")"
# 12 linhas / 1 request vs 12 linhas / 12 requests: o 2º tem de custar MAIS.
# Se o hook contasse linhas, os dois dariam o mesmo número.
if [ -n "$u1" ] && [ -n "$u2" ] && [ "$u2" -gt "$u1" ]; then
  ok "12 linhas com 1 requestId estimam MENOS que 12 requests distintos (US\$ $u1 < $u2)"
else
  bad "estimativa ignorou o requestId (US\$ '$u1' vs '$u2' — esperava o 1º menor)"
fi

# FALSIFICAÇÃO: transcript SEM requestId (formato antigo) não pode zerar o aviso
# — o fallback para contagem de linhas tem de manter a mensagem de pé.
mk_transcript "$tmp/r3.jsonl" 300000 12
if printf '%s' "$(run "$tmp/r3.jsonl" sr3)" | command grep -q 'systemMessage'; then
  ok "falsificação: transcript sem requestId ainda avisa (fallback de linhas)"
else
  bad "sem requestId o hook emudeceu — o fallback não segurou"
fi

echo "== nota de modelo (só quando o modelo custa mais que a referência) =="

if printf '%s' "$out_fable" | jq -e '.systemMessage | test("/model opus")' >/dev/null 2>&1
then ok "fable: mensagem oferece '/model opus'"
else bad "fable: mensagem não oferece a troca de modelo"; fi

if printf '%s' "$out_fable" | jq -e '.hookSpecificOutput.additionalContext | test("money-path")' >/dev/null 2>&1
then ok "fable: contexto do agente ressalva onde NÃO descer (money-path/auditoria)"
else bad "fable: contexto do agente não ressalva quando ficar em fable"; fi

# Em Opus a nota não pode aparecer — sugerir '/model opus' a quem já está nele é ruído
if printf '%s' "$(run "$tmp/o1.jsonl" so3)" | jq -e '.systemMessage | test("/model opus")' >/dev/null 2>&1
then bad "opus: sugeriu trocar para o modelo em que a sessão já está"
else ok "opus: sem nota de modelo (nada a trocar)"; fi

echo
if [ "$fail" -eq 0 ]; then echo "VERDE — todos os casos passaram"; exit 0; fi
echo "VERMELHO — ha casos falhando"; exit 1
