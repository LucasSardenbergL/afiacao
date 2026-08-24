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
mkdir -p "$tmp/bin" "$tmp/codexhome_ok" "$tmp/codexhome_vazio" "$tmp/codexhome_free" "$tmp/codexhome_pago"
: > "$tmp/codexhome_ok/auth.json"

# auth.json com JWT FALSO carregando só o claim do plano (nada de segredo — o payload de um
# JWT é base64, não cifra). Serve para provar que a mensagem de cota LÊ o plano declarado.
jwt_com_plano() { # plano → token falso `header.payload.assinatura`
  local payload
  payload=$(printf '{"https://api.openai.com/auth":{"chatgpt_plan_type":"%s"}}' "$1" \
    | openssl base64 -A | tr '+/' '-_' | tr -d '=')
  printf 'ZmFrZQ.%s.assinatura-irrelevante' "$payload"
}
printf '{"tokens":{"access_token":"%s"}}' "$(jwt_com_plano free)"    > "$tmp/codexhome_free/auth.json"
printf '{"tokens":{"access_token":"%s"}}' "$(jwt_com_plano prolite)" > "$tmp/codexhome_pago/auth.json"

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
  # mensagem REAL medida 2026-08-22 (vem prefixada com ERROR:, ao contrario do que o stub
  # anterior supunha) — o texto e literal do servidor.
  quota)     echo "ERROR: You've hit your usage limit. To continue using Codex and get access to GPT-5.3-Codex, start a free trial of Plus today (https://chatgpt.com/explore/plus), or try again at Sep 20th, 2026 10:37 PM." >&2; exit 1 ;;
  # variante SEM prefixo: o classificador nao pode depender de conhecer o vocabulario de
  # prefixos do codex-cli, que muda entre versoes.
  quota_sem_prefixo) echo "You have reached your usage limit" >&2; exit 1 ;;
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
# igual ao run(), mas com CODEX_HOME escolhido (para variar o plano declarado no token)
run_home() {
  local home="$1" mode="$2"; shift 2
  : > "$tmp/count"
  env -i PATH="$tmp/bin:/usr/bin:/bin" HOME="$HOME" TMPDIR="$tmp" \
    CODEX_HOME="$tmp/$home" CODEX_STUB_MODE="$mode" CODEX_STUB_COUNT="$tmp/count" \
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
run quota_sem_prefixo "x" >/dev/null 2>&1
caso_exit "cota SEM prefixo ERROR: também vira 75" 75 $?

echo "── cota: suspeitar do TOKEN antes de aceitar o limite ──"
# 2026-08-23: o COTA_ESGOTADA mandou esperar até 20/09 — mas a "cota" era a do plano FREE
# que um token congelado declarava, numa conta paga. Relogar devolveu tudo. A mensagem tem
# de mostrar o plano DECLARADO no token e mandar conferi-lo antes de aceitar o limite.
saida=$(run_home codexhome_free quota "x" 2>&1); rc=$?
caso_exit "cota continua 75" 75 "$rc"
case "$saida" in
  *free*) echo "  ok    mostra o plano declarado no token (free)" ;;
  *) echo "  FAIL  não mostra o plano — o humano não vê que o token está rebaixado"; fail=1 ;;
esac
case "$saida" in
  *logout*) echo "  ok    plano rebaixado → manda REEMITIR o token (logout+login)" ;;
  *) echo "  FAIL  não manda relogar: repete o erro que custou 2 dias"; fail=1 ;;
esac

saida=$(run_home codexhome_pago quota "x" 2>&1)
case "$saida" in
  *prolite*) echo "  ok    plano pago é mostrado tal como declarado" ;;
  *) echo "  FAIL  não mostra o plano pago"; fail=1 ;;
esac
case "$saida" in
  *Caminho\ B*) echo "  ok    plano confere → Caminho B (aí sim o limite é real)" ;;
  *) echo "  FAIL  perdeu o Caminho B no caso em que ele é a ação certa"; fail=1 ;;
esac

# sensor ausente degrada (auth.json sem JWT legível) — mensagem informativa, não guard
saida=$(run_home codexhome_ok quota "x" 2>&1)
case "$saida" in
  *desconhecido*) echo "  ok    plano ilegível → 'desconhecido', sem fingir que leu" ;;
  *) echo "  FAIL  não degradou o sensor de plano"; fail=1 ;;
esac

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
# 2026-08-23: o 400 de modelo NÃO era direito de acesso — era o `plan_type` CONGELADO num
# token velho (dizia `free`; a conta é paga). `terra`/`luna` respondiam, então a heurística
# "se algum modelo passa, o login está OK" deu o login por bom e mandou trocar de modelo.
# Trocar o modelo "resolveu" o sintoma e escondeu a causa por 2 dias. A mensagem tem de
# oferecer a hipótese barata de verificar.
case "$saida" in
  *logout*) echo "  ok    oferece a hipótese do token/plano congelado (logout+login)" ;;
  *) echo "  FAIL  não cita relogin — a causa real de 2026-08-23 fica invisível"; fail=1 ;;
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

# (h) por que a correção tira o ECO em vez de casar só linhas `ERROR:` — a alternativa
#     óbvia. Prompts do ritual colam stderr de erro o tempo todo, e essas linhas COMEÇAM
#     com "ERROR:": um filtro por prefixo deixaria o veneno passar inteiro. (A justificativa
#     anterior aqui dizia que a mensagem de cota não vinha prefixada; medição de 2026-08-22
#     mostrou que VEM — o argumento estava errado, a decisão continua certa por este outro.)
run ratelimit "diagnostique este log que colei:
ERROR: You've hit your usage limit. Try again at Sep 20th.
o que houve?" >/dev/null 2>&1
caso_exit "prompt com LINHA 'ERROR: ...usage limit' + 429 real → retry → 0" 0 $?
if [ "$(invocacoes)" -eq 2 ]; then echo "  ok    filtro por prefixo não bastaria — o eco tem de sair"
else echo "  FAIL  invocações=$(invocacoes), esperava 2"; fail=1; fi

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

# (g) prompt GRANDE: tirar o eco não pode ser O(n·m). Medido 2026-08-22 no macOS com um
#     prompt de 5.000 linhas: `grep -Fvxf` (BSD grep) levou 29s POR TENTATIVA — 3 tentativas
#     = ~2min de espera antes de o ritual sequer reportar o erro. O ugrep e o GNU grep do CI
#     resolvem na hora, então a lentidão seria INVISÍVEL no CI e só doeria na máquina do
#     founder. `awk` com hash é O(n+m): <1s. O teto de 20s abaixo é folgado de propósito —
#     é guarda contra a regressão catastrófica, não benchmark.
prompt_grande=$(awk 'BEGIN{for(i=1;i<=5000;i++) printf "%6d\tlinha de codigo %d;\n", i, i}')
t0=$(date +%s)
saida=$(run generico400 "$prompt_grande" 2>&1)
gasto=$(( $(date +%s) - t0 ))
if [ "$gasto" -le 20 ]; then echo "  ok    prompt de 5k linhas classificado em ${gasto}s (teto 20s)"
else echo "  FAIL  ${gasto}s para um prompt de 5k linhas — remoção do eco virou O(n*m)"; fail=1; fi
case "$saida" in
  *"linha de codigo 512"*) echo "  FAIL  vazou o prompt grande na saída"; fail=1 ;;
  *) echo "  ok    …e sem vazar o prompt na saída" ;;
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
