#!/usr/bin/env bash
# Prova PG17 de `fin_sync_watchdog_diario` (migration 20261013120000): e-mail diário só com problema,
# "OK" curto às segundas (horário de Brasília), detalhe de causa/correção por problema.
# Aplica a migration REAL sobre um esquema mínimo (fin_alertas, fornecedor_alerta, cron.job e um
# `_data_health_compute` de mentira lido de tabela) e executa a função.
#
#   bash db/test-watchdog-diario-so-problema.sh > /tmp/t.log 2>&1; echo "exit=$?"
#   SABOTAGEM=<nome> bash db/test-watchdog-diario-so-problema.sh   # tem de ficar VERMELHA
#   bash db/test-watchdog-diario-so-problema.sh --falsificar        # controle verde + cada sabotagem vermelha no assert dela
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIG="$REPO_ROOT/supabase/migrations/20261013120000_watchdog_diario_so_problema.sql"

if [ "${1:-}" = "--falsificar" ]; then
  # <sabotagem>:<assert que TEM de acusá-la>
  SABOTAGENS="ok_todo_dia:A1 ok_em_utc:A8 sem_como_corrigir:A3c conta_dispensado:A4 sem_fallback_compute:A6 acl_aberta:A9"
  LOGDIR="$(mktemp -d "/tmp/falsifica-watchdog-diario.XXXXXX")"
  echo "══ CONTROLE ══"
  if ! SABOTAGEM="" bash "$0" > "$LOGDIR/controle.log" 2>&1; then
    echo "❌ controle VERMELHO — falsificação abortada (log: $LOGDIR/controle.log)"; tail -15 "$LOGDIR/controle.log"; exit 1
  fi
  echo "✅ controle verde"
  falhas=0
  for par in $SABOTAGENS; do
    s="${par%%:*}"; a="${par##*:}"
    if SABOTAGEM="$s" bash "$0" > "$LOGDIR/$s.log" 2>&1; then
      echo "❌ $s: suíte ficou VERDE"; falhas=$((falhas+1)); continue
    fi
    if ! grep -q "SABOTAGEM ATIVA: $s" "$LOGDIR/$s.log"; then
      echo "❌ $s: sabotagem NÃO aplicou"; falhas=$((falhas+1)); continue
    fi
    if grep -q "^FAIL $a " "$LOGDIR/$s.log"; then
      echo "✅ $s → $a vermelho"
    else
      echo "❌ $s: vermelho, mas não no $a (log: $LOGDIR/$s.log)"; falhas=$((falhas+1))
    fi
  done
  n_sab=0; for _ in $SABOTAGENS; do n_sab=$((n_sab+1)); done
  echo "SABOTAGENS: $((n_sab - falhas)) vermelhas / $falhas falhas"   # recibo exigido por db/roda-nucleo-ci.sh
  [ "$falhas" -eq 0 ] && exit 0 || exit 1
fi

export PGVER=17
# shellcheck disable=SC1091  # caminho resolvido em runtime a partir de REPO_ROOT
. "$REPO_ROOT/db/lib/pg-harness.sh"
PORT="${PGPORT_TEST:-5487}"
DATA="$(mktemp -d "/tmp/pgtest-watchdog-diario.XXXXXX")/data"
export LC_ALL=C LANG=C
MIG_USADA="$(dirname "$DATA")/mig.sql"
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

cp "$MIG" "$MIG_USADA"
sabotar() { # $1 = de, $2 = para (literal)
  python3 -I - "$MIG_USADA" "$1" "$2" <<'PY'
import sys
p, de, para = sys.argv[1:]
s = open(p, encoding="utf-8").read()
if de not in s:
    sys.exit("padrao ausente: " + de)
open(p, "w", encoding="utf-8").write(s.replace(de, para))
PY
}
case "${SABOTAGEM:-}" in
  "") ;;
  ok_todo_dia)          sabotar "IF extract(isodow FROM v_local) = 1 THEN" "IF true THEN" ;;
  ok_em_utc)            sabotar "extract(isodow FROM v_local)" "extract(isodow FROM p_agora AT TIME ZONE 'UTC')" ;;
  sem_como_corrigir)    sabotar "E'\n   Como corrigir: '||(d->>'how_to_fix')" "''" ;;
  conta_dispensado)     sabotar "WHERE (tipo LIKE 'sync_%' OR tipo LIKE 'data_health_%') AND dismissed_at IS NULL;" "WHERE (tipo LIKE 'sync_%' OR tipo LIKE 'data_health_%');" ;;
  sem_fallback_compute) sabotar "EXCEPTION WHEN OTHERS THEN
    v_det := '{}'::jsonb;" "EXCEPTION WHEN division_by_zero THEN
    v_det := '{}'::jsonb;" ;;
  acl_aberta)           sabotar "FROM PUBLIC, anon, authenticated;" "FROM anon;" ;;
  *) echo "sabotagem desconhecida: $SABOTAGEM"; exit 9 ;;
esac
[ -n "${SABOTAGEM:-}" ] && echo "⚠️  SABOTAGEM ATIVA: $SABOTAGEM"

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$(dirname "$DATA")/pg.log" -w start >/dev/null
P()  { "$PGBIN/psql" -X -v ON_ERROR_STOP=1 -p "$PORT" -h /tmp -U postgres -d postgres "$@"; }
Pq() { P -qAt "$@"; }

P -q <<'SQL'
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN;
CREATE TABLE public.fin_alertas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company text NOT NULL CHECK (company IN ('oben','colacor','colacor_sc')),
  tipo text NOT NULL,
  severidade text NOT NULL CHECK (severidade IN ('info','aviso','critico')),
  mensagem text NOT NULL,
  criado_em timestamptz NOT NULL DEFAULT now(),
  dismissed_at timestamptz);
CREATE TABLE public.fornecedor_alerta (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa text NOT NULL, tipo text NOT NULL CHECK (tipo IN ('outro')),
  severidade text NOT NULL CHECK (severidade IN ('info','atencao','urgente')),
  titulo text NOT NULL, mensagem text NOT NULL,
  status text CHECK (status IN ('pendente_notificacao','notificado','falha_notificacao','ignorado')),
  criado_em timestamptz NOT NULL DEFAULT now());
-- compute de mentira: lê de tabela; GUC teste.compute_quebra=on faz ele lançar
CREATE TABLE public._dh_fake (source text, status text, message text, probable_cause text, how_to_fix text, last_error text);
CREATE FUNCTION public._data_health_compute()
 RETURNS TABLE(source text, domain text, status text, age_seconds bigint, expected_max_age_seconds bigint, freshness_basis text, message text, last_error text, probable_cause text, how_to_fix text, severity text)
 LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('teste.compute_quebra', true) = 'on' THEN RAISE EXCEPTION 'compute explodiu'; END IF;
  RETURN QUERY SELECT f.source, 'x'::text, f.status, 0::bigint, 0::bigint, 'x'::text, f.message, f.last_error, f.probable_cause, f.how_to_fix, 'high'::text FROM public._dh_fake f;
END $$;
CREATE SCHEMA cron;
CREATE TABLE cron.job (jobid bigint PRIMARY KEY, jobname text, schedule text, command text, active boolean DEFAULT true);
INSERT INTO cron.job VALUES (1, 'fin-sync-heartbeat', '0 11 * * 1-5', 'SELECT public.fin_sync_heartbeat()', true);
CREATE FUNCTION cron.schedule(p_jobname text, p_schedule text, p_command text) RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v bigint;
BEGIN
  SELECT jobid INTO v FROM cron.job WHERE jobname = p_jobname;
  IF v IS NULL THEN
    SELECT COALESCE(max(jobid),0)+1 INTO v FROM cron.job;
    INSERT INTO cron.job VALUES (v, p_jobname, p_schedule, p_command, true);
  ELSE
    UPDATE cron.job SET schedule = p_schedule, command = p_command WHERE jobid = v;
  END IF;
  RETURN v;
END $$;
SQL

P -q -f "$MIG_USADA" >/dev/null
P -q -f "$MIG_USADA" >/dev/null   # idempotente

PASS=0; FAIL=0
eq() { if [ "$2" = "$3" ]; then echo "PASS $1"; PASS=$((PASS+1)); else echo "FAIL $1 — obtido [$2] esperado [$3]"; FAIL=$((FAIL+1)); fi; }
tem() { case "$2" in *"$3"*) echo "PASS $1"; PASS=$((PASS+1));; *) echo "FAIL $1 — sem [$3]"; FAIL=$((FAIL+1));; esac; }
nao_tem() { case "$2" in *"$3"*) echo "FAIL $1 — contém [$3]"; FAIL=$((FAIL+1));; *) echo "PASS $1"; PASS=$((PASS+1));; esac; }
limpa() { Pq -c "TRUNCATE public.fin_alertas, public.fornecedor_alerta, public._dh_fake;" >/dev/null; }
roda() { Pq -c "SELECT public.fin_sync_watchdog_diario('$1'::timestamptz);"; }
n_emails() { Pq -c "SELECT count(*) FROM public.fornecedor_alerta;"; }
TER='2026-10-13 11:00:00+00'   # terça 08:00 BRT
SEG='2026-10-12 11:00:00+00'   # segunda 08:00 BRT

limpa
eq "A1 terça sem alerta → silêncio" "$(roda "$TER") $(n_emails)" "silencio 0"

limpa
eq "A2 segunda sem alerta → OK semanal" "$(roda "$SEG") $(n_emails)" "ok_semanal 1"
eq "A2b título/severidade do OK" "$(Pq -c "SELECT titulo||'|'||severidade FROM public.fornecedor_alerta;")" "[Watchdog OK] semana de 12/10|info"

limpa
Pq -c "INSERT INTO public.fin_alertas (company,tipo,severidade,mensagem,criado_em) VALUES
  ('oben','sync_stale','aviso','Sync sem conclusao ha >18h: movimentacoes','2026-10-13 09:00+00'),
  ('oben','data_health_pedidos_compra_sync','critico','Pedidos de compra: coleta PARCIAL','2026-10-13 08:00+00'),
  ('oben','saida_spike','aviso','Proxima semana: saidas altas', now());
INSERT INTO public._dh_fake VALUES
  ('pedidos_compra_sync','broken','coleta parcial','timeout no Omie pag 5','Rodar omie-sync pedidos manualmente','Signal timed out'),
  ('zz_check_saudavel','ok','tudo bem',NULL,NULL,NULL);" >/dev/null
eq "A3 terça com 2 alertas vigiados → problema, 1 e-mail" "$(roda "$TER") $(n_emails)" "problema 1"
EMAIL="$(Pq -c "SELECT titulo||E'\n'||severidade||E'\n'||mensagem FROM public.fornecedor_alerta;")"
tem     "A3a título conta só os vigiados"  "$EMAIL" "[Watchdog: 2 problema(s)] 13/10"
tem     "A3b crítico → severidade urgente" "$EMAIL" $'\nurgente\n'
tem     "A3c traz como corrigir"           "$EMAIL" "Como corrigir: Rodar omie-sync pedidos manualmente"
tem     "A3d traz causa provável"          "$EMAIL" "Causa provável: timeout no Omie pag 5"
tem     "A3e traz último erro"             "$EMAIL" "Último erro: Signal timed out"
tem     "A3f traz o alerta de sync"        "$EMAIL" "Sync oben — sync_stale"
nao_tem "A3g não lista check OK"           "$EMAIL" "zz_check_saudavel"
nao_tem "A3h não lista alerta fora do vigia" "$EMAIL" "saida_spike"
eq "A3i crítico vem primeiro" "$(Pq -c "SELECT strpos(mensagem,'pedidos_compra_sync') < strpos(mensagem,'sync_stale') FROM public.fornecedor_alerta;")" "t"

limpa
Pq -c "INSERT INTO public.fin_alertas (company,tipo,severidade,mensagem,dismissed_at) VALUES ('oben','sync_error','critico','x', now());" >/dev/null
eq "A4 alerta dispensado não conta (terça)" "$(roda "$TER") $(n_emails)" "silencio 0"

limpa
Pq -c "INSERT INTO public.fin_alertas (company,tipo,severidade,mensagem) VALUES ('colacor','sync_error','aviso','erro no sync');" >/dev/null
eq "A5 segunda COM problema → só o aviso de problema" "$(roda "$SEG") $(n_emails) $(Pq -c "SELECT count(*) FROM public.fornecedor_alerta WHERE titulo LIKE '[Watchdog OK]%';")" "problema 1 0"
eq "A5b só avisos → severidade atencao" "$(Pq -c "SELECT severidade FROM public.fornecedor_alerta;")" "atencao"

limpa
Pq -c "INSERT INTO public.fin_alertas (company,tipo,severidade,mensagem) VALUES ('oben','data_health_x','aviso','check x degradado');" >/dev/null
R6="$(PGOPTIONS='-c teste.compute_quebra=on' Pq -c "SELECT public.fin_sync_watchdog_diario('$TER'::timestamptz);" 2>&1 || true)"
eq "A6 compute quebrado ainda manda o aviso" "$R6 $(n_emails)" "problema 1"
tem "A6b aviso diz que o detalhe falhou" "$(Pq -c "SELECT mensagem FROM public.fornecedor_alerta;")" "compute explodiu"

limpa
Pq -c "INSERT INTO public.fin_alertas (company,tipo,severidade,mensagem) VALUES ('oben','data_health_y','aviso','y degradado');
       INSERT INTO public._dh_fake VALUES ('y','ok','voltou',NULL,NULL,NULL);" >/dev/null
roda "$TER" >/dev/null
tem "A7 alerta já recuperado é sinalizado" "$(Pq -c "SELECT mensagem FROM public.fornecedor_alerta;")" "já voltou a OK"

limpa
# segunda 01:00 UTC = domingo 22:00 em Brasília → não é dia de OK
eq "A8 dia da semana é o de Brasília" "$(roda '2026-10-12 01:00:00+00') $(n_emails)" "silencio 0"

eq "A9 authenticated e anon não executam" \
   "$(Pq -c "SELECT has_function_privilege('authenticated','public.fin_sync_watchdog_diario(timestamptz)','EXECUTE')::text||' '||has_function_privilege('anon','public.fin_sync_watchdog_diario(timestamptz)','EXECUTE')::text;")" "false false"

eq "A10 cron aponta para a função nova" "$(Pq -c "SELECT schedule||'|'||command FROM cron.job WHERE jobname='fin-sync-heartbeat';")" "0 11 * * 1-5|SELECT public.fin_sync_watchdog_diario()"

echo "PASS=$PASS  FAIL=$FAIL"
[ "$FAIL" -eq 0 ] && echo "WATCHDOG_DIARIO_PROVA_OK"
[ "$FAIL" -eq 0 ]
