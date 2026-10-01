#!/usr/bin/env bash
# test-instrucoes-carregadas.sh — o sensor de InstructionsLoaded (.claude/hooks/instrucoes-carregadas.sh).
#
# Por quê: era o ÚNICO hook ligado no settings.json sem suíte que o executasse (medido em
# 2026-09-27: 21 ligados, 20 cobertos). O check-gstack.sh passou 136 dias na mesma condição sem
# negar nada (docs/historico/gate-gstack-fail-open.md), e desde então o `gates:frescura` reprova
# HOOK-SEM-TESTE. Este sensor alimenta scripts/instrucoes-relatorio.sh — a medição que decide o
# split do CLAUDE.md —, então um campo renomeado, um null virando 0 ou um evento perdido em
# silêncio mudam a resposta sem ninguém ver.
#
# Hermético: HOME sintético, log sintético (AFIACAO_INSTR_LOG) e payload sintético. Nunca o
# ~/.config/afiacao real: lá o log acumula eventos de verdade, e um caso "grava 1 linha" ficaria
# verde ou vermelho pelo histórico da máquina, não pelo sensor.
#
# Uso: bash scripts/test-instrucoes-carregadas.sh              (exit 0 = verde · 1 = asserção · 2 = infra)
#      bash scripts/test-instrucoes-carregadas.sh --falsificar (sabota CÓPIAS do sensor; exige vermelho)
#
# Marcadores ASCII de caixa fixa, casados com grep -F e sem -i; a falsificação roda nos DOIS
# locales (LC_ALL=C e um UTF-8 achado por sonda positiva), porque falsificar num só não prova (#1483).
set -u

here="$(cd "$(dirname "$0")" && pwd)"
HOOK="${INSTR_HOOK:-$here/../.claude/hooks/instrucoes-carregadas.sh}"
RELATORIO="$here/instrucoes-relatorio.sh"

command -v jq >/dev/null 2>&1 || { echo "INFRA: jq ausente — nao da para ler o log"; exit 2; }
[ -f "$HOOK" ] || { echo "INFRA: sensor nao encontrado em $HOOK"; exit 2; }
[ -f "$RELATORIO" ] || { echo "INFRA: relatorio nao encontrado em $RELATORIO"; exit 2; }

tmp="$(mktemp -d)" || exit 2
trap 'rm -rf "$tmp"' EXIT

# ── falsificação ───────────────────────────────────────────────────────────────────────────────
# O CONTROLE roda a MESMA suíte (recursão com o override INSTR_HOOK) sobre o sensor REAL, e vem
# antes de cada sabotagem: uma suíte sempre-vermelha aprovaria todas elas sem provar nada
# (docs/historico/falsificacao-sem-linha-de-base.md). Cada sabotagem tem de sair com exit 1 E com
# FAIL no caso que ela mira — exit 2 é infra (não conta como detecção), e um FAIL em outro caso
# qualquer não prova que o caso-alvo tem dente. Cada uma é uma regressão que o próprio sensor
# documenta ter sofrido ou evitado (os comentários dele contam a história).
if [ "${1:-}" = "--falsificar" ]; then
  utf8=""
  for cand in pt_BR.UTF-8 pt_BR.utf8 en_US.UTF-8 en_US.utf8 C.UTF-8 C.utf8; do
    if [ "$(LC_ALL="$cand" locale charmap 2>/dev/null)" = "UTF-8" ]; then utf8="$cand"; break; fi
  done
  if [ -z "$utf8" ]; then
    echo "ABORTA — nenhum locale UTF-8 neste ambiente; metade da falsificacao nao rodaria."; exit 1
  fi

  falhas=0
  controle() {
    local saida rc
    saida="$(LC_ALL="$1" INSTR_HOOK="$HOOK" bash "$0" 2>&1)"; rc=$?
    if [ "$rc" -ne 0 ]; then
      printf 'ABORTA — controle nao esta verde (LC_ALL=%s, rc=%s). Sabotar agora aprovaria qualquer coisa.\n%s\n' "$1" "$rc" "$saida"
      exit 1
    fi
  }
  # sabotar <id> <caso-alvo> <descricao> <sed-script>
  sabotar() {
    local id="$1" alvo="$2" desc="$3" sedscr="$4" copia="$tmp/sabotado-$1.sh" saida rc
    sed "$sedscr" "$HOOK" > "$copia"
    if cmp -s "$HOOK" "$copia"; then
      printf '  ❌ %s: a sabotagem nao mudou nada (alvo do sed sumiu do sensor?) — no-op nao prova nada\n' "$id"
      falhas=$((falhas + 1)); return
    fi
    saida="$(LC_ALL="$LOC" INSTR_HOOK="$copia" bash "$0" 2>&1)"; rc=$?
    if [ "$rc" -eq 1 ] && printf '%s\n' "$saida" | grep -F "FAIL [$alvo]" >/dev/null; then
      printf '  ✅ %s %s -> vermelho em [%s] (LC_ALL=%s)\n' "$id" "$desc" "$alvo" "$LOC"
    else
      printf '  ❌ %s %s: esperava exit 1 com FAIL [%s]; veio rc=%s\n%s\n' "$id" "$desc" "$alvo" "$rc" "$saida"
      falhas=$((falhas + 1))
    fi
  }

  # shellcheck disable=SC2016  # os `$` dos scripts de sed são TEXTO do sensor a casar, não expansão
  for LOC in C "$utf8"; do
    printf '== falsificacao (LC_ALL=%s) ==\n' "$LOC"
    controle "$LOC"
    sabotar S1 C1 'o log vai para um caminho que o relatorio nao le' 's|instrucoes-carregadas.jsonl}"|outro.jsonl}"|'
    controle "$LOC"
    sabotar S2 C5 'ausente vira zero (o 0 de "nao consegui ler")' 's|^bytes_arquivo=null|bytes_arquivo=0|'
    controle "$LOC"
    sabotar S3 C7 'default "principal" rotula como observado o que nao foi' 's|(.agent_type // null)|(.agent_type // "principal")|'
    controle "$LOC"
    sabotar S4 C8 'chars fabricado: 0 quando o payload nao traz file_content' 's#if has("file_content") then (.file_content|length) else null end#((.file_content // "")|length)#'
    controle "$LOC"
    sabotar S5 C10 'payload invalido some calado (sem a linha jq-falhou)' '/"erro":"jq-falhou"/s/.*/  :/'
    controle "$LOC"
    sabotar S6 C11 'o ramo jq-ausente e pulado' 's|if ! command -v jq >/dev/null 2>&1; then|if false; then|'
    controle "$LOC"
    sabotar S7 C13 'o log e SOBRESCRITO a cada evento' 's| >>"\$LOG" 2>/dev/null; then| >"\$LOG" 2>/dev/null; then|'
    controle "$LOC"
    sabotar S8 C4 'o peso medido nao chega ao log' 's|--argjson bytes "\$bytes_arquivo"|--argjson bytes null|'
    controle "$LOC"
    sabotar S9 C6 'arquivo vazio tratado como ausente' 's|\[ -f "\$fp" \]|[ -s "$fp" ]|'
    controle "$LOC"
    sabotar S10 C14 'o campo muda de nome e o relatorio deixa de acha-lo' 's|bytes_arquivo: \$bytes,|bytes: $bytes,|'
  done

  echo
  if [ "$falhas" -eq 0 ]; then echo "✅ falsificacao: cada caso-alvo reprova a sua sabotagem, nos 2 locales"; exit 0; fi
  echo "❌ falsificacao: $falhas sabotagem(ns) sem vermelho no caso-alvo"; exit 1
fi

# ── suíte ──────────────────────────────────────────────────────────────────────────────────────
fail=0
ok()   { printf '  ok   [%s] %s\n' "$1" "$2"; }
ruim() { printf '  FAIL [%s] %s\n' "$1" "$2"; fail=1; }
tem()  { printf '%s' "$1" | grep -F -- "$2" >/dev/null; }

# Os arquivos que o payload aponta: o sensor mede o peso do DISCO (o payload nunca traz o conteúdo).
F_TEXTO="$tmp/fixtures/CLAUDE.md"; F_VAZIO="$tmp/fixtures/vazio.md"; F_AUSENTE="$tmp/fixtures/nao-existe.md"
mkdir -p "$tmp/fixtures" "$tmp/logs"
printf 'um dois tres\nquatro\n' > "$F_TEXTO"   # 20 bytes, 4 palavras — ASCII: igual em C e em UTF-8
: > "$F_VAZIO"

# payload <sessao> <arquivo> [json-extra] → a entrada que o harness manda no stdin
payload() {
  local extra="${3:-}"
  [ -n "$extra" ] || extra='{}'
  jq -cn --arg s "$1" --arg f "$2" --argjson extra "$extra" \
    '{session_id: $s, cwd: "/repo", hook_event_name: "InstructionsLoaded", load_reason: "session_start", file_path: $f} + $extra'
}

# rodar <home> <log> <entrada> → $out (stdout) e $rc. log "-" = sem AFIACAO_INSTR_LOG (caminho padrão).
rodar() {
  if [ "$2" = - ]; then
    out="$(printf '%s' "$3" | env -u AFIACAO_INSTR_LOG HOME="$1" bash "$HOOK" 2>/dev/null)"; rc=$?
  else
    out="$(printf '%s' "$3" | env AFIACAO_INSTR_LOG="$2" HOME="$1" bash "$HOOK" 2>/dev/null)"; rc=$?
  fi
}
# Contrato comum a TODO caso: o sensor sai 0 e não escreve nada no stdout — ele só grava no log.
contrato() {
  if [ "$rc" -eq 0 ] && [ -z "$out" ]; then return 0; fi
  ruim "$1" "contrato quebrado: esperava rc=0 e stdout vazio (rc=$rc, stdout=$out)"; return 1
}
linhas() { if [ -f "$1" ]; then wc -l < "$1" | tr -d ' '; else echo 0; fi; }
# campo <log> <n-da-linha> <filtro-jq> → o valor em JSON compacto (string vem COM aspas; null é null)
campo() { sed -n "${2}p" "$1" 2>/dev/null | jq -c "$3" 2>/dev/null; }

HOME_A="$tmp/home-a"; HOME_B="$tmp/home-b"; mkdir -p "$HOME_A" "$HOME_B"
L_PADRAO="$HOME_A/.config/afiacao/instrucoes-carregadas.jsonl"

echo "── instrucoes-carregadas.sh ──"

# C1 caminho PADRÃO — o mesmo que o relatório lê: HOME sem ~/.config, o sensor cria o diretório e
# grava UMA linha JSON.
rodar "$HOME_A" - "$(payload s-1 "$F_TEXTO")"
if contrato C1; then
  if [ "$(linhas "$L_PADRAO")" = 1 ] && [ "$(campo "$L_PADRAO" 1 'type')" = '"object"' ]; then
    ok C1 'caminho padrao -> cria ~/.config/afiacao e grava 1 linha JSON'
  else ruim C1 "esperava 1 linha JSON em $L_PADRAO (linhas=$(linhas "$L_PADRAO"))"; fi
fi

# C2 AFIACAO_INSTR_LOG manda — e o HOME fica intocado.
L2="$tmp/logs/c2.jsonl"
rodar "$HOME_B" "$L2" "$(payload s-2 "$F_TEXTO")"
if contrato C2; then
  if [ "$(linhas "$L2")" = 1 ] && [ ! -e "$HOME_B/.config/afiacao/instrucoes-carregadas.jsonl" ]; then
    ok C2 'AFIACAO_INSTR_LOG -> grava ali, e nao no HOME'
  else ruim C2 "esperava 1 linha em $L2 e nada no HOME (linhas=$(linhas "$L2"))"; fi
fi

# C3 identidade do evento: os campos que o relatório agrupa, e `campos` = as chaves REAIS do payload.
if [ "$(campo "$L_PADRAO" 1 .motivo)" = '"session_start"' ] && [ "$(campo "$L_PADRAO" 1 .arquivo)" = "\"$F_TEXTO\"" ] \
   && [ "$(campo "$L_PADRAO" 1 .sessao)" = '"s-1"' ] && [ "$(campo "$L_PADRAO" 1 .cwd)" = '"/repo"' ] \
   && campo "$L_PADRAO" 1 .ts | grep -Eq '^"[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z"$' \
   && [ "$(campo "$L_PADRAO" 1 .campos)" = '"cwd,file_path,hook_event_name,load_reason,session_id"' ]; then
  ok C3 'motivo, arquivo, sessao, cwd, ts UTC e as chaves reais do payload'
else ruim C3 "identidade do evento errada: $(sed -n 1p "$L_PADRAO" 2>/dev/null)"; fi

# C4 peso medido do DISCO, como NÚMERO (o relatório ordena por `-(.b)`; string quebraria a conta).
if [ "$(campo "$L_PADRAO" 1 .bytes_arquivo)" = 20 ] && [ "$(campo "$L_PADRAO" 1 .palavras_arquivo)" = 4 ]; then
  ok C4 'peso do disco como numero: 20 bytes, 4 palavras'
else ruim C4 "esperava bytes_arquivo=20 e palavras_arquivo=4: $(sed -n 1p "$L_PADRAO" 2>/dev/null)"; fi

# C5 ausente ≠ zero: arquivo que não existe não pesa 0 — pesa "não sei".
L5="$tmp/logs/c5.jsonl"
rodar "$HOME_B" "$L5" "$(payload s-5 "$F_AUSENTE")"
if contrato C5; then
  if [ "$(campo "$L5" 1 .bytes_arquivo)" = null ] && [ "$(campo "$L5" 1 .palavras_arquivo)" = null ] \
     && [ "$(campo "$L5" 1 .erro)" = null ] && [ "$(campo "$L5" 1 .arquivo)" = "\"$F_AUSENTE\"" ]; then
    ok C5 'arquivo inexistente -> peso null, nunca 0 (ausente != zero)'
  else ruim C5 "esperava peso null para arquivo inexistente: $(cat "$L5" 2>/dev/null)"; fi
fi

# C6 o 0 MEDIDO é a resposta certa: o que se recusa é o 0 que veio de erro, não o de arquivo vazio.
L6="$tmp/logs/c6.jsonl"
rodar "$HOME_B" "$L6" "$(payload s-6 "$F_VAZIO")"
if contrato C6; then
  if [ "$(campo "$L6" 1 .bytes_arquivo)" = 0 ] && [ "$(campo "$L6" 1 .palavras_arquivo)" = 0 ]; then
    ok C6 'arquivo vazio -> 0 medido (e nao null)'
  else ruim C6 "esperava bytes_arquivo=0 e palavras_arquivo=0: $(cat "$L6" 2>/dev/null)"; fi
fi

# C7 sem agent_type o agente é null e a FONTE diz "ausente" — nunca o default "principal", que
# rotulava como observação o que nunca foi observado (o sensor é cego a subagente, medido).
if [ "$(campo "$L_PADRAO" 1 .agente)" = null ] && [ "$(campo "$L_PADRAO" 1 .agente_fonte)" = '"ausente"' ] \
   && [ "$(campo "$L_PADRAO" 1 .agent_id)" = null ]; then
  ok C7 'sem agent_type -> agente null, agente_fonte "ausente"'
else ruim C7 "esperava agente null e agente_fonte \"ausente\": $(sed -n 1p "$L_PADRAO" 2>/dev/null)"; fi

# C8 sem file_content, chars é null — `(.file_content // "") | length` gravava a MEDIDA 0.
if [ "$(campo "$L_PADRAO" 1 .chars)" = null ]; then
  ok C8 'sem file_content -> chars null, nunca 0'
else ruim C8 "esperava chars null: $(sed -n 1p "$L_PADRAO" 2>/dev/null)"; fi

# C9 quando o payload TRAZ os campos, o sensor os registra — e diz de onde vieram.
L9="$tmp/logs/c9.jsonl"
rodar "$HOME_B" "$L9" "$(payload s-9 "$F_TEXTO" '{"agent_type":"Explore","agent_id":"ag-9","file_content":"abcde"}')"
if contrato C9; then
  if [ "$(campo "$L9" 1 .agente)" = '"Explore"' ] && [ "$(campo "$L9" 1 .agente_fonte)" = '"payload"' ] \
     && [ "$(campo "$L9" 1 .agent_id)" = '"ag-9"' ] && [ "$(campo "$L9" 1 .chars)" = 5 ]; then
    ok C9 'com agent_type e file_content -> registra ambos, fonte "payload"'
  else ruim C9 "esperava agente Explore, fonte payload, chars 5: $(cat "$L9" 2>/dev/null)"; fi
fi

# C10 payload que não é JSON: o sensor NÃO some calado — grava o erro, e só ele.
L10="$tmp/logs/c10.jsonl"
rodar "$HOME_B" "$L10" 'isto nao e json {'
if contrato C10; then
  if [ "$(linhas "$L10")" = 1 ] && [ "$(campo "$L10" 1 .erro)" = '"jq-falhou"' ]; then
    ok C10 'payload invalido -> 1 linha com erro jq-falhou'
  else ruim C10 "esperava exatamente 1 linha com erro jq-falhou: $(cat "$L10" 2>/dev/null)"; fi
fi

# C11 sem jq: log vazio tem de significar "nada carregou", nunca "sensor quebrado" — então o
# sensor grava o erro. PATH montado só com o que esse ramo usa: tirar o jq do PATH real não serve
# (no runner ubuntu ele mora em /usr/bin, junto do resto).
SEMJQ="$tmp/bin-sem-jq"; mkdir -p "$SEMJQ"
for b in mkdir dirname date cat; do
  p="$(command -v "$b")" || { echo "INFRA: $b ausente"; exit 2; }
  ln -s "$p" "$SEMJQ/$b"
done
BASH_BIN="$(command -v bash)"
L11="$tmp/logs/c11.jsonl"
out="$(printf '%s' "$(payload s-11 "$F_TEXTO")" | env PATH="$SEMJQ" AFIACAO_INSTR_LOG="$L11" HOME="$HOME_B" "$BASH_BIN" "$HOOK" 2>/dev/null)"; rc=$?
if contrato C11; then
  if [ "$(linhas "$L11")" = 1 ] && [ "$(campo "$L11" 1 .erro)" = '"jq-ausente"' ]; then
    ok C11 'jq ausente -> 1 linha com erro jq-ausente'
  else ruim C11 "esperava exatamente 1 linha com erro jq-ausente: $(cat "$L11" 2>/dev/null)"; fi
fi

# C12 diretório do log impossível de criar: sensor não derruba a sessão — sai 0, calado.
: > "$tmp/um-arquivo"
rodar "$HOME_B" "$tmp/um-arquivo/sub/c12.jsonl" "$(payload s-12 "$F_TEXTO")"
if contrato C12; then ok C12 'diretorio do log impossivel -> sai 0 sem escrever no stdout'; fi

# C13 JSONL ACRESCENTA: o segundo evento vira a 2ª linha e o primeiro fica intacto.
rodar "$HOME_A" - "$(payload s-13 "$F_TEXTO")"
if contrato C13; then
  if [ "$(linhas "$L_PADRAO")" = 2 ] && [ "$(campo "$L_PADRAO" 1 .sessao)" = '"s-1"' ] \
     && [ "$(campo "$L_PADRAO" 2 .sessao)" = '"s-13"' ]; then
    ok C13 'segundo evento acrescenta a 2a linha, o 1o fica intacto'
  else ruim C13 "esperava 2 linhas (s-1, s-13): $(cat "$L_PADRAO" 2>/dev/null)"; fi
fi

# C14 o CONSUMIDOR lê o que o sensor grava: o relatório conta os eventos e os erros, agrupa pelo
# motivo e mostra o peso — um campo renomeado no sensor vira "n/d" lá, sem erro nenhum.
L14="$tmp/logs/c14.jsonl"
rodar "$HOME_B" "$L14" "$(payload s-14 "$F_TEXTO")"
rodar "$HOME_B" "$L14" 'isto nao e json {'
rel="$(AFIACAO_INSTR_LOG="$L14" HOME="$HOME_B" bash "$RELATORIO" 2>&1)"; rrc=$?
if [ "$rrc" -eq 0 ] && tem "$rel" ' 2 evento(s) ' && tem "$rel" ' 1 com erro de sensor' \
   && tem "$rel" 'session_start' && tem "$rel" '20 bytes' && tem "$rel" '4 palavras'; then
  ok C14 'instrucoes-relatorio.sh le o log do sensor: eventos, erro, motivo e peso'
else ruim C14 "o relatorio nao leu o que o sensor gravou (rc=$rrc):
$rel"; fi

echo
if [ "$fail" -eq 0 ]; then echo "PASS — todos os casos"; else echo "FALHOU"; fi
exit "$fail"
