#!/usr/bin/env bash
# test-codex-async.sh — TDD do scripts/codex-async.sh com `codex` STUBADO (sem quota).
#
# Contrato testado: 0=parecer entregue · 64=uso errado · 69=binário ausente ·
# 75=cota esgotada (SEM retry) · 77=sem auth · retry só em transitório ·
# watchdog mata execução travada.
#
# Uso: bash scripts/test-codex-async.sh   (exit 0 = tudo verde)
set -u

here="$(cd "$(dirname "$0")" && pwd)"
ASYNC="$here/codex-async.sh"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin" "$tmp/codexhome_ok" "$tmp/codexhome_vazio"
: > "$tmp/codexhome_ok/auth.json"

# stub de codex: comportamento por CODEX_STUB_MODE; conta invocações em CODEX_STUB_COUNT
cat >"$tmp/bin/codex" <<'STUB'
#!/bin/sh
echo x >> "$CODEX_STUB_COUNT"
# stderr FIEL ao codex real (medido 2026-08-22, codex-cli 0.144.1): header, o PROMPT
# ECOADO sob "user", e só então as linhas ERROR:. O eco é o que envenena qualquer
# classificação feita sobre o arquivo cru.
for a in "$@"; do prompt="$a"; done
{ echo "OpenAI Codex v0.144.1"; echo "--------"; echo "model: stub"
  echo "sandbox: read-only"; echo "--------"; echo "user"; printf '%s\n' "$prompt"
  echo "warning: Model metadata for \`stub\` not found. Defaulting to fallback metadata."
} >&2
case "$CODEX_STUB_MODE" in
  ok)        echo "parecer: aprovado com ressalvas"; exit 0 ;;
  quota)     echo "You have reached your usage limit" >&2; exit 1 ;;
  modelo)    echo 'ERROR: {"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The '"'"'gpt-5.6-sol'"'"' model is not supported when using Codex with a ChatGPT account."}}' >&2; exit 1 ;;
  ratelimit) n=$(wc -l < "$CODEX_STUB_COUNT" | tr -d ' ')
             if [ "$n" -ge 2 ]; then echo "parecer pós-retry"; exit 0
             else echo "429 rate limit exceeded" >&2; exit 1; fi ;;
  # 400 permanente SEM marcador nenhum: nao casa cota, modelo, nem invalid_request_error.
  # E o unico caso em que so a REMOCAO DO ECO decide — por isso ele testa o bug original.
  generico400) echo 'ERROR: {"type":"error","status":400,"error":{"message":"malformed request"}}' >&2; exit 1 ;;
  # 400 permanente que NAO e cota nem modelo-recusado (repetir manda o mesmo request)
  permanente) echo 'ERROR: {"type":"error","status":400,"error":{"type":"invalid_request_error","message":"Unsupported parameter: reasoning.effort is not supported with this model."}}' >&2; exit 1 ;;
  # 5xx de VERDADE, em linha de ERRO: transitorio legitimo, tem de continuar retentando
  erro5xx)   n=$(wc -l < "$CODEX_STUB_COUNT" | tr -d ' ')
             if [ "$n" -ge 2 ]; then echo "parecer pos-503"; exit 0
             else echo 'ERROR: {"type":"error","status":503,"error":{"message":"upstream unavailable"}}' >&2; exit 1; fi ;;
  # numero 500-599 DENTRO da mensagem de erro, sem ser status HTTP (contagem de tokens).
  # Isola a ancora: aqui remover o eco do prompt nao salva — o "5120" esta na linha de ERRO.
  num5xx)    echo 'ERROR: {"type":"error","status":400,"error":{"type":"context_length_exceeded","message":"prompt has 5120 tokens; maximum for this model is 4096"}}' >&2; exit 1 ;;
  trava)     sleep 30 ;;
  *)         echo "erro desconhecido" >&2; exit 1 ;;
esac
STUB
chmod +x "$tmp/bin/codex"

fail=0
# ambiente controlado: PATH mínimo com o stub; sem env keys; backoffs zerados
run() {
  local mode="$1"; shift
  : > "$tmp/count"
  env -i PATH="$tmp/bin:/usr/bin:/bin" HOME="$HOME" TMPDIR="$tmp" \
    CODEX_HOME="$tmp/codexhome_ok" CODEX_STUB_MODE="$mode" CODEX_STUB_COUNT="$tmp/count" \
    CODEX_ASYNC_BACKOFFS="0 0 0" bash "$ASYNC" "$@" </dev/null
}
invocacoes() { wc -l < "$tmp/count" | tr -d ' '; }

caso_exit() { # nome want_exit rc
  if [ "$3" -eq "$2" ]; then echo "  ok    exit $3 | $1"
  else echo "  FAIL  want exit $2, got $3 | $1"; fail=1; fi
}

echo "── caminho feliz ──"
out="$(run ok "pergunta qualquer" 2>/dev/null)"; rc=$?
caso_exit "parecer entregue → 0" 0 "$rc"
if printf '%s' "$out" | grep -q "parecer: aprovado"; then echo "  ok    stdout contém o parecer"
else echo "  FAIL  parecer ausente do stdout"; fail=1; fi

echo "── preflight ──"
run ok 2>/dev/null; caso_exit "prompt vazio → 64" 64 $?
env -i PATH="/usr/bin:/bin" HOME="$HOME" TMPDIR="$tmp" bash "$ASYNC" "x" >/dev/null 2>&1
caso_exit "codex ausente do PATH → 69" 69 $?
env -i PATH="$tmp/bin:/usr/bin:/bin" HOME="$HOME" TMPDIR="$tmp" CODEX_HOME="$tmp/codexhome_vazio" \
  CODEX_STUB_MODE=ok CODEX_STUB_COUNT="$tmp/count" bash "$ASYNC" "x" >/dev/null 2>&1
caso_exit "sem auth (nem env, nem auth.json) → 77" 77 $?

echo "── cota e retry ──"
run quota "x" >/dev/null 2>&1; rc=$?
caso_exit "cota esgotada → 75" 75 "$rc"
if [ "$(invocacoes)" -eq 1 ]; then echo "  ok    cota NÃO faz retry (1 invocação)"
else echo "  FAIL  cota fez retry ($(invocacoes) invocações)"; fail=1; fi

echo "── modelo recusado pela conta ──"
# 400 do servidor quando o modelo do config não vale para a conta (2026-08-22: os 10
# nomes testados foram recusados, então NÃO é erro de digitação do nome — é direito de
# acesso). Antes caía no CODEX_FALHOU genérico: rc=1 e um tail de stderr, sem dizer o
# que fazer. Confundir com cota manda para o Caminho B, que é esperar — e esperar não
# conserta config.
saida=$(run modelo "x" 2>&1); rc=$?
caso_exit "modelo recusado → 78 (EX_CONFIG), não 75 nem 1" 78 "$rc"
if [ "$(invocacoes)" -eq 1 ]; then echo "  ok    modelo recusado NÃO faz retry (1 invocação)"
else echo "  FAIL  modelo recusado fez retry ($(invocacoes) invocações)"; fail=1; fi
case "$saida" in
  *MODELO_NAO_ACEITO*) echo "  ok    diagnóstico próprio (MODELO_NAO_ACEITO)" ;;
  *) echo "  FAIL  sem diagnóstico próprio: $(printf '%s' "$saida" | tr '\n' ' ' | cut -c1-90)"; fail=1 ;;
esac
case "$saida" in
  *"codex login"*|*config.toml*) echo "  ok    diz o que FAZER (login/config)" ;;
  *) echo "  FAIL  não instrui a ação"; fail=1 ;;
esac
case "$saida" in
  *Caminho\ B*) echo "  FAIL  mandou para o Caminho B (esperar não conserta config)"; fail=1 ;;
  *) echo "  ok    NÃO manda para o Caminho B" ;;
esac

out="$(run ratelimit "x" 2>/dev/null)"; rc=$?
caso_exit "rate limit transitório → retry → 0" 0 "$rc"
if [ "$(invocacoes)" -eq 2 ]; then echo "  ok    exatamente 1 retry (2 invocações)"
else echo "  FAIL  invocações=$(invocacoes), esperava 2"; fail=1; fi

echo "── classificação não pode ler o ECO DO PROMPT ──"
# O stderr do codex reimprime o prompt inteiro sob "user" (medido 2026-08-22). Classificar
# o arquivo CRU deixa o CONTEÚDO do prompt decidir o controle de fluxo — e o ritual /codex
# cola log, stderr e `cat -n` de arquivo dentro do prompt o tempo todo.

# (a) o CENÁRIO DO RELATO, tal como ocorreu: `5[0-9][0-9]` casava o número de linha de um
#     `cat -n` colado no prompt e um 400 que nunca mudaria queimava 3 tentativas + 80s.
#     Precisa das DUAS proteções para ficar verde (eco removido E 5xx ancorado) — sabotar
#     só uma delas não o derruba; por isso (b)/(c) e (e) existem, isolando cada camada.
prompt_numerado="revise este trecho:
   511	const a = 1;
   512	const b = 2;
   513	const c = 3;"
run generico400 "$prompt_numerado" >/dev/null 2>&1
if [ "$(invocacoes)" -eq 1 ]; then echo "  ok    400 permanente NÃO retenta (1 invocação)"
else echo "  FAIL  400 permanente retentou ($(invocacoes)x) — eco do prompt virou transitorio"; fail=1; fi

# (b) o inverso: prompt que FALA de cota, erro real transitório → tem de retentar
run ratelimit "por que deu 'You have reached your usage limit' ontem?" >/dev/null 2>&1; rc=$?
caso_exit "prompt citando cota + 429 real → retry → 0" 0 "$rc"
if [ "$(invocacoes)" -eq 2 ]; then echo "  ok    prompt citando cota não vira COTA_ESGOTADA"
else echo "  FAIL  invocações=$(invocacoes), esperava 2 — eco do prompt virou cota"; fail=1; fi

# (c) idem modelo: ESTE bug foi levado ao Codex com a frase dentro do prompt.
run ratelimit "o 400 diz: model is not supported when using Codex — o que eu faço?" >/dev/null 2>&1; rc=$?
caso_exit "prompt citando 'model is not supported' + 429 real → retry → 0" 0 "$rc"
if [ "$(invocacoes)" -eq 2 ]; then echo "  ok    prompt citando modelo não vira MODELO_NAO_ACEITO"
else echo "  FAIL  invocações=$(invocacoes), esperava 2 — eco do prompt virou modelo recusado"; fail=1; fi

# (d) não regredir: 5xx de VERDADE (em linha ERROR:) continua transitório
run erro5xx "x" >/dev/null 2>&1; rc=$?
caso_exit "503 real → retry → 0" 0 "$rc"
if [ "$(invocacoes)" -eq 2 ]; then echo "  ok    503 real ainda retenta (2 invocações)"
else echo "  FAIL  invocações=$(invocacoes), esperava 2 — perdeu o retry legítimo"; fail=1; fi

# (e2) o ramo do 400 de requisição inválida tem de DIZER o julgamento — um ramo que só
#      faz `break` é indistinguível do break final: ninguém lê, nenhum teste falsifica.
saida=$(run permanente "x" 2>&1)
case "$saida" in
  *ERRO_PERMANENTE*) echo "  ok    400 inválido diz que é permanente (não para em silêncio)" ;;
  *) echo "  FAIL  parou sem dizer o julgamento — indistinguível do break final"; fail=1 ;;
esac

# (e) a âncora do 5xx, isolada: tirar o eco do prompt NÃO cobre este caso — o número
#     500-599 está DENTRO da linha de erro ("5120 tokens"), e não é status HTTP nenhum.
run num5xx "x" >/dev/null 2>&1; rc=$?
if [ "$(invocacoes)" -eq 1 ]; then echo "  ok    5xx só conta ancorado em HTTP (1 invocação)"
else echo "  FAIL  invocações=$(invocacoes), esperava 1 — '5120 tokens' virou 'erro 5xx'"; fail=1; fi

# (f) o relatório de falha também não pode devolver o prompt: `tail` do stderr CRU
#     despeja o eco inteiro, que é exatamente o ruído que escondeu o 400 no diagnóstico.
saida=$(run generico400 "$prompt_numerado" 2>&1)
case "$saida" in
  *"const b = 2;"*) echo "  FAIL  CODEX_FALHOU devolveu o prompt ecoado no stderr"; fail=1 ;;
  *) echo "  ok    CODEX_FALHOU mostra o diagnóstico, não o eco do prompt" ;;
esac
case "$saida" in
  *"malformed request"*) echo "  ok    …e o motivo cru continua visível" ;;
  *) echo "  FAIL  perdeu o motivo cru do erro"; fail=1 ;;
esac

echo "── watchdog (execução travada) ──"
# -t 3, não -t 1: o stub conta a invocação na PRIMEIRA linha, mas sob swap (M2 8GB com
# vitest ao lado) o processo pode não ser escalonado a tempo e morrer antes de contar —
# visto 1× ao registrar esta suíte no CI, com invocações=2. O que se testa aqui é o
# watchdog matar e o kill contar como transitório, não a agilidade do escalonador.
run trava -t 3 "x" >/dev/null 2>&1; rc=$?
if [ "$rc" -ne 0 ] && [ "$rc" -ne 75 ]; then echo "  ok    exit $rc ≠ 0 (matou o processo travado)"
else echo "  FAIL  watchdog não matou (exit $rc)"; fail=1; fi
if [ "$(invocacoes)" -eq 3 ]; then echo "  ok    esgotou as 3 tentativas"
else echo "  FAIL  invocações=$(invocacoes), esperava 3"; fail=1; fi

echo
if [ "$fail" -eq 0 ]; then echo "PASS — todos os casos"; else echo "FALHOU"; fi
exit "$fail"
