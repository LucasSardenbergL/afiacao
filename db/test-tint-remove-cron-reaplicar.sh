#!/usr/bin/env bash
# PROVA — 20261013200000_tint_remove_cron_reaplicar_snapshot.sql
# Remove o cron da mitigação do #3054 SÓ se o promote vivo já tiver a correção do #3051.
#   R1 promote SEM a correção + job agendado  → ABORTA (42501? não: P0001 com a marca) e o job FICA
#   R2 promote COM a correção + job agendado  → job removido
#   R3 promote COM a correção + job ausente   → no-op (NOTICE), sem erro
#   F1 guarda neutralizada (`IF false`)       → R1 TEM de cair (removeria a mitigação sem o conserto)
# O pg_cron não existe no PG local: cron.job + cron.unschedule são stubs com o mesmo contrato.
# A função sob teste é a migration REAL; o promote é um stub com/sem as marcas que a guarda lê.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC1091  # o gate roda sem -x; o helper e versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/pg-harness.sh"
PORT="${PGPORT_TEST:-${PORT:-5448}}"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/pgtest-rmcron.XXXXXX")"
DATA="$TMP/data"
MIG="$REPO_ROOT/supabase/migrations/20261013200000_tint_remove_cron_reaplicar_snapshot.sql"
export LC_ALL=C LANG=C
[ -f "$MIG" ] || { echo "migration ausente: $MIG"; exit 1; }

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMP"; }
trap cleanup EXIT
"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k $TMP" -l "$TMP/pg.log" -w start >/dev/null
PA() { "$PGBIN/psql" -X -p "$PORT" -h "$TMP" -U postgres -v ON_ERROR_STOP=1 "$@"; }

PASSOU=0; FALHAS=0
ok()  { echo "  ✓ $*"; PASSOU=$((PASSOU + 1)); }
bad() { echo "  ✗ $*"; FALHAS=$((FALHAS + 1)); }

# banco com stubs; $2 = com|sem a correção do #3051 no promote; $3 = com|sem o job
prepara() {
  PA -q -d postgres -c "DROP DATABASE IF EXISTS $1" -c "CREATE DATABASE $1" >/dev/null
  PA -q -d "$1" >/dev/null <<'SQL'
CREATE SCHEMA cron;
CREATE TABLE cron.job (jobid bigserial PRIMARY KEY, jobname text UNIQUE, schedule text, command text, active boolean DEFAULT true);
CREATE FUNCTION cron.unschedule(p text) RETURNS boolean LANGUAGE plpgsql AS $f$
BEGIN DELETE FROM cron.job WHERE jobname = p; RETURN FOUND; END $f$;
SQL
  if [ "$2" = "com" ]; then
    PA -q -d "$1" -c "CREATE FUNCTION public.tint_promote_sync_run(p uuid) RETURNS jsonb LANGUAGE plpgsql AS \$f\$ DECLARE v_fantasmas_fonte int := 0; BEGIN PERFORM 1 WHERE now() IS NOT NULL /* AND sf.created_at < v_snap_recebido */; RETURN '{}'::jsonb; END \$f\$;" >/dev/null
  else
    PA -q -d "$1" -c "CREATE FUNCTION public.tint_promote_sync_run(p uuid) RETURNS jsonb LANGUAGE plpgsql AS \$f\$ DECLARE v_tombstones_fase5 int := 0; BEGIN RETURN '{}'::jsonb; END \$f\$;" >/dev/null
  fi
  if [ "$3" = "com" ]; then
    PA -q -d "$1" -c "INSERT INTO cron.job (jobname, schedule, command) VALUES ('tint-reaplicar-snapshot-6h','30 */6 * * *','SELECT 1')" >/dev/null
  fi
}
job() { PA -d "$1" -tA -c "SELECT count(*) FROM cron.job WHERE jobname='tint-reaplicar-snapshot-6h'"; }

suite() {   # $1 = arquivo da migration (real ou sabotada)
  local mig="$1" saida
  prepara r1 sem com
  if saida="$(PA -d r1 -q -f "$mig" 2>&1)"; then
    bad "R1 sem a correção do #3051 a remoção PASSOU (removeria a mitigação sem o conserto)"
  else
    case "$saida" in
      *"remove-cron ABORTADA: o promote vivo NAO"*|*"remove-cron ABORTADA: o promote vivo NÃO"*)
        if [ "$(job r1)" = "1" ]; then ok "R1 sem a correção do #3051: aborta pela guarda e o job FICA"
        else bad "R1 abortou mas o job sumiu"; fi ;;
      *) bad "R1 abortou pelo motivo ERRADO: $(printf '%s' "$saida" | tail -c 200)" ;;
    esac
  fi
  prepara r2 com com
  PA -d r2 -q -f "$mig" >/dev/null 2>&1 || true
  if [ "$(job r2)" = "0" ]; then ok "R2 com a correção: o job é removido"; else bad "R2 o job continua agendado"; fi
  prepara r3 com sem
  if PA -d r3 -q -f "$mig" >/dev/null 2>&1; then ok "R3 sem o job: no-op sem erro"; else bad "R3 sem o job deu erro"; fi
}

echo "════ controle (migration real) ════"
suite "$MIG"
CONTROLE=$PASSOU
[ "$FALHAS" -eq 0 ] || { echo "PASS=$PASSOU  FAIL=$FALHAS"; echo "RESULTADO: VERMELHO no controle"; exit 1; }

echo "════ F1 — guarda neutralizada ════"
SAB="$TMP/sab.sql"
python3 - "$MIG" "$SAB" <<'PY'
import sys
s = open(sys.argv[1]).read()
a = "  IF v_def IS NULL OR position('v_fantasmas_fonte' IN v_def) = 0"
assert s.count(a) == 1, "ancora da guarda nao casou 1 vez"
open(sys.argv[2], 'w').write(s.replace(a, "  IF false AND (v_def IS NULL OR position('v_fantasmas_fonte' IN v_def) = 0", 1).replace(
    "     OR position('AND sf.created_at < v_snap_recebido' IN v_def) = 0 THEN",
    "     OR position('AND sf.created_at < v_snap_recebido' IN v_def) = 0) THEN", 1))
PY
FALSIF_ERR=0
saida_f="$(PASSOU=0; FALHAS=0; suite "$SAB" 2>&1)"
caidos="$(printf '%s\n' "$saida_f" | sed -n 's/^  ✗ \(R[0-9]\) .*/\1/p' | sort | tr '\n' ' ' | sed 's/ $//')"
if [ "$caidos" = "R1" ]; then echo "  ✓ F1 derrubou EXATAMENTE [R1]"
else echo "  ✗ F1: esperado [R1], veio [$caidos]"; FALSIF_ERR=1; fi

echo "PASS=$CONTROLE  FAIL=$FALSIF_ERR"
[ "$FALSIF_ERR" -eq 0 ] || { echo "RESULTADO: VERMELHO"; exit 1; }
echo "RESULTADO: VERDE — $CONTROLE asserts + 1 falsificação com conjunto exato"
