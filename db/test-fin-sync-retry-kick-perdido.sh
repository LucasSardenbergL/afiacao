#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA PG17 — 20260704102000_fin_sync_retry_kick_perdido.sql                   ║
# ║  Retry de kick perdido do fin-sync (money-path financeiro).                    ║
# ║  Rode:  bash db/test-fin-sync-retry-kick-perdido.sh > /tmp/t.log 2>&1; echo $? ║
# ║                                                                                ║
# ║  Prova:                                                                        ║
# ║   • fin_sync_kicks_perdidos (decisão PURA): janelas UTC, grace 30min,          ║
# ║     guards a/b/c/d, decisão-6 (any-status bloqueia, não só complete), prio,    ║
# ║     fronteira de dia, independência de TimeZone, guard-d (conta ocupada).      ║
# ║   • fin_sync_retry_tick (efeito): retry+request_id, cap 1/empresa/tick,        ║
# ║     espalhamento por tick (guard c e2e), advisory lock (no-op sob lock).       ║
# ║   • RLS da tabela nova fin_sync_kick_retry.                                    ║
# ║   • FALSIFICAÇÃO de cada guard (sabota → exige vermelho → restaura).           ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5457}"
SLUG="fin_sync_retry_kick"
DATA="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")/data"
export LC_ALL=C LANG=C

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER} pgvector"; exit 1; }

CELLAR="$(brew --prefix "postgresql@${PGVER}")"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$(dirname "$DATA")"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "/tmp/pg-${SLUG}.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
P()  { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
Pq() { P -tA "$@"; }

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

echo "═══ setup PG17 :$PORT ═══"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — PRÉ-REQUISITOS (schemas/objetos que a migração LÊ mas não cria)
# ══════════════════════════════════════════════════════════════════════════════
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
-- STUB net.http_post: registra e devolve request_id crescente
CREATE SCHEMA IF NOT EXISTS net;
CREATE TABLE net._http_calls (
  id bigserial PRIMARY KEY, url text, headers jsonb, body jsonb, timeout_milliseconds int, called_at timestamptz DEFAULT now()
);
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
echo "pré-requisitos ok"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — APLICAR A MIGRATION REAL
# ══════════════════════════════════════════════════════════════════════════════
MIG="$REPO_ROOT/supabase/migrations/20260704102000_fin_sync_retry_kick_perdido.sql"
P -q -f "$MIG"
echo "migration aplicada: $(basename "$MIG")"

Pq -c "SELECT count(*) FROM public.fin_sync_kicks_perdidos('2026-07-04 09:30:00+00');" >/dev/null && ok "L0 fin_sync_kicks_perdidos executa (não só CREATE)"
Pq -c "SELECT public.fin_sync_retry_tick();" >/dev/null && ok "L0 fin_sync_retry_tick executa (não só CREATE)"
CRON_SCHED=$(Pq -c "SELECT schedule FROM cron.job WHERE jobname='fin-sync-retry-kicks' ORDER BY jobid DESC LIMIT 1;")
CRON_CMD=$(Pq   -c "SELECT command  FROM cron.job WHERE jobname='fin-sync-retry-kicks' ORDER BY jobid DESC LIMIT 1;")
eq "L1 cron schedule offset :5 (nunca :00/:20/:40)" "$CRON_SCHED" "5-55/10 * * * *"
case "$CRON_CMD" in *fin_sync_retry_tick*) ok "L1 cron chama fin_sync_retry_tick()";; *) bad "L1 cron errado: $CRON_CMD";; esac
# NÃO toca o continuador (não deve aparecer — migração não o recria)
eq "L2 continuador intocado" "$(Pq -c "SELECT count(*) FROM cron.job WHERE jobname='fin-sync-continuacao-10min';")" "0"

# helpers de cenário
reset()   { P -q -c "TRUNCATE public.fin_sync_log, public.fin_sync_cursor, public.fin_sync_kick_retry, net._http_calls RESTART IDENTITY;"; }
cover()   { P -q -c "INSERT INTO public.fin_sync_log(action,companies,status,started_at) VALUES ('sync_$1', ARRAY['$2'], 'complete', now());"; }
running() { P -q -c "INSERT INTO public.fin_sync_log(action,companies,status,started_at) VALUES ('sync_$1', ARRAY['$2'], 'running', '$3');"; }
kicks()   { Pq -c "SELECT count(*) FROM public.fin_sync_kicks_perdidos('$1')$2;"; }

A="2026-07-04 09:30:00+00"   # âncora: janelas ativas hoje CP 08:00 / CR 08:20 / mov 08:40

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4 — ASSERTS
# ══════════════════════════════════════════════════════════════════════════════
echo "── fin_sync_kicks_perdidos (decisão pura) ──"

reset
eq "A1 perdido puro → elegível" "$(kicks "$A" " WHERE company='oben' AND resource='contas_pagar'")" "1"

reset; P -q -c "INSERT INTO public.fin_sync_log(action,companies,status,started_at) VALUES ('sync_contas_pagar',ARRAY['oben'],'complete','2026-07-04 08:00:15+00');"
eq "A2 log complete pós-janela bloqueia (guard a)" "$(kicks "$A" " WHERE company='oben' AND resource='contas_pagar'")" "0"

reset; P -q -c "INSERT INTO public.fin_sync_log(action,companies,status,started_at) VALUES ('sync_contas_pagar',ARRAY['oben'],'running','2026-07-04 08:05:00+00');"
eq "A3 log running pós-janela bloqueia (kick chegou)" "$(kicks "$A" " WHERE company='oben' AND resource='contas_pagar'")" "0"

reset; P -q -c "INSERT INTO public.fin_sync_log(action,companies,status,started_at) VALUES ('sync_contas_pagar',ARRAY['oben'],'error','2026-07-04 08:05:00+00');"
eq "A4 log error pós-janela bloqueia (decisão 6)" "$(kicks "$A" " WHERE company='oben' AND resource='contas_pagar'")" "0"

reset; P -q -c "INSERT INTO public.fin_sync_log(action,companies,status,started_at) VALUES ('sync_contas_pagar',ARRAY['oben'],'running','2026-07-04 07:30:00+00');"
eq "A5 running pré-janela não bloqueia (órfã antiga)" "$(kicks "$A" " WHERE company='oben' AND resource='contas_pagar'")" "1"

reset; P -q -c "INSERT INTO public.fin_sync_cursor(company,resource,next_page,updated_at) VALUES ('oben','contas_pagar',3,'2026-07-04 08:02:00+00');"
eq "A6 cursor pendente bloqueia (guard b)" "$(kicks "$A" " WHERE company='oben' AND resource='contas_pagar'")" "0"

reset; P -q -c "INSERT INTO public.fin_sync_cursor(company,resource,next_page,updated_at) VALUES ('oben','contas_pagar',NULL,'2026-07-04 08:10:00+00');"
eq "A7 cursor updated_at pós-janela bloqueia" "$(kicks "$A" " WHERE company='oben' AND resource='contas_pagar'")" "0"

reset; P -q -c "INSERT INTO public.fin_sync_cursor(company,resource,next_page,updated_at) VALUES ('oben','contas_pagar',NULL,'2026-07-04 07:00:00+00');"
eq "A8 cursor updated_at pré-janela não bloqueia" "$(kicks "$A" " WHERE company='oben' AND resource='contas_pagar'")" "1"

reset; P -q -c "INSERT INTO public.fin_sync_kick_retry(company,resource,janela) VALUES ('oben','contas_pagar','2026-07-04 08:00:00+00');"
eq "A9 retry mesma janela bloqueia (guard c)" "$(kicks "$A" " WHERE company='oben' AND resource='contas_pagar'")" "0"

reset; P -q -c "INSERT INTO public.fin_sync_kick_retry(company,resource,janela) VALUES ('oben','contas_pagar','2026-07-03 14:00:00+00');"
eq "A10 retry de janela anterior não bloqueia" "$(kicks "$A" " WHERE company='oben' AND resource='contas_pagar'")" "1"

# A_d guard-d: conta Omie ocupada (running recente de OUTRO recurso da empresa)
reset; running contas_receber oben '2026-07-04 09:25:00+00'   # running recente (5min antes da âncora)
eq "Ad1 running recente da empresa bloqueia CP (guard d)" "$(kicks "$A" " WHERE company='oben' AND resource='contas_pagar'")" "0"
reset; running contas_receber oben '2026-07-04 09:00:00+00'   # running antigo (30min antes) → órfão, não bloqueia
eq "Ad2 running antigo não bloqueia CP (guard d)" "$(kicks "$A" " WHERE company='oben' AND resource='contas_pagar'")" "1"

reset
eq "A11 grace: janela 08:00 não elegível às 08:15" "$(kicks '2026-07-04 08:15:00+00' " WHERE janela='2026-07-04 08:00:00+00'")" "0"
eq "A11b grace: janela 08:00 elegível às 08:31"    "$(kicks '2026-07-04 08:31:00+00' " WHERE company='oben' AND resource='contas_pagar' AND janela='2026-07-04 08:00:00+00'")" "1"

reset
eq "A12 prio CP=1"  "$(Pq -c "SELECT prio FROM public.fin_sync_kicks_perdidos('$A') WHERE company='oben' AND resource='contas_pagar';")" "1"
eq "A12 prio mov=3" "$(Pq -c "SELECT prio FROM public.fin_sync_kicks_perdidos('$A') WHERE company='oben' AND resource='movimentacoes';")" "3"

reset
eq "A13 janela é UTC (TZ São Paulo não desloca)" \
   "$(Pq -c "SET TimeZone='America/Sao_Paulo'; SELECT count(*) FROM public.fin_sync_kicks_perdidos('$A') WHERE company='oben' AND resource='contas_pagar' AND janela='2026-07-04 08:00:00+00';" | tail -1)" "1"

reset
eq "A14 pós-meia-noite pega janela CP de ontem 14:00" "$(kicks '2026-07-04 00:15:00+00' " WHERE company='oben' AND resource='contas_pagar' AND janela='2026-07-03 14:00:00+00'")" "1"
eq "A14b nenhuma janela futura inventada"             "$(kicks '2026-07-04 00:15:00+00' " WHERE janela > '2026-07-04 00:15:00+00'")" "0"

# ── fin_sync_retry_tick (efeito; determinístico via neutralização com now()) ──
echo "── fin_sync_retry_tick (efeito) ──"

# T2 retry: kick perdido → 1 retry + request_id + 1 post
reset
for r in contas_pagar contas_receber movimentacoes; do for c in oben colacor colacor_sc; do
  if [ "$r" = "contas_pagar" ] && [ "$c" = "oben" ]; then continue; fi; cover "$r" "$c"; done; done
P -q -c "SELECT public.fin_sync_retry_tick();" >/dev/null
eq "T2 retry: 1 linha em fin_sync_kick_retry" "$(Pq -c "SELECT count(*) FROM public.fin_sync_kick_retry;")" "1"
eq "T2 retry: par correto"                    "$(Pq -c "SELECT company||'/'||resource FROM public.fin_sync_kick_retry;")" "oben/contas_pagar"
eq "T2 retry: request_id gravado"             "$(Pq -c "SELECT (request_id IS NOT NULL)::text FROM public.fin_sync_kick_retry;")" "true"
eq "T2 retry: 1 post action certo"            "$(Pq -c "SELECT body->>'action' FROM net._http_calls WHERE body->>'company'='oben';")" "sync_contas_pagar"
eq "T2 retry: request_id == id do post"       "$(Pq -c "SELECT (r.request_id = c.id)::text FROM public.fin_sync_kick_retry r, net._http_calls c;")" "true"

# T3 CAP 1/empresa/tick: oben CP+CR perdidos → só 1 retry (CP, prio 1)
reset
cover movimentacoes oben
for r in contas_pagar contas_receber movimentacoes; do for c in colacor colacor_sc; do cover "$r" "$c"; done; done
P -q -c "SELECT public.fin_sync_retry_tick();" >/dev/null
eq "T3 cap: 1 retry p/ oben no tick"        "$(Pq -c "SELECT count(*) FROM public.fin_sync_kick_retry WHERE company='oben';")" "1"
eq "T3 cap: o retry é o de maior prio (CP)" "$(Pq -c "SELECT resource FROM public.fin_sync_kick_retry WHERE company='oben';")" "contas_pagar"
eq "T3 cap: só 1 post no tick"              "$(Pq -c "SELECT count(*) FROM net._http_calls;")" "1"

# T4 espalhamento por tick + anti-tempestade (guard c e2e)
P -q -c "TRUNCATE net._http_calls RESTART IDENTITY;"
P -q -c "SELECT public.fin_sync_retry_tick();" >/dev/null   # tick 2 → cobre CR
POSTS_T2=$(Pq -c "SELECT count(*) FROM net._http_calls;")
P -q -c "SELECT public.fin_sync_retry_tick();" >/dev/null   # tick 3 → nada novo
POSTS_T3=$(Pq -c "SELECT count(*) FROM net._http_calls;")
eq "T4 tick 2 cobre CR (1 post novo)"            "$POSTS_T2" "1"
eq "T4 tick 3 não repete (0 posts novos)"        "$POSTS_T3" "1"
eq "T4 total 2 retries p/ oben (CP+CR, nunca 3)" "$(Pq -c "SELECT count(*) FROM public.fin_sync_kick_retry WHERE company='oben';")" "2"
eq "T4 retries são CP e CR distintos"            "$(Pq -c "SELECT string_agg(resource,',' ORDER BY resource) FROM public.fin_sync_kick_retry WHERE company='oben';")" "contas_pagar,contas_receber"

# T5 guard-d e2e: empresa com running recente NÃO é re-kickada pelo tick
reset
P -q -c "INSERT INTO public.fin_sync_log(action,companies,status,started_at) VALUES ('sync_contas_receber',ARRAY['oben'],'running', now());"
# oben CP está descoberto, mas a conta está ocupada (CR running agora) → tick não posta p/ oben
for c in colacor colacor_sc; do for r in contas_pagar contas_receber movimentacoes; do cover "$r" "$c"; done; done
cover movimentacoes oben  # neutraliza mov de oben (não interfere)
P -q -c "SELECT public.fin_sync_retry_tick();" >/dev/null
eq "T5 guard-d: 0 retry p/ oben (conta ocupada)" "$(Pq -c "SELECT count(*) FROM public.fin_sync_kick_retry WHERE company='oben';")" "0"

# ── RLS ──
echo "── RLS fin_sync_kick_retry ──"
reset
P -q <<'SQL'
INSERT INTO auth.users(id) VALUES
  ('11111111-1111-1111-1111-111111111111'),
  ('22222222-2222-2222-2222-222222222222') ON CONFLICT DO NOTHING;
INSERT INTO public.user_roles(user_id,role) VALUES
  ('11111111-1111-1111-1111-111111111111','master') ON CONFLICT DO NOTHING;
INSERT INTO public.fin_sync_kick_retry(company,resource,janela) VALUES ('oben','contas_pagar','2026-07-04 08:00:00+00');
GRANT SELECT ON public.fin_sync_kick_retry, public.user_roles TO authenticated, anon;
SQL
STAFF=$(Pq   -c "SET test.uid='11111111-1111-1111-1111-111111111111'; SET ROLE authenticated; SELECT count(*) FROM public.fin_sync_kick_retry;" | tail -1)
NOSTAFF=$(Pq -c "SET test.uid='22222222-2222-2222-2222-222222222222'; SET ROLE authenticated; SELECT count(*) FROM public.fin_sync_kick_retry;" | tail -1)
ANON=$(Pq    -c "SET ROLE anon; SELECT count(*) FROM public.fin_sync_kick_retry;" | tail -1)
eq "R1 staff (master) lê"               "$STAFF"   "1"
eq "R2 authenticated não-staff não lê"  "$NOSTAFF" "0"
eq "R3 anon não lê"                     "$ANON"    "0"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICAÇÃO
# ══════════════════════════════════════════════════════════════════════════════
echo "── falsificação (cada guard tem dente?) ──"

# base furável: $1 grace-expr, $2 guard-a(log), $3 guard-c(retry), $4 guard-d(running)
sabota_kicks() {
P -q <<SQL
CREATE OR REPLACE FUNCTION public.fin_sync_kicks_perdidos(p_now timestamptz DEFAULT now())
RETURNS TABLE(company text, resource text, janela timestamptz, prio int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS \$fn\$
  WITH recursos(resource, off_min, prio) AS (
    VALUES ('contas_pagar',0,1),('contas_receber',20,2),('movimentacoes',40,3)
  ),
  janelas AS (
    SELECT r.resource, r.prio,
           ((date_trunc('day', p_now AT TIME ZONE 'UTC') - make_interval(days=>d.d)
             + make_interval(hours=>h.h, mins=>r.off_min)) AT TIME ZONE 'UTC') AS janela
    FROM recursos r, (VALUES (0),(1)) d(d), (VALUES (8),(14)) h(h)
  ),
  ultima_janela AS (
    SELECT j.resource, j.prio, max(j.janela) AS janela
    FROM janelas j WHERE j.janela <= p_now ${1}
    GROUP BY j.resource, j.prio
  ),
  empresas(company) AS (VALUES ('oben'),('colacor'),('colacor_sc'))
  SELECT e.company, u.resource, u.janela, u.prio
  FROM empresas e CROSS JOIN ultima_janela u
  WHERE ${2}
    AND NOT EXISTS (SELECT 1 FROM public.fin_sync_cursor cur WHERE cur.company=e.company AND cur.resource=u.resource AND (cur.next_page IS NOT NULL OR cur.updated_at>=u.janela))
    AND ${3}
    AND ${4}
\$fn\$;
SQL
}
GRACE="- interval '30 minutes'"
LOG="NOT EXISTS (SELECT 1 FROM public.fin_sync_log l WHERE l.action='sync_'||u.resource AND e.company=ANY(l.companies) AND l.started_at>=u.janela)"
RETRY="NOT EXISTS (SELECT 1 FROM public.fin_sync_kick_retry r WHERE r.company=e.company AND r.resource=u.resource AND r.janela=u.janela)"
RUNNING="NOT EXISTS (SELECT 1 FROM public.fin_sync_log l WHERE e.company=ANY(l.companies) AND l.status='running' AND l.started_at > p_now - interval '10 minutes')"
restore() { P -q -f "$MIG" >/dev/null; }

# F1 grace tem dente
reset
sabota_kicks "- interval '0 minutes'" "$LOG" "$RETRY" "$RUNNING"
V=$(kicks '2026-07-04 08:15:00+00' " WHERE janela='2026-07-04 08:00:00+00'")
[ "$V" != "0" ] && ok "F1 grace furado → janela recente elegível (A11 tem dente)" || bad "F1 grace sabotado e nada mudou"
restore

# F2 guard-a tem dente
reset; P -q -c "INSERT INTO public.fin_sync_log(action,companies,status,started_at) VALUES ('sync_contas_pagar',ARRAY['oben'],'complete','2026-07-04 08:00:15+00');"
sabota_kicks "$GRACE" "true" "$RETRY" "$RUNNING"
V=$(kicks "$A" " WHERE company='oben' AND resource='contas_pagar'")
[ "$V" != "0" ] && ok "F2 sem guard-log → complete não bloqueia (A2/A3 têm dente)" || bad "F2 guard-log sabotado e nada mudou"
restore

# F3 decisão-6 tem dente (só-complete deixa error passar)
reset; P -q -c "INSERT INTO public.fin_sync_log(action,companies,status,started_at) VALUES ('sync_contas_pagar',ARRAY['oben'],'error','2026-07-04 08:05:00+00');"
sabota_kicks "$GRACE" "NOT EXISTS (SELECT 1 FROM public.fin_sync_log l WHERE l.action='sync_'||u.resource AND e.company=ANY(l.companies) AND l.status='complete' AND l.started_at>=u.janela)" "$RETRY" "$RUNNING"
V=$(kicks "$A" " WHERE company='oben' AND resource='contas_pagar'")
[ "$V" != "0" ] && ok "F3 só-complete → error re-kickado (A4/decisão-6 tem dente)" || bad "F3 decisão-6 não provada"
restore

# F4 guard-c tem dente
reset; P -q -c "INSERT INTO public.fin_sync_kick_retry(company,resource,janela) VALUES ('oben','contas_pagar','2026-07-04 08:00:00+00');"
sabota_kicks "$GRACE" "$LOG" "true" "$RUNNING"
V=$(kicks "$A" " WHERE company='oben' AND resource='contas_pagar'")
[ "$V" != "0" ] && ok "F4 sem guard-retry → retry repete (A9 tem dente)" || bad "F4 guard-retry sabotado e nada mudou"
restore

# F_d guard-d tem dente
reset; running contas_receber oben '2026-07-04 09:25:00+00'
sabota_kicks "$GRACE" "$LOG" "$RETRY" "true"
V=$(kicks "$A" " WHERE company='oben' AND resource='contas_pagar'")
[ "$V" != "0" ] && ok "Fd sem guard-running → conta ocupada re-kickada (Ad1 tem dente)" || bad "Fd guard-d sabotado e nada mudou"
restore

# F5 CAP (tick): sem DISTINCT ON, oben CP+CR gera 2 retries no MESMO tick
reset
cover movimentacoes oben
for r in contas_pagar contas_receber movimentacoes; do for c in colacor colacor_sc; do cover "$r" "$c"; done; done
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.fin_sync_retry_tick() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $fn$
DECLARE k record; v_req bigint; v_url constant text := 'https://x';
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtext('fin_sync_retry_tick')::bigint) THEN RETURN; END IF;
  FOR k IN SELECT kp.company, kp.resource, kp.janela FROM public.fin_sync_kicks_perdidos(now()) kp ORDER BY kp.company, kp.prio  -- SABOTADO: sem DISTINCT ON
  LOOP
    INSERT INTO public.fin_sync_kick_retry (company, resource, janela) VALUES (k.company,k.resource,k.janela) ON CONFLICT DO NOTHING;
    IF FOUND THEN SELECT net.http_post(url:=v_url, body:=jsonb_build_object('action','sync_'||k.resource,'company',k.company)) INTO v_req; END IF;
  END LOOP;
END $fn$;
SQL
P -q -c "SELECT public.fin_sync_retry_tick();" >/dev/null
V=$(Pq -c "SELECT count(*) FROM public.fin_sync_kick_retry WHERE company='oben';")
[ "$V" -ge 2 ] && ok "F5 sem DISTINCT ON → 2 retries/empresa/tick (T3/cap tem dente, veio $V)" || bad "F5 removi o cap e ainda deu $V"
restore

# F6 advisory lock (concorrência real)
echo "── advisory lock (concorrência) ──"
reset
cover movimentacoes oben; cover contas_receber oben
for r in contas_pagar contas_receber movimentacoes; do for c in colacor colacor_sc; do cover "$r" "$c"; done; done
( P -q -c "BEGIN; SELECT pg_advisory_xact_lock(hashtext('fin_sync_retry_tick')::bigint); SELECT pg_sleep(4); COMMIT;" >/dev/null 2>&1 ) &
LOCKPID=$!
LOCK_HELD=0
for _ in $(seq 1 60); do
  H=$(Pq -c "SELECT count(*) FROM pg_locks WHERE locktype='advisory';" 2>/dev/null || echo 0)
  if [ "${H:-0}" -ge 1 ]; then LOCK_HELD=1; break; fi
  sleep 0.1
done
if [ "$LOCK_HELD" = "1" ]; then
  P -q -c "TRUNCATE net._http_calls RESTART IDENTITY;"
  P -q -c "SELECT public.fin_sync_retry_tick();" >/dev/null
  eq "F6 tick vira no-op sob lock ocupado" "$(Pq -c "SELECT count(*) FROM net._http_calls;")" "0"
  P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.fin_sync_retry_tick() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','pg_temp' AS $fn$
DECLARE k record; v_req bigint; v_url constant text := 'https://x';
BEGIN
  -- SABOTADO: sem pg_try_advisory_xact_lock
  FOR k IN SELECT DISTINCT ON (kp.company) kp.company, kp.resource, kp.janela FROM public.fin_sync_kicks_perdidos(now()) kp ORDER BY kp.company, kp.prio
  LOOP
    INSERT INTO public.fin_sync_kick_retry (company, resource, janela) VALUES (k.company,k.resource,k.janela) ON CONFLICT DO NOTHING;
    IF FOUND THEN SELECT net.http_post(url:=v_url, body:=jsonb_build_object('action','sync_'||k.resource,'company',k.company)) INTO v_req; END IF;
  END LOOP;
END $fn$;
SQL
  P -q -c "TRUNCATE net._http_calls RESTART IDENTITY; TRUNCATE public.fin_sync_kick_retry;"
  P -q -c "SELECT public.fin_sync_retry_tick();" >/dev/null
  V=$(Pq -c "SELECT count(*) FROM net._http_calls;")
  [ "$V" -ge 1 ] && ok "F6b sem try-lock → tick posta sob lock ocupado (F6 tem dente, veio $V)" || bad "F6b removi o lock e o tick não postou ($V)"
  restore
else
  echo "  ⚠️  F6 pulado: não detectei o lock em A (timing) — advisory lock não provado nesta run"
fi
wait "$LOCKPID" 2>/dev/null || true

echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
