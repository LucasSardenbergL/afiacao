#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA PG17 — 20261012130954_fin_sync_kick_skipped_busy_e_perdido.sql          ║
# ║  skipped_busy NÃO conta como "kick chegou" no fin_sync_kicks_perdidos.         ║
# ║  Rode:  bash db/test-fin-sync-kick-skipped-busy.sh > /tmp/t.log 2>&1; echo $? ║
# ║                                                                                ║
# ║  Prova:                                                                        ║
# ║   • cenário do incidente 2026-10-12 (colacor/mov skipped_busy às :40) vira     ║
# ║     elegível; complete/error/running pós-janela seguem bloqueando;             ║
# ║     guard (d) segura enquanto a conta está ocupada; guard (c) 1/janela.        ║
# ║   • e2e: fin_sync_retry_tick posta EXATAMENTE o kick perdido, 1 vez.           ║
# ║   • postcondição da migration tem dente (corpo sem o fix / ACL aberto).        ║
# ║   • FALSIFICAÇÃO na MESMA invocação: corpo antigo (20260704102000) → vermelho; ║
# ║     controle verde antes e depois.                                             ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export PGVER=17   # consumido pelo db/lib/pg-harness.sh via source
PORT="${PGPORT_TEST:-5471}"
SLUG="fin-sync-kick-skipped-busy"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C

# shellcheck disable=SC1091  # o gate roda sem -x; o helper e versionado ao lado, em db/lib/
. "$REPO_ROOT/db/lib/pg-harness.sh"

TMPD="$(dirname "$DATA")"
cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMPD"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "/tmp/pg-${SLUG}.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
P()  { "$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

echo "═══ setup PG17 :$PORT ═══"

# ── pré-requisitos que as migrations LEEM mas não criam (forma de prod) ──
P -q <<'SQL'
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname='app_role') THEN
    CREATE TYPE public.app_role AS ENUM ('employee','customer','master');
  END IF;
END $$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon')          THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role')  THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
END $$;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
CREATE SCHEMA IF NOT EXISTS auth;
CREATE OR REPLACE FUNCTION auth.uid()  RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.uid',  true), '')::uuid $f$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.role', true), '') $f$;
CREATE TABLE IF NOT EXISTS auth.users (id uuid PRIMARY KEY);
CREATE TABLE IF NOT EXISTS public.user_roles (user_id uuid, role public.app_role);
CREATE TABLE IF NOT EXISTS public.fin_sync_log (
  id uuid DEFAULT gen_random_uuid(), action text, companies text[], status text, started_at timestamptz
);
CREATE TABLE IF NOT EXISTS public.fin_sync_cursor (
  company text, resource text, next_page int, updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company, resource)
);
CREATE SCHEMA IF NOT EXISTS net;
CREATE TABLE net._http_calls (id bigserial PRIMARY KEY, url text, headers jsonb, body jsonb, timeout_milliseconds int);
CREATE OR REPLACE FUNCTION net.http_post(
  url text, body jsonb DEFAULT '{}', params jsonb DEFAULT '{}', headers jsonb DEFAULT '{}', timeout_milliseconds int DEFAULT 5000
) RETURNS bigint LANGUAGE sql AS $f$
  INSERT INTO net._http_calls(url, headers, body, timeout_milliseconds)
  VALUES (url, headers, body, timeout_milliseconds) RETURNING id;
$f$;
CREATE SCHEMA IF NOT EXISTS vault;
CREATE TABLE vault.decrypted_secrets (name text, decrypted_secret text);
INSERT INTO vault.decrypted_secrets VALUES ('CRON_SECRET','shh');
CREATE SCHEMA IF NOT EXISTS cron;
CREATE TABLE cron.job (jobid bigserial, jobname text, schedule text, command text);
CREATE OR REPLACE FUNCTION cron.schedule(job_name text, schedule text, command text)
RETURNS bigint LANGUAGE sql AS $f$
  INSERT INTO cron.job(jobname, schedule, command) VALUES (job_name, schedule, command) RETURNING jobid;
$f$;
SQL

OLD="$REPO_ROOT/supabase/migrations/20260704102000_fin_sync_retry_kick_perdido.sql"
MIG="$REPO_ROOT/supabase/migrations/20261012130954_fin_sync_kick_skipped_busy_e_perdido.sql"
P -q -f "$OLD"
# ACL de prod (medido via psql-ro 2026-10-12): service_role=X vem do default privilege do Supabase
P -q -c "GRANT EXECUTE ON FUNCTION public.fin_sync_kicks_perdidos(timestamptz) TO service_role;"
P -q -f "$MIG"
P -q -f "$MIG" 2>/dev/null && ok "L0 migration nova aplica 2× (idempotente) sobre a antiga"

# ── helpers ──
reset() { P -q -c "TRUNCATE public.fin_sync_log, public.fin_sync_cursor, public.fin_sync_kick_retry, net._http_calls RESTART IDENTITY;"; }
log()   { P -q -c "INSERT INTO public.fin_sync_log(action,companies,status,started_at) VALUES ('sync_$1', ARRAY['$2'], '$3', '$4');"; }
A="2026-10-12 09:30:00+00"   # âncora: janela mov de hoje = 08:40 UTC (05:40 BRT), grace vencido
MOV=" WHERE company='colacor' AND resource='movimentacoes'"
kicks() { Pq -c "SELECT count(*) FROM public.fin_sync_kicks_perdidos('$A')$1;"; }

# estado do incidente: cursor terminado ontem 19:20 UTC, kick de hoje 08:40:03 saiu skipped_busy
incidente() {
  reset
  P -q -c "INSERT INTO public.fin_sync_cursor(company,resource,next_page,updated_at) VALUES ('colacor','movimentacoes',NULL,'2026-10-11 19:20:12+00');"
  log movimentacoes colacor skipped_busy '2026-10-12 08:40:03+00'
}

# cenários que dependem do fix; rodam no controle E na sabotagem
caso_incidente() { incidente; kicks "$MOV"; }
caso_e2e() {
  reset
  # cobre todo kick perdido de AGORA, menos colacor/mov — que recebe só um skipped_busy
  P -q <<'SQL'
INSERT INTO public.fin_sync_log(action,companies,status,started_at)
SELECT 'sync_'||k.resource, ARRAY[k.company],
       CASE WHEN k.company='colacor' AND k.resource='movimentacoes' THEN 'skipped_busy' ELSE 'complete' END,
       k.janela + interval '3 seconds'
FROM public.fin_sync_kicks_perdidos(now()) k;
SQL
  P -q -c "SELECT public.fin_sync_retry_tick();" >/dev/null
  P -q -c "SELECT public.fin_sync_retry_tick();" >/dev/null   # 2º tick: guard (c) não re-posta
  Pq -c "SELECT count(*)||':'||coalesce(string_agg(body->>'company'||'/'||(body->>'action'), ','),'') FROM net._http_calls;"
}

echo "── controle (migration nova) ──"
eq "C1 incidente: skipped_busy às :40 → kick perdido elegível" "$(caso_incidente)" "1"
eq "C2 e2e: retry_tick posta só colacor/sync_movimentacoes, 1×" "$(caso_e2e)" "1:colacor/sync_movimentacoes"

incidente; log movimentacoes colacor complete '2026-10-12 08:55:00+00'
eq "C3 skipped_busy + complete depois → bloqueia" "$(kicks "$MOV")" "0"
incidente; log movimentacoes colacor error '2026-10-12 08:55:00+00'
eq "C4 skipped_busy + error → bloqueia (decisão 6 preservada)" "$(kicks "$MOV")" "0"
incidente; log movimentacoes colacor running '2026-10-12 08:50:00+00'
eq "C5 skipped_busy + running pós-janela → bloqueia" "$(kicks "$MOV")" "0"
incidente; log contas_receber colacor running '2026-10-12 09:25:00+00'
eq "C6 conta ocupada (running <10min) → guard (d) segura" "$(kicks "$MOV")" "0"
incidente; log contas_receber colacor running '2026-10-12 09:10:00+00'
eq "C7 running de 20min atrás não segura" "$(kicks "$MOV")" "1"
incidente; P -q -c "INSERT INTO public.fin_sync_kick_retry(company,resource,janela) VALUES ('colacor','movimentacoes','2026-10-12 08:40:00+00');"
eq "C8 retry já feito na janela → guard (c), sem laço" "$(kicks "$MOV")" "0"
incidente; log movimentacoes oben skipped_busy '2026-10-12 08:40:03+00'; log movimentacoes oben complete '2026-10-12 08:41:00+00'
eq "C9 skipped_busy de outra empresa não vaza" "$(kicks " WHERE company='oben' AND resource='movimentacoes'")" "0"
incidente; P -q -c "UPDATE public.fin_sync_cursor SET next_page=5, updated_at='2026-10-12 08:45:00+00';"
eq "C10 cursor pendente → continuador cobre (guard b)" "$(kicks "$MOV")" "0"

echo "── postcondição tem dente ──"
SAB="$TMPD/sem-fix.sql"
grep -v "IS DISTINCT FROM 'skipped_busy'" "$MIG" > "$SAB"
if OUT=$(P -q -f "$SAB" 2>&1); then bad "PC1 corpo sem o fix passou na postcondição"; else
  case "$OUT" in *"guard (a) sem a"*) ok "PC1 corpo sem o fix → postcondição aborta";; *) bad "PC1 abortou pelo motivo errado: $OUT";; esac; fi
P -q -c "GRANT EXECUTE ON FUNCTION public.fin_sync_kicks_perdidos(timestamptz) TO anon;"
if OUT=$(P -q -f "$MIG" 2>&1); then bad "PC2 ACL aberto passou na postcondição"; else
  case "$OUT" in *"anon executa"*) ok "PC2 ACL aberto → postcondição aborta";; *) bad "PC2 abortou pelo motivo errado: $OUT";; esac; fi
P -q -c "REVOKE EXECUTE ON FUNCTION public.fin_sync_kicks_perdidos(timestamptz) FROM anon;"
P -q -f "$MIG"

echo "── falsificação: corpo ANTIGO (any-status) → vermelho ──"
P -q -f "$OLD" >/dev/null 2>&1
V=$(caso_incidente)
if [ "$V" = "0" ]; then ok "F1 corpo antigo → incidente invisível (C1 tem dente)"; else bad "F1 corpo antigo e C1 seguiu [$V]"; fi
V=$(caso_e2e)
if [ "$V" = "0:" ]; then ok "F2 corpo antigo → retry_tick não posta (C2 tem dente)"; else bad "F2 corpo antigo e C2 seguiu [$V]"; fi
P -q -f "$MIG"
eq "F3 controle restaurado (mesma invocação)" "$(caso_incidente)" "1"

echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
