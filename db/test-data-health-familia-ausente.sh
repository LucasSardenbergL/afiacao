#!/usr/bin/env bash
# Teste PG17 do check 'vendas_familia_ausente' do Sentinela — o compute, a LISTA que vai no e-mail
# (_vendas_familia_ausente_lista_email) e o push pelo watchdog —, contra a VERSÃO QUE PRODUÇÃO EXECUTA
# (db/lib/data-health-vivo.sh: snapshot + cadeia viva do trio). Semeia família NULL / vazia / só-espaço
# × ativo × conta e asserta:
#  • compute: conta NULLIF(btrim(familia),'') × COALESCE(ativo,false) × account IN (oben, colacor) —
#    vazia e só-espaço contam, inativo e colacor_sc não; a mensagem traz o breakdown oben/colacor;
#    stale/warning com n>0, ok/info com n=0;
#  • helper: lista cada produto que conta como '• [conta] descrição (cód. X)', sob o cabeçalho, e
#    EXCLUI os que não contam — o MESMO predicado do compute, provado no MESMO seed (F4 × L9: a lista
#    que diverge da contagem manda o founder classificar o produto errado); cap honesto "… e mais N";
#    ordem por conta e, dentro dela, por descrição; NULL com n=0;
#  • E2E: numa rodada COMPLETA do watchdog vivo, o alerta abre em fin_alertas SEM a lista e o e-mail
#    sai COM ela, depois da mensagem original; o heartbeat traz o source no resumo; com n=0 o watchdog
#    dispensa o alerta.
#
# Até 2026-09-30 eram duas provas, esta e a test-familia-ausente-lista-email.sh, e as duas re-aplicavam
# a 20260604150000 (junho) sobre o snapshot: morreram no setup quando o re-dump #1509 absorveu o drop de
# omie_clientes (docs/historico/provas-db-mortas-fora-do-nucleo.md). Mesmo subindo, mediriam o watchdog
# de junho (INSERT direto em fin_alertas), não o de hoje (episódio com anti-flap). Foram fundidas porque
# semeiam o mesmo catálogo e o invariante que as une — o helper lista o que o compute conta — só se prova
# com os dois no mesmo estado. Histórico: docs/historico/provas-data-health-revividas.md.
#
# O E2E não re-dispara depois de dispensar DE PROPÓSITO: o _data_health_episodio vivo não re-enfileira
# e-mail de episódio dispensado há menos de 2h (anti-flap), então "reabriu e não mandou e-mail" mediria
# o anti-flap, não este check (medido no #2605, docs/historico/provas-tint-apodrecidas.md).
#
# MODOS
#   bash db/test-data-health-familia-ausente.sh               # cenário na versão viva → PASS=<n>  FAIL=<m>
#   bash db/test-data-health-familia-ausente.sh --falsificar  # controle VERDE + sabotagens → SABOTAGENS: …
# O banco-base (snapshot + cadeia + seed) sobe UMA vez; cada rodada roda num clone dele (CREATE
# DATABASE … TEMPLATE), então controle e sabotagens partem do mesmo estado e nenhuma herda histórico.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17   # consumido pelo db/lib/pg-harness.sh via source
# shellcheck disable=SC1091  # o gate roda sem -x; o helper e versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/pg-harness.sh"   # exporta PGBIN — fail-CLOSED, confere a major POSITIVAMENTE
PORT="${PGPORT_TEST:-5441}"
TMPD="$(mktemp -d /tmp/pgtest-familia.XXXXXX)"
DATA="$TMPD/data"
export LC_ALL=C LANG=C

MODO=normal
case "${1:-}" in
  '') ;;
  --falsificar) MODO=falsificar ;;
  *) echo "uso: $0 [--falsificar]" >&2; exit 2 ;;
esac

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMPD"; }
trap cleanup EXIT

# Socket num diretório exclusivo e sem TCP: a porta deixa de ser recurso disputado entre provas.
"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k $TMPD -c listen_addresses='' -c autovacuum=off" \
  -l "$TMPD/pg.log" -w start >/dev/null
DB=base
P()   { "$PGBIN/psql" -X -p "$PORT" -h "$TMPD" -U postgres -d "$DB" "$@"; }
adm() { "$PGBIN/psql" -X -p "$PORT" -h "$TMPD" -U postgres -d postgres -v ON_ERROR_STOP=1 -q "$@"; }
adm -c "CREATE DATABASE base;"

# shellcheck disable=SC1091  # idem: versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/data-health-vivo.sh"
echo "→ banco-base: stubs + prelude + snapshot + MV + ACL de prod + cadeia viva do trio…"
dhv_montar

echo "→ seed-base (5 contam: NULL, vazia, só-espaço × oben/colacor; 3 NÃO contam, cada uma por um motivo)…"
P -v ON_ERROR_STOP=1 -q <<'SQL'
INSERT INTO public.omie_products (omie_codigo_produto, codigo, descricao, account, familia, ativo) VALUES
  (1001,'PRD1001','Faca reta',   'oben',       NULL,        true),   -- CONTA (NULL)
  (1002,'PRD1002','Rodizio gel', 'oben',       '',          true),   -- CONTA (vazia → NULLIF)
  (1003,'PRD1003','Primer cinza','oben',       '   ',       true),   -- CONTA (só espaço → btrim)
  (1004,'PRD1004','Lixa grao',   'oben',       'ABRASIVOS', true),   -- NÃO: tem família
  (1005,'PRD1005','Item velho',  'oben',       NULL,        false),  -- NÃO: inativo
  (2001,'PRD2001','Cliente X',   'colacor',    NULL,        true),   -- CONTA (NULL)
  (2002,'PRD2002','Cliente Y',   'colacor',    '',          true),   -- CONTA (vazia)
  (3001,'PRD3001','Servico Z',   'colacor_sc', NULL,        true);   -- NÃO: colacor_sc é serviço, fora do wizard
SQL

# A rodada que ACABOU de rodar foi completa e sem falha (o marcador de sucesso só avança assim, e é
# gravado DEPOIS do last_run_at da mesma rodada). `ultimo_erro` vai no valor para o log dizer o porquê.
SQL_RODADA="SELECT CASE WHEN last_success_at >= last_run_at AND checks_falhos = 0 AND ultimo_erro IS NULL
                        THEN 'completa'
                        ELSE 'incompleta: avaliados=' || COALESCE(checks_avaliados::text, '?') || ' falhos='
                             || COALESCE(checks_falhos::text, '?') || ' erro=' || COALESCE(ultimo_erro, '') END
              FROM public.data_health_watchdog_estado WHERE id;"
ALERTA="FROM public.fin_alertas WHERE company='oben' AND tipo='data_health_vendas_familia_ausente'"
EMAIL="FROM public.fornecedor_alerta WHERE titulo='[Saúde de dados] vendas_familia_ausente'"
MSG_COMPUTE="(SELECT message FROM public._data_health_compute() WHERE source='vendas_familia_ausente')"

PASS=0; FAIL=0; FALHOS=" "
chk() {  # <id> <descrição> <obtido> <esperado>
  if [ "$3" = "$4" ]; then echo "  ✓ $1 $2"; PASS=$((PASS+1))
  else echo "  ✗ $1 $2 — got[$3] exp[$4]"; FAIL=$((FAIL+1)); FALHOS="$FALHOS$1 "; fi
}
# Valor da consulta (só SELECT). O stderr fica FORA do valor: um NOTICE do compute poluiria todo assert.
# Na falha, o valor é o erro (re-executa a leitura para capturá-lo) — assert vermelho com o porquê.
q() {
  local out
  if out="$(P -tA -c "$1" 2>/dev/null)"; then printf '%s' "$out" | tr '\n' ' ' | sed 's/ *$//'
  else printf 'ERRO: %s' "$(P -tA -c "$1" 2>&1 >/dev/null | tr '\n' ' ' | cut -c1-300)"; fi
}
# O PASSO também é assert: SQL que erra fica vermelho (com o erro no log) em vez de derrubar a rodada.
roda() {  # <id> <descrição> <sql>
  local saida
  if saida="$(P -v ON_ERROR_STOP=1 -q -c "$3" 2>&1 >/dev/null)"; then chk "$1" "$2" "ok" "ok"
  else chk "$1" "$2" "ERRO: $(printf '%s' "$saida" | tr '\n' ' ' | cut -c1-300)" "ok"; fi
}
qf() { q "SELECT $1 FROM public._data_health_compute() WHERE source='vendas_familia_ausente';"; }
lista() { q "SELECT ($1)::text FROM (SELECT public._vendas_familia_ausente_lista_email($2) AS l) s;"; }
bullets() { lista "length(l) - length(replace(l, '•', ''))" "$1"; }

cenario() {
  PASS=0; FAIL=0; FALHOS=" "
  echo "→ compute (n=5: oben 3 + colacor 2)"
  chk F1 "vendas_familia_ausente aparece 1x" "$(qf "count(*)")" "1"
  chk F2 "status stale com n>0"              "$(qf "status")"   "stale"
  chk F3 "severity warning com n>0"          "$(qf "severity")" "warning"
  chk F4 "conta 5: NULL, vazia e só-espaço × ativo × oben/colacor (inativo e colacor_sc NÃO)" \
    "$(qf "substring(message from ': ([0-9]+) produto')")" "5"
  chk F5 "breakdown: oben 3"    "$(qf "substring(message from '[(]oben ([0-9]+) ')")" "3"
  chk F6 "breakdown: colacor 2" "$(qf "substring(message from ' colacor ([0-9]+)[)]')")" "2"

  echo "→ helper — conteúdo, formato e o MESMO predicado do compute"
  chk L1 "cabeçalho na 1ª linha" \
    "$(lista "split_part(l, E'\n', 1) = 'Produtos sem família (classifique no Omie):'" 50)" "true"
  chk L2 "lista a de família NULL como '• [oben] desc (cód. X)'" "$(lista "l LIKE '%• [oben] Faca reta (cód. PRD1001)%'" 50)" "true"
  chk L3 "lista a de família VAZIA (NULLIF)"                   "$(lista "l LIKE '%• [oben] Rodizio gel (cód. PRD1002)%'" 50)" "true"
  chk L4 "lista a de família SÓ-ESPAÇO (btrim)"                "$(lista "l LIKE '%• [oben] Primer cinza (cód. PRD1003)%'" 50)" "true"
  chk L5 "lista a colacor com o prefixo da conta"              "$(lista "l LIKE '%• [colacor] Cliente X (cód. PRD2001)%'" 50)" "true"
  chk L6 "NÃO lista a que TEM família (PRD1004)"  "$(lista "l LIKE '%PRD1004%'" 50)" "false"
  chk L7 "NÃO lista a INATIVA (PRD1005)"          "$(lista "l LIKE '%PRD1005%'" 50)" "false"
  chk L8 "NÃO lista a colacor_sc (PRD3001)"       "$(lista "l LIKE '%PRD3001%'" 50)" "false"
  chk L9 "5 bullets — o mesmo n que o compute conta (F4)" "$(bullets 50)" "5"
  echo "→ helper — cap honesto e ordem estável"
  chk L10 "p_limit=2 mostra 2 bullets" "$(bullets 2)" "2"
  chk L11 "p_limit=2 anuncia '… e mais 3 produto(s)'" "$(lista "l LIKE '%… e mais 3 produto(s)%'" 2)" "true"
  chk L12 "sem o cap excedido, NÃO anuncia 'e mais'" "$(lista "l LIKE '%e mais%'" 50)" "false"
  # strpos > 0 antes de comparar: a conta ausente dá 0, e "0 < n" aprovaria a ordem por vacuidade.
  chk L13 "ordem por conta: [colacor] antes de [oben]" \
    "$(lista "strpos(l, '[colacor]') > 0 AND strpos(l, '[colacor]') < strpos(l, '[oben]')" 50)" "true"
  chk L14 "dentro da conta, por descrição: Faca reta antes de Rodizio gel" \
    "$(lista "strpos(l, 'Faca reta') > 0 AND strpos(l, 'Faca reta') < strpos(l, 'Rodizio gel')" 50)" "true"

  echo "→ E2E pelo watchdog vivo (n=5)"
  roda E1 "watchdog executou" "SELECT public.data_health_watchdog();"
  chk W1 "rodada COMPLETA e sem falha (pré-condição do E2E)" "$(q "$SQL_RODADA")" "completa"
  chk W2 "PUSH: alerta ativo em fin_alertas" "$(q "SELECT count(*) $ALERTA AND dismissed_at IS NULL;")" "1"
  chk W3 "PUSH: e-mail enfileirado"          "$(q "SELECT count(*) $EMAIL AND status='pendente_notificacao';")" "1"
  chk W4 "o e-mail TEM a lista no corpo"     "$(q "SELECT count(*) $EMAIL AND mensagem LIKE '%• [oben] Faca reta (cód. PRD1001)%';")" "1"
  chk W5 "o e-mail começa pela mensagem original (o resumo com o breakdown)" \
    "$(q "SELECT count(*) $EMAIL AND starts_with(mensagem, $MSG_COMPUTE);")" "1"
  chk W6 "o ALERTA leva só a mensagem — a lista (volátil) fica no e-mail" \
    "$(q "SELECT count(*) $ALERTA AND dismissed_at IS NULL AND mensagem = $MSG_COMPUTE;")" "1"
  roda E2 "heartbeat executou" "SELECT public.fin_sync_heartbeat();"
  chk H1 "heartbeat: o resumo traz vendas_familia_ausente com o status" \
    "$(q "SELECT count(*) FROM public.fornecedor_alerta WHERE titulo LIKE '[Watchdog%' AND mensagem LIKE '%vendas_familia_ausente: stale%';")" "1"

  echo "→ mutação: classifica o catálogo (n=0)"
  roda M1 "preenche a família" "UPDATE public.omie_products SET familia='CLASSIFICADO' WHERE account IN ('oben','colacor');"
  chk Z1 "compute volta a ok"       "$(qf "status")"   "ok"
  chk Z2 "severity volta a info"    "$(qf "severity")" "info"
  chk Z3 "helper devolve NULL (nada a anexar)" "$(lista "l IS NULL" 50)" "true"
  roda E3 "watchdog (n=0) executou" "SELECT public.data_health_watchdog();"
  chk Z4 "rodada COMPLETA e sem falha (pré-condição da dispensa)" "$(q "$SQL_RODADA")" "completa"
  chk Z5 "o watchdog dispensou o alerta (0 ativos)" "$(q "SELECT count(*) $ALERTA AND dismissed_at IS NULL;")" "0"
  return 0
}

# SABOTAGENS: <nome>:<VERMELHOS>[:<VERDES>] — os asserts que TÊM de acusar a sabotagem e as
# pré-condições que TÊM de seguir verdes (`,` = E; `|` = OU). Vermelho em outra camada (setup
# quebrado, rodada incompleta, erro de execução) é quebra, não dente. As do compute mantêm o helper
# verde (L9) e as do helper mantêm o compute verde (F4): é o par que prova o MESMO predicado dos dois
# lados, porque a divergência entre eles é o defeito que a lista existe para não ter.
SABOTAGENS="compute_sem_btrim:F4,F5:F1,F2,L9 compute_sem_nullif:F4,F6:F1,F2,L9
            compute_conta_inativo:F4,F5:F1,L9 compute_conta_colacor_sc:F4:F5,F6,L9
            compute_nunca_dispara:F2,W2:F4,W1
            lista_sem_btrim:L4,L9:L2,F4 lista_conta_inativo:L7,L9:L2,F4 lista_conta_colacor_sc:L8,L9:L2,F4
            lista_sem_cap:L11:L10 lista_ordem_invertida:L13,L14:L2,L9
            email_sem_lista:W4:W1,W3,W5 email_sem_mensagem:W5:W3,W4 alerta_com_lista:W6:W2,W4
            push_sem_familia:W2,W3:W1 nao_dispensa:Z5:Z4,W2 resumo_sem_familia:H1:E2,W2
            migracao_nova_sem_push:W2,W3:W1"

# O trecho do watchdog que monta o e-mail tem aspas simples e barras (E'\n\n'): entre aspas duplas,
# `\\n` vira barra + n, que é o texto do corpo. Heredoc dentro de "$(…)" não serve: com o `(` aberto
# do COALESCE, o bash 3.2 do macOS não fecha o parse — e, com o trap de EXIT, sai 0 sem rodar nada
# (docs/historico/evidencia-positiva-shell.md, nº 22).
ANC_EMAIL="THEN r.message || COALESCE(E'\\n\\n' || public._vendas_familia_ausente_lista_email(50)"
TROCA_EMAIL="THEN COALESCE(E'\\n\\n' || public._vendas_familia_ausente_lista_email(50)"

# sabotagem <nome> — troca UM trecho do corpo VIVO no banco da rodada (âncora única, conferida pelo
# dhv_sabotar). Status ≠0 = não aplicou.
sabotagem() {
  local cp='public._data_health_compute()' wd='public.data_health_watchdog()' hb='public.fin_sync_heartbeat()'
  local hl='public._vendas_familia_ausente_lista_email(integer)'
  local pred="NULLIF(btrim(familia), '') IS NULL AND COALESCE(ativo, false)"
  local push="'omie_tipo_produto_oben','vendas_familia_ausente',"
  case "$1" in
    compute_sem_btrim)        dhv_sabotar "$cp" "$pred" "NULLIF(familia, '') IS NULL AND COALESCE(ativo, false)" ;;
    compute_sem_nullif)       dhv_sabotar "$cp" "$pred" "btrim(familia) IS NULL AND COALESCE(ativo, false)" ;;
    compute_conta_inativo)    dhv_sabotar "$cp" "$pred" "NULLIF(btrim(familia), '') IS NULL AND true" ;;
    compute_conta_colacor_sc) dhv_sabotar "$cp" "COALESCE(ativo, false) AND account IN ('oben','colacor')" "COALESCE(ativo, false) AND account IN ('oben','colacor','colacor_sc')" ;;
    compute_nunca_dispara)    dhv_sabotar "$cp" "CASE WHEN fa.n = 0 THEN 'ok' ELSE 'stale' END" "'ok'::text" ;;
    lista_sem_btrim)          dhv_sabotar "$hl" "WHERE NULLIF(btrim(familia), '') IS NULL" "WHERE NULLIF(familia, '') IS NULL" ;;
    lista_conta_inativo)      dhv_sabotar "$hl" "AND COALESCE(ativo, false)" "AND true" ;;
    lista_conta_colacor_sc)   dhv_sabotar "$hl" "AND account IN ('oben','colacor')" "AND account IN ('oben','colacor','colacor_sc')" ;;
    lista_sem_cap)            dhv_sabotar "$hl" "count(*) FILTER (WHERE rn <= GREATEST(p_limit, 0))::int AS n_mostrados" "count(*)::int AS n_mostrados" ;;
    lista_ordem_invertida)    dhv_sabotar "$hl" "ORDER BY account, descricao, codigo" "ORDER BY account DESC, descricao DESC, codigo" ;;
    email_sem_lista)          dhv_sabotar "$wd" "public._vendas_familia_ausente_lista_email(50)" "NULL::text" ;;
    email_sem_mensagem)       dhv_sabotar "$wd" "$ANC_EMAIL" "$TROCA_EMAIL" ;;
    alerta_com_lista)         dhv_sabotar "$wd" "r.message, v_msg_email," "v_msg_email, v_msg_email," ;;
    push_sem_familia)         dhv_sabotar "$wd" "$push" "'omie_tipo_produto_oben'," ;;
    nao_dispensa)             dhv_sabotar "$wd" "WHERE company = 'oben' AND tipo = 'data_health_' || r.source AND dismissed_at IS NULL;" "WHERE false;" ;;
    resumo_sem_familia)       dhv_sabotar "$hb" "'vendas_familia_ausente'," "" ;;
    migracao_nova_sem_push)   dhv_migracao_nova "$wd" "$push" "'omie_tipo_produto_oben'," ;;
    *) echo "sabotagem desconhecida: $1" >&2; return 1 ;;
  esac
}

# rodada <sabotagem|""> — clona o banco-base e roda o cenário no clone. Exit 3 = a sabotagem não
# aplicou (âncora sumiu do corpo vivo): isso é FALHA da falsificação, nunca dente.
rodada() {
  adm -c "DROP DATABASE IF EXISTS rodada;" -c "CREATE DATABASE rodada TEMPLATE base;"
  DB=rodada
  if [ -n "$1" ]; then sabotagem "$1" || return 3; fi
  cenario
}

if [ "$MODO" = normal ]; then
  rodada ""
  echo ""
  echo "════════════════════════════════════════"
  echo "  PASS=$PASS  FAIL=$FAIL"
  echo "════════════════════════════════════════"
  [ "$FAIL" -eq 0 ]
  exit $?
fi

# ── --falsificar ───────────────────────────────────────────────────────────────────────────────
# Sabotar sem CONTROLE verde na MESMA invocação é teatro: uma suíte sempre-vermelha (ambiente
# quebrado, snapshot que não sobe) aprovaria todas as sabotagens. O controle roda primeiro, aqui, e
# um controle vermelho aborta ANTES da primeira sabotagem.
echo "══ CONTROLE (versão viva, sem sabotagem) — tem de ficar VERDE ══"
rodada "" > "$TMPD/controle.log" 2>&1
executados_controle=$((PASS + FAIL))
if [ "$FAIL" -ne 0 ] || [ "$PASS" -lt 1 ]; then
  echo "  ❌ CONTROLE VERMELHO (PASS=$PASS FAIL=$FAIL) — abortando antes de sabotar"
  tail -30 "$TMPD/controle.log"
  exit 1
fi
echo "  ✅ controle verde: $PASS asserts"

# O vermelho que conta é o do assert DECLARADO, verde no controle e vermelho na rodada; os verdes
# declarados seguem verdes; a rodada executa tantos asserts quanto o controle; e vermelho com ERRO
# de execução não é dente (docs/historico/falsificacao-exit-nao-e-dente.md).
falhas=0
for item in $SABOTAGENS; do
  sab="${item%%:*}"; resto="${item#*:}"
  verm="${resto%%:*}"; verdes=""
  [ "$resto" = "$verm" ] || verdes="${resto#*:}"
  log="$TMPD/sab-$sab.log"
  rc=0; rodada "$sab" > "$log" 2>&1 || rc=$?
  motivo=""
  if [ "$rc" -ne 0 ]; then
    motivo=" sabotagem não aplicou (exit $rc): $({ grep -m1 -E 'ERRO|ERROR|dhv_' "$log" || true; } | cut -c1-200)"
  elif [ "$((PASS + FAIL))" -ne "$executados_controle" ]; then
    motivo=" a rodada executou $((PASS + FAIL)) asserts e o controle $executados_controle: vermelho de aborto, não de assert"
  elif grep -Eq '^  ✗ .*got\[ERRO: ' "$log"; then
    motivo=" vermelho com ERRO de execução: a medição que erra cai pelo erro, não pelo valor"
  else
    for id in ${verm//,/ }; do
      if ! grep -Eq "^  ✓ ($id) " "$TMPD/controle.log" || ! grep -Eq "^  ✗ ($id) " "$log"; then
        motivo="$motivo $id não virou (verde no controle → vermelho aqui);"
      fi
    done
    for id in ${verdes//,/ }; do
      grep -Eq "^  ✓ ($id) " "$log" || motivo="$motivo $id ficou VERMELHO (pré-condição: a sabotagem quebrou outra camada);"
    done
  fi
  if [ -z "$motivo" ]; then
    echo "  ✅ $sab — vermelho no assert declarado ($verm)"
  else
    falhas=$((falhas+1)); echo "  ❌ $sab —$motivo"
    { grep -E '^  ✗ ' "$log" || true; } | head -8 | sed 's/^/       /'
  fi
done

# Recibo EXCLUSIVO deste modo (o normal nunca o emite): é como o runner confere que a flag não foi
# ignorada.
total="$(wc -w <<<"$SABOTAGENS" | tr -d ' ')"
echo "SABOTAGENS: $((total - falhas)) vermelhas / $falhas falhas"
[ "$falhas" -eq 0 ]
