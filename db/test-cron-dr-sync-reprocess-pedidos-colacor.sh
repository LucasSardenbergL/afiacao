#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════════╗
# ║  HARNESS PG17 — DR do cron sync-reprocess-pedidos-colacor-2h (M-37 · Lote D)       ║
# ║   bash db/test-cron-dr-sync-reprocess-pedidos-colacor.sh > "$SCRATCH/t.log" 2>&1  ║
# ║                                                                                    ║
# ║  Aplica a migration REAL 20261012173000 em dois mundos:                            ║
# ║   REBUILD (cron.job vazio) → o job nasce com o comando de prod BYTE A BYTE (md5)   ║
# ║   PROD    (job já existe, comando próprio) → no-op: jobid e comando intocados      ║
# ║  + re-aplicar não duplica + nenhum segredo literal no arquivo.                     ║
# ║  FALSIFICAÇÃO (espelho em tmpdir, após CONTROLE verde na MESMA invocação):         ║
# ║   (F1) sem o guard IF NOT EXISTS → o mundo PROD fica vermelho (comando sobrescrito)║
# ║   (F2) schedule trocado → a pós-condição aborta a transação.                       ║
# ╚══════════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17   # consumido pelo db/lib/pg-harness.sh via source
PORT="${PGPORT_TEST:-5534}"
SLUG="cron-dr-colacor"
TMPD="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")"
DATA="$TMPD/data"
MIG="$REPO_ROOT/supabase/migrations/20261012173000_cron_sync_reprocess_pedidos_colacor_dr.sql"
JOB="sync-reprocess-pedidos-colacor-2h"
MD5_PROD="b8a85ce3584a68c70700f6646b721bd5"   # md5(command) em prod, psql-ro 2026-10-12
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
SQL

# Roda as asserções contra UMA migration (a real ou um espelho sabotado). Zera cron.job a cada mundo.
provar() {
  local mig="$1"
  echo "── REBUILD (cron.job vazio)"
  P -q -c "DELETE FROM cron.job"
  if P -q -f "$mig" >"$TMPD/apply.log" 2>&1; then ok "migration aplica no rebuild"; else bad "migration abortou no rebuild: $(tail -1 "$TMPD/apply.log")"; fi
  eq "md5 do comando recriado = prod" "$(Pq -c "SELECT md5(command) FROM cron.job WHERE jobname='$JOB'")" "$MD5_PROD"
  eq "schedule e active" "$(Pq -c "SELECT schedule||'|'||active FROM cron.job WHERE jobname='$JOB'")" "40 */2 * * *|true"
  P -q -f "$mig" >/dev/null 2>&1 || true
  eq "re-aplicar não duplica" "$(Pq -c "SELECT count(*) FROM cron.job WHERE jobname='$JOB'")" "1"

  echo "── PROD (job já existe)"
  P -q -c "DELETE FROM cron.job"
  P -q -c "INSERT INTO cron.job (jobid, jobname, schedule, command, active) VALUES (198, '$JOB', '40 */2 * * *', 'SELECT 1 /*prod*/', true)"
  if P -q -f "$mig" >"$TMPD/apply.log" 2>&1; then ok "migration aplica em prod"; else bad "migration abortou em prod: $(tail -1 "$TMPD/apply.log")"; fi
  eq "comando de prod intocado" "$(Pq -c "SELECT command FROM cron.job WHERE jobname='$JOB'")" "SELECT 1 /*prod*/"
  eq "jobid de prod intocado" "$(Pq -c "SELECT jobid FROM cron.job WHERE jobname='$JOB'")" "198"
}

echo "═══ CONTROLE — migration real"
provar "$MIG"
if grep -Eq 'eyJ[A-Za-z0-9_-]{10,}|[Bb]earer[[:space:]]+[A-Za-z0-9]' "$MIG"; then bad "segredo literal na migration"; else ok "nenhum segredo literal na migration"; fi
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
falsificar F1-sem-guard 's/IF NOT EXISTS \(SELECT 1 FROM cron\.job[^)]*\) THEN/IF true THEN/'
falsificar F2-schedule "s/(PERFORM cron\\.schedule\\([^,]+, )'40/\\1'41/"

echo "PASS=$PASS  FAIL=$FAIL"
[ "$FAIL" -eq 0 ]
