#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  HARNESS PG17 — vendas_sync_cursor (cursor + lease do backfill de pedidos)     ║
# ║  Prova money-path: serialização real (lease), retomada por next_page,         ║
# ║  completude SÓ com fim-real, RLS (staff lê / service escreve / RPC gated),     ║
# ║  e a lógica do cron de continuação (1 http_post por conta, a janela + antiga). ║
# ║  Rodar:  bash db/test-vendas_sync_cursor.sh > /tmp/t.log 2>&1; echo "exit=$?"  ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

# ── arranque PG17 descartável (contorna keg-only do brew) ──
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5457}"
SLUG="vendas_sync_cursor"
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

P -q -f "$REPO_ROOT/db/stubs-supabase.sql"
P -q <<'SQL'
CREATE OR REPLACE FUNCTION auth.uid()  RETURNS uuid LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.uid',  true), '')::uuid $f$;
CREATE OR REPLACE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $f$ SELECT nullif(current_setting('test.role', true), '') $f$;
ALTER ROLE service_role BYPASSRLS;
SQL

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

echo "═══ setup pronto (PG17 :$PORT) ═══"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — PRÉ-REQUISITOS (o que a migração lê/usa mas não cria):
#   app_role + user_roles (RLS); cron/net/vault stubados p/ a migração REAL aplicar.
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname='app_role') THEN
  CREATE TYPE public.app_role AS ENUM ('master','employee','customer'); END IF; END $$;
CREATE TABLE IF NOT EXISTS public.user_roles (user_id uuid, role public.app_role);

-- pg_cron: o schema + cron.job já vêm do stubs-supabase.sql (jobid bigint PK, sem unique em jobname).
-- Só faltam as FUNÇÕES schedule/unschedule — GUARDAM o command (pra eu EXECUTAR a string REAL depois).
CREATE OR REPLACE FUNCTION cron.schedule(p_jobname text, p_schedule text, p_command text)
RETURNS bigint LANGUAGE plpgsql AS $$
DECLARE v_id bigint;
BEGIN
  DELETE FROM cron.job WHERE jobname = p_jobname;          -- delete-then-insert (sem unique em jobname)
  v_id := COALESCE((SELECT max(jobid) FROM cron.job), 0) + 1;
  INSERT INTO cron.job(jobid, jobname, schedule, command, active) VALUES (v_id, p_jobname, p_schedule, p_command, true);
  RETURN v_id;
END $$;
CREATE OR REPLACE FUNCTION cron.unschedule(p_jobname text)
RETURNS boolean LANGUAGE sql AS $$ DELETE FROM cron.job WHERE jobname=$1; SELECT true; $$;

-- pg_net stub: net.http_post REGISTRA cada chamada (assinatura nomeada idêntica à real).
CREATE SCHEMA IF NOT EXISTS net;
CREATE TABLE net._calls (id serial PRIMARY KEY, url text, body jsonb);
CREATE OR REPLACE FUNCTION net.http_post(
  url text, body jsonb DEFAULT '{}'::jsonb, params jsonb DEFAULT '{}'::jsonb,
  headers jsonb DEFAULT '{}'::jsonb, timeout_milliseconds integer DEFAULT 5000)
RETURNS bigint LANGUAGE sql AS $$
  INSERT INTO net._calls(url, body) VALUES (url, body);
  SELECT count(*)::bigint FROM net._calls; $$;

-- vault stub (o cron lê o CRON_SECRET).
CREATE SCHEMA IF NOT EXISTS vault;
CREATE TABLE vault.decrypted_secrets (name text, decrypted_secret text);
INSERT INTO vault.decrypted_secrets VALUES ('CRON_SECRET','test-secret');
SQL

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — APLICAR A MIGRATION REAL (Lei #1)
# ══════════════════════════════════════════════════════════════════════════════
MIG="$REPO_ROOT/supabase/migrations/20260617133633_vendas_sync_cursor.sql"
P -q -f "$MIG"
echo "migration aplicada: $(basename "$MIG")"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 3 — SEED + GRANTS
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
INSERT INTO auth.users(id) VALUES
  ('11111111-1111-1111-1111-111111111111'),   -- staff (employee)
  ('22222222-2222-2222-2222-222222222222')    -- não-staff (customer)
  ON CONFLICT DO NOTHING;
INSERT INTO public.user_roles(user_id, role) VALUES
  ('11111111-1111-1111-1111-111111111111','employee'),
  ('22222222-2222-2222-2222-222222222222','customer') ON CONFLICT DO NOTHING;

-- Janela base pros asserts de RPC (oben): pendente, retomar da pág 3.
INSERT INTO public.vendas_sync_cursor(account, date_from, date_to, next_page)
VALUES ('oben','2025-01-01','2025-01-31', 3);
-- Janela colacor pro heartbeat.
INSERT INTO public.vendas_sync_cursor(account, date_from, date_to, next_page)
VALUES ('colacor','2025-03-01','2025-03-31', 1);

-- migration é --no-privileges; concede SELECT p/ os asserts de RLS (a RLS filtra por cima).
GRANT SELECT ON public.vendas_sync_cursor, public.user_roles TO authenticated, anon;
SQL

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4 — ASSERTS
# ══════════════════════════════════════════════════════════════════════════════
echo "── asserts: lease + cursor (money-path core) ──"

# N1 + P2: serialização real. 1º acquire pega e RETOMA da pág 3 (não 1); 2º no-opa (lease vivo).
A1=$(Pq -c "SELECT public.vendas_sync_lease_acquire('oben','2025-01-01','2025-01-31');")
A2=$(Pq -c "SELECT public.vendas_sync_lease_acquire('oben','2025-01-01','2025-01-31');")
eq "N1/P2 1º acquire pega e retoma do next_page" "$A1" "3"
eq "N1 2º acquire no-opa (lease vivo → NULL)"     "$A2" ""

# N3: lease MORTO (heartbeat > 3 min) é re-adquirível (retomada após crash).
P -q -c "UPDATE public.vendas_sync_cursor SET heartbeat_at = now() - interval '4 minutes'
         WHERE account='oben' AND date_from='2025-01-01';" >/dev/null
A3=$(Pq -c "SELECT public.vendas_sync_lease_acquire('oben','2025-01-01','2025-01-31');")
eq "N3 lease morto (>3min) re-adquirível"         "$A3" "3"

# P4: finish PAUSA (budget/transitório) — mantém next_page, grava last_error_kind, NÃO completa, libera lease.
Pq -c "SELECT public.vendas_sync_finish('oben','2025-01-01','2025-01-31', false, 7, 'rate_limit');" >/dev/null
NP=$(Pq  -c "SELECT next_page FROM public.vendas_sync_cursor WHERE account='oben' AND date_from='2025-01-01';")
CN=$(Pq  -c "SELECT completed_at IS NULL FROM public.vendas_sync_cursor WHERE account='oben' AND date_from='2025-01-01';")
EK=$(Pq  -c "SELECT last_error_kind FROM public.vendas_sync_cursor WHERE account='oben' AND date_from='2025-01-01';")
RS=$(Pq  -c "SELECT running_since IS NULL FROM public.vendas_sync_cursor WHERE account='oben' AND date_from='2025-01-01';")
eq "P4 pausa mantém next_page"               "$NP" "7"
eq "P4 pausa NÃO seta completed_at"          "$CN" "t"
eq "P4 pausa grava last_error_kind"          "$EK" "rate_limit"
eq "P4 pausa libera o lease"                 "$RS" "t"

# P3: finish COMPLETE (fim real) — seta completed_at, limpa next_page e last_error_kind.
Pq -c "SELECT public.vendas_sync_finish('oben','2025-01-01','2025-01-31', true, NULL, NULL);" >/dev/null
DONE=$(Pq -c "SELECT completed_at IS NOT NULL FROM public.vendas_sync_cursor WHERE account='oben' AND date_from='2025-01-01';")
NP2=$(Pq  -c "SELECT next_page FROM public.vendas_sync_cursor WHERE account='oben' AND date_from='2025-01-01';")
EK2=$(Pq  -c "SELECT last_error_kind FROM public.vendas_sync_cursor WHERE account='oben' AND date_from='2025-01-01';")
eq "P3 complete seta completed_at"           "$DONE" "t"
eq "P3 complete limpa next_page"             "$NP2"  ""
eq "P3 complete limpa last_error_kind"       "$EK2"  ""

# N2: janela COMPLETA não é re-adquirível (completed_at IS NULL filtra).
A4=$(Pq -c "SELECT public.vendas_sync_lease_acquire('oben','2025-01-01','2025-01-31');")
eq "N2 janela completa não re-adquirível"    "$A4" ""

# P5: heartbeat renova lease E PERSISTE progresso (next_page := página em curso); janela LIVRE intocada.
Pq -c "SELECT public.vendas_sync_lease_acquire('colacor','2025-03-01','2025-03-31');" >/dev/null
P -q -c "UPDATE public.vendas_sync_cursor SET heartbeat_at = now() - interval '2 minutes'
         WHERE account='colacor' AND date_from='2025-03-01';" >/dev/null
Pq -c "SELECT public.vendas_sync_heartbeat('colacor','2025-03-01','2025-03-31', 4);" >/dev/null  # processando pág 4
HB=$(Pq -c "SELECT heartbeat_at > now() - interval '10 seconds' FROM public.vendas_sync_cursor WHERE account='colacor' AND date_from='2025-03-01';")
NPH=$(Pq -c "SELECT next_page FROM public.vendas_sync_cursor WHERE account='colacor' AND date_from='2025-03-01';")
eq "P5 heartbeat renova lease vivo"                       "$HB"  "t"
eq "P5 heartbeat PERSISTE progresso (next_page=em curso)" "$NPH" "4"
# guard: janela LIVRE (sem lease) → heartbeat não toca heartbeat NEM next_page
P -q -c "UPDATE public.vendas_sync_cursor SET running_since=NULL, next_page=4, heartbeat_at=now()-interval '5 minutes'
         WHERE account='colacor' AND date_from='2025-03-01';" >/dev/null
Pq -c "SELECT public.vendas_sync_heartbeat('colacor','2025-03-01','2025-03-31', 9);" >/dev/null  # tenta avançar p/ 9
HBF=$(Pq -c "SELECT heartbeat_at < now() - interval '4 minutes' FROM public.vendas_sync_cursor WHERE account='colacor' AND date_from='2025-03-01';")
NPF=$(Pq -c "SELECT next_page FROM public.vendas_sync_cursor WHERE account='colacor' AND date_from='2025-03-01';")
eq "P5 heartbeat NÃO renova janela livre"                "$HBF" "t"
eq "P5 heartbeat NÃO avança next_page de janela livre"   "$NPF" "4"

# P6: erro INESPERADO não rebobina — release preserva o next_page que o heartbeat persistiu (fix Codex).
P -q -c "INSERT INTO public.vendas_sync_cursor(account,date_from,date_to,next_page) VALUES ('oben','2027-01-01','2027-01-31',1);" >/dev/null
Pq -c "SELECT public.vendas_sync_lease_acquire('oben','2027-01-01','2027-01-31');" >/dev/null  # resume=1
Pq -c "SELECT public.vendas_sync_heartbeat('oben','2027-01-01','2027-01-31', 6);" >/dev/null    # progrediu até a pág 6
Pq -c "SELECT public.vendas_sync_release('oben','2027-01-01','2027-01-31', 'error');" >/dev/null  # erro inesperado escapou
NPR=$(Pq -c "SELECT next_page FROM public.vendas_sync_cursor WHERE account='oben' AND date_from='2027-01-01';")
RSR=$(Pq -c "SELECT running_since IS NULL FROM public.vendas_sync_cursor WHERE account='oben' AND date_from='2027-01-01';")
EKR=$(Pq -c "SELECT last_error_kind FROM public.vendas_sync_cursor WHERE account='oben' AND date_from='2027-01-01';")
CAR=$(Pq -c "SELECT completed_at IS NULL FROM public.vendas_sync_cursor WHERE account='oben' AND date_from='2027-01-01';")
eq "P6 release NÃO rebobina (next_page=6 do heartbeat, não 1)" "$NPR" "6"
eq "P6 release solta o lease"                                  "$RSR" "t"
eq "P6 release grava o kind"                                   "$EKR" "error"
eq "P6 release NÃO completa"                                   "$CAR" "t"

echo "── asserts: CHECK constraints ──"
# N5 account inválido
R=$(P -tA 2>&1 <<'SQL'
DO $$ BEGIN
  INSERT INTO public.vendas_sync_cursor(account,date_from,date_to) VALUES ('xpto','2025-01-01','2025-01-31');
  RAISE EXCEPTION 'CHECK_NAO_BARROU';
EXCEPTION WHEN check_violation THEN RAISE NOTICE 'ACCOUNT_CHECK_OK';
  WHEN OTHERS THEN RAISE; END $$;
SQL
)
case "$R" in *ACCOUNT_CHECK_OK*) ok "N5 CHECK account rejeita inválido" ;; *) bad "N5 — veio: $R" ;; esac

# N6 last_error_kind inválido
R=$(P -tA 2>&1 <<'SQL'
DO $$ BEGIN
  INSERT INTO public.vendas_sync_cursor(account,date_from,date_to,last_error_kind)
    VALUES ('oben','2099-01-01','2099-01-31','bogus');
  RAISE EXCEPTION 'CHECK_NAO_BARROU';
EXCEPTION WHEN check_violation THEN RAISE NOTICE 'KIND_CHECK_OK';
  WHEN OTHERS THEN RAISE; END $$;
SQL
)
case "$R" in *KIND_CHECK_OK*) ok "N6 CHECK last_error_kind rejeita inválido" ;; *) bad "N6 — veio: $R" ;; esac

echo "── asserts: RLS + gate de EXECUTE ──"
# R1 staff lê / R3 não-staff não vê / R2 anon não vê
TOTAL=$(Pq -c "SELECT count(*) FROM public.vendas_sync_cursor;")   # superuser vê tudo (a verdade)
STAFF=$(Pq -c "SET test.uid='11111111-1111-1111-1111-111111111111'; SET ROLE authenticated; SELECT count(*) FROM public.vendas_sync_cursor;" | tail -1)
NOSTAFF=$(Pq -c "SET test.uid='22222222-2222-2222-2222-222222222222'; SET ROLE authenticated; SELECT count(*) FROM public.vendas_sync_cursor;" | tail -1)
ANON=$(Pq -c "SET ROLE anon; SELECT count(*) FROM public.vendas_sync_cursor;" | tail -1)
eq "R1 staff vê TODAS as janelas (== total)" "$STAFF" "$TOTAL"
eq "R3 não-staff (customer) não vê"  "$NOSTAFF" "0"
eq "R2 anon não vê"                  "$ANON"    "0"

# R4 anon/authenticated NÃO executam o RPC de lease (REVOKE → insufficient_privilege 42501)
R=$(P -tA 2>&1 <<'SQL'
SET ROLE authenticated;
DO $$ BEGIN
  PERFORM public.vendas_sync_lease_acquire('oben','2025-01-01','2025-01-31');
  RAISE EXCEPTION 'EXECUTE_NAO_BARROU';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'EXECUTE_GATED_OK';
  WHEN OTHERS THEN RAISE; END $$;
SQL
)
case "$R" in *EXECUTE_GATED_OK*) ok "R4 authenticated NÃO executa lease_acquire (REVOKE)" ;; *) bad "R4 — veio: $R" ;; esac

echo "── asserts: cron de continuação (DISTINCT ON account, janela + antiga) ──"
# Limpa e semeia: oben com DUAS janelas pendentes (deve disparar só a + antiga) + colacor pendente + 1 completa.
P -q <<'SQL'
TRUNCATE net._calls;
DELETE FROM public.vendas_sync_cursor;
INSERT INTO public.vendas_sync_cursor(account,date_from,date_to,next_page,completed_at) VALUES
  ('oben',   '2024-01-01','2024-01-31', 1, NULL),         -- + antiga do oben → DEVE disparar
  ('oben',   '2024-02-01','2024-02-29', 1, NULL),         -- + nova do oben  → NÃO dispara (DISTINCT ON)
  ('colacor','2024-05-01','2024-05-31', 1, NULL),         -- colacor          → DEVE disparar
  ('oben',   '2023-12-01','2023-12-31', NULL, now());     -- completa         → NÃO dispara
SQL
# EXECUTA a string de comando REAL que a migração agendou (sem cópia → sem drift).
P -q <<'SQL'
DO $exec$ DECLARE c text; BEGIN
  SELECT command INTO c FROM cron.job WHERE jobname='vendas-sync-continuacao-6min';
  EXECUTE c;
END $exec$;
SQL
NCALLS=$(Pq -c "SELECT count(*) FROM net._calls;")
OBENWIN=$(Pq -c "SELECT body->>'date_from' FROM net._calls WHERE body->>'account'='oben';")
eq "C1 cron dispara 1 http_post por conta pendente" "$NCALLS"  "2"
eq "C2 cron escolhe a janela + ANTIGA do oben"      "$OBENWIN" "01/01/2024"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICAÇÃO (Lei #3): sabota → exige VERMELHO → restaura
# ══════════════════════════════════════════════════════════════════════════════
echo "── falsificação ──"

# F1: lease SEM a cláusula de concorrência → 2 acquires na mesma janela passam os dois (serialização morre).
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.vendas_sync_lease_acquire(p_account text, p_date_from date, p_date_to date)
RETURNS integer LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
  UPDATE public.vendas_sync_cursor SET running_since=now(), heartbeat_at=now()
   WHERE account=p_account AND date_from=p_date_from AND date_to=p_date_to  -- SABOTADO: sem o guard de lease
  RETURNING COALESCE(next_page,1);
$fn$;
INSERT INTO public.vendas_sync_cursor(account,date_from,date_to,next_page) VALUES ('oben','2030-01-01','2030-01-31',5);
SQL
S1=$(Pq -c "SELECT public.vendas_sync_lease_acquire('oben','2030-01-01','2030-01-31');")
S2=$(Pq -c "SELECT public.vendas_sync_lease_acquire('oben','2030-01-01','2030-01-31');")
if [ -n "$S1" ] && [ -n "$S2" ]; then ok "F1 lease furado deixa 2 acquires passarem (N1 tem dente)"; else bad "F1 sabotei o lease e N1 não mudou → assert fraco"; fi
P -q -f "$MIG" >/dev/null   # restaura

# F2: finish que SEMPRE seta completed_at (mesmo em pausa) → P4 "NÃO completa" viraria vermelho.
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.vendas_sync_finish(p_account text, p_date_from date, p_date_to date,
  p_complete boolean, p_next_page integer, p_last_error_kind text)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
  UPDATE public.vendas_sync_cursor
     SET next_page = CASE WHEN p_complete THEN NULL ELSE p_next_page END,
         completed_at = now(),                 -- SABOTADO: completa mesmo em pausa
         last_error_kind = CASE WHEN p_complete THEN NULL ELSE p_last_error_kind END,
         running_since = NULL, heartbeat_at = now()
   WHERE account=p_account AND date_from=p_date_from AND date_to=p_date_to;
$fn$;
INSERT INTO public.vendas_sync_cursor(account,date_from,date_to,next_page) VALUES ('oben','2031-01-01','2031-01-31',2);
SQL
Pq -c "SELECT public.vendas_sync_finish('oben','2031-01-01','2031-01-31', false, 4, 'rate_limit');" >/dev/null
CNF=$(Pq -c "SELECT completed_at IS NULL FROM public.vendas_sync_cursor WHERE account='oben' AND date_from='2031-01-01';")
if [ "$CNF" = "f" ]; then ok "F2 finish furado completa em pausa (P4 'NÃO completa' tem dente)"; else bad "F2 sabotei finish e completed_at seguiu NULL → assert fraco"; fi
P -q -f "$MIG" >/dev/null   # restaura

# F3: policy de SELECT como USING(true) → anon passaria a ver (R2 tem dente).
P -q <<'SQL'
DROP POLICY IF EXISTS "vendas_sync_cursor_select_staff" ON public.vendas_sync_cursor;
CREATE POLICY "vendas_sync_cursor_select_staff" ON public.vendas_sync_cursor FOR SELECT USING (true);
SQL
ANON2=$(Pq -c "SET ROLE anon; SELECT count(*) FROM public.vendas_sync_cursor;" | tail -1)
if [ "$ANON2" != "0" ]; then ok "F3 policy furada (USING true) deixa anon ver (R2 tem dente)"; else bad "F3 furei a policy e anon seguiu sem ver → assert fraco"; fi
P -q -f "$MIG" >/dev/null   # restaura

# F4: GRANT EXECUTE a authenticated → R4 deixaria de barrar.
P -q -c "GRANT EXECUTE ON FUNCTION public.vendas_sync_lease_acquire(text,date,date) TO authenticated;" >/dev/null
R=$(P -tA 2>&1 <<'SQL'
SET ROLE authenticated;
DO $$ BEGIN
  PERFORM public.vendas_sync_lease_acquire('zzz','2025-01-01','2025-01-31');  -- conta inexistente: roda mas não barra por privilégio
  RAISE NOTICE 'EXECUTOU_SEM_BARRAR';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'AINDA_BARRA';
  WHEN OTHERS THEN RAISE; END $$;
SQL
)
case "$R" in *EXECUTOU_SEM_BARRAR*) ok "F4 com GRANT a authenticated o RPC executa (R4 tem dente)" ;; *) bad "F4 concedi EXECUTE e R4 seguiu barrando → assert fraco: $R" ;; esac
P -q -f "$MIG" >/dev/null   # restaura (re-REVOKE)

# F5: heartbeat que NÃO persiste progresso (versão antiga) → o rewind volta (P6 perde o dente).
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.vendas_sync_heartbeat(p_account text, p_date_from date, p_date_to date, p_page integer)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
  UPDATE public.vendas_sync_cursor SET heartbeat_at = now()  -- SABOTADO: não grava next_page
   WHERE account=p_account AND date_from=p_date_from AND date_to=p_date_to AND running_since IS NOT NULL;
$fn$;
INSERT INTO public.vendas_sync_cursor(account,date_from,date_to,next_page) VALUES ('oben','2032-01-01','2032-01-31',1);
SQL
Pq -c "SELECT public.vendas_sync_lease_acquire('oben','2032-01-01','2032-01-31');" >/dev/null
Pq -c "SELECT public.vendas_sync_heartbeat('oben','2032-01-01','2032-01-31', 6);" >/dev/null
Pq -c "SELECT public.vendas_sync_release('oben','2032-01-01','2032-01-31', 'error');" >/dev/null
NPS=$(Pq -c "SELECT next_page FROM public.vendas_sync_cursor WHERE account='oben' AND date_from='2032-01-01';")
if [ "$NPS" = "1" ]; then ok "F5 heartbeat furado rebobina p/ 1 (P6 'não rebobina' tem dente)"; else bad "F5 sabotei o heartbeat e o next_page seguiu $NPS≠1 → P6 fraco"; fi
P -q -f "$MIG" >/dev/null   # restaura

# ── veredito ──
echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
