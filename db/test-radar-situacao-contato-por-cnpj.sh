#!/usr/bin/env bash
# test-radar-situacao-contato-por-cnpj.sh — prova EXECUTADA (PG17) da 20261031190000_radar_situacao_contato_por_cnpj.sql:
#   no descarte de lead pela RFB (trecho (b) de `radar_aplicar_situacao`), cada CNPJ que muda para `descartado` ganha
#   EXATAMENTE um contato do sistema, cada contato corresponde a uma mudança real de estado, e o `status_anterior` é o
#   da linha TRAVADA — também quando o vendedor escreve entre o retrato (tmp_rfb_irreg) e o descarte.
#
# Monta o schema de PRODUÇÃO como a db/test-radar-kpis-conversao.sh (snapshot + ACL + retrato de 29/10 + desfazer vivo +
# 20261031111000, com o trigger `radar_empresas_status_guard`), carrega o predecessor de 20261019200000 e confere o
# md5(prosrc) de prod dos 3 corpos ANTES da migration.
#
# As duas corridas são DETERMINÍSTICAS (nenhum pg_sleep decide a ordem):
#   R1 — entre o retrato e o (b): um gancho de harness em `radar_rfb_descricao` (chamada DENTRO do CREATE TEMP TABLE do
#        retrato, cujo snapshot já está fixo) espera um advisory lock do "vendedor". O vendedor só escreve depois de VER
#        o cron parado ali (pg_stat_activity) e solta o lock ao sair. É o traço do Codex: X vira cliente, Y é reaberto,
#        W vira ja_cliente. O corpo antigo passava (3 contatos = 3 mudanças, conjuntos diferentes).
#   R2 — durante o (b): o vendedor segura a linha (transação aberta) e só faz COMMIT depois de VER o cron esperando a
#        trava. X2 vai a em_conversa (o contato tem de dizer em_conversa), Z2 vira cliente (não pode ser descartado).
#
# Uso:
#   bash db/test-radar-situacao-contato-por-cnpj.sh               # cenário → PASS=<n>  FAIL=<m>
#   bash db/test-radar-situacao-contato-por-cnpj.sh --falsificar  # controle verde + cada sabotagem tem de ficar VERMELHA
#   LOCALE_TESTE=pt_BR.UTF-8 bash db/test-radar-situacao-contato-por-cnpj.sh   # a mesma prova sob pt_BR (os DOIS locales)
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17   # consumido pelo db/lib/pg-harness.sh via source
# shellcheck disable=SC1091  # o gate roda sem -x; o helper e versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/pg-harness.sh"   # exporta PGBIN — fail-CLOSED, confere a major POSITIVAMENTE
PORT="${PGPORT_TEST:-5496}"
TMPD="$(mktemp -d /tmp/pgtest-radar-contato-cnpj.XXXXXX)"
DATA="$TMPD/data"
export LC_ALL="${LOCALE_TESTE:-C}" LANG="${LOCALE_TESTE:-C}"
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
MIG_INTEG="$REPO_ROOT/supabase/migrations/20261031111000_radar_contato_integridade.sql"
MIG_PRED="$REPO_ROOT/supabase/migrations/20261019200000_radar_situacao_cadastral.sql"
MIG="$REPO_ROOT/supabase/migrations/20261031190000_radar_situacao_contato_por_cnpj.sql"
for f in "$FIXTURE" "$FIXTURE_DESFAZER" "$MIG_INTEG" "$MIG_PRED" "$MIG"; do
  [ -f "$f" ] || { echo "fixture ou migration ausente: $f"; exit 1; }
done
# radar_aplicar_situacao fica FORA do CV_FUNCOES (o predecessor tem de ser conferido antes da migration). Logo uma
# migration POSTERIOR que mexa nele não entraria aqui e a prova seguiria verde sobre o corpo velho: recusa.
POSTERIORES="$(cd "$REPO_ROOT/supabase/migrations" && for m in *.sql; do
  [[ "$m" > "$(basename "$MIG")" ]] && grep -lE 'radar_aplicar_situacao([^_]|$)' "$m"; done || true)"
if [ -n "$POSTERIORES" ]; then
  echo "PROVA DESATUALIZADA: migration posterior mexe em radar_aplicar_situacao — leve-a ao harness: $POSTERIORES"; exit 1
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
echo "→ banco-base: snapshot + ACL de prod + retrato de 29/10 + desfazer vivo + 20261031111000 + predecessor RFB…"
cv_montar
P -v ON_ERROR_STOP=1 -q -f "$FIXTURE_DESFAZER" > /dev/null
P -v ON_ERROR_STOP=1 -q -1 -f "$MIG_INTEG" > /dev/null

# O predecessor: os 2 corpos da 20261019200000 que o retrato não traz (a descrição e o finalize) + a ACL dela. Só os
# blocos CREATE … $$; (a migration inteira recriaria radar_docs_clientes por cima da versão de prod do retrato).
PRED_SQL="$TMPD/predecessor.sql"
awk '/^CREATE OR REPLACE FUNCTION public\.(radar_rfb_descricao|radar_aplicar_situacao)\(/{p=1} p{print} p && /^\$\$;$/{p=0}' \
  "$MIG_PRED" > "$PRED_SQL"
grep -E '^(REVOKE|GRANT) .*public\.radar_aplicar_situacao\(text, timestamptz\)' "$MIG_PRED" >> "$PRED_SQL"
[ "$(grep -c '^CREATE OR REPLACE FUNCTION' "$PRED_SQL")" = 2 ] || { echo "não extraí os 2 corpos do predecessor"; exit 9; }
P -v ON_ERROR_STOP=1 -q -1 -f "$PRED_SQL" > /dev/null
P -v ON_ERROR_STOP=1 -q <<'SQL'
DO $md5$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
      ('public.radar_aplicar_situacao(text,timestamptz)', '73e049de2f5ec345daf0c8db81099e98'),
      ('public.radar_rfb_descricao(text,date,text,text)', 'ec7507207ea2717a3aa07d513ae8b9e5'),
      ('public.radar_docs_clientes()',                    'b162657d88d851992c5e36f27b1d777c')) v(fn, prod) LOOP
    IF (SELECT md5(prosrc) FROM pg_proc WHERE oid = r.fn::regprocedure) IS DISTINCT FROM r.prod THEN
      RAISE EXCEPTION 'HARNESS DIVERGE DE PROD: % (prod %)', r.fn, r.prod;
    END IF;
  END LOOP;
END $md5$;
-- O predecessor guardado para o G4 (corpo novo sem o trecho (b) = predecessor sem o trecho (b)).
CREATE TABLE prova.predecessor AS
  SELECT prosrc FROM pg_proc WHERE oid = 'public.radar_aplicar_situacao(text,timestamptz)'::regprocedure;
SQL
echo "    · predecessor = prod (radar_aplicar_situacao 73e049de…, radar_rfb_descricao ec750720…, radar_docs_clientes b162657d…)"
# A transação é do executor (db:aplicar); aqui, a do psql -1.
P -v ON_ERROR_STOP=1 -q -1 -f "$MIG" > /dev/null
echo "    · 20261031190000 aplicada (TRAVA → PRE → CREATE → ACL → PÓS)"

# Gancho de HARNESS (não é da migration): a descrição é chamada dentro do CREATE TEMP TABLE do retrato, depois de o
# snapshot dele estar fixo. Espera o advisory lock 4242 (o "vendedor" de R1 o segura) e devolve o texto de prod.
P -v ON_ERROR_STOP=1 -q <<'SQL'
ALTER FUNCTION public.radar_rfb_descricao(text, date, text, text) SET SCHEMA prova;
CREATE FUNCTION public.radar_rfb_descricao(p_situacao text, p_data date, p_motivo_codigo text, p_motivo_descricao text)
RETURNS text LANGUAGE plpgsql VOLATILE AS $g$
BEGIN
  PERFORM pg_advisory_xact_lock_shared(4242);
  RETURN prova.radar_rfb_descricao(p_situacao, p_data, p_motivo_codigo, p_motivo_descricao);
END $g$;
-- O finalize como o cron o vê: o retorno (leads_descartados) ou a SQLSTATE. Não é `WHEN OTHERS THEN 'OK'`: o código
-- volta e o assert o compara EXATO; o erro desfaz o que a chamada fez (o cron real falha inteiro do mesmo jeito).
CREATE FUNCTION prova.aplicar(p_lote text, p_agora timestamptz) RETURNS text LANGUAGE plpgsql AS $f$
BEGIN
  RETURN 'ok:' || (public.radar_aplicar_situacao(p_lote, p_agora) ->> 'leads_descartados');
EXCEPTION WHEN OTHERS THEN
  RETURN 'ERRO:' || SQLSTATE;
END $f$;
SQL

SIS='00000000-0000-0000-0000-00000000ad0f'     # usuário-sistema do cron da RFB
HUM='00000000-0000-0000-0000-00000000b003'     # um vendedor (dono de um contato humano no seed)

# emp <cnpj> <status> <ja_cliente> <lote da foto ('' = sem foto)> [código Omie confirmado no ledger]
# Entra como a linha já estava (sem a guarda: o seed não é o que se prova). A foto, quando dada, é a do lote (08 em
# 01/03/2026), então o (a) não toca a linha — é o caso em que o cron não a trava antes do (b).
emp() {
  local cnpj="$1" st="$2" jc="$3" lote="$4" cod="${5:-}" foto="NULL, NULL, NULL" led=""
  [ -z "$lote" ] || foto="'08', DATE '2026-03-01', '$lote'"
  [ -z "$cod" ] || led="INSERT INTO public.omie_cliente_confirmacoes (account, documento, codigo_cliente, origem) VALUES ('oben','$cnpj','$cod','incluir');"
  P -v ON_ERROR_STOP=1 -q -c "SET session_replication_role = replica;
    INSERT INTO public.radar_empresas (cnpj, razao_social, cnae_principal, ultimo_lote, ja_cliente, omie_codigo_cliente,
                                       prospeccao_status, rfb_situacao, rfb_situacao_data, rfb_situacao_lote)
      VALUES ('$cnpj', 'EMP $cnpj', '4744005', '2026-10', $jc, NULLIF('$cod',''), '$st', $foto); $led" > /dev/null
}
# sit <cnpj> <lote> <situação> — a linha do dump da RFB.
sit() {
  P -v ON_ERROR_STOP=1 -q -c "INSERT INTO public.radar_situacao_cadastral (cnpj, lote, situacao, data_situacao, motivo_codigo, motivo_descricao)
    VALUES ('$1', '$2', '$3', DATE '2026-03-01', '01', 'EXTINCAO POR ENCERRAMENTO')" > /dev/null
}
# estado <cnpj> → status|nº de contatos 'descartado' do sistema|status_anterior deles|dono
estado() {
  P -tA -q -c "SELECT e.prospeccao_status || '|' || count(c.id) || '|' || COALESCE(string_agg(c.status_anterior, ',' ORDER BY c.created_at), '∅')
                 || '|' || COALESCE(e.prospeccao_contato_id::text, '∅')
               FROM public.radar_empresas e
               LEFT JOIN public.radar_contatos c ON c.cnpj = e.cnpj AND c.criado_por = '$SIS' AND c.acao = 'descartado'
              WHERE e.cnpj = '$1' GROUP BY e.cnpj, e.prospeccao_status, e.prospeccao_contato_id"
}
aplicar() { P -tA -q -c "SELECT prova.aplicar('$1', '$2'::timestamptz)"; }
acl() { P -tA -q -c "SELECT string_agg(has_function_privilege(r, 'public.radar_aplicar_situacao(text,timestamptz)', 'EXECUTE')::text, '|' ORDER BY o)
                       FROM (VALUES (1,'public'),(2,'anon'),(3,'authenticated'),(4,'service_role')) v(o, r)"; }

# sessao <arquivo> <application_name> <-c sql…> — uma sessão em background (o "vendedor" ou o cron).
sessao() {
  local out="$1" app="$2"; shift 2
  PGAPPNAME="$app" P -v ON_ERROR_STOP=1 -tA -q -c "SET client_min_messages = warning" "$@" > "$out" 2>&1 &
}
# esperar_app <application_name> — até a sessão anunciar que está pronta (máx. 10 s); imprime 1 ou 0.
esperar_app() {
  local i
  for i in $(seq 1 100); do
    [ "$(P -tA -q -c "SELECT count(*) FROM pg_stat_activity WHERE application_name = '$1'")" -ge 1 ] && { printf 1; return; }
    sleep 0.1; : "$i"
  done
  printf 0
}
# O "vendedor" só age depois de VER o cron parado esperando trava (até 10 s); devolve t/f — o assert de que a corrida
# aconteceu na ordem declarada (sem isto, uma prova verde podia não ter corrido nada). pg_stat_activity é um retrato
# que vale até o fim da transação: sem pg_stat_clear_snapshot(), o laço (e o vendedor do R2, que está em BEGIN) relê
# a foto velha e nunca vê o cron parar.
VE_CRON_PARADO="DO \$v\$ BEGIN FOR i IN 1..200 LOOP
    PERFORM pg_stat_clear_snapshot();
    EXIT WHEN EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name = 'cron' AND wait_event_type = 'Lock');
    PERFORM pg_sleep(0.05); END LOOP; END \$v\$;"
VIU_CRON_PARADO="SELECT pg_stat_clear_snapshot(); SELECT 'viu=' || EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name = 'cron' AND wait_event_type = 'Lock')"

PASS=0; FAIL=0
chk() {  # <id> <descrição> <obtido> <esperado>
  if [ "$3" = "$4" ]; then echo "  ✓ $1 $2"; PASS=$((PASS+1))
  else echo "  ✗ $1 $2 — got[$3] exp[$4]"; FAIL=$((FAIL+1)); fi
}

cenario() {
  echo "── B. as regras do descarte, sem corrida (lote 2026-10) ──"
  emp 10000000000110 a_contatar false ''
  P -v ON_ERROR_STOP=1 -q -c "SET session_replication_role = replica;
    INSERT INTO public.radar_contatos (id, cnpj, acao, criado_por, status_anterior, created_at)
      VALUES ('00000000-0000-0000-0000-0000000c0001', '10000000000110', 'a_contatar', '$HUM', 'a_contatar', '2026-10-01');
    UPDATE public.radar_empresas SET prospeccao_contato_id = '00000000-0000-0000-0000-0000000c0001' WHERE cnpj = '10000000000110';"
  emp 10000000000210 a_contatar true  ''                       # cliente: ja_cliente
  emp 10000000000310 a_contatar false ''                       # cliente: documento nas fontes
  P -v ON_ERROR_STOP=1 -q -c "INSERT INTO public.omie_clientes_nao_vinculados (empresa, omie_codigo_cliente, cnpj_cpf, razao_social, synced_at)
    VALUES ('oben', 310, '10.000.000/0003-10', 'CLIENTE FONTE', '2026-10-01')" > /dev/null
  emp 10000000000410 virou_cliente false '' 410
  emp 10000000000510 descartado false ''
  emp 10000000000610 a_contatar false ''                       # situação 02
  emp 10000000000710 a_contatar false '2026-11'                # foto mais nova que o lote: não vigente
  for c in 10000000000110 10000000000210 10000000000310 10000000000410 10000000000510 10000000000710 10000000000810; do
    sit "$c" 2026-10 08
  done
  sit 10000000000610 2026-10 02
  chk B0 "o finalize do lote: 1 lead descartado"                  "$(aplicar 2026-10 '2026-10-05 06:05+00')" "ok:1"
  chk B1 "lead 08: descartado, 1 contato, status_anterior dele, dono zerado pela guarda" \
                                                                   "$(estado 10000000000110)" "descartado|1|a_contatar|∅"
  chk B1b "o motivo do descarte é o texto da RFB"                  "$(P -tA -q -c "SELECT descarte_motivo FROM public.radar_empresas WHERE cnpj = '10000000000110'")" \
                                                                   "RFB: BAIXADA em 01/03/2026 (01 — EXTINCAO POR ENCERRAMENTO)"
  chk B2 "cliente (ja_cliente): intocado"                          "$(estado 10000000000210)" "a_contatar|0|∅|∅"
  chk B3 "cliente (documento nas fontes): intocado"                "$(estado 10000000000310)" "a_contatar|0|∅|∅"
  chk B4 "virou_cliente: intocado"                                 "$(estado 10000000000410)" "virou_cliente|0|∅|∅"
  chk B5 "descartado: intocado, sem contato novo"                  "$(estado 10000000000510)" "descartado|0|∅|∅"
  chk B6 "situação 02: intocado"                                   "$(estado 10000000000610)" "a_contatar|0|∅|∅"
  chk B7 "lote mais velho que a foto: intocado"                    "$(estado 10000000000710)" "a_contatar|0|∅|∅"
  chk B8 "reaplicar o lote: 0 descartes, 0 contatos novos"         "$(aplicar 2026-10 '2026-10-06 06:05+00')|$(estado 10000000000110)" "ok:0|descartado|1|a_contatar|∅"

  echo "── R1. o vendedor escreve ENTRE o retrato e o descarte (lote 2026-11) ──"
  emp 20000000000111 a_contatar false 2026-11 111   # X: vira cliente depois do retrato
  emp 20000000000211 descartado false 2026-11       # Y: reaberto depois do retrato
  emp 20000000000311 a_contatar false 2026-11       # W: vira ja_cliente depois do retrato
  emp 20000000000411 em_conversa false ''           # K: ninguém mexe (e o (a) atualiza a foto dele)
  for c in 20000000000111 20000000000211 20000000000311 20000000000411; do sit "$c" 2026-11 08; done
  sessao "$TMPD/r1-vend.out" vendedor -c "SELECT pg_advisory_lock(4242)" -c "SET application_name = 'vendedor_pronto'" -c "$VE_CRON_PARADO" -c "$VIU_CRON_PARADO" \
    -c "UPDATE public.radar_empresas SET prospeccao_status = 'virou_cliente' WHERE cnpj = '20000000000111'" \
    -c "UPDATE public.radar_empresas SET prospeccao_status = 'a_contatar', descarte_motivo = NULL WHERE cnpj = '20000000000211'" \
    -c "UPDATE public.radar_empresas SET ja_cliente = true WHERE cnpj = '20000000000311'"
  local pv=$! pc
  esperar_app vendedor_pronto > /dev/null
  sessao "$TMPD/r1-cron.out" cron -c "SELECT prova.aplicar('2026-11', '2026-11-05 06:05+00')"
  pc=$!
  wait "$pv" || true; wait "$pc" || true
  chk R1a "o vendedor escreveu com o cron parado DENTRO do retrato" "$(grep -o 'viu=[tf]' "$TMPD/r1-vend.out" || echo 'sem-sinal')" "viu=t"
  chk R1b "o finalize termina: 2 descartes (Y e K)"               "$(tr -d '\n ' < "$TMPD/r1-cron.out")" "ok:2"
  chk R1c "X virou cliente depois do retrato: sem descarte e sem contato" "$(estado 20000000000111)" "virou_cliente|0|∅|∅"
  chk R1d "Y reaberto depois do retrato: descartado com o contato" "$(estado 20000000000211)" "descartado|1|a_contatar|∅"
  chk R1e "W virou ja_cliente depois do retrato: intocado"         "$(estado 20000000000311)" "a_contatar|0|∅|∅"
  chk R1f "K: descartado com o contato"                            "$(estado 20000000000411)" "descartado|1|em_conversa|∅"
  chk R1g "reaplicar o lote: 0"                                    "$(aplicar 2026-11 '2026-11-06 06:05+00')" "ok:0"

  echo "── R2. o vendedor segura a linha DURANTE o descarte (lote 2026-12) ──"
  emp 30000000000112 a_contatar false 2026-12       # X2: vai a em_conversa na transação do vendedor
  emp 30000000000212 a_contatar false 2026-12 212   # Z2: vira cliente na transação do vendedor
  for c in 30000000000112 30000000000212; do sit "$c" 2026-12 08; done
  sessao "$TMPD/r2-vend.out" vendedor -c "BEGIN" \
    -c "UPDATE public.radar_empresas SET prospeccao_status = 'em_conversa' WHERE cnpj = '30000000000112'" \
    -c "UPDATE public.radar_empresas SET prospeccao_status = 'virou_cliente' WHERE cnpj = '30000000000212'" \
    -c "SET application_name = 'vendedor_pronto2'" -c "$VE_CRON_PARADO" -c "$VIU_CRON_PARADO" -c "COMMIT"
  pv=$!
  esperar_app vendedor_pronto2 > /dev/null
  sessao "$TMPD/r2-cron.out" cron -c "SELECT prova.aplicar('2026-12', '2026-12-05 06:05+00')"
  pc=$!
  wait "$pv" || true; wait "$pc" || true
  chk R2a "o cron esperou a trava do vendedor"                     "$(grep -o 'viu=[tf]' "$TMPD/r2-vend.out" || echo 'sem-sinal')" "viu=t"
  chk R2b "X2: descartado, status_anterior = o da linha travada (em_conversa)" "$(estado 30000000000112)" "descartado|1|em_conversa|∅"
  chk R2c "Z2 virou cliente com o cron esperando: intocado"        "$(estado 30000000000212)" "virou_cliente|0|∅|∅"
  chk R2d "o finalize termina: 1 descarte"                         "$(tr -d '\n ' < "$TMPD/r2-cron.out")" "ok:1"

  echo "── P. a postcondição compara POR CNPJ, não os totais (lote 2027-01) ──"
  # Gancho só do harness: o contato de P1 é gravado em P2. 1 estado e 1 contato, CNPJs diferentes — a contagem passa,
  # a postcondição tem de abortar (25000) e a chamada inteira volta atrás (Codex P2: sem isto, toda sabotagem que a
  # alcança também mudava os totais).
  emp 40000000000113 a_contatar false 2027-01       # P1: o lead descartado
  emp 40000000000213 descartado false ''            # P2: recebe o contato desviado (existe por causa da FK)
  sit 40000000000113 2027-01 08
  P -v ON_ERROR_STOP=1 -q -c "CREATE FUNCTION prova.desvia_contato() RETURNS trigger LANGUAGE plpgsql AS \$f\$
      BEGIN NEW.cnpj := '40000000000213'; RETURN NEW; END \$f\$;
    CREATE TRIGGER zz_prova_desvia_contato BEFORE INSERT ON public.radar_contatos
      FOR EACH ROW WHEN (NEW.cnpj = '40000000000113') EXECUTE FUNCTION prova.desvia_contato();" > /dev/null
  chk P1 "contato em outro CNPJ, mesmos totais: a postcondição aborta" "$(aplicar 2027-01 '2027-01-05 06:05+00')" "ERRO:25000"
  P -v ON_ERROR_STOP=1 -q -c "DROP TRIGGER zz_prova_desvia_contato ON public.radar_contatos" > /dev/null
  chk P2 "P1 volta atrás: sem descarte e sem contato"              "$(estado 40000000000113)" "a_contatar|0|∅|∅"
  chk P3 "P2 sem o contato desviado"                               "$(estado 40000000000213)" "descartado|0|∅|∅"

  echo "── G. catálogo ──"
  # A ACL é lida ANTES de reaplicar: a reaplicação repararia um grant indevido antes de alguém olhar (lição do #3447).
  chk G1 "PUBLIC, anon e authenticated não executam; service_role executa" "$(acl)" "false|false|false|true"
  chk G2 "re-aplicar a migration é no-op"           "$(P -v ON_ERROR_STOP=1 -q -1 -f "$MIG" >/dev/null 2>&1 && echo ok || echo falhou)" "ok"
  chk G3 "a reaplicação mantém a ACL"               "$(acl)" "false|false|false|true"
  # Fora do trecho (b), o corpo vivo é o predecessor de prod byte a byte: as regras de (a) e (c) que as provas
  # vigentes (situacao-cadastral, situacao-por-cron) asseveram seguem valendo para este corpo.
  chk G4 "fora do trecho (b), o corpo é o predecessor"  "$(P -tA -q -c "
    WITH c(fonte, src) AS (
      SELECT 'novo', prosrc FROM pg_proc WHERE oid = 'public.radar_aplicar_situacao(text,timestamptz)'::regprocedure
      UNION ALL SELECT 'pred', prosrc FROM prova.predecessor),
    f AS (SELECT fonte, strpos(src, '  -- (b) LEAD irregular') AS b, strpos(src, '  -- (c) CLIENTE irregular NOVO') AS cc, src FROM c)
    SELECT CASE WHEN min(b) = 0 OR min(cc) = 0 THEN 'marcador ausente'
                WHEN count(DISTINCT left(src, b - 1) || substr(src, cc)) = 1 THEN 'igual' ELSE 'diverge' END FROM f")" "igual"
}

# sabotagem <nome> — muda UMA camada no clone. Exit ≠ 0 = a sabotagem não aplicou (falha da falsificação).
sabotagem() {
  local F='public.radar_aplicar_situacao(text,timestamptz)'
  case "$1" in
    # O contato volta a nascer do RETRATO (o corpo antigo); a postcondição tem de abortar a corrida R1 (3 contatos × 2
    # estados — os totais também diferem; o dente de "por CNPJ" é o P1 com post_por_total).
    contato_do_retrato) cv_sabotar "$F" "      SELECT e.cnpj, 'descartado', e.descricao, c_sistema, e.status_anterior, p_agora
        FROM estado e" "      SELECT i.cnpj, 'descartado', i.descricao, c_sistema, i.prospeccao_status, p_agora
        FROM tmp_rfb_irreg i WHERE i.no_radar AND i.vigente AND NOT i.cliente
         AND i.prospeccao_status NOT IN ('descartado', 'virou_cliente')" ;;
    # …e sem a postcondição: os asserts por CNPJ têm de pegar sozinhos.
    contato_do_retrato_sem_post)
                   cv_sabotar "$F" "      SELECT e.cnpj, 'descartado', e.descricao, c_sistema, e.status_anterior, p_agora
        FROM estado e" "      SELECT i.cnpj, 'descartado', i.descricao, c_sistema, i.prospeccao_status, p_agora
        FROM tmp_rfb_irreg i WHERE i.no_radar AND i.vigente AND NOT i.cliente
         AND i.prospeccao_status NOT IN ('descartado', 'virou_cliente')" || return 1
                   cv_sabotar "$F" "    IF v_diverge THEN" "    IF false THEN" ;;
    # A postcondição volta a comparar os TOTAIS (o corpo antigo): o desvio do P1 (1 = 1) passa.
    post_por_total) cv_sabotar "$F" "    IF v_diverge THEN" "    IF v_leads <> v_leads_upd THEN" ;;
    status_do_retrato) cv_sabotar "$F" "re.prospeccao_status AS status_anterior" "i.prospeccao_status AS status_anterior" ;;
    sem_trava)     cv_sabotar "$F" "
         FOR UPDATE OF re" "" ;;
    ja_cliente_do_retrato) cv_sabotar "$F" "
         AND NOT COALESCE(re.ja_cliente, false)" "" ;;
    sem_status_vivo) cv_sabotar "$F" "
         AND re.prospeccao_status NOT IN ('descartado', 'virou_cliente')" "" ;;
    descarta_cliente_fonte) cv_sabotar "$F" "WHERE i.no_radar AND i.vigente AND NOT i.cliente
         AND NOT COALESCE" "WHERE i.no_radar AND i.vigente
         AND NOT COALESCE" ;;
    fora_de_b)     cv_sabotar "$F" "LIMIT c_teto_linhas) n;" "LIMIT 100000) n;" ;;
    acl_anon)      P -v ON_ERROR_STOP=1 -q -c "GRANT EXECUTE ON FUNCTION public.radar_aplicar_situacao(text, timestamptz) TO anon" > /dev/null ;;
    *) echo "sabotagem desconhecida: $1" >&2; return 1 ;;
  esac
}
# <sabotagem>:<ids que TÊM de virar vermelho>[:<ids que têm de seguir verdes>]
SABOTAGENS="contato_do_retrato:R1b:B1
contato_do_retrato_sem_post:R1c,R1e:B1
post_por_total:P1:B1
status_do_retrato:R2b:R2c
sem_trava:R2c:B1
ja_cliente_do_retrato:R1e:R1d
sem_status_vivo:B4:B1
descarta_cliente_fonte:B3:B2
fora_de_b:G4:G1
acl_anon:G1:G4"

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
