#!/usr/bin/env bash
# test-bash-contexto-nudge.sh — prova do hook .claude/hooks/bash-contexto-nudge.sh
#
# Roda em DOIS locales (C e pt_BR.UTF-8) de propósito: no #1483 uma asserção
# passou por acidente de ambiente porque `grep -i` sob pt_BR.UTF-8 dobra Ã↔ã e
# casava o ramo errado. Aqui todo casamento é por marcador ASCII exclusivo, caixa
# fixa, com `command grep` e SEM -i — e o teste é executado nos dois locales para
# provar que a asserção não depende disso.
#
# Inclui FALSIFICAÇÃO: no fim, sabota o limiar do hook e exige que o teste do
# silêncio fique VERMELHO. Um teste que passa com o código sabotado não prova nada.
set -u

# NUDGE_OVERRIDE aponta para uma CÓPIA sabotada: é assim que a falsificação
# reexecuta a suíte inteira contra o hook quebrado e exige vermelho.
HOOK="${NUDGE_OVERRIDE:-$(cd "$(dirname "$0")/.." && pwd)/.claude/hooks/bash-contexto-nudge.sh}"
[ -x "$HOOK" ] || { echo "hook não encontrado/executável: $HOOK" >&2; exit 1; }
command -v jq >/dev/null || { echo "jq é necessário" >&2; exit 1; }

falhas=0

# Monta o JSON de entrada do PostToolUse com uma saída de N chars.
entrada() { # <n_chars> <comando> [tool_name]
  jq -n -c --arg cmd "$2" --arg tool "${3:-Bash}" --argjson n "$1" \
    '{tool_name:$tool, tool_input:{command:$cmd},
      tool_response:( "x" * $n )}'
}

# Mesma entrada, agora com session_id — é a chave do corte "1o ensina, resto lembra".
entrada_s() { # <n_chars> <comando> <session_id>
  jq -n -c --arg cmd "$2" --arg sid "$3" --argjson n "$1" \
    '{tool_name:"Bash", session_id:$sid, tool_input:{command:$cmd},
      tool_response:( "x" * $n )}'
}

# roda o hook e devolve stdout
executa() { printf '%s' "$1" | bash "$HOOK" 2>>"${ERROS_DO_ALVO:-/dev/null}"; }
# idem, com TMPDIR proprio: a marca de "ja ensinou" vive la, e sem isolar, a 2a
# rodada de locale herdaria a marca da 1a e o caso do 1o disparo viraria falso.
executa_t() { printf '%s' "$2" | TMPDIR="$1" bash "$HOOK" 2>>"${ERROS_DO_ALVO:-/dev/null}"; }
ctx_de() { printf '%s' "$1" | jq -r '.hookSpecificOutput.additionalContext // ""' 2>/dev/null; }

checa() { # <titulo> <esperado: MARCADOR|VAZIO> <json>
  local titulo="$1" esperado="$2" json="$3" saida
  saida="$(executa "$json")"
  if [ "$esperado" = "VAZIO" ]; then
    if [ -z "$saida" ]; then printf '  ok   %s\n' "$titulo"; return 0; fi
    printf '  FALHA %s — esperava silêncio, veio: %s\n' "$titulo" "$(printf '%s' "$saida" | head -c 120)"
    falhas=$((falhas + 1)); return 1
  fi
  # marcador tem de estar no additionalContext, não em qualquer lugar do JSON
  if printf '%s' "$saida" | jq -r '.hookSpecificOutput.additionalContext // ""' 2>/dev/null \
       | command grep -q "$esperado"; then
    printf '  ok   %s\n' "$titulo"; return 0
  fi
  printf '  FALHA %s — esperava %s, veio: %s\n' "$titulo" "$esperado" "$(printf '%s' "$saida" | head -c 160)"
  falhas=$((falhas + 1)); return 1
}

rodada() {
  echo "--- locale: ${LC_ALL:-(herdado)} ---"

  # (1) POSITIVO: saída grande sem limite -> BASH-SAIDA-GRANDE
  checa "N1 saida 5k sem head" "BASH-SAIDA-GRANDE" "$(entrada 5000 'psql -c "select * from t"')"

  # (2) POSITIVO: saída grande QUE JÁ USAVA head -> o outro ramo
  checa "N2 saida 5k com head -120" "BASH-LIMITE-POR-LINHA" "$(entrada 5000 'cat arq.sql | head -120')"

  # (3) POSITIVO: saída enorme -> ainda o ramo SAIDA-GRANDE (e o 🔴 na msg)
  checa "N3 saida 20k sem head" "BASH-SAIDA-GRANDE" "$(entrada 20000 'git diff')"

  # (4) NEGATIVO: abaixo do limiar -> SILÊNCIO (o caso que a falsificação quebra)
  checa "N4 saida 500 (abaixo do limiar)" "VAZIO" "$(entrada 500 'ls')"

  # (5) NEGATIVO: exatamente 3999 -> silêncio (fronteira)
  checa "N5 saida 3999 (fronteira)" "VAZIO" "$(entrada 3999 'ls')"

  # (6) NEGATIVO: outra ferramenta -> silêncio
  checa "N6 tool_name=Read" "VAZIO" "$(entrada 9000 'irrelevante' 'Read')"

  # (7) ROBUSTEZ: JSON inválido não pode quebrar nem falar
  local saida
  saida="$(printf '%s' 'isto não é json' | bash "$HOOK" 2>>"${ERROS_DO_ALVO:-/dev/null}")"
  if [ -z "$saida" ]; then printf '  ok   N7 entrada invalida -> silencio\n'
  else printf '  FALHA N7 entrada invalida falou: %s\n' "$saida"; falhas=$((falhas + 1)); fi

  # (8) ROBUSTEZ: tool_response como OBJETO (formato alternativo) ainda mede
  local j
  j="$(jq -n -c '{tool_name:"Bash", tool_input:{command:"git log"},
                  tool_response:{stdout:("y" * 9000), stderr:"", exitCode:0}}')"
  checa "N8 tool_response objeto 9k" "BASH-SAIDA-GRANDE" "$j"

  # ---- o corte "1o disparo ENSINA, os seguintes so LEMBRAM" -------------------
  # Medido: o texto longo entrou 2.726x e ocupou 88,7M tok*req (4,1% da ocupacao
  # do proprio Bash), e o efeito POR EVENTO nao aparece na medicao. O 1o disparo
  # da sessao continua completo; os seguintes viram uma linha.
  local TD c1 c2 c3 n1 n2
  TD="$(mktemp -d)"

  # (10) 1o disparo da sessao -> texto COMPLETO
  c1="$(ctx_de "$(executa_t "$TD" "$(entrada_s 5000 'psql -c "select * from t"' sessao-alfa)")")"
  if printf '%s' "$c1" | command grep -qF "BASH-SAIDA-GRANDE"; then printf '  ok   N10 1o disparo da sessao -> texto completo\n'
  else printf '  FALHA N10 1o disparo nao trouxe BASH-SAIDA-GRANDE\n'; falhas=$((falhas + 1)); fi

  # (11) 2o disparo da MESMA sessao -> texto BREVE
  c2="$(ctx_de "$(executa_t "$TD" "$(entrada_s 5000 'psql -c "select * from u"' sessao-alfa)")")"
  if printf '%s' "$c2" | command grep -qF "BASH-NUDGE-REPETIDO"; then printf '  ok   N11 2o disparo da mesma sessao -> texto breve\n'
  else printf '  FALHA N11 2o disparo repetiu o texto longo — o corte nao esta ativo\n'; falhas=$((falhas + 1)); fi

  # (12) sessao DIFERENTE volta a ensinar: o corte e por sessao, nao global.
  # Se fosse global, uma sessao nova nunca receberia a licao — que e justamente
  # o unico efeito que a medicao atribui a este hook.
  c3="$(ctx_de "$(executa_t "$TD" "$(entrada_s 5000 'psql -c "select * from v"' sessao-beta)")")"
  if printf '%s' "$c3" | command grep -qF "BASH-SAIDA-GRANDE"; then printf '  ok   N12 sessao nova volta a receber o texto completo\n'
  else printf '  FALHA N12 o corte vazou entre sessoes — sessao nova perdeu a licao\n'; falhas=$((falhas + 1)); fi

  # (13) o texto breve tem de ser MESMO menor — e o unico motivo do corte.
  # Sem esta assercao, trocar o marcador e manter os 861 chars passaria verde.
  n1=${#c1}; n2=${#c2}
  if [ "$n1" -gt 0 ] && [ "$n2" -gt 0 ] && [ "$n2" -lt "$(( n1 / 3 ))" ]; then
    printf '  ok   N13 texto breve e < 1/3 do completo (%s vs %s chars)\n' "$n2" "$n1"
  else
    printf '  FALHA N13 breve=%s completo=%s — o corte nao economiza contexto\n' "$n2" "$n1"; falhas=$((falhas + 1)); fi

  # (14) SEM session_id o hook mantem o comportamento antigo (fail-open): sem
  # identidade nao ha como saber que e repeticao, e calar perderia a licao.
  executa_t "$TD" "$(entrada 5000 'git diff')" >/dev/null
  if ctx_de "$(executa_t "$TD" "$(entrada 5000 'git diff')")" | command grep -qF "BASH-SAIDA-GRANDE"; then
    printf '  ok   N14 sem session_id -> sempre completo (fail-open)\n'
  else printf '  FALHA N14 sem session_id o hook encurtou — nao ha como saber que e repeticao\n'; falhas=$((falhas + 1)); fi
  rm -rf "$TD"

  # (9) o JSON emitido é válido e tem o hookEventName certo
  local ev
  ev="$(executa "$(entrada 5000 'ls')" | jq -r '.hookSpecificOutput.hookEventName' 2>/dev/null)"
  if [ "$ev" = "PostToolUse" ]; then printf '  ok   N9 hookEventName=PostToolUse\n'
  else printf '  FALHA N9 hookEventName veio "%s"\n' "$ev"; falhas=$((falhas + 1)); fi
}

echo "== bash-contexto-nudge =="
LC_ALL=C rodada
if locale -a 2>/dev/null | command grep -qi '^pt_BR.UTF-*8$'; then
  LC_ALL=pt_BR.UTF-8 rodada
else
  echo "--- locale pt_BR.UTF-8 indisponível nesta máquina: pulado ---"
fi

# ---------------------------------------------------------------- falsificação
# Sabota o limiar (4000 -> 1) e exige que o teste do SILÊNCIO fique vermelho.
# Se continuar verde, a asserção (4) não estava provando nada.
# Só no nível de cima: a reexecução da suíte (NUDGE_OVERRIDE) não refaz a falsificação.
if [ -z "${NUDGE_OVERRIDE:-}" ]; then
  echo "--- falsificação (sabota o limiar; o silêncio TEM de quebrar) ---"
  sabotado="$(mktemp)"; trap 'rm -f "$sabotado"' EXIT
  # shellcheck disable=SC2016  # o $chars é literal de propósito: casa o TEXTO do hook, não expande
  sed 's/\[ "\$chars" -ge 4000 \]/[ "$chars" -ge 1 ]/' "$HOOK" > "$sabotado"
  if command grep -q '\-ge 1 \]' "$sabotado"; then
    # O silêncio tem de quebrar COM o nudge (o marcador no additionalContext) — o valor que só o
    # limiar sabotado produz. Até 2026-09-27 valia "o hook imprimiu QUALQUER coisa": um hook que
    # quebra e cospe erro no stdout passava por dente. docs/historico/falsificacao-exit-nao-e-dente.md
    saida_sab="$(printf '%s' "$(entrada 500 'ls')" | bash "$sabotado" 2>/dev/null)"
    if ctx_de "$saida_sab" | command grep -qF "BASH-SAIDA-GRANDE"; then
      echo "  ok   sabotagem detectada (o silêncio quebrou COM o nudge BASH-SAIDA-GRANDE)"
    elif [ -n "$saida_sab" ]; then
      echo "  FALHA o silêncio quebrou, mas SEM o nudge — vermelho que não é o do limiar: $(printf '%s' "$saida_sab" | head -c 100)"
      falhas=$((falhas + 1))
    else
      echo "  FALHA a sabotagem NÃO quebrou o teste — a asserção do silêncio é teatro"
      falhas=$((falhas + 1))
    fi
  else
    echo "  FALHA não consegui sabotar o hook (o padrão do limiar mudou?)"
    falhas=$((falhas + 1))
  fi
fi

# --- falsificação do corte "1o ensina, resto lembra" -------------------------
# Sabota o hook, uma regra por vez, e exige que a suíte REEXECUTADA contra a cópia sabotada fique
# vermelha NO ASSERT que a sabotagem declara. Exit≠0 NÃO é dente: até 2026-09-27 este bloco contava
# "a suíte saiu ≠0" — assert alheio, aborto e sintaxe quebrada (não havia `bash -n`) contavam.
# docs/historico/falsificacao-exit-nao-e-dente.md
# Reexecução só no nível de cima: com NUDGE_OVERRIDE setado, pular.
if [ -z "${NUDGE_OVERRIDE:-}" ]; then
  echo "--- falsificação (sabota o hook; a suíte TEM de quebrar NO assert declarado) ---"
  if [ "$falhas" -ne 0 ]; then
    echo "  FALHA suíte já vermelha antes de sabotar — sabotar não provaria nada"
    falhas=$((falhas + 1))
  else
    sab_dir="$(mktemp -d)"
    # Asserts EXECUTADOS numa rodada (ok + FALHA): o recibo de que a suíte rodou inteira.
    asserts() { LC_ALL=C grep -cE '^  (ok +|FALHA )' "$1" || true; }
    # Erro de execução do BASH no hook: a suíte normal joga o stderr dele fora (o contrato é o
    # stdout); aqui ERROS_DO_ALVO o recolhe — o hook que morre de `set -u` CALA, e silêncio é
    # justamente o que metade dos asserts espera.
    erros_exec() { LC_ALL=C grep -cE 'unbound variable|command not found|syntax error|bad substitution' "$1" 2>/dev/null || true; }
    vermelhos() { { LC_ALL=C grep -Eo '^  FALHA N[0-9]+ ' "$1" || true; } | LC_ALL=C awk '!v[$2]++ { printf "%s ", $2 }'; }

    # CONTROLE na MESMA invocação do laço (cópia INTACTA, o mesmo NUDGE_OVERRIDE): as caixas acima
    # rodaram sobre o hook real; o LOG desta rodada é a régua das camadas abaixo.
    ctl="$sab_dir/controle.log"; : > "$ctl.stderr"
    cp "$HOOK" "$sab_dir/controle.sh"; chmod +x "$sab_dir/controle.sh"
    NUDGE_OVERRIDE="$sab_dir/controle.sh" ERROS_DO_ALVO="$ctl.stderr" bash "$0" > "$ctl" 2>&1; rc=$?
    if [ "$rc" -ne 0 ] || [ "$(asserts "$ctl")" -eq 0 ]; then
      echo "  FALHA controle (cópia INTACTA) já VERMELHO (exit $rc, $(asserts "$ctl") asserts) — sem linha de base, sabotar não prova nada"
      falhas=$((falhas + 1))
    else
      # <sabotagem>:<IDs dos asserts que TÊM de acusá-la> — `,` = E, `|` = OU; o ID é o 1º token do
      # assert (`FALHA N4 …`). Colaterais (asserts que também caem) ficam de fora de propósito.
      SABOTAGENS="corte_desligado:N11 corte_global:N12 breve_nao_breve:N13"

      # registra <nome> <descricao> <expressao sed> — a TABELA das sabotagens. Nome da lista sem
      # registro e registro fora da lista são FALHA: o primeiro não sabotaria nada, o segundo nunca roda.
      registradas=""
      registra() { registradas="$registradas $1"; printf -v "desc_$1" '%s' "$2"; printf -v "expr_$1" '%s' "$3"; }
      # shellcheck disable=SC2016  # $marca/$sessao/$tok_k sao literais: casam o TEXTO do hook —
      # expandir aqui produziria padrao vazio e "sabotagem vazia".
      registra corte_desligado "corte desligado (sempre texto longo)" \
        's/^  if \[ -e "\$marca" \]; then repetido=1;/  if false; then repetido=1;/'
      # shellcheck disable=SC2016
      registra corte_global "corte vira GLOBAL (sessao nova perde a licao)" \
        's|bash-nudge-visto-\${sessao}|bash-nudge-visto-global|'
      # shellcheck disable=SC2016
      registra breve_nao_breve "texto breve deixa de ser breve" \
        's|^    ctx="BASH-NUDGE-REPETIDO: +\${tok_k}k tokens no contexto\. Recorte.*|    ctx="BASH-NUDGE-REPETIDO: $(printf %500s . \| tr " " x)"|'

      # A rodada só conta como vermelha com as QUATRO camadas (as do sync-reprocess): (1) a
      # sabotagem aplicou e não quebrou a sintaxe; (2) a suíte rodou INTEIRA (nº de asserts = o do
      # controle); (3) CADA assert declarado está verde no controle e vermelho aqui; (4) nenhum erro
      # de execução do bash no hook que o controle não tem.
      copia="$sab_dir/h.sh"
      for item in $SABOTAGENS; do
        sab="${item%%:*}"; exigidos="${item#*:}"
        v="desc_$sab"; desc="${!v-}"; v="expr_$sab"; expr="${!v-}"
        if [ -z "$expr" ]; then
          echo "  FALHA \"$sab\": na lista SABOTAGENS e SEM registro — nada foi sabotado"; falhas=$((falhas + 1)); continue
        fi
        if ! erro="$(sed "$expr" "$HOOK" 2>&1 >"$copia")"; then
          echo "  FALHA \"$desc\": sed inválido (${erro:0:50}) — sabotagem vazia"; falhas=$((falhas + 1)); continue
        fi
        if cmp -s "$HOOK" "$copia"; then
          echo "  FALHA \"$desc\": padrão não casou, hook intacto — sabotagem vazia"; falhas=$((falhas + 1)); continue
        fi
        if ! bash -n "$copia" 2>/dev/null; then
          echo "  FALHA \"$desc\": quebrou a SINTAXE do hook — vermelho pelo motivo errado"; falhas=$((falhas + 1)); continue
        fi
        chmod +x "$copia"
        log="$sab_dir/sabotada-$sab.log"; : > "$log.stderr"
        NUDGE_OVERRIDE="$copia" ERROS_DO_ALVO="$log.stderr" bash "$0" > "$log" 2>&1; rc=$?
        if [ "$rc" -eq 0 ]; then
          echo "  FALHA \"$desc\": hook sabotado e a suíte passou VERDE — invariante sem cobertura"
          falhas=$((falhas + 1)); continue
        fi
        # Daqui em diante a rodada saiu ≠0 — o que, sozinho, não prova NADA.
        faltam=""
        for exigido in ${exigidos//,/ }; do
          if ! LC_ALL=C grep -Eq "^  ok +($exigido) " "$ctl" || ! LC_ALL=C grep -Eq "^  FALHA ($exigido) " "$log"; then
            faltam="$faltam $exigido"
          fi
        done
        if [ "$(asserts "$log")" != "$(asserts "$ctl")" ]; then
          echo "  FALHA \"$desc\": a suíte NÃO rodou inteira ($(asserts "$log") de $(asserts "$ctl") asserts) — vermelho de aborto, não de assert"
          falhas=$((falhas + 1))
        elif [ "$(erros_exec "$log.stderr")" != "$(erros_exec "$ctl.stderr")" ]; then
          echo "  FALHA \"$desc\": vermelha com ERRO de execução no hook — o assert caiu por crash, não por julgamento"
          falhas=$((falhas + 1))
        elif [ -n "$faltam" ]; then
          echo "  FALHA \"$desc\": vermelha, mas o assert declarado NÃO virou (verde no controle -> vermelho aqui):$faltam · vermelhos: $(vermelhos "$log")"
          falhas=$((falhas + 1))
        else
          echo "  ok   \"$desc\" -> vermelho no assert declarado ($exigidos) · vermelhos: $(vermelhos "$log")"
        fi
      done
      for r in $registradas; do
        case " $SABOTAGENS " in
          *[[:space:]]"$r:"*) ;;
          *) echo "  FALHA \"$r\": registrada e FORA da lista SABOTAGENS — nunca roda"; falhas=$((falhas + 1)) ;;
        esac
      done
    fi
    rm -rf "$sab_dir"
  fi
fi

echo
if [ "$falhas" -eq 0 ]; then echo "TODOS OS TESTES PASSARAM"; exit 0; fi
echo "FALHAS: $falhas"; exit 1
