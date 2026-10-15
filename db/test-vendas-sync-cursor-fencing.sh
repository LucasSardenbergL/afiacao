#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  HARNESS PG17 — fencing token do lease do vendas_sync_cursor                    ║
# ║  Migration: 20261015221600_vendas_sync_cursor_fencing_token.sql                 ║
# ║  Prova: (P) o dono opera o lease · (N) o ZUMBI que perdeu o lease não mexe em   ║
# ║  nada (heartbeat/finish/release → false, estado do sucessor intacto), token     ║
# ║  NULL não é bypass · (L) o caminho ANTIGO segue funcionando sozinho e nunca     ║
# ║  toca lease cercado · (A) ACL service_role-only · (C) a corrida real com 2      ║
# ║  sessões, bloqueio OBSERVADO · (V) o validador pós-apply aprova o bom e         ║
# ║  reprova o sabotado · (F) cada invariante falsificado → vermelho → restaura.    ║
# ║  Rodar:  bash db/test-vendas-sync-cursor-fencing.sh > "$LOG" 2>&1; echo $?      ║
# ║  Sentinelas ASCII, caixa fixa; negativos por SQLSTATE (nunca texto do servidor).║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17
PORT="${PGPORT_TEST:-5461}"
SLUG="vendas-sync-cursor-fencing"
TMPROOT="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")"
DATA="$TMPROOT/data"
export LC_ALL=C LANG=C

# shellcheck disable=SC1091  # o gate roda sem -x; o helper é versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/pg-harness.sh"

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMPROOT"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$TMPROOT/pg.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
P()  { "$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -q -tA "$@"; }

P -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -q <<'SQL'
CREATE OR REPLACE FUNCTION auth.uid()  RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.uid',  true), '')::uuid $f$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.role', true), '') $f$;
ALTER ROLE service_role BYPASSRLS;
SQL

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  OK  $1"; }
bad() { FAIL=$((FAIL+1)); echo "  FALHOU  $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

echo "=== setup pronto (PG17 :$PORT) ==="

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — PRÉ-REQUISITOS da migration-fundação 20260617133633 (policy lê user_roles;
# ela agenda o cron → stubs de cron/net/vault).
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname='app_role') THEN
  CREATE TYPE public.app_role AS ENUM ('master','employee','customer'); END IF; END $$;
CREATE TABLE IF NOT EXISTS public.user_roles (user_id uuid, role public.app_role);
CREATE OR REPLACE FUNCTION cron.schedule(p_jobname text, p_schedule text, p_command text)
RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v_id bigint;
BEGIN
  DELETE FROM cron.job WHERE jobname = p_jobname;
  v_id := COALESCE((SELECT max(jobid) FROM cron.job), 0) + 1;
  INSERT INTO cron.job(jobid, jobname, schedule, command, active) VALUES (v_id, p_jobname, p_schedule, p_command, true);
  RETURN v_id;
END $$;
CREATE OR REPLACE FUNCTION cron.unschedule(p_jobname text)
RETURNS boolean LANGUAGE sql AS $$ DELETE FROM cron.job WHERE jobname=$1; SELECT true; $$;
CREATE SCHEMA IF NOT EXISTS net;
CREATE OR REPLACE FUNCTION net.http_post(
  url text, body jsonb DEFAULT '{}'::jsonb, params jsonb DEFAULT '{}'::jsonb,
  headers jsonb DEFAULT '{}'::jsonb, timeout_milliseconds integer DEFAULT 5000)
RETURNS bigint LANGUAGE sql AS $$ SELECT 1::bigint $$;
CREATE SCHEMA IF NOT EXISTS vault;
CREATE TABLE IF NOT EXISTS vault.decrypted_secrets (name text, decrypted_secret text);
SQL

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — MIGRATIONS REAIS: fundação + a SOB TESTE (aplicada DUAS vezes: idempotência).
# ══════════════════════════════════════════════════════════════════════════════
MIG_BASE="$REPO_ROOT/supabase/migrations/20260617133633_vendas_sync_cursor.sql"
MIG="$REPO_ROOT/supabase/migrations/20261015221600_vendas_sync_cursor_fencing_token.sql"
VALIDA="$REPO_ROOT/db/valida-vendas-sync-cursor-fencing.sql"
P -q -f "$MIG_BASE" >/dev/null 2>&1
PGOPTIONS="-c client_min_messages=warning" P -q -f "$MIG" >/dev/null
echo "migrations aplicadas: $(basename "$MIG_BASE") + $(basename "$MIG")"

# ══════════════════════════════════════════════════════════════════════════════
# Helpers de cenário — cada um usa a SUA janela (date_from único), para poder rodar
# de novo sob cada sabotagem. Rodam em nível de topo (sem $(...)) e deixam o veredito em OUT.
# ══════════════════════════════════════════════════════════════════════════════
DT_OF() { Pq -c "SELECT (DATE '$1' + 30)::text"; }
seed()  { P -q -c "INSERT INTO public.vendas_sync_cursor(account,date_from,date_to,next_page)
                   VALUES ('oben','$1',(DATE '$1' + 30),$2);" >/dev/null; }
acq()   { Pq -c "SELECT public.vendas_sync_lease_acquire_fenced('oben','$1',(DATE '$1' + 30))->>'lease_token';"; }
envelhece() { P -q -c "UPDATE public.vendas_sync_cursor SET heartbeat_at = now() - interval '4 minutes'
                       WHERE account='oben' AND date_from='$1';" >/dev/null; }
estado() { Pq -c "SELECT coalesce(next_page::text,'null')||'/'||(running_since IS NOT NULL)||'/'||(completed_at IS NOT NULL)||'/'||coalesce(lease_token::text,'null')
                  FROM public.vendas_sync_cursor WHERE account='oben' AND date_from='$1';"; }

# Tomada de lease: A adquire, morre (heartbeat envelhece), B rouba. Deixa TA e TB.
takeover() { seed "$1" 3; TA=$(acq "$1"); envelhece "$1"; TB=$(acq "$1"); }

cen_zumbi_heartbeat() {   # A (zumbi) tenta heartbeat com o token velho
  takeover "$1"
  local r; r=$(Pq -c "SELECT public.vendas_sync_heartbeat_fenced('oben','$1',(DATE '$1' + 30),'$TA'::uuid,2);")
  OUT="$r|$(estado "$1" | sed "s/$TB/TB/")"
}
cen_zumbi_finish() {      # A tenta FECHAR a janela que agora é de B
  takeover "$1"
  local r; r=$(Pq -c "SELECT public.vendas_sync_finish_fenced('oben','$1',(DATE '$1' + 30),'$TA'::uuid,true,NULL,NULL);")
  OUT="$r|$(estado "$1" | sed "s/$TB/TB/")"
}
cen_zumbi_release() {     # A tenta SOLTAR o lease de B
  takeover "$1"
  local r; r=$(Pq -c "SELECT public.vendas_sync_release_fenced('oben','$1',(DATE '$1' + 30),'$TA'::uuid,'error');")
  OUT="$r|$(estado "$1" | sed "s/$TB/TB/")"
}
cen_token_nulo() {        # lease tomado pelo caminho ANTIGO (token NULL): token NULL não pode casar
  seed "$1" 4
  Pq -c "SELECT public.vendas_sync_lease_acquire('oben','$1',(DATE '$1' + 30));" >/dev/null
  local h f r
  h=$(Pq -c "SELECT public.vendas_sync_heartbeat_fenced('oben','$1',(DATE '$1' + 30),NULL,9);")
  f=$(Pq -c "SELECT public.vendas_sync_finish_fenced('oben','$1',(DATE '$1' + 30),NULL,true,NULL,NULL);")
  r=$(Pq -c "SELECT public.vendas_sync_release_fenced('oben','$1',(DATE '$1' + 30),NULL,'error');")
  OUT="$h$f$r|$(estado "$1")"
}
cen_antigo_nao_toca_cercado() {  # caminho antigo contra lease cercado: nada muda
  seed "$1" 5; local t; t=$(acq "$1")
  Pq -c "SELECT public.vendas_sync_heartbeat('oben','$1',(DATE '$1' + 30),99);" >/dev/null
  Pq -c "SELECT public.vendas_sync_release('oben','$1',(DATE '$1' + 30),'error');" >/dev/null
  Pq -c "SELECT public.vendas_sync_finish('oben','$1',(DATE '$1' + 30),true,NULL,NULL);" >/dev/null
  OUT="$(estado "$1" | sed "s/$t/T/")"
}
cen_antigo_rouba_cercado() {     # acquire antigo rouba lease cercado morto → o dono cercado é cercado fora
  seed "$1" 6; local t a h; t=$(acq "$1"); envelhece "$1"
  a=$(Pq -c "SELECT public.vendas_sync_lease_acquire('oben','$1',(DATE '$1' + 30));")
  h=$(Pq -c "SELECT public.vendas_sync_heartbeat_fenced('oben','$1',(DATE '$1' + 30),'$t'::uuid,7);")
  OUT="$a|$h|$(estado "$1")"
}
cen_corrida() {   # A (lease morto) faz heartbeat ENQUANTO B rouba numa transação aberta
  seed "$1" 3; local ta sig="$TMPROOT/sig.$1" blk="sem_bloqueio" i a np xpid apid
  ta=$(acq "$1"); envelhece "$1"; rm -f "$sig"
  P -q -tA > "$TMPROOT/x.$1" 2>&1 <<SQL &
BEGIN;
SELECT public.vendas_sync_lease_acquire_fenced('oben','$1',(DATE '$1' + 30))->>'lease_token';
\! touch $sig
SELECT pg_sleep(3);
COMMIT;
SQL
  xpid=$!
  for i in $(seq 1 100); do [ -f "$sig" ] && break; sleep 0.1; done
  [ -f "$sig" ] || { OUT="TIMEOUT_LARGADA"; wait "$xpid" || true; return; }
  Pq -c "SELECT public.vendas_sync_heartbeat_fenced('oben','$1',(DATE '$1' + 30),'$ta'::uuid,50);" > "$TMPROOT/a.$1" 2>&1 &
  apid=$!
  for i in $(seq 1 100); do
    if [ "$(Pq -c "SELECT count(*) FROM pg_stat_activity WHERE datname='prove' AND cardinality(pg_blocking_pids(pid)) > 0;")" != "0" ]; then
      blk="bloqueio_observado"; break
    fi
    sleep 0.05
  done
  wait "$apid" || true; wait "$xpid" || true
  a=$(tr -d '[:space:]' < "$TMPROOT/a.$1")
  np=$(Pq -c "SELECT next_page FROM public.vendas_sync_cursor WHERE account='oben' AND date_from='$1';")
  OUT="$blk|$a|$np"
}

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4 — ASSERTS
# ══════════════════════════════════════════════════════════════════════════════
echo "-- P: o dono opera o lease --"
seed 2026-01-01 3
T1=$(acq 2026-01-01)
RP=$(Pq -c "SELECT public.vendas_sync_lease_acquire_fenced('oben','2026-01-01','2026-01-31');")
eq "P1 acquire devolve token (uuid)" "$(echo "$T1" | grep -cE '^[0-9a-f-]{36}$')" "1"
eq "P1 token gravado na linha"       "$(estado 2026-01-01)" "3/true/false/$T1"
eq "N4 2o acquire com lease vivo -> NULL (nao rouba)" "$RP" ""
P -q -c "UPDATE public.vendas_sync_cursor SET running_since=NULL, lease_token=NULL WHERE date_from='2026-01-01';" >/dev/null
RP=$(Pq -c "SELECT (public.vendas_sync_lease_acquire_fenced('oben','2026-01-01','2026-01-31'))->>'resume_page';")
eq "P1 acquire retoma do next_page" "$RP" "3"
T1=$(Pq -c "SELECT lease_token FROM public.vendas_sync_cursor WHERE date_from='2026-01-01';")
eq "P2 heartbeat do dono -> true" "$(Pq -c "SELECT public.vendas_sync_heartbeat_fenced('oben','2026-01-01','2026-01-31','$T1'::uuid,5);")" "t"
eq "P2 heartbeat persiste a pagina em curso" "$(estado 2026-01-01)" "5/true/false/$T1"
eq "P3 finish PAUSA do dono -> true" "$(Pq -c "SELECT public.vendas_sync_finish_fenced('oben','2026-01-01','2026-01-31','$T1'::uuid,false,7,'rate_limit');")" "t"
eq "P3 pausa: next_page/lease solto/nao completa/token limpo" "$(estado 2026-01-01)" "7/false/false/null"
eq "P3 pausa grava last_error_kind" "$(Pq -c "SELECT last_error_kind FROM public.vendas_sync_cursor WHERE date_from='2026-01-01';")" "rate_limit"
eq "N7 token de lease ja encerrado -> false" "$(Pq -c "SELECT public.vendas_sync_heartbeat_fenced('oben','2026-01-01','2026-01-31','$T1'::uuid,8);")" "f"
T2=$(acq 2026-01-01)
eq "P4 release do dono -> true" "$(Pq -c "SELECT public.vendas_sync_release_fenced('oben','2026-01-01','2026-01-31','$T2'::uuid,'error');")" "t"
eq "P4 release preserva next_page e limpa lease/token" "$(estado 2026-01-01)" "7/false/false/null"
T3=$(acq 2026-01-01)
eq "P5 finish COMPLETO do dono -> true" "$(Pq -c "SELECT public.vendas_sync_finish_fenced('oben','2026-01-01','2026-01-31','$T3'::uuid,true,NULL,NULL);")" "t"
eq "P5 completo: next_page null/livre/completed/token null" "$(estado 2026-01-01)" "null/false/true/null"
eq "N5 acquire em janela completa -> NULL" "$(acq 2026-01-01)" ""

echo "-- N: o zumbi que perdeu o lease nao mexe em nada --"
takeover 2026-02-01
eq "P6 roubo de lease morto emite token NOVO" "$([ -n "$TB" ] && [ "$TA" != "$TB" ] && echo novo || echo igual)" "novo"
cen_zumbi_heartbeat 2026-03-01; eq "N1 heartbeat do zumbi -> false; next_page e token de B intactos" "$OUT" "f|3/true/false/TB"
cen_zumbi_finish    2026-04-01; eq "N2 finish do zumbi -> false; janela NAO fecha, lease de B intacto" "$OUT" "f|3/true/false/TB"
cen_zumbi_release   2026-05-01; eq "N3 release do zumbi -> false; lease de B intacto" "$OUT" "f|3/true/false/TB"
cen_token_nulo      2026-06-01; eq "N6 token NULL nunca casa (sem bypass) em lease antigo" "$OUT" "fff|4/true/false/null"

echo "-- L: caminho antigo (edge velha / revertida) --"
cen_antigo_nao_toca_cercado 2026-07-01; eq "L1 heartbeat/release/finish ANTIGOS nao tocam lease cercado" "$OUT" "5/true/false/T"
cen_antigo_rouba_cercado    2026-08-01; eq "L3 acquire antigo rouba lease morto cercado e cerca o dono fora" "$OUT" "6|f|6/true/false/null"
seed 2026-09-01 2
Pq -c "SELECT public.vendas_sync_lease_acquire('oben','2026-09-01',(DATE '2026-09-01' + 30));" >/dev/null
Pq -c "SELECT public.vendas_sync_heartbeat('oben','2026-09-01',(DATE '2026-09-01' + 30),4);" >/dev/null
Pq -c "SELECT public.vendas_sync_finish('oben','2026-09-01',(DATE '2026-09-01' + 30),true,NULL,NULL);" >/dev/null
eq "L2 fluxo ANTIGO completo segue funcionando sozinho" "$(estado 2026-09-01)" "null/false/true/null"

echo "-- A: fronteira de EXECUTE --"
R=$(P -q -tA 2>&1 <<'SQL'
SET ROLE authenticated;
DO $$
DECLARE n int := 0;
BEGIN
  BEGIN PERFORM public.vendas_sync_lease_acquire_fenced('oben','2026-01-01','2026-01-31');
  EXCEPTION WHEN insufficient_privilege THEN n := n + 1; END;
  BEGIN PERFORM public.vendas_sync_heartbeat_fenced('oben','2026-01-01','2026-01-31',NULL,1);
  EXCEPTION WHEN insufficient_privilege THEN n := n + 1; END;
  BEGIN PERFORM public.vendas_sync_finish_fenced('oben','2026-01-01','2026-01-31',NULL,false,1,NULL);
  EXCEPTION WHEN insufficient_privilege THEN n := n + 1; END;
  BEGIN PERFORM public.vendas_sync_release_fenced('oben','2026-01-01','2026-01-31',NULL,NULL);
  EXCEPTION WHEN insufficient_privilege THEN n := n + 1; END;
  RAISE NOTICE 'NEGADAS_AUTHENTICATED=%', n;
END $$;
SQL
)
case "$R" in *NEGADAS_AUTHENTICATED=4*) ok "A1 authenticated nao executa as 4 RPCs cercadas (42501)" ;; *) bad "A1 — veio: $R" ;; esac
R=$(Pq -c "SET ROLE service_role; SELECT public.vendas_sync_heartbeat_fenced('oben','2026-01-01','2026-01-31',NULL,1);" | tail -1)
eq "A2 service_role executa (a edge consegue)" "$R" "f"

echo "-- C: corrida real (2 sessoes) --"
cen_corrida 2026-10-01; eq "C1 heartbeat do zumbi espera o lock do roubo e devolve false (EPQ)" "$OUT" "bloqueio_observado|f|3"

echo "-- I/V: idempotencia + validador pos-apply --"
TK=$(Pq -c "SELECT lease_token FROM public.vendas_sync_cursor WHERE date_from='2026-02-01';")
PGOPTIONS="-c client_min_messages=warning" P -q -f "$MIG" >/dev/null
eq "I1 re-aplicar a migration nao mexe em lease vivo" "$(Pq -c "SELECT lease_token FROM public.vendas_sync_cursor WHERE date_from='2026-02-01';")" "$TK"
V=$(Pq -f "$VALIDA")
case "$V" in "✅"*) ok "V1 validador aprova o banco bom" ;; *) bad "V1 validador reprovou o banco bom: $V" ;; esac

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICAÇÃO: sabota UMA coisa → o assert alvo fica VERMELHO → restaura (re-aplica).
# Cada uma mira um cenário com janela NOVA (estado limpo) e confere o validador quando ele cobre.
# ══════════════════════════════════════════════════════════════════════════════
echo "-- F: falsificacao --"
restaura() { PGOPTIONS="-c client_min_messages=warning" P -q -f "$MIG" >/dev/null; }
valida_reprova() {  # $1 rotulo  $2 trecho esperado na reprovacao
  local v; v=$(Pq -f "$VALIDA")
  case "$v" in *"$2"*) ok "$1" ;; *) bad "$1 — validador disse: $v" ;; esac
}

# F1 → N1: heartbeat cercado SEM o predicado do token
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.vendas_sync_heartbeat_fenced(p_account text, p_date_from date, p_date_to date, p_lease_token uuid, p_page integer)
RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $f$
  WITH u AS (UPDATE public.vendas_sync_cursor SET heartbeat_at=now(), next_page=p_page, updated_at=now()
              WHERE account=p_account AND date_from=p_date_from AND date_to=p_date_to AND running_since IS NOT NULL
             RETURNING 1)
  SELECT EXISTS (SELECT 1 FROM u);
$f$;
SQL
cen_zumbi_heartbeat 2027-01-01
[ "$OUT" != "f|3/true/false/TB" ] && ok "F1 sem token o zumbi move o next_page de B ($OUT) — N1 tem dente" || bad "F1 sabotei e N1 seguiu verde"
valida_reprova "F1b validador reprova heartbeat sem token" "nao exige o token"
restaura

# F2 → N2: finish cercado SEM o predicado do token
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.vendas_sync_finish_fenced(p_account text, p_date_from date, p_date_to date, p_lease_token uuid,
  p_complete boolean, p_next_page integer, p_last_error_kind text)
RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $f$
  WITH u AS (UPDATE public.vendas_sync_cursor
                SET next_page = CASE WHEN p_complete THEN NULL ELSE p_next_page END,
                    completed_at = CASE WHEN p_complete THEN now() ELSE completed_at END,
                    running_since = NULL, lease_token = NULL, heartbeat_at = now(), updated_at = now()
              WHERE account=p_account AND date_from=p_date_from AND date_to=p_date_to AND running_since IS NOT NULL
             RETURNING 1)
  SELECT EXISTS (SELECT 1 FROM u);
$f$;
SQL
cen_zumbi_finish 2027-02-01
[ "$OUT" != "f|3/true/false/TB" ] && ok "F2 sem token o zumbi FECHA a janela de B ($OUT) — N2 tem dente" || bad "F2 sabotei e N2 seguiu verde"
restaura

# F3 → N3: release cercado SEM o predicado do token
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.vendas_sync_release_fenced(p_account text, p_date_from date, p_date_to date, p_lease_token uuid, p_last_error_kind text)
RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $f$
  WITH u AS (UPDATE public.vendas_sync_cursor SET running_since=NULL, lease_token=NULL, last_error_kind=p_last_error_kind
              WHERE account=p_account AND date_from=p_date_from AND date_to=p_date_to AND running_since IS NOT NULL
             RETURNING 1)
  SELECT EXISTS (SELECT 1 FROM u);
$f$;
SQL
cen_zumbi_release 2027-03-01
[ "$OUT" != "f|3/true/false/TB" ] && ok "F3 sem token o zumbi SOLTA o lease de B ($OUT) — N3 tem dente" || bad "F3 sabotei e N3 seguiu verde"
restaura

# F4 → N1: o roubo NÃO troca o token (reaproveita o do morto)
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.vendas_sync_lease_acquire_fenced(p_account text, p_date_from date, p_date_to date)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $f$
  UPDATE public.vendas_sync_cursor
     SET running_since = now(), heartbeat_at = now(), updated_at = now(),
         lease_token = COALESCE(lease_token, gen_random_uuid())
   WHERE account = p_account AND date_from = p_date_from AND date_to = p_date_to
     AND completed_at IS NULL AND (running_since IS NULL OR heartbeat_at < now() - interval '3 minutes')
  RETURNING jsonb_build_object('resume_page', COALESCE(next_page, 1), 'lease_token', lease_token);
$f$;
SQL
cen_zumbi_heartbeat 2027-04-01
[ "$OUT" != "f|3/true/false/TB" ] && ok "F4 roubo sem token novo deixa o zumbi valido ($OUT) — N1 tem dente" || bad "F4 sabotei e N1 seguiu verde"
valida_reprova "F4b validador reprova acquire sem token novo" "nao emite token novo"
restaura

# F5 → N6: token NULL vira bypass (IS NOT DISTINCT FROM)
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.vendas_sync_heartbeat_fenced(p_account text, p_date_from date, p_date_to date, p_lease_token uuid, p_page integer)
RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $f$
  WITH u AS (UPDATE public.vendas_sync_cursor SET heartbeat_at=now(), next_page=p_page, updated_at=now()
              WHERE account=p_account AND date_from=p_date_from AND date_to=p_date_to AND running_since IS NOT NULL
                AND lease_token IS NOT DISTINCT FROM p_lease_token
             RETURNING 1)
  SELECT EXISTS (SELECT 1 FROM u);
$f$;
SQL
cen_token_nulo 2027-05-01
[ "$OUT" != "fff|4/true/false/null" ] && ok "F5 IS NOT DISTINCT FROM: token NULL vira chave-mestra ($OUT) — N6 tem dente" || bad "F5 sabotei e N6 seguiu verde"
restaura

# F6 → L1: heartbeat ANTIGO sem o guard lease_token IS NULL
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.vendas_sync_heartbeat(p_account text, p_date_from date, p_date_to date, p_page integer)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $f$
  UPDATE public.vendas_sync_cursor SET heartbeat_at = now(), next_page = p_page, updated_at = now()
   WHERE account = p_account AND date_from = p_date_from AND date_to = p_date_to AND running_since IS NOT NULL;
$f$;
SQL
cen_antigo_nao_toca_cercado 2027-06-01
[ "$OUT" != "5/true/false/T" ] && ok "F6 sem o guard a edge velha mexe no lease cercado ($OUT) — L1 tem dente" || bad "F6 sabotei e L1 seguiu verde"
valida_reprova "F6b validador reprova RPC antiga sem guard" "RPC antiga ainda age"
restaura

# F7 → L3: acquire ANTIGO não zera o token ao roubar
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.vendas_sync_lease_acquire(p_account text, p_date_from date, p_date_to date)
RETURNS integer LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $f$
  UPDATE public.vendas_sync_cursor SET running_since = now(), heartbeat_at = now(), updated_at = now()
   WHERE account = p_account AND date_from = p_date_from AND date_to = p_date_to
     AND completed_at IS NULL AND (running_since IS NULL OR heartbeat_at < now() - interval '3 minutes')
  RETURNING COALESCE(next_page, 1);
$f$;
SQL
cen_antigo_rouba_cercado 2027-07-01
case "$OUT" in 6\|t\|*) ok "F7 roubo antigo sem zerar token deixa o dono cercado vivo ($OUT) — L3 tem dente" ;; *) bad "F7 sabotei e L3 seguiu verde ($OUT)" ;; esac
valida_reprova "F7b validador reprova acquire antigo que nao zera token" "acquire antigo nao zera"
restaura

# F8 → A1: GRANT EXECUTE a authenticated
P -q -c "GRANT EXECUTE ON FUNCTION public.vendas_sync_heartbeat_fenced(text,date,date,uuid,integer) TO authenticated;" >/dev/null
R=$(P -q -tA 2>&1 <<'SQL'
SET ROLE authenticated;
DO $$ BEGIN
  PERFORM public.vendas_sync_heartbeat_fenced('oben','2026-01-01','2026-01-31',NULL,1);
  RAISE NOTICE 'EXECUTOU_SEM_BARRAR';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'AINDA_BARRA'; END $$;
SQL
)
case "$R" in *EXECUTOU_SEM_BARRAR*) ok "F8 com GRANT o authenticated executa — A1 tem dente" ;; *) bad "F8 concedi e A1 seguiu barrando: $R" ;; esac
valida_reprova "F8b validador reprova RPC cercada aberta a authenticated" "executavel por anon/authenticated"
P -q -c "REVOKE EXECUTE ON FUNCTION public.vendas_sync_heartbeat_fenced(text,date,date,uuid,integer) FROM authenticated;" >/dev/null
restaura

# F9 → C1: heartbeat check-then-act (TOCTOU) — o token é conferido num SELECT e o UPDATE não o repete
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.vendas_sync_heartbeat_fenced(p_account text, p_date_from date, p_date_to date, p_lease_token uuid, p_page integer)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $f$
DECLARE v uuid;
BEGIN
  SELECT lease_token INTO v FROM public.vendas_sync_cursor
   WHERE account=p_account AND date_from=p_date_from AND date_to=p_date_to;
  IF v IS DISTINCT FROM p_lease_token THEN RETURN false; END IF;
  UPDATE public.vendas_sync_cursor SET heartbeat_at=now(), next_page=p_page, updated_at=now()
   WHERE account=p_account AND date_from=p_date_from AND date_to=p_date_to AND running_since IS NOT NULL;
  RETURN FOUND;
END $f$;
SQL
cen_corrida 2027-08-01
case "$OUT" in bloqueio_observado\|t\|50) ok "F9 check-then-act: o zumbi grava pagina 50 por cima do roubo ($OUT) — C1 tem dente" ;; *) bad "F9 sabotei e C1 nao mudou ($OUT)" ;; esac
restaura

# Pós-restauração: a versão REAL voltou (o validador aprova e o zumbi volta a ser barrado).
V=$(Pq -f "$VALIDA")
case "$V" in "✅"*) ok "POS validador aprova depois de restaurar" ;; *) bad "POS restauracao incompleta: $V" ;; esac
cen_zumbi_heartbeat 2027-09-01; eq "POS N1 volta a barrar o zumbi" "$OUT" "f|3/true/false/TB"

echo "------------------------------"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "HARNESS VERMELHO"; exit 1; }
echo "HARNESS VERDE"
