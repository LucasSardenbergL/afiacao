#!/usr/bin/env bash
# Teste PG17 do check 'carteira_rebuild' do Sentinela — o FRESCOR do rebuild da carteira —, contra a
# VERSÃO QUE PRODUÇÃO EXECUTA (db/lib/data-health-vivo.sh: snapshot + cadeia viva do trio).
#
# O incidente (2026-07-28): o cron carteira-rebuild-nightly enfileirou, a edge nunca respondeu e
# carteira_assignments ficou 24h congelada com o Sentinela VERDE — o único check da família,
# carteira_scores, mede o SCORING (farmer_client_scores.calculated_at), e o scoring daquela manhã estava
# fresco. Dois writers, dois frescores. A 20260729160000 acrescentou o ramo; esta prova asserta:
#  • o ramo existe EXATAMENTE 1x e os vizinhos seguem, cada um 1x (era o "+1 check" da revisão de julho
#    — num corpo que cresce toda semana, a contagem total não é invariante de ninguém);
#  • o corte é em 30h pelos DOIS lados (31h stale, 29h ok), a carteira vazia é broken (max NULL não vira
#    ok por omissão), a idade é a do rebuild (não fabricada), e a causa provável ensina que
#    cron.job_run_details só prova o ENQUEUE;
#  • os dois writers são independentes nos DOIS sentidos: rebuild fresco com o scoring parado → ok, e o
#    incidente (rebuild de 31h com o scoring recém-recalculado) → carteira_scores ok e carteira_rebuild
#    stale — no compute e em get_data_health(), a RPC que o app lê (useDataHealth → banner/badge), lida
#    COMO o app (papel authenticated, com o ACL de prod). É a ÚNICA superfície do ramo: carteira_rebuild
#    está FORA do v_sources do watchdog e do resumo do heartbeat desde que nasceu (a 20260729160000 só
#    tocou o compute), então não vira e-mail. Esta prova não congela isso: promover a push é decisão de
#    produto em aberto.
#
# O scoring é CONTROLADO à parte, de propósito: o INSERT na carteira dispara
# reconcile_score_owner_from_carteira, que cria a linha do cliente em farmer_client_scores com
# calculated_at DEFAULT now() — o scoring nasceria fresco por efeito colateral da própria carteira, e o
# "dois writers" viraria um INSERT só (achado da revisão independente de 2026-09-30).
#
# Até 2026-09-30 esta prova re-aplicava a 20260729160000 sobre o snapshot e suas sabotagens editavam
# a migration de julho por sed. O re-dump e3d500327 (#1675) absorveu as reescritas seguintes, e o
# CREATE OR REPLACE de julho passou a REVERTER o compute no banco de teste (29 → 25 checks): o A5 "+1
# check" caiu medindo uma versão que ninguém executa (docs/historico/provas-db-mortas-fora-do-nucleo.md).
# Histórico: docs/historico/provas-data-health-revividas.md.
#
# MODOS
#   bash db/test-data-health-carteira-rebuild.sh               # cenário na versão viva → PASS=<n>  FAIL=<m>
#   bash db/test-data-health-carteira-rebuild.sh --falsificar  # controle VERDE + sabotagens → SABOTAGENS: …
# O banco-base (snapshot + cadeia + seed) sobe UMA vez; cada rodada roda num clone dele (CREATE
# DATABASE … TEMPLATE), então controle e sabotagens partem do mesmo estado.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17   # consumido pelo db/lib/pg-harness.sh via source
# shellcheck disable=SC1091  # o gate roda sem -x; o helper e versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/pg-harness.sh"   # exporta PGBIN — fail-CLOSED, confere a major POSITIVAMENTE
PORT="${PGPORT_TEST:-5471}"
TMPD="$(mktemp -d /tmp/pgtest-carteira-rebuild.XXXXXX)"
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

# carteira_assignments tem FK (customer_user_id, owner_user_id) → auth.users: os dois usuários nascem
# no banco-base. E get_data_health() recusa sem auth.uid(): o stub passa a ler o GUC test.uid (o
# idioma da versão anterior desta prova) — nenhuma das funções do trio lê auth.uid().
CLIENTE='11111111-1111-1111-1111-111111111111'
VENDEDOR='22222222-2222-2222-2222-222222222222'
# Desde a 20261005150000 o get_data_health() só atende STAFF (o app que o lê é de staff): o vendedor
# é employee, como na prod. O auth.uid() também lê o JWT (como o do Supabase): a POS daquela migration
# simula uma sessão logada sem papel por request.jwt.claim.sub/claims.
echo "→ seed-base: auth.uid() pelo GUC test.uid (ou o JWT) + os dois usuários da carteira (vendedor = employee)…"
P -v ON_ERROR_STOP=1 -q <<SQL
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE
  AS \$f\$ SELECT COALESCE(nullif(current_setting('test.uid', true), ''),
                         nullif(current_setting('request.jwt.claim.sub', true), ''),
                         nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid \$f\$;
INSERT INTO auth.users (id) VALUES ('$CLIENTE'), ('$VENDEDOR');
INSERT INTO public.user_roles (user_id, role) VALUES ('$VENDEDOR', 'employee');
SQL

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
# A mesma leitura COMO o app: papel authenticated e o uid fixados na MESMA sessão que lê (vários -c,
# um psql só). Sem EXECUTE para authenticated, o valor é o ERRO — e o assert cai com o porquê.
q_app() {
  local ctx=(-c "SET ROLE authenticated" -c "SET test.uid = '$VENDEDOR'" -c "$1") out
  if out="$(P -tA -q "${ctx[@]}" 2>/dev/null)"; then printf '%s' "$out" | tr '\n' ' ' | sed 's/ *$//'
  else printf 'ERRO: %s' "$(P -tA -q "${ctx[@]}" 2>&1 >/dev/null | tr '\n' ' ' | cut -c1-300)"; fi
}
# O PASSO também é assert: SQL que erra fica vermelho (com o erro no log) em vez de derrubar a rodada.
roda() {  # <id> <descrição> <sql>
  local saida
  if saida="$(P -v ON_ERROR_STOP=1 -q -c "$3" 2>&1 >/dev/null)"; then chk "$1" "$2" "ok" "ok"
  else chk "$1" "$2" "ERRO: $(printf '%s' "$saida" | tr '\n' ' ' | cut -c1-300)" "ok"; fi
}
qr() { q "SELECT $1 FROM public._data_health_compute() WHERE source='carteira_rebuild';"; }
qs() { q "SELECT status FROM public._data_health_compute() WHERE source='carteira_scores';"; }
# semear <id> <expressão do last_synced_at> — a carteira com UMA atribuição, sincronizada naquele
# instante, e o SCORING do cliente parado há 40h (upsert explícito: o trigger da carteira o criaria
# fresco). Relativo ao now() do banco, a 1h de cada lado do corte: sem borda de calendário, sem relógio
# do bash.
semear() {
  roda "$1" "carteira sincronizada em $2, scoring parado há 40h" "TRUNCATE public.carteira_assignments CASCADE;
    INSERT INTO public.carteira_assignments (customer_user_id, owner_user_id, source, last_synced_at)
    VALUES ('$CLIENTE', '$VENDEDOR', 'omie', $2);
    INSERT INTO public.farmer_client_scores (customer_user_id, farmer_id, calculated_at)
    VALUES ('$CLIENTE', '$VENDEDOR', now() - interval '40 hours')
    ON CONFLICT (customer_user_id) DO UPDATE SET calculated_at = EXCLUDED.calculated_at;"
}

cenario() {
  PASS=0; FAIL=0; FALHOS=" "
  echo "→ o ramo no corpo vivo"
  chk R1 "carteira_rebuild aparece exatamente 1x" "$(qr "count(*)")" "1"
  # count(*), não count(DISTINCT): um vizinho DUPLICADO também é quebra (o watchdog vivo não roda o laço).
  chk R2 "os vizinhos seguem, 1x cada (saldo_bancario, contas_pagar, contas_receber, carteira_scores, custos_produtos, estoque_reposicao)" \
    "$(q "SELECT count(*) FROM public._data_health_compute() WHERE source IN ('saldo_bancario','contas_pagar','contas_receber','carteira_scores','custos_produtos','estoque_reposicao');")" "6"
  chk R3 "metadados: domínio, base do frescor, esperado de 30h e severidade" \
    "$(qr "domain || '|' || freshness_basis || '|' || expected_max_age_seconds || '|' || severity")" "carteira|last_synced_at|108000|warning"
  chk R4 "a RPC do app NÃO executa para anon (o ACL de prod; um DROP+CREATE o resetaria)" \
    "$(q "SELECT has_function_privilege('anon', 'public.get_data_health()', 'EXECUTE')::text;")" "false"

  echo "→ o frescor do rebuild — o corte em 30h pelos dois lados, com o scoring PARADO"
  semear S1 "now()"
  chk R5 "rebuild de agora → ok (o ramo não lê o scoring, parado há 40h)" "$(qr "status")" "ok"
  semear S2 "now() - interval '31 hours'"
  chk R6 "rebuild de 31h → stale" "$(qr "status")" "stale"
  chk R7 "a idade é a do rebuild (31h ± 10 min), não fabricada" \
    "$(qr "(age_seconds BETWEEN 31*3600 - 600 AND 31*3600 + 600)::text")" "true"
  chk R8 "stale: a causa provável ensina que cron.job_run_details só prova o ENQUEUE" \
    "$(qr "(strpos(probable_cause, 'job_run_details so prova o ENQUEUE') > 0)::text")" "true"
  semear S3 "now() - interval '29 hours'"
  chk R9 "rebuild de 29h → ok (o corte é 30h, não um stale preguiçoso)" "$(qr "status")" "ok"
  roda S4 "esvazia a carteira" "TRUNCATE public.carteira_assignments CASCADE;"
  chk R10 "carteira vazia → broken (max NULL não vira ok por omissão)" "$(qr "status")" "broken"

  echo "→ o incidente de 2026-07-28: rebuild parado há 31h, scoring recalculado agora"
  semear S5 "now() - interval '31 hours'"
  chk R11 "carteira_scores stale com o scoring de 40h (o frescor dele é do SCORING)" "$(qs)" "stale"
  roda S6 "o scoring recalcula agora" "UPDATE public.farmer_client_scores SET calculated_at = now() WHERE customer_user_id = '$CLIENTE';"
  chk R12 "carteira_scores ok (o scoring está mesmo fresco)" "$(qs)" "ok"
  chk R13 "carteira_rebuild stale (o rebuild parou — o Sentinela deixa de ficar verde)" "$(qr "status")" "stale"
  chk R14 "o app vê (authenticated): get_data_health() devolve carteira_rebuild stale" \
    "$(q_app "SELECT status FROM public.get_data_health() WHERE source='carteira_rebuild';")" "stale"
  return 0
}

# SABOTAGENS: <nome>:<VERMELHOS>[:<VERDES>] — os asserts que TÊM de acusar a sabotagem e as
# pré-condições que TÊM de seguir verdes (`,` = E; `|` = OU). Vermelho em outra camada (setup
# quebrado, erro de execução) é quebra, não dente. O corte é sabotado pelos DOIS lados (frouxo e
# apertado), e o `mede_o_scoring` é o incidente de volta — o ramo lendo o writer ERRADO, que cai nos
# dois sentidos (R5: rebuild fresco com scoring parado; R13/R14: o incidente). As `migracao_nova_*`
# são a regressão chegando pela PRÓXIMA migration: as de get_data_health só ficam vermelhas porque
# ela está em DHV_GUARDADAS — fora dela, a cadeia não as pega e a sabotagem reprova.
SABOTAGENS="limiar_frouxo:R6,R13:R5,R10 limiar_apertado:R9:R5,R6 vazia_ok:R10:R6
            ramo_some:R1,R13:R2,R12 vizinho_some:R2:R1,R13 mede_o_scoring:R5,R13,R14:R1,R11,R12
            idade_fabricada:R7:R6 esperado_diverge:R3:R1,R6 causa_sem_enqueue:R8:R6 app_filtra:R14:R13
            migracao_nova_limiar_frouxo:R6,R13:R5,R10 migracao_nova_app_filtra:R14:R13
            migracao_nova_drop_create:R4:R13,R14"

# sabotagem <nome> — troca UM trecho do corpo VIVO no banco da rodada (âncora única, conferida pelo
# dhv_sabotar). Status ≠0 = não aplicou.
sabotagem() {
  local cp='public._data_health_compute()' gd='public.get_data_health()'
  local corte="now() - max(ca.last_synced_at) > interval '30 hours' THEN 'stale'"
  local app="FROM public._data_health_compute() c;" app_sem="FROM public._data_health_compute() c WHERE c.source <> 'carteira_rebuild';"
  case "$1" in
    limiar_frouxo)     dhv_sabotar "$cp" "$corte" "now() - max(ca.last_synced_at) > interval '90 hours' THEN 'stale'" ;;
    limiar_apertado)   dhv_sabotar "$cp" "$corte" "now() - max(ca.last_synced_at) > interval '28 hours' THEN 'stale'" ;;
    vazia_ok)          dhv_sabotar "$cp" "CASE WHEN max(ca.last_synced_at) IS NULL THEN 'broken'" "CASE WHEN max(ca.last_synced_at) IS NULL THEN 'ok'" ;;
    ramo_some)         dhv_sabotar "$cp" "SELECT 'carteira_rebuild'::text, 'carteira'::text," "SELECT 'carteira_rebuild_x'::text, 'carteira'::text," ;;
    vizinho_some)      dhv_sabotar "$cp" "SELECT 'carteira_scores'::text, 'carteira'::text," "SELECT 'carteira_scores_x'::text, 'carteira'::text," ;;
    mede_o_scoring)    dhv_sabotar "$cp" "FROM public.carteira_assignments ca" "FROM (SELECT calculated_at AS last_synced_at FROM public.farmer_client_scores) ca" ;;
    idade_fabricada)   dhv_sabotar "$cp" "EXTRACT(EPOCH FROM now() - max(ca.last_synced_at))::bigint" "0::bigint" ;;
    esperado_diverge)  dhv_sabotar "$cp" "(30*3600)::bigint, 'last_synced_at'" "(36*3600)::bigint, 'last_synced_at'" ;;
    causa_sem_enqueue) dhv_sabotar "$cp" "cron.job_run_details so prova o ENQUEUE" "cron.job_run_details prova a execucao" ;;
    app_filtra)        dhv_sabotar "$gd" "$app" "$app_sem" ;;
    migracao_nova_limiar_frouxo)
                       dhv_migracao_nova "$cp" "$corte" "now() - max(ca.last_synced_at) > interval '90 hours' THEN 'stale'" ;;
    migracao_nova_app_filtra)
                       dhv_migracao_nova "$gd" "$app" "$app_sem" ;;
    # A armadilha do CLAUDE.md: DROP FUNCTION + CREATE devolve o ACL ao default (EXECUTE a PUBLIC);
    # o CREATE OR REPLACE preservaria. A RPC segue funcionando (R13/R14) — só o anon passa a executar.
    migracao_nova_drop_create)
                       dhv_migracao_nova "$gd" "CREATE OR REPLACE FUNCTION public.get_data_health()" \
                         $'DROP FUNCTION public.get_data_health();\nCREATE FUNCTION public.get_data_health()' ;;
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
