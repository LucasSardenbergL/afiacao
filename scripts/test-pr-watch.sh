#!/usr/bin/env bash
# test-pr-watch.sh — TDD do scripts/pr-watch.sh com `gh` STUBADO (sem rede).
#
# Contrato testado (exit codes): 0=MERGED · 2=CLOSED · 3=DIRTY(conflito) ·
# 4=check OBRIGATÓRIO vermelho/sem veredito · 5=CONSULTEI e o PR segue sem
# desfecho · 6=NÃO CONSEGUI CONSULTAR (estado DESCONHECIDO — confirmar à mão
# antes de reportar) · 64=uso errado.
#
# 5 vs 6 é o coração deste teste. Até o #1396 os dois saíam 5: o watcher não
# conseguiu consultar (2 falhas + relógio saltando o deadline com a máquina
# dormindo), saiu 5, e o PR tinha MERGEADO — falso negativo reportado ao
# founder. Se algum dia "não consegui consultar" voltar a sair 5, este teste
# fica vermelho.
#
# O 4 tem a guarda gêmea, pelo lado do falso POSITIVO. Até 2026-09-14 ele saía
# para QUALQUER check vermelho, e no #2472 o `mutation-check` (fora dos
# obrigatórios) pintou "CI VERMELHO" três vezes num PR que mergeou em seguida —
# alarme que mente ensina a sessão a ignorar o 4. Os casos `nao-obrig-*` provam
# que não-obrigatório vermelho SEGUE vigiando (e avisa); os `req-*`, que "não
# sei se é obrigatório" é 6, nunca "não é".
#
# O último caso cobre o GATILHO do #1396: a janela conta VIGÍLIA, não relógio
# de parede. Ali o exit code não discrimina (5 nos dois mundos) — o observável
# é quantas vezes o script chegou a consultar.
#
# Todo FAIL sai com marca ASCII de caixa fixa — `FAIL [<id>] exit:`,
# `FAIL [<id>] saida:` ou `FAIL [<id>] contagem:` — para dizer PELO QUE a
# suíte ficou vermelha, não só que ficou.
#
# Uso: bash scripts/test-pr-watch.sh              (exit 0 = tudo verde)
#      bash scripts/test-pr-watch.sh --falsificar (sabota o vigia; exige vermelho pela marca, 2 locales)
set -u

here="$(cd "$(dirname "$0")" && pwd)"
# PR_WATCH_ALVO: a CÓPIA (de controle ou sabotada) que o `--falsificar` serve — nunca o versionado.
WATCH="${PR_WATCH_ALVO:-$here/pr-watch.sh}"

# ── modo falsificação ───────────────────────────────────────────────────────
# Sabota o VIGIA numa cópia e EXIGE que a suíte fique vermelha PELO MOTIVO CERTO: cada sabotagem
# declara a marca ASCII, caixa fixa, que a suíte tem de imprimir. `FAIL [<id>] exit: want X, got Y`
# fixa até o exit ERRADO esperado — um crash de shell sob `set -u` (exit 1) não se passa pela
# regressão. Julgada nos DOIS locales (#1483), e só depois de um CONTROLE verde na MESMA invocação
# do laço: sem linha de base, arnês sempre-vermelho aprova toda sabotagem
# (docs/historico/falsificacao-sem-linha-de-base.md).
if [ "${1:-}" = "--falsificar" ]; then
  printf '== falsificacao (sabota o VIGIA; exige vermelho pela marca certa, 2 locales) ==\n'
  fals="$(mktemp -d)"
  trap 'rm -rf "$fals"' EXIT
  falhas=0

  # locale UTF-8: sonda POSITIVA — rodar só LC_ALL=C e chamar de "2 locales" é a falsificação em
  # UM ambiente do #1483.
  utf8=""
  for cand in pt_BR.UTF-8 pt_BR.utf8 en_US.UTF-8 en_US.utf8 C.UTF-8 C.utf8; do
    if [ "$(LC_ALL="$cand" locale charmap 2>/dev/null)" = "UTF-8" ]; then utf8="$cand"; break; fi
  done
  if [ -z "$utf8" ]; then
    echo "❌ nenhum locale UTF-8 (pt_BR/en_US/C) neste ambiente — metade da falsificacao nao rodaria."
    exit 1
  fi
  original="$fals/original.sh"; cp "$WATCH" "$original"

  # A MESMA invocação para controle e sabotagem — só o alvo muda.
  suite() { # $1 alvo · $2 locale → $saida_suite, $rc_suite
    saida_suite="$(LC_ALL="$2" PR_WATCH_ALVO="$1" bash "$0" 2>&1)"; rc_suite=$?
  }

  # ── CONTROLE: verde ANTES do primeiro sed, nos dois locales ──
  cp "$WATCH" "$fals/controle.sh"
  for loc in C "$utf8"; do
    suite "$fals/controle.sh" "$loc"
    if [ "$rc_suite" -eq 0 ] && grep -q '^PASS ' <<<"$saida_suite" && ! grep -qF 'FAIL [' <<<"$saida_suite"; then
      echo "  ok    controle (copia SEM sabotagem, LC_ALL=$loc) -> VERDE"
    else
      echo "  FAIL  controle SEM sabotagem ja esta VERMELHO (LC_ALL=$loc, exit $rc_suite) — sem linha de base, sabotar nao prova nada"
      falhas=$((falhas + 1))
    fi
  done
  if [ "$falhas" -ne 0 ]; then
    printf '\n❌ falsificacao ABORTADA: sem verde de partida. Conserte a suite antes de sabotar.\n'
    exit 1
  fi

  # sabota <regra que quebra> <marca do vermelho certo> <expressão sed>
  sabota() {
    local regra="$1" marca="$2" expr="$3" copia="$fals/sabotado.sh" erro loc
    erro="$(sed "$expr" "$WATCH" 2>&1 >"$copia")"
    # sed inválido escreve cópia vazia; padrão que não casa deixa o vigia intacto; sintaxe
    # quebrada fica vermelha sem ter testado a regra — as três são sabotagem VAZIA.
    if [ -n "$erro" ]; then
      echo "  FAIL  \"$regra\": sed invalido (${erro:0:60}) — sabotagem vazia"; falhas=$((falhas + 1)); return
    fi
    if cmp -s "$WATCH" "$copia"; then
      echo "  FAIL  \"$regra\": padrao nao casou, vigia intacto — sabotagem vazia"; falhas=$((falhas + 1)); return
    fi
    if ! bash -n "$copia" 2>/dev/null; then
      echo "  FAIL  \"$regra\": quebrou a SINTAXE do shell — vermelho pelo motivo errado"; falhas=$((falhas + 1)); return
    fi
    for loc in C "$utf8"; do
      suite "$copia" "$loc"
      if [ "$rc_suite" -eq 0 ]; then
        echo "  FAIL  \"$regra\" passou VERDE (LC_ALL=$loc) — a suite NAO cobre"; falhas=$((falhas + 1))
      elif ! grep -qF -- "$marca" <<<"$saida_suite"; then
        echo "  FAIL  \"$regra\" vermelho SEM a marca \"$marca\" (LC_ALL=$loc) — vermelho por outro motivo:"
        grep -F 'FAIL [' <<<"$saida_suite" | cut -c1-150 | sed 's/^/        /'
        falhas=$((falhas + 1))
      else
        echo "  ok    \"$regra\" -> \"$marca\" (LC_ALL=$loc)"
      fi
    done
  }

  # Uma camada por vez: a que ficar VERDE é redundante ou inalcançada.
  # shellcheck disable=SC2016  # `$req_vermelhos`, `$alarmes`… são o TEXTO que o sed procura no vigia
  {
  sabota "nao-obrigatorio vermelho volta a ser desfecho (o bug do #2472)" \
         "FAIL [nao-obrig-mergeia] exit: want 0, got 4" \
         's/select(.isRequired and vermelho)/select(vermelho)/'
  sabota "nao-obrigatorio SEM VEREDITO volta a ser desfecho" \
         "FAIL [nao-obrig-cancelado] exit: want 0, got 4" \
         's/select(.isRequired and (vermelho | not))/select(vermelho | not)/'
  sabota "obrigatorio vermelho deixa de sair 4" \
         "FAIL [obrig-vermelho] exit: want 4, got 5" \
         's/if \[ -n "\$req_vermelhos" \]; then/if false; then/'
  sabota "vermelho no rollup deixa de disparar a consulta dos obrigatorios" \
         "FAIL [obrig-vermelho] exit: want 4, got 5" \
         's/if \[ "\$alarme" = true \]; then/if false; then/'
  sabota "rc!=0 da consulta (GraphQL parcial) passa como resposta boa" \
         "FAIL [req-parcial] exit: want 6, got 5" \
         's/resp="\$(consultar_obrigatorios)"/resp="$(consultar_obrigatorios || true)"/'
  sabota "resposta ilegivel dos obrigatorios passa como 'nenhum obrigatorio'" \
         "FAIL [req-ilegivel] exit: want 6, got 5" \
         's/if \[ -z "\$nos" \]; then/if false; then/'
  sabota "resposta truncada (hasNextPage) passa como completa" \
         "FAIL [req-truncado] exit: want 6, got 5" \
         's/select(.pageInfo.hasNextPage == false) | //'
  sabota "isRequired AUSENTE vira nao-obrigatorio (ausente != false)" \
         "FAIL [req-sem-isrequired] exit: want 6, got 5" \
         's/(.isRequired | type) != "boolean"/false/'
  sabota "run SUPERADO do mesmo nome volta a contar no veredito" \
         "FAIL [req-cancelado-superado] exit: want 0, got 4" \
         's/max_by(quando)/.[]/'
  sabota "o dedupe fica com o run mais VELHO do nome" \
         "FAIL [req-cancelado-mais-novo] exit: want 4, got 5" \
         's/max_by(quando)/min_by(quando)/'
  sabota "sem carimbo de tempo deixa de ser fail-closed" \
         "FAIL [req-sem-carimbo] exit: want 4, got 5" \
         's/if any(.\[\]; quando == "") then .\[\] else/if false then .[] else/'
  sabota "a nota do vermelho SUPERADO fica calada" \
         'FAIL [req-cancelado-superado] saida: falta "SUPERADO [validate]"' \
         's/echo \("[^S]*SUPERADO\)/: \1/'
  sabota "o GATILHO filtra o superado e a nota nunca nasce" \
         'FAIL [req-cancelado-superado] saida: falta "SUPERADO [validate]"' \
         's|any(.statusCheckRollup\[\]?; vermelho or sem_veredito)|any(((.statusCheckRollup // []) \| ultimos)[]; vermelho or sem_veredito)|'
  sabota "o AVISO do nao-obrigatorio fica calado" \
         'FAIL [nao-obrig-mergeia] saida: falta "AVISO NAO-OBRIGATORIO [mutation-check]"' \
         's/echo \("[^A]*AVISO NAO-OBRIGATORIO\)/: \1/'
  sabota "o AVISO repete a cada consulta" \
         "FAIL [nao-obrig-aviso-unico] contagem: want 1 aviso, got 3" \
         's/ && \[ "\$nao_obrigatorios" != "\$ultimo_aviso" \]//'
  sabota "PR que nao e numero passa pela entrada" \
         "FAIL [pr-nao-numerico] exit: want 64, got 0" \
         's/\*\[!0-9\]\*)/__nunca__)/'
  }

  # ── CONTROLE DE SAÍDA: sabotar cópias não pode ter mexido no alvo — conferido por CONTEÚDO ──
  if cmp -s "$original" "$WATCH"; then echo "  ok    alvo intacto apos as sabotagens (conferido por conteudo)"
  else echo "  FAIL  o alvo MUDOU durante a falsificacao"; falhas=$((falhas + 1)); fi

  echo
  if [ "$falhas" -eq 0 ]; then
    echo "✅ falsificacao: toda sabotagem ficou vermelha pela marca certa, em LC_ALL=C e LC_ALL=$utf8"; exit 0
  fi
  echo "❌ falsificacao: $falhas falha(s) — a suite nao cobre o que promete"; exit 1
fi

stub="$(mktemp -d)"
tempo="$(mktemp -d)"
trap 'rm -rf "$stub" "$tempo"' EXIT

# Stubs de TEMPO — usados SÓ pelos casos que precisam de várias consultas
# (entram no PATH apenas neles, pros demais seguirem exercitando date/sleep de
# verdade). Relógio VIRTUAL num arquivo: `sleep N` não dorme, só adianta o
# relógio em N + SLEEP_SALTO. Assim dá pra simular a máquina suspendendo — de
# forma determinística e instantânea, sem esperar 40min de verdade.
cat >"$tempo/date" <<'STUB'
#!/bin/sh
cat "$PR_WATCH_RELOGIO"
STUB
cat >"$tempo/sleep" <<'STUB'
#!/bin/sh
agora="$(cat "$PR_WATCH_RELOGIO")"
echo $(( agora + $1 + ${SLEEP_SALTO:-0} )) > "$PR_WATCH_RELOGIO"
STUB
chmod +x "$tempo/date" "$tempo/sleep"

# stub de gh — o vigia faz DUAS perguntas diferentes:
#   `gh api graphql` = quais checks são OBRIGATÓRIOS. Imprime GH_STUB_REQ_FILE e
#       sai GH_STUB_REQ_EXIT (default 0) — corpo E rc juntos, como o gh real: a
#       resposta PARCIAL do GraphQL chega no stdout com rc=1 (medido em
#       2026-09-14 num PR inexistente: `{"data":…,"errors":[…]}` e exit 1).
#   qualquer outra = `gh pr view`, contada em GH_STUB_CONTADOR:
#     GH_STUB_EXIT=N   → falha SEMPRE com N (rede fora o tempo todo)
#     GH_STUB_FALHAS=N → falha as N PRIMEIRAS chamadas e depois devolve o JSON
#                        (a rede volta — cenário real do #1396)
#     GH_STUB_DEPOIS=F → da chamada GH_STUB_VIRA_EM (default 2) em diante
#                        devolve F: o PR muda (mergeia) DURANTE a vigília
#     senão            → devolve o JSON do cenário (GH_STUB_FILE)
cat >"$stub/gh" <<'STUB'
#!/bin/sh
if [ "$1 $2" = "api graphql" ]; then
  [ -n "${GH_STUB_REQ_FILE:-}" ] && cat "$GH_STUB_REQ_FILE"
  exit "${GH_STUB_REQ_EXIT:-0}"
fi
n=0
[ -f "$GH_STUB_CONTADOR" ] && n="$(cat "$GH_STUB_CONTADOR")"
n=$((n + 1)); printf '%s' "$n" > "$GH_STUB_CONTADOR"
[ -n "${GH_STUB_EXIT:-}" ] && exit "$GH_STUB_EXIT"
[ "$n" -le "${GH_STUB_FALHAS:-0}" ] && exit 1
if [ -n "${GH_STUB_DEPOIS:-}" ] && [ "$n" -ge "${GH_STUB_VIRA_EM:-2}" ]; then
  cat "$GH_STUB_DEPOIS"; exit 0
fi
cat "$GH_STUB_FILE"
STUB
chmod +x "$stub/gh"
export PATH="$stub:$PATH"
export GH_STUB_CONTADOR="$stub/contador"
# backoff da cartada final zerado: o teste prova a SEQUÊNCIA, não a espera
export PR_WATCH_BACKOFFS="0 0 0"

fail=0

# Cenário extra do PRÓXIMO `caso`, que zera tudo ao terminar — nada vaza adiante:
req=""        # corpo do `gh api graphql` (checks obrigatórios); "" = corpo vazio
req_exit=0    # rc do `gh api graphql`
depois=""     # JSON do `gh pr view` a partir da consulta `vira_em` ("" = o PR não muda)
vira_em=2
saida_caso="" # saída do último `caso`, para asserção extra

# Corpo do GraphQL no formato REAL (medido contra o PR #2472 em 2026-09-14: 10
# contexts, só o `validate` com isRequired=true). $1 = array JSON de contexts.
gql_nos() {
  jq -c '{data: {repository: {pullRequest: {commits: {nodes: [{commit: {statusCheckRollup:
    {contexts: {pageInfo: {hasNextPage: false}, nodes: .}}}}]}}}}}' <<<"$1"
}
# Atalho: gql <nome>:<conclusion|null>:<true|false> … → CheckRuns com isRequired.
gql() {
  local t nos='[]'
  for t in "$@"; do
    nos="$(jq -c --arg t "$t" '. + [($t | split(":")) as [$n, $c, $r] | {__typename: "CheckRun",
      name: $n, conclusion: (if $c == "null" then null else $c end), isRequired: ($r == "true")}]' <<<"$nos")"
  done
  gql_nos "$nos"
}

# Roda o watcher e confere exit + saída.
#   $1 id ASCII (vai na marca do FAIL) · $2 nome · $3 exit esperado
#   $4 JSON do `gh pr view` · $5 consultas que falham antes de a rede voltar (default 0)
#   $6… trechos FIXOS que a saída PRECISA conter — sem isso um exit 5 "não
#       consegui consultar" se disfarça de exit 5 "consultei"
# Sem `depois`: timeout 0 e poll 1s com date/sleep REAIS (1 consulta + cartada
# final). Com `depois`: relógio VIRTUAL (timeout 5min, poll 60s) — ver o PR mudar
# exige ≥2 consultas, e esperar de verdade não provaria nada a mais.
caso() {
  local id="$1" nome="$2" want_exit="$3" json="$4" falhas="${5:-0}" out rc trecho
  if [ $# -gt 5 ]; then shift 5; else set --; fi
  printf '%s' "$json" > "$stub/cenario.json"
  printf '%s' "$req" > "$stub/req.json"
  printf '%s' "$depois" > "$stub/depois.json"
  rm -f "$GH_STUB_CONTADOR"
  if [ -n "$depois" ]; then
    echo 1000000000 > "$tempo/relogio"
    out="$(PATH="$tempo:$PATH" PR_WATCH_RELOGIO="$tempo/relogio" \
      GH_STUB_FILE="$stub/cenario.json" GH_STUB_FALHAS="$falhas" \
      GH_STUB_REQ_FILE="$stub/req.json" GH_STUB_REQ_EXIT="$req_exit" \
      GH_STUB_DEPOIS="$stub/depois.json" GH_STUB_VIRA_EM="$vira_em" \
      bash "$WATCH" 999 5 60 2>/dev/null)"; rc=$?
  else
    out="$(GH_STUB_FILE="$stub/cenario.json" GH_STUB_FALHAS="$falhas" \
      GH_STUB_REQ_FILE="$stub/req.json" GH_STUB_REQ_EXIT="$req_exit" \
      bash "$WATCH" 999 0 1 2>/dev/null)"; rc=$?
  fi
  req=""; req_exit=0; depois=""; vira_em=2; saida_caso="$out"
  if [ "$rc" -ne "$want_exit" ]; then
    echo "  FAIL [$id] exit: want $want_exit, got $rc | $nome | $out"; fail=1; return
  fi
  for trecho in "$@"; do
    if ! grep -qF -- "$trecho" <<<"$out"; then
      echo "  FAIL [$id] saida: falta \"$trecho\" | $nome | $out"; fail=1; return
    fi
  done
  echo "  ok    exit $rc | $nome"
}

MERGED='{"state":"MERGED","mergeStateStatus":"CLEAN","statusCheckRollup":[],"title":"t","url":"u"}'

echo "── desfechos terminais ──"
caso merged "MERGED → 0" 0 "$MERGED"
caso closed "CLOSED sem merge → 2" 2 '{"state":"CLOSED","mergeStateStatus":"","statusCheckRollup":[],"title":"t","url":"u"}'
caso dirty "conflito (DIRTY) → 3" 3 '{"state":"OPEN","mergeStateStatus":"DIRTY","statusCheckRollup":[],"title":"t","url":"u"}'
req="$(gql validate:FAILURE:true)"
caso vermelho-failure "CI vermelho (conclusion FAILURE) → 4" 4 '{"state":"OPEN","mergeStateStatus":"BLOCKED","statusCheckRollup":[{"name":"validate","conclusion":"FAILURE"}],"title":"t","url":"u"}' 0 "CI VERMELHO [validate]"
req="$(gql_nos '[{"__typename":"StatusContext","context":"ci","state":"error","isRequired":true}]')"
caso vermelho-error "CI vermelho (state ERROR, sem conclusion) → 4" 4 '{"state":"OPEN","mergeStateStatus":"BLOCKED","statusCheckRollup":[{"context":"ci","state":"error"}],"title":"t","url":"u"}' 0 "CI VERMELHO [ci]"

# `cancelled` NÃO casava a regex FAILURE|ERROR até 2026-09-07: o check nunca vira verde e nunca
# vira vermelho, então o watcher ia até o deadline e saía 5 ("segue sem desfecho") — silêncio de
# 45 min sobre um PR que já tinha desfecho. É o falso negativo do #1396 pelo outro lado.
# Regressão viva: o job `validate` rodava a segundos do teto de 15min e 5 de 69 runs saíram assim.
req="$(gql validate:CANCELLED:true)"
caso cancelado "check CANCELLED (estouro de timeout) → 4" 4 '{"state":"OPEN","mergeStateStatus":"BLOCKED","statusCheckRollup":[{"name":"validate","conclusion":"CANCELLED"}],"title":"t","url":"u"}' 0 "CI SEM VEREDITO [validate]"
req="$(gql validate:TIMED_OUT:true)"
caso timed-out "check TIMED_OUT → 4" 4 '{"state":"OPEN","mergeStateStatus":"BLOCKED","statusCheckRollup":[{"name":"validate","conclusion":"TIMED_OUT"}],"title":"t","url":"u"}' 0 "CI SEM VEREDITO [validate]"

echo "── vários runs do MESMO nome no head: vale o mais RECENTE ──"
# Medido no #2507 (2026-09-15): o head `2690f463a` ficou com TRÊS check runs `ordem-entre-edges` no
# rollup — um CANCELLED (a `concurrency` matou o run do push) e dois SUCCESS 6s depois, porque a
# edição do corpo disparou outro. O vigia lia o cancelado e gritava; com o contexto OBRIGATÓRIO isso
# seria exit 4 FALSO em todo PR onde push e edição do corpo se atropelam — o fluxo normal de agente.
req="$(gql_nos '[{"__typename":"CheckRun","name":"validate","conclusion":"CANCELLED","startedAt":"2026-09-15T04:17:49Z","isRequired":true},{"__typename":"CheckRun","name":"validate","conclusion":"SUCCESS","startedAt":"2026-09-15T04:18:35Z","isRequired":true}]')"; depois="$MERGED"
caso req-cancelado-superado "cancelado SUPERADO por run mais novo do mesmo nome + PR mergeia → 0" 0 \
  '{"state":"OPEN","mergeStateStatus":"BLOCKED","statusCheckRollup":[{"name":"validate","conclusion":"CANCELLED","startedAt":"2026-09-15T04:17:49Z"},{"name":"validate","conclusion":"SUCCESS","startedAt":"2026-09-15T04:18:35Z"}],"title":"t","url":"u"}' \
  0 MERGEADO "SUPERADO [validate]"

# O contrário não pode virar verde: quando o CANCELADO é o mais novo, é ele que vale.
req="$(gql_nos '[{"__typename":"CheckRun","name":"validate","conclusion":"SUCCESS","startedAt":"2026-09-15T04:17:49Z","isRequired":true},{"__typename":"CheckRun","name":"validate","conclusion":"CANCELLED","startedAt":"2026-09-15T04:18:35Z","isRequired":true}]')"
caso req-cancelado-mais-novo "cancelado MAIS NOVO que o verde do mesmo nome → 4" 4 \
  '{"state":"OPEN","mergeStateStatus":"BLOCKED","statusCheckRollup":[{"name":"validate","conclusion":"SUCCESS","startedAt":"2026-09-15T04:17:49Z"},{"name":"validate","conclusion":"CANCELLED","startedAt":"2026-09-15T04:18:35Z"}],"title":"t","url":"u"}'

# Sem carimbo não dá para ordenar, e ausente ≠ zero: contam TODOS (fail-closed), como antes do dedupe.
req="$(gql_nos '[{"__typename":"CheckRun","name":"validate","conclusion":"CANCELLED","isRequired":true},{"__typename":"CheckRun","name":"validate","conclusion":"SUCCESS","isRequired":true}]')"
caso req-sem-carimbo "dois runs do mesmo nome SEM carimbo de tempo → fail-closed, 4" 4 \
  '{"state":"OPEN","mergeStateStatus":"BLOCKED","statusCheckRollup":[{"name":"validate","conclusion":"CANCELLED"},{"name":"validate","conclusion":"SUCCESS"}],"title":"t","url":"u"}'

# O stub serve o JSON que mandarem, então nenhum caso acima pega a CONSULTA que esquece o carimbo —
# e sem `startedAt` nela todo run vira "sem carimbo", o fail-closed acima devolve o 4 falso de volta.
if grep -q 'startedAt' "$WATCH" && grep -q 'createdAt' "$WATCH"; then
  echo "  ok    a consulta pede startedAt/createdAt | sem tempo, dedupe por tempo é cego"
else
  echo "  FAIL [req-query-sem-carimbo] o vigia nao pede startedAt/createdAt na consulta | dedupe por tempo sem tempo é cego"; fail=1
fi

echo "── check OBRIGATÓRIO vermelho: é desfecho, e o veredito nomeia só ele (→ 4) ──"
req="$(gql validate:FAILURE:true mutation-check:FAILURE:false)"
caso obrig-vermelho "required vermelho + não-obrigatório vermelho → 4 só com o obrigatório" 4 \
  '{"state":"OPEN","mergeStateStatus":"BLOCKED","statusCheckRollup":[{"name":"validate","conclusion":"FAILURE"},{"name":"mutation-check","conclusion":"FAILURE"}],"title":"t","url":"u"}' \
  0 "CI VERMELHO [validate]"

echo "── check NÃO-obrigatório vermelho: segue vigiando até o desfecho real, e AVISA ──"
# O #2472 (2026-09-14): `validate` — o ÚNICO obrigatório; o auto-merge só espera ele — verde,
# `mutation-check` vermelho, e o vigia saiu 4 "CI VERMELHO" enquanto o PR MERGEAVA (94e2dd881).
OPEN_REQ_VERDE_MUT_VERMELHO='{"state":"OPEN","mergeStateStatus":"BLOCKED","statusCheckRollup":[{"name":"validate","conclusion":"SUCCESS"},{"name":"mutation-check","conclusion":"FAILURE"}],"title":"t","url":"u"}'
req="$(gql validate:SUCCESS:true mutation-check:FAILURE:false)"; depois="$MERGED"
caso nao-obrig-mergeia "required verde + não-obrigatório vermelho + PR mergeia → 0" 0 \
  "$OPEN_REQ_VERDE_MUT_VERMELHO" 0 MERGEADO "AVISO NAO-OBRIGATORIO [mutation-check]"

# Run 34858141569 do mesmo PR: o `mutation-check` caiu (HTTP 504 no setup-deno) com os `needs` do
# `validate` ainda rodando. O `validate` é agregador e só NASCE depois deles (check-run criado às
# 14:09:39Z, 3s após o último need) — nessa janela NENHUM obrigatório existe, e isso é pendente,
# não "consulta falhou". (É aqui que `gh pr checks --required` sai com ERRO.)
req="$(gql mutation-check:FAILURE:false testes:null:false)"; depois="$MERGED"
caso nao-obrig-sem-validate "não-obrigatório vermelho ANTES de o validate existir + PR mergeia → 0" 0 \
  '{"state":"OPEN","mergeStateStatus":"BLOCKED","statusCheckRollup":[{"name":"mutation-check","conclusion":"FAILURE"},{"name":"testes","conclusion":null}],"title":"t","url":"u"}' \
  0 MERGEADO "AVISO NAO-OBRIGATORIO [mutation-check]"

# Sem veredito também só é desfecho no obrigatório: `mutation-check` cancelado não segura o merge.
req="$(gql validate:SUCCESS:true mutation-check:CANCELLED:false)"; depois="$MERGED"
caso nao-obrig-cancelado "não-obrigatório CANCELLED + PR mergeia → 0" 0 \
  '{"state":"OPEN","mergeStateStatus":"BLOCKED","statusCheckRollup":[{"name":"validate","conclusion":"SUCCESS"},{"name":"mutation-check","conclusion":"CANCELLED"}],"title":"t","url":"u"}' \
  0 MERGEADO "AVISO NAO-OBRIGATORIO [mutation-check]"

# Vigília de até 45min com poll de 60s: repetir o MESMO aviso a cada consulta enterra o desfecho
# em ruído. Avisa quando o conjunto muda — 3 consultas com o mesmo vermelho = 1 aviso.
req="$(gql validate:SUCCESS:true mutation-check:FAILURE:false)"; depois="$MERGED"; vira_em=4
caso nao-obrig-aviso-unico "o mesmo não-obrigatório vermelho em 3 consultas → 0" 0 \
  "$OPEN_REQ_VERDE_MUT_VERMELHO" 0 MERGEADO
avisos="$(grep -cF 'AVISO NAO-OBRIGATORIO [' <<<"$saida_caso")"
if [ "$avisos" -eq 1 ]; then echo "  ok    1 aviso em 3 consultas | o aviso não repete a cada poll"
else echo "  FAIL [nao-obrig-aviso-unico] contagem: want 1 aviso, got $avisos | $saida_caso"; fail=1; fi

echo "── consultei e o PR segue sem desfecho (→ 5) ──"
caso open-limpo "OPEN limpo até o deadline → 5" 5 '{"state":"OPEN","mergeStateStatus":"BLOCKED","statusCheckRollup":[{"name":"validate","conclusion":null}],"title":"t","url":"u"}'

# check pendente NÃO pode contar como vermelho (falso-positivo)
caso pendente "check pendente ≠ vermelho → 5" 5 '{"state":"OPEN","mergeStateStatus":"BLOCKED","statusCheckRollup":[{"name":"validate","state":"PENDING"}],"title":"t","url":"u"}'

echo "── NÃO consegui consultar (→ 6, nunca 5) ──"
# Regressão do #1396: "não sei o estado" não pode se disfarçar de "sem desfecho".
rm -f "$GH_STUB_CONTADOR"
out="$(GH_STUB_EXIT=1 GH_STUB_FILE=/dev/null bash "$WATCH" 999 0 1 2>/dev/null)"; rc=$?
if [ "$rc" -eq 6 ]; then echo "  ok    exit 6 | gh falhando sempre (rede/rate-limit) → DESCONHECIDO"
else echo "  FAIL [gh-sempre-falha] exit: want 6, got $rc | gh falhando sempre → DESCONHECIDO"; fail=1; fi

# gh vivo mas devolvendo lixo (JSON ilegível) também é "não sei", não "sem desfecho"
caso json-ilegivel "JSON ilegível → 6" 6 'nao-e-json'

echo "── NÃO sei se o vermelho é obrigatório (→ 6, nunca 5 nem 4) ──"
# Com vermelho no rollup, quem decide o desfecho é a consulta dos obrigatórios. Se ela não
# responde, "não sei se é obrigatório" não pode virar "não é" (seguir e sair 5: fail-open) nem
# "é" (o falso 4 que este contrato matou) — é o 6 de sempre.
OPEN_MUT_VERMELHO='{"state":"OPEN","mergeStateStatus":"BLOCKED","statusCheckRollup":[{"name":"mutation-check","conclusion":"FAILURE"}],"title":"t","url":"u"}'
req_exit=1
caso req-consulta-falha "consulta dos obrigatórios falha (rc=1, corpo vazio) → 6" 6 "$OPEN_MUT_VERMELHO" 0 DESCONHECIDO
req="$(gql mutation-check:FAILURE:false)"; req_exit=1
caso req-parcial "corpo legível MAS rc=1 (GraphQL parcial, com errors) → 6" 6 "$OPEN_MUT_VERMELHO" 0 DESCONHECIDO
req='nao-e-json'
caso req-ilegivel "resposta dos obrigatórios ilegível → 6" 6 "$OPEN_MUT_VERMELHO" 0 DESCONHECIDO
req="$(gql_nos '[{"__typename":"CheckRun","name":"mutation-check","conclusion":"FAILURE"}]')"
caso req-sem-isrequired "check vermelho SEM isRequired (ausente ≠ false) → 6" 6 "$OPEN_MUT_VERMELHO" 0 DESCONHECIDO
req="$(gql mutation-check:FAILURE:false | jq -c '.data.repository.pullRequest.commits.nodes[0].commit.statusCheckRollup.contexts.pageInfo.hasNextPage = true')"
caso req-truncado "resposta truncada (hasNextPage) → 6: o obrigatório pode estar na página 2" 6 "$OPEN_MUT_VERMELHO" 0 DESCONHECIDO

echo "── cartada final: a rede volta antes de desistir ──"
# O caso REAL do #1396: máquina dormiu, o relógio saltou o deadline e as
# primeiras consultas falharam — mas o PR já tinha MERGEADO. O desfecho real
# precisa vencer o timeout, senão o watcher mente sobre um PR que fechou.
caso cartada-merged "falha 2×, a rede volta e acha MERGED → 0" 0 "$MERGED" 2 MERGEADO
caso cartada-open "falha 1×, a rede volta e o PR segue OPEN → 5" 5 '{"state":"OPEN","mergeStateStatus":"BLOCKED","statusCheckRollup":[{"name":"validate","conclusion":null}],"title":"t","url":"u"}' 1 'ainda OPEN'

echo "── uso ──"
# A consulta dos obrigatórios é por NÚMERO (`isRequired(pullRequestNumber:)`, Int!). URL ou
# branch passaria no `gh pr view` e só quebraria no primeiro vermelho — viraria 6 justo quando o
# veredito mais importa. Recusa na entrada.
printf '%s' "$MERGED" > "$stub/cenario.json"; rm -f "$GH_STUB_CONTADOR"
out="$(GH_STUB_FILE="$stub/cenario.json" bash "$WATCH" https://github.com/o/r/pull/999 0 1 2>&1)"; rc=$?
if [ "$rc" -eq 64 ]; then echo "  ok    exit 64 | PR que não é número (URL) → uso errado"
else echo "  FAIL [pr-nao-numerico] exit: want 64, got $rc | PR que não é número (URL) | $out"; fail=1; fi

echo "── relógio saltando (máquina suspendendo) ──"
# A janela quer dizer "N min VIGIANDO", não N min de relógio de parede. Se o
# laptop dorme, `sleep` não avança mas o relógio salta — e o watcher queimava a
# janela inteira tendo consultado 2× (foi o GATILHO do #1396).
#
# O exit code NÃO discrimina aqui (com ou sem o fix dá 5): o observável é
# QUANTAS vezes ele realmente consultou. Janela de 5min com poll de 60s = ~6
# consultas; sem o fix, o 1º sono de 40min encerra tudo na 2ª.
echo 1000000000 > "$tempo/relogio"
rm -f "$GH_STUB_CONTADOR"
printf '%s' '{"state":"OPEN","mergeStateStatus":"BLOCKED","statusCheckRollup":[],"title":"t","url":"u"}' > "$stub/cenario.json"
# Watchdog: com `sleep` stubado (instantâneo), errar a aritmética do salto —
# creditar o elapsed inteiro em vez do EXCESSO — faria o deadline recuar tanto
# quanto avança, e o teste TRAVARIA em vez de falhar. Aqui vira exit 143 = FAIL.
PATH="$tempo:$PATH" PR_WATCH_RELOGIO="$tempo/relogio" SLEEP_SALTO=2400 \
  GH_STUB_FILE="$stub/cenario.json" bash "$WATCH" 999 5 60 >"$tempo/saida" 2>/dev/null &
alvo=$!
( sleep 20 && kill "$alvo" 2>/dev/null ) >/dev/null 2>&1 &
cao=$!
wait "$alvo"; rc=$?
kill "$cao" 2>/dev/null
polls="$(cat "$GH_STUB_CONTADOR" 2>/dev/null || echo 0)"
if [ "$rc" -eq 5 ] && [ "$polls" -ge 5 ]; then
  echo "  ok    exit 5 após $polls polls | 40min de sono por poll não queimam a janela de 5min"
else
  echo "  FAIL [relogio-saltando] exit: want exit 5 com ≥5 polls, got exit $rc com $polls poll(s) | a janela foi queimada pelo relógio, não pela vigília"; fail=1
fi

echo
if [ "$fail" -eq 0 ]; then echo "PASS — todos os casos"; else echo "FALHOU"; fi
exit "$fail"
