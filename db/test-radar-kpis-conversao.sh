#!/usr/bin/env bash
# test-radar-kpis-conversao.sh — prova EXECUTADA (PG17) da 20261031142000_radar_kpis_conversao.sql:
#   `radar_kpis.virou_cliente_mes` conta quem AINDA está em virou_cliente, foi cadastrado no mês de SP pela data
#   imutável `omie_cadastrado_em` e foi CRIADO pelo Radar no Omie (ledger `origem = 'incluir'`, mesmo CNPJ e código).
#   Tirar e devolver num mês novo não reconta; vincular cliente que já existia (`lookup`) não conta; o gate da
#   frente 2 segue de pé.
#
# Monta o schema de PRODUÇÃO como a db/test-radar-contato-integridade.sh (snapshot + ACL + retrato de 29/10 +
# 20261029201200 + desfazer vivo + 20261031111000) e confere o md5 de prod do predecessor ANTES da migration.
# O contador é cumulativo: cada lead entra por vez e o assert lê o KPI depois dele, então cada regra tem o seu assert.
#
# Uso:
#   bash db/test-radar-kpis-conversao.sh               # cenário → PASS=<n>  FAIL=<m>
#   bash db/test-radar-kpis-conversao.sh --falsificar  # controle verde + cada sabotagem tem de ficar VERMELHA
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17   # consumido pelo db/lib/pg-harness.sh via source
# shellcheck disable=SC1091  # o gate roda sem -x; o helper e versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/pg-harness.sh"   # exporta PGBIN — fail-CLOSED, confere a major POSITIVAMENTE
PORT="${PGPORT_TEST:-5495}"
TMPD="$(mktemp -d /tmp/pgtest-radar-kpis.XXXXXX)"
DATA="$TMPD/data"
export LC_ALL=C LANG=C
# O banco de prod roda em UTC: o mês de SP só aparece se a função pedir o fuso (sabotagem `fuso`).
export PGTZ=UTC

MODO=normal
case "${1:-}" in
  '') ;;
  --falsificar) MODO=falsificar ;;
  *) echo "uso: $0 [--falsificar]" >&2; exit 2 ;;
esac

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$TMPD"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k $TMPD -c listen_addresses='' -c autovacuum=off" \
  -l "$TMPD/pg.log" -w start >/dev/null
DB=base
P()   { "$PGBIN/psql" -X -p "$PORT" -h "$TMPD" -U postgres -d "$DB" "$@"; }
adm() { "$PGBIN/psql" -X -p "$PORT" -h "$TMPD" -U postgres -d postgres -v ON_ERROR_STOP=1 -q "$@"; }
adm -c "CREATE DATABASE base;"

FIXTURE="$REPO_ROOT/db/fixtures/radar-acesso-vendedor-prod-20261029.sql"
FIXTURE_DESFAZER="$REPO_ROOT/db/fixtures/radar-contato-integridade-prod-20261031.sql"
MIG_ANT="$REPO_ROOT/supabase/migrations/20261031111000_radar_contato_integridade.sql"
MIG="$REPO_ROOT/supabase/migrations/20261031142000_radar_kpis_conversao.sql"
[ -f "$FIXTURE" ] && [ -f "$FIXTURE_DESFAZER" ] && [ -f "$MIG_ANT" ] && [ -f "$MIG" ] || { echo "fixture ou migration ausente"; exit 1; }
# radar_kpis fica FORA do CV_FUNCOES (a cadeia aplicaria esta migration antes de o predecessor ser conferido). Logo uma
# migration POSTERIOR que mexa nele não entraria aqui e a prova seguiria verde sobre o corpo velho (Codex): recusa.
POSTERIORES="$(cd "$REPO_ROOT/supabase/migrations" && for m in *.sql; do
  [[ "$m" > "$(basename "$MIG")" ]] && grep -l 'radar_kpis' "$m"; done || true)"
if [ -n "$POSTERIORES" ]; then
  echo "PROVA DESATUALIZADA: migration posterior mexe em radar_kpis — leve-a ao harness: $POSTERIORES"; exit 1
fi

# shellcheck disable=SC2034  # consumida pelo db/lib/corpo-vivo.sh, que o shellcheck sem -x não segue
CV_FUNCOES=(cap_radar_prospectar radar_atendimento_expira_em radar_definir_atendimento radar_atendimentos_ativos
            radar_telefone_compartilhado)
# shellcheck disable=SC2034  # consumida pelo db/lib/corpo-vivo.sh, que o shellcheck sem -x não segue
CV_TABELAS=(radar_atendimentos)
# shellcheck disable=SC2329  # chamada pelo cv_montar (db/lib/corpo-vivo.sh), que o shellcheck sem -x não segue
cv_antes_da_cadeia() {
  P -v ON_ERROR_STOP=1 -q -f "$FIXTURE" > /dev/null || return 1
  P -v ON_ERROR_STOP=1 -q -c "DROP FUNCTION IF EXISTS public.radar_contagem_por_municipio(text,text,text,text,boolean,date,date,integer)" > /dev/null || return 1
}
# shellcheck disable=SC1091  # idem: versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/corpo-vivo.sh"
echo "→ banco-base: snapshot + ACL de prod + retrato de 29/10 + 20261029201200 + 20261031111000 + esta migration…"
cv_montar
P -v ON_ERROR_STOP=1 -q -f "$FIXTURE_DESFAZER" > /dev/null
P -v ON_ERROR_STOP=1 -q -1 -f "$MIG_ANT" > /dev/null
P -v ON_ERROR_STOP=1 -q <<'SQL'
DO $md5$
DECLARE v text;
BEGIN
  SELECT md5(p.prosrc) INTO v FROM pg_proc p WHERE p.oid = 'public.radar_kpis()'::regprocedure;
  IF v IS DISTINCT FROM 'de4e4731507e4be5a085c90efdfc0687' THEN
    RAISE EXCEPTION 'HARNESS DIVERGE DE PROD: radar_kpis() (md5 %, prod de4e4731507e4be5a085c90efdfc0687)', v;
  END IF;
END $md5$;
SQL
echo "    · predecessor = prod (md5 de4e4731…)"
# A transação é do executor (db:aplicar); aqui, a do psql -1.
P -v ON_ERROR_STOP=1 -q -1 -f "$MIG" > /dev/null
echo "    · 20261031142000 aplicada (TRAVA → PRE → CREATE → PÓS)"

GER='00000000-0000-0000-0000-00000000b002'     # employee + gerencial (gestor)
FARM='00000000-0000-0000-0000-00000000b003'    # employee + farmer
OPER='00000000-0000-0000-0000-00000000b006'    # employee + operacional: fora do Radar

echo "→ seed: papéis…"
P -v ON_ERROR_STOP=1 -q <<SQL
INSERT INTO auth.users (id) VALUES ('$GER'),('$FARM'),('$OPER');
INSERT INTO public.user_roles (user_id, role) VALUES ('$GER','employee'),('$FARM','employee'),('$OPER','employee');
INSERT INTO public.commercial_roles (user_id, commercial_role) VALUES
  ('$GER','gerencial'),('$FARM','farmer'),('$OPER','operacional');
SQL

PASS=0; FAIL=0
chk() {  # <id> <descrição> <obtido> <esperado>
  if [ "$3" = "$4" ]; then echo "  ✓ $1 $2"; PASS=$((PASS+1))
  else echo "  ✗ $1 $2 — got[$3] exp[$4]"; FAIL=$((FAIL+1)); fi
}
# q_como <uid> <sql> — como o app: SET ROLE e o JWT na MESMA sessão (como o PostgREST).
q_como() {
  local ctx out
  ctx=(-c "SET ROLE authenticated" -c "SET request.jwt.claims = '{\"sub\":\"$1\",\"role\":\"authenticated\"}'" -c "$2")
  if out="$(P -v ON_ERROR_STOP=1 -tA -q "${ctx[@]}" 2>/dev/null)"; then printf '%s' "$out" | tr '\n' ' ' | sed 's/ *$//'
  else printf 'ERRO: %s' "$(P -v ON_ERROR_STOP=1 -tA -q "${ctx[@]}" 2>&1 >/dev/null | tr '\n' ' ' | cut -c1-200)"; fi
}
kpi() { q_como "$FARM" "SELECT public.radar_kpis()->>'virou_cliente_mes'"; }
# lead <cnpj> <código Omie> <cadastrado_em (expressão SQL)> <atualizado_em (expressão SQL)> <status> <origens…>
# Entra como uma linha que o cadastro já gravou (sem a guarda: o seed não é o que se prova); o ledger com as origens.
lead() {
  local cnpj="$1" cod="$2" cad="$3" atu="$4" st="$5"; shift 5
  local o ins=""
  for o in "$@"; do ins="$ins INSERT INTO public.omie_cliente_confirmacoes (account, documento, codigo_cliente, origem) VALUES ('oben','$cnpj','${o#*=}','${o%%=*}');"; done
  P -v ON_ERROR_STOP=1 -q -c "SET session_replication_role = replica;
    INSERT INTO public.radar_empresas (cnpj, razao_social, cnae_principal, ultimo_lote, ja_cliente, omie_codigo_cliente,
                                       omie_cadastrado_em, prospeccao_status, prospeccao_atualizado_em)
      VALUES ('$cnpj', 'LEAD $cnpj', '4744005', '2026-10', true, '$cod', $cad, '$st', $atu); $ins" > /dev/null
}
MES="date_trunc('month', now(), 'America/Sao_Paulo')"
acl() { P -tA -q -c "SELECT has_function_privilege('anon','public.radar_kpis()','EXECUTE') || '|' || has_function_privilege('authenticated','public.radar_kpis()','EXECUTE') || '|' || has_function_privilege('service_role','public.radar_kpis()','EXECUTE')"; }

cenario() {
  echo "── K. o card conta a conversão do mês ──"
  chk K0a "o vendedor lê o KPI (gate da frente 2)"   "$(kpi)" "0"
  chk K0b "fora do Radar: forbidden"                  "$(q_como "$OPER" "SELECT public.radar_kpis()->>'virou_cliente_mes'" | grep -o 'forbidden: radar_prospectar' || true)" "forbidden: radar_prospectar"

  lead 51515151000151 101 "now()" "now()" virou_cliente incluir=101
  chk K1 "criado pelo Radar e cadastrado no mês: conta"           "$(kpi)" "1"
  lead 52525252000152 102 "now()" "now()" virou_cliente lookup=102
  chk K2 "vínculo a cliente que já existia (lookup): não conta"  "$(kpi)" "1"
  lead 53535353000153 103 "$MES - interval '10 days'" "now()" virou_cliente incluir=103
  chk K3 "tirado e devolvido neste mês, cadastrado antes: não reconta" "$(kpi)" "1"
  lead 54545454000154 104 "now()" "now()" descartado incluir=104
  chk K4 "o gestor tirou de virou_cliente: não conta"             "$(kpi)" "1"
  lead 55555555000155 105 "now()" "now()" virou_cliente lookup=105 incluir=105
  chk K5 "lookup e incluir do mesmo código: conta (regra do cadastro)" "$(kpi)" "2"
  # O ledger não tem unicidade: duas linhas 'incluir' iguais contam UMA conversão (JOIN no lugar do EXISTS contaria 2).
  lead 61616161000161 111 "now()" "now()" virou_cliente incluir=111 incluir=111
  chk K5b "duas linhas 'incluir' iguais: conta uma vez"            "$(kpi)" "3"
  lead 56565656000156 106 "now()" "now()" virou_cliente lookup=106 incluir=906
  chk K6 "o 'incluir' é de OUTRO código: não conta"              "$(kpi)" "3"
  lead 57575757000157 107 "$MES - interval '1 second'" "$MES - interval '1 second'" virou_cliente incluir=107
  chk K7 "1 s antes do mês de SP começar: não conta"              "$(kpi)" "3"
  lead 58585858000158 108 "$MES" "$MES" virou_cliente incluir=108
  chk K8 "no 1º instante do mês de SP: conta"                     "$(kpi)" "4"
  # Fuso: 1 h antes do mês de SP é DENTRO do mês UTC (SP = UTC-3) — só conta se a função esquecer o fuso.
  lead 59595959000159 109 "$MES - interval '1 hour'" "$MES - interval '1 hour'" virou_cliente incluir=109
  chk K9 "1 h antes do mês de SP (já no mês UTC): não conta"      "$(kpi)" "4"
  # Teto: a transação aberta antes da virada lê now() do mês velho e enxergaria o cadastro do mês novo.
  lead 62626262000162 112 "date_add($MES, interval '1 month', 'America/Sao_Paulo')" "now()" virou_cliente incluir=112
  chk K10 "cadastro do mês SEGUINTE: não conta neste"              "$(kpi)" "4"

  echo "── E. ponta a ponta pelas RPCs ──"
  P -v ON_ERROR_STOP=1 -q -c "INSERT INTO public.radar_empresas (cnpj, razao_social, cnae_principal, ultimo_lote, ja_cliente)
      VALUES ('60606060000160', 'LEAD E', '4744005', '2026-10', false);
    INSERT INTO public.omie_cliente_confirmacoes (account, documento, codigo_cliente, origem) VALUES ('oben','60606060000160','110','incluir');"
  # A v2 é a que o app chama (a v1 só o service_role executa em prod); ela delega à v1, que grava o cadastro.
  chk E1 "o cadastro pelo Radar conta"                            "$(q_como "$FARM" "SELECT public.radar_registrar_cadastro_omie_v2('60606060000160','110',false)->>'ok'") $(kpi)" "true 5"
  chk E2 "o gestor tira: sai do card"                             "$(q_como "$GER" "SELECT public.registrar_contato_radar('60606060000160','descartado','encerrou')->>'deduped'") $(kpi)" "false 4"
  # Devolver num mês NOVO: o cadastro fica no mês dele, e o carimbo do status vai para hoje.
  P -v ON_ERROR_STOP=1 -q -c "SET session_replication_role = replica;
    UPDATE public.radar_empresas SET omie_cadastrado_em = $MES - interval '20 days' WHERE cnpj = '60606060000160'"
  chk E3 "devolvido num mês novo: não reconta"                    "$(q_como "$GER" "SELECT public.registrar_contato_radar('60606060000160','virou_cliente',NULL)->>'deduped'") $(kpi)" "false 4"

  echo "── G. catálogo ──"
  # A ACL é lida ANTES de reaplicar: a reaplicação repararia um grant indevido antes de alguém olhar (Codex).
  chk G2 "anon sem EXECUTE; authenticated e service_role executam" "$(acl)" "false|true|true"
  chk G1 "re-aplicar a migration é no-op"           "$(P -v ON_ERROR_STOP=1 -q -1 -f "$MIG" >/dev/null 2>&1 && echo ok || echo falhou)" "ok"
  chk G3 "a reaplicação mantém a ACL"               "$(acl)" "false|true|true"
}

# sabotagem <nome> — muda UMA regra no clone. Exit ≠ 0 = a sabotagem não aplicou (falha da falsificação).
sabotagem() {
  local K='public.radar_kpis()'
  case "$1" in
    carimbo_movel) cv_sabotar "$K" "AND e.omie_cadastrado_em >= date_trunc" "AND e.prospeccao_atualizado_em >= date_trunc" ;;
    conta_lookup)  cv_sabotar "$K" "AND c.origem = 'incluir'" "" ;;
    sem_status)    cv_sabotar "$K" "WHERE e.prospeccao_status = 'virou_cliente'" "WHERE true" ;;
    outro_codigo)  cv_sabotar "$K" "AND c.codigo_cliente = e.omie_codigo_cliente" "" ;;
    fuso)          cv_sabotar "$K" "e.omie_cadastrado_em >= date_trunc('month', now(), 'America/Sao_Paulo')" "e.omie_cadastrado_em >= date_trunc('month', now(), 'UTC')" ;;
    limite_aberto) cv_sabotar "$K" "e.omie_cadastrado_em >= date_trunc" "e.omie_cadastrado_em > date_trunc" ;;
    sem_teto)      cv_sabotar "$K" "interval '1 month', 'America/Sao_Paulo')" "interval '100 years', 'America/Sao_Paulo')" ;;
    join_multiplica) cv_sabotar "$K" "FROM public.radar_empresas e" "FROM public.radar_empresas e JOIN public.omie_cliente_confirmacoes cj ON cj.documento = e.cnpj AND cj.codigo_cliente = e.omie_codigo_cliente AND cj.origem = 'incluir'" ;;
    acl_anon)      P -v ON_ERROR_STOP=1 -q -c "GRANT EXECUTE ON FUNCTION public.radar_kpis() TO anon" > /dev/null ;;
    sem_gate)      cv_sabotar "$K" "IF NOT (COALESCE(private.cap_radar_prospectar(v_uid), false)) THEN" "IF false THEN" ;;
    *) echo "sabotagem desconhecida: $1" >&2; return 1 ;;
  esac
}
# <sabotagem>:<ids que TÊM de virar vermelho>[:<ids que têm de seguir verdes>]
SABOTAGENS="carimbo_movel:K3:K2
conta_lookup:K2:K1
sem_status:K4:K3
outro_codigo:K6:K5
fuso:K9:K6
limite_aberto:K8:K7
sem_teto:K10:K9
join_multiplica:K5b:K5
sem_gate:K0b:K0a
acl_anon:G2:G1"

rodada() {
  adm -c "DROP DATABASE IF EXISTS rodada;" -c "CREATE DATABASE rodada TEMPLATE base;" || return 4
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
# Sabotar sem CONTROLE verde na MESMA invocação é teatro: o controle roda primeiro e, vermelho, aborta antes
# da primeira sabotagem.
echo "══ CONTROLE (sem sabotagem) — tem de ficar VERDE ══"
rodada "" > "$TMPD/controle.log" 2>&1
executados_controle=$((PASS + FAIL))
if [ "$FAIL" -ne 0 ] || [ "$PASS" -lt 1 ]; then
  echo "  ❌ CONTROLE VERMELHO (PASS=$PASS FAIL=$FAIL) — abortando antes de sabotar"
  tail -30 "$TMPD/controle.log"
  exit 1
fi
echo "  ✅ controle verde: $PASS asserts"

falhas=0
for item in $SABOTAGENS; do
  sab="${item%%:*}"; resto="${item#*:}"
  verm="${resto%%:*}"; verdes=""
  [ "$resto" = "$verm" ] || verdes="${resto#*:}"
  log="$TMPD/sab-$sab.log"
  PASS=0; FAIL=0
  rc=0; rodada "$sab" > "$log" 2>&1 || rc=$?
  motivo=""
  if [ "$rc" -ne 0 ]; then
    motivo=" sabotagem não aplicou (exit $rc): $({ grep -m1 -E 'ERRO|ERROR|cv_|SABOTAGEM' "$log" || true; } | cut -c1-200)"
  elif [ "$((PASS + FAIL))" -ne "$executados_controle" ]; then
    motivo=" a rodada executou $((PASS + FAIL)) asserts e o controle $executados_controle: vermelho de aborto, não de assert"
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

total="$(wc -w <<<"$SABOTAGENS" | tr -d ' ')"
echo "SABOTAGENS: $((total - falhas)) vermelhas / $falhas falhas"
[ "$falhas" -eq 0 ]
