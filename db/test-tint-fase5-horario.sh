#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════════╗
# ║  HARNESS PG17 — tint-watchdog-fase5-6h fora do horário de loja (30 9,21 UTC)      ║
# ║   bash db/test-tint-fase5-horario.sh > "$SCRATCH/t.log" 2>&1                     ║
# ║                                                                                  ║
# ║  Aplica a migration REAL 20261103222735 numa transação (como o db:aplicar):      ║
# ║   PROD     (job 167, 0 */6, marcador de 1 min) → 30 9,21; jobid e comando (md5)  ║
# ║            intocados; re-aplicar não duplica                                     ║
# ║   DR       (marcador ausente) → aplica                                           ║
# ║   ATRASADO (marcador de 13 h) → P7 aborta e o job fica em 0 */6 (rollback)        ║
# ║   CORANTE  (dead-man da A em 6 h) → P6 aborta                                    ║
# ║  FALSIFICAÇÃO (espelho em tmpdir, após CONTROLE verde na MESMA invocação):       ║
# ║   (F1) schedule trocado no cron.schedule → P3 aborta                             ║
# ║   (F2) teto da P7 frouxo → o mundo ATRASADO passa e fica vermelho                ║
# ║   (F3) regex da P6 frouxa → o mundo CORANTE passa e fica vermelho                ║
# ╚══════════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17   # consumido pelo db/lib/pg-harness.sh via source
PORT="${PGPORT_TEST:-5536}"
SLUG="tint-fase5-horario"
TMPD="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")"
DATA="$TMPD/data"
MIG="$REPO_ROOT/supabase/migrations/20261103222735_tint_watchdog_fase5_fora_do_horario_de_loja.sql"
JOB="tint-watchdog-fase5-6h"
MD5_PROD="fe21fbd80a2d401af553c7b90e24b1c1"   # md5(command) em prod, psql-ro 2026-11-03
export LC_ALL=C LANG=C

# shellcheck disable=SC1091  # o gate roda sem -x; o helper e versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/pg-harness.sh"

[ -f "$MIG" ] || { echo "migration nao encontrada: $MIG"; exit 1; }

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMPD"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$TMPD/pg.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
P()  { "$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

P -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -q <<'SQL'
-- cron.schedule com a semântica do pg_cron: re-agendar o MESMO nome atualiza o job
CREATE OR REPLACE FUNCTION cron.schedule(p_jobname text, p_schedule text, p_command text)
RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v_id bigint;
BEGIN
  SELECT jobid INTO v_id FROM cron.job WHERE jobname = p_jobname;
  IF v_id IS NULL THEN
    SELECT COALESCE(MAX(jobid), 0) + 1 INTO v_id FROM cron.job;
    INSERT INTO cron.job (jobid, jobname, schedule, command, active) VALUES (v_id, p_jobname, p_schedule, p_command, true);
  ELSE
    UPDATE cron.job SET schedule = p_schedule, command = p_command WHERE jobid = v_id;
  END IF;
  RETURN v_id;
END $$;
CREATE TABLE IF NOT EXISTS public.sync_state (
  entity_type text NOT NULL, account text NOT NULL DEFAULT 'vendas', last_sync_at timestamptz);
CREATE OR REPLACE FUNCTION public.tint_watchdog_fase5_check() RETURNS void LANGUAGE sql AS $f$ SELECT $f$;
SQL

# Camada A: só o trecho do dead-man importa para a P6 (o limite vem por parâmetro)
corante() {
  P -q -c "CREATE OR REPLACE FUNCTION public.tint_watchdog_corante_check() RETURNS void LANGUAGE plpgsql AS \$f\$
DECLARE v_b_atraso interval; BEGIN
  IF v_b_atraso IS NOT NULL AND v_b_atraso > interval '$1' THEN RETURN; END IF;
END \$f\$;"
}

# Mundo de prod: o job como está hoje (jobid 167, 0 */6, comando de prod) + marcador dado.
mundo() {
  P -q -c "DELETE FROM cron.job; DELETE FROM public.sync_state;"
  P -q -c "INSERT INTO cron.job (jobid, jobname, schedule, command, active) VALUES (167, '$JOB', '0 */6 * * *',
    \$c\$SET statement_timeout = '10min'; SELECT public.tint_watchdog_fase5_check();\$c\$, true)"
  [ "$1" = "ausente" ] || P -q -c "INSERT INTO public.sync_state (entity_type, account, last_sync_at)
    VALUES ('tint_watchdog_fase5', 'oben', now() - interval '$1')"
}
aplicar() { P -q -1 -f "$1" >"$TMPD/apply.log" 2>&1; }

provar() {
  local mig="$1"
  echo "── PROD (marcador de 1 min)"
  corante "13 hours"; mundo "1 minute"
  if aplicar "$mig"; then ok "migration aplica em prod"; else bad "migration abortou em prod: $(tail -1 "$TMPD/apply.log")"; fi
  eq "schedule e active" "$(Pq -c "SELECT schedule||'|'||active FROM cron.job WHERE jobname='$JOB'")" "30 9,21 * * *|true"
  eq "md5 do comando = prod" "$(Pq -c "SELECT md5(command) FROM cron.job WHERE jobname='$JOB'")" "$MD5_PROD"
  eq "jobid de prod intocado" "$(Pq -c "SELECT jobid FROM cron.job WHERE jobname='$JOB'")" "167"
  aplicar "$mig" || true
  eq "re-aplicar não duplica" "$(Pq -c "SELECT count(*) FROM cron.job WHERE jobname='$JOB'")" "1"

  echo "── DR (marcador ausente)"
  mundo "ausente"
  if aplicar "$mig"; then ok "aplica sem marcador"; else bad "abortou sem marcador: $(tail -1 "$TMPD/apply.log")"; fi

  echo "── ATRASADO (marcador de 13 h)"
  mundo "13 hours"
  if aplicar "$mig"; then bad "aplicou com a próxima rodada a > 12h30 do marcador"
  elif grep -q "P7 FALHOU" "$TMPD/apply.log"; then ok "P7 aborta"
  else bad "abortou, mas não pela P7: $(tail -1 "$TMPD/apply.log")"; fi
  eq "job segue no horário velho (rollback)" "$(Pq -c "SELECT schedule FROM cron.job WHERE jobname='$JOB'")" "0 */6 * * *"

  echo "── CORANTE (dead-man da A em 6 h)"
  corante "6 hours"; mundo "1 minute"
  if aplicar "$mig"; then bad "aplicou com o dead-man da A abaixo de 12 h"
  elif grep -q "P6 FALHOU" "$TMPD/apply.log"; then ok "P6 aborta"
  else bad "abortou, mas não pela P6: $(tail -1 "$TMPD/apply.log")"; fi
}

echo "═══ CONTROLE — migration real"
provar "$MIG"
CONTROLE_FAIL=$FAIL
[ "$CONTROLE_FAIL" -eq 0 ] || { echo "PASS=$PASS  FAIL=$FAIL"; echo "controle vermelho — falsificação não roda"; exit 1; }

echo "═══ FALSIFICAÇÃO (espelhos em $TMPD; supabase/migrations/ intocado)"
falsificar() {
  local nome="$1" sed_expr="$2" espelho="$TMPD/$1.sql" antes_pass=$PASS antes_fail=$FAIL
  sed -E "$sed_expr" "$MIG" > "$espelho"
  if cmp -s "$MIG" "$espelho"; then bad "$nome: sed não alterou nada (sabotagem vazia)"; return; fi
  provar "$espelho" >"$TMPD/$nome.log" 2>&1 || true
  local novos_fail=$((FAIL - antes_fail))
  PASS=$antes_pass; FAIL=$antes_fail
  if [ "$novos_fail" -gt 0 ]; then ok "$nome ficou VERMELHO ($novos_fail assert(s))"; else bad "$nome passou VERDE — a prova não morde"; fi
}
falsificar F1-schedule "s/^  '30 9,21 \\* \\* \\*',/  '30 9,22 * * *',/"
falsificar F2-teto-p7 "s/> interval '12 hours 30 minutes'/> interval '99 hours'/"
falsificar F3-regex-p6 "s/''13 hours'''/''[0-9]+ hours'''/"

echo "PASS=$PASS  FAIL=$FAIL"
[ "$FAIL" -eq 0 ] && echo "FIM-OK"
[ "$FAIL" -eq 0 ]
