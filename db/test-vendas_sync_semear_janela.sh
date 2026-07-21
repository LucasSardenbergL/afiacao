#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  HARNESS PG17 — vendas_sync_semear_janela (semeadura staff do backfill)        ║
# ║  Prova money-path: gate staff fail-closed (uid nulo NUNCA passa), fronteira    ║
# ║  de EXECUTE (anon barrado por privilégio), validação de janela (22023),        ║
# ║  idempotência que NÃO clobbera janela em voo/completa, e integração com o      ║
# ║  cron REAL (janela semeada → http_post do vendas-sync-continuacao-6min).       ║
# ║  Rodar:  bash db/test-vendas_sync_semear_janela.sh > "$LOG" 2>&1; echo $?      ║
# ║  Sentinelas: ASCII, caixa fixa, sem -i, sem grep (case builtin) — locale-safe. ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

# ── arranque PG17 descartável (contorna keg-only do brew) ──
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5459}"
SLUG="vendas_sync_semear_janela"
TMPROOT="$(mktemp -d "/tmp/pgtest-${SLUG}.XXXXXX")"
DATA="$TMPROOT/data"
export LC_ALL=C LANG=C

[ -x "$PGBIN/initdb" ] || { echo "postgresql@${PGVER} ausente: brew install postgresql@${PGVER} pgvector"; exit 1; }

CELLAR="$(brew --prefix "postgresql@${PGVER}")"
cp -Rn "$CELLAR"/share/postgresql/. "/opt/homebrew/share/postgresql@${PGVER}/" 2>/dev/null || true
mkdir -p "/opt/homebrew/lib/postgresql@${PGVER}"
cp -Rn "$CELLAR"/lib/postgresql/. "/opt/homebrew/lib/postgresql@${PGVER}/" 2>/dev/null || true

cleanup() { "$PGBIN/pg_ctl" -D "$DATA" stop -m immediate >/dev/null 2>&1 || true; rm -rf "$TMPROOT"; }
trap cleanup EXIT

"$PGBIN/initdb" -D "$DATA" -U postgres -E UTF8 --locale=C >/dev/null
"$PGBIN/pg_ctl" -D "$DATA" -o "-p $PORT -k /tmp" -l "$TMPROOT/pg.log" -w start >/dev/null
"$PGBIN/createdb" -p "$PORT" -h /tmp -U postgres prove
P()  { "$PGBIN/psql" -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
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
# ZONA 1 — PRÉ-REQUISITOS: app_role + user_roles + has_role REAL (verbatim da
# PROD via pg_get_functiondef, 2026-07-21 — é o GATE, não pode ser stub de mentira),
# e os stubs cron/net/vault pra migração-fundação (20260617133633) aplicar.
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname='app_role') THEN
  CREATE TYPE public.app_role AS ENUM ('master','employee','customer'); END IF; END $$;
CREATE TABLE IF NOT EXISTS public.user_roles (user_id uuid, role public.app_role);

-- has_role: espelho verbatim da PROD (SECURITY DEFINER, STABLE, search_path=public).
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $function$;

-- pg_cron: schema+cron.job vêm do stubs; faltam schedule/unschedule GUARDANDO o command.
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

-- pg_net stub: registra cada chamada (assinatura nomeada idêntica à real).
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
# ZONA 2 — MIGRATIONS REAIS (Lei #1): fundação (tabela+RPCs+cron) e a SOB TESTE.
# ══════════════════════════════════════════════════════════════════════════════
MIG_BASE="$REPO_ROOT/supabase/migrations/20260617133633_vendas_sync_cursor.sql"
MIG="$REPO_ROOT/supabase/migrations/20260726130000_vendas_sync_semear_janela.sql"
P -q -f "$MIG_BASE"
P -q -f "$MIG"
echo "migrations aplicadas: $(basename "$MIG_BASE") + $(basename "$MIG")"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 3 — SEED
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
INSERT INTO auth.users(id) VALUES
  ('11111111-1111-1111-1111-111111111111'),   -- staff (employee)
  ('33333333-3333-3333-3333-333333333333'),   -- staff (master)
  ('22222222-2222-2222-2222-222222222222')    -- não-staff (customer)
  ON CONFLICT DO NOTHING;
INSERT INTO public.user_roles(user_id, role) VALUES
  ('11111111-1111-1111-1111-111111111111','employee'),
  ('33333333-3333-3333-3333-333333333333','master'),
  ('22222222-2222-2222-2222-222222222222','customer') ON CONFLICT DO NOTHING;
GRANT SELECT ON public.vendas_sync_cursor, public.user_roles TO authenticated, anon;
SQL

# guard anti-teatro do SET ROLE (#1434): impersonação TEM de rebaixar o role.
CU=$(Pq -c "SET ROLE authenticated; SELECT current_user;")
[ "$CU" = "authenticated" ] || { echo "ABORTA: SET ROLE nao rebaixou (current_user=$CU) — zona de RLS seria teatro"; exit 1; }

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4 — ASSERTS
# ══════════════════════════════════════════════════════════════════════════════
echo "-- positivos: semeadura pelo CAMINHO REAL (authenticated + JWT staff) --"

# P1: staff (employee) semeia janela nova → semeada=true; nasce livre (sem lease, sem progresso).
R=$(Pq <<'SQL'
SET test.uid='11111111-1111-1111-1111-111111111111';
SET ROLE authenticated;
SELECT public.vendas_sync_semear_janela('oben', DATE '2026-01-01', DATE '2026-06-30')->>'semeada';
SQL
)
eq "P1 staff semeia janela nova (semeada=true)" "$R" "true"
ROW=$(Pq -c "SELECT (next_page IS NULL)||'/'||(completed_at IS NULL)||'/'||(running_since IS NULL) FROM public.vendas_sync_cursor WHERE account='oben' AND date_from='2026-01-01';")
eq "P1 janela nasce livre (next_page/completed/lease nulos)" "$ROW" "true/true/true"

# P1b: master também semeia (2ª conta — o clique arma as DUAS contas).
R=$(Pq <<'SQL'
SET test.uid='33333333-3333-3333-3333-333333333333';
SET ROLE authenticated;
SELECT public.vendas_sync_semear_janela('colacor', DATE '2026-01-01', DATE '2026-06-30')->>'semeada';
SQL
)
eq "P1b master semeia a outra conta" "$R" "true"

# P6: o motor consegue COMEÇAR a janela semeada (lease_acquire retorna pág 1).
A=$(Pq -c "SELECT public.vendas_sync_lease_acquire('oben','2026-01-01','2026-06-30');")
eq "P6 lease_acquire da janela semeada retoma da pag 1" "$A" "1"
P -q -c "SELECT public.vendas_sync_release('oben','2026-01-01','2026-06-30', NULL);" >/dev/null

# P2: re-semear a MESMA janela → semeada=false e linha intocada (updated_at idêntico).
UA1=$(Pq -c "SELECT updated_at FROM public.vendas_sync_cursor WHERE account='colacor' AND date_from='2026-01-01';")
R=$(Pq <<'SQL'
SET test.uid='11111111-1111-1111-1111-111111111111';
SET ROLE authenticated;
SELECT public.vendas_sync_semear_janela('colacor', DATE '2026-01-01', DATE '2026-06-30')->>'semeada';
SQL
)
UA2=$(Pq -c "SELECT updated_at FROM public.vendas_sync_cursor WHERE account='colacor' AND date_from='2026-01-01';")
eq "P2 re-semear no-opa (semeada=false)" "$R" "false"
eq "P2 re-semear nao toca a linha (updated_at identico)" "$UA2" "$UA1"

# P3: janela EM VOO não é clobberada — nem progresso (next_page) nem lease.
P -q -c "UPDATE public.vendas_sync_cursor SET running_since=now(), heartbeat_at=now(), next_page=7
         WHERE account='oben' AND date_from='2026-01-01';" >/dev/null
R=$(Pq <<'SQL'
SET test.uid='11111111-1111-1111-1111-111111111111';
SET ROLE authenticated;
SELECT public.vendas_sync_semear_janela('oben', DATE '2026-01-01', DATE '2026-06-30')->>'semeada';
SQL
)
VOO=$(Pq -c "SELECT next_page||'/'||(running_since IS NOT NULL) FROM public.vendas_sync_cursor WHERE account='oben' AND date_from='2026-01-01';")
eq "P3 semear sobre janela em voo no-opa"                 "$R"   "false"
eq "P3 progresso e lease preservados (next_page=7/lease)" "$VOO" "7/true"

# P4: janela COMPLETA não reabre.
P -q -c "UPDATE public.vendas_sync_cursor SET running_since=NULL, next_page=NULL, completed_at='2026-06-24 08:00:00+00'
         WHERE account='oben' AND date_from='2026-01-01';" >/dev/null
R=$(Pq <<'SQL'
SET test.uid='11111111-1111-1111-1111-111111111111';
SET ROLE authenticated;
SELECT (public.vendas_sync_semear_janela('oben', DATE '2026-01-01', DATE '2026-06-30'))->>'semeada'
    || '/' || ((public.vendas_sync_semear_janela('oben', DATE '2026-01-01', DATE '2026-06-30'))->>'completed_at' IS NOT NULL);
SQL
)
CA=$(Pq -c "SELECT completed_at = '2026-06-24 08:00:00+00'::timestamptz FROM public.vendas_sync_cursor WHERE account='oben' AND date_from='2026-01-01';")
eq "P4 semear sobre completa no-opa e devolve completed_at" "$R"  "false/true"
eq "P4 completed_at original preservado"                    "$CA" "t"

echo "-- negativos: gate, fronteira e validacao (SQLSTATE esperada + re-raise) --"

# N1: customer (authenticated, COM grant de EXECUTE) → barrado pelo GATE (42501 com a msg do gate).
R=$(P -q -tA 2>&1 <<'SQL'
SET test.uid='22222222-2222-2222-2222-222222222222';
SET ROLE authenticated;
DO $$ BEGIN
  PERFORM public.vendas_sync_semear_janela('oben', DATE '2026-02-01', DATE '2026-02-28');
  RAISE EXCEPTION 'SABOTAGEM_GATE_AUSENTE';
EXCEPTION WHEN insufficient_privilege THEN
  IF SQLERRM LIKE '%requer perfil staff%' THEN RAISE NOTICE 'N1_GATE_BARROU';
  ELSE RAISE; END IF;
  WHEN OTHERS THEN RAISE; END $$;
SQL
)
case "$R" in *N1_GATE_BARROU*) ok "N1 customer barrado pelo gate (42501 do gate)" ;; *) bad "N1 — veio: $R" ;; esac
NC=$(Pq -c "SELECT count(*) FROM public.vendas_sync_cursor WHERE date_from='2026-02-01';")
eq "N1 nenhuma janela criada pelo customer" "$NC" "0"

# N2: anon → barrado na FRONTEIRA (REVOKE): 'permission denied for function' do Postgres,
# que o MEU código nunca emite (sentinela exclusiva do ramo de privilégio).
R=$(P -q -tA 2>&1 <<'SQL'
SET ROLE anon;
SELECT public.vendas_sync_semear_janela('oben', DATE '2026-02-01', DATE '2026-02-28');
SQL
) || true
case "$R" in *"permission denied for function"*) ok "N2 anon barrado na fronteira (sem EXECUTE)" ;; *) bad "N2 — veio: $R" ;; esac

# N3: authenticated SEM uid (JWT sem sub) → o gate uid-nulo barra (fail-closed), não a fronteira.
R=$(P -q -tA 2>&1 <<'SQL'
SET ROLE authenticated;
DO $$ BEGIN
  PERFORM public.vendas_sync_semear_janela('oben', DATE '2026-02-01', DATE '2026-02-28');
  RAISE EXCEPTION 'SABOTAGEM_UID_NULO_PASSOU';
EXCEPTION WHEN insufficient_privilege THEN
  IF SQLERRM LIKE '%requer perfil staff%' THEN RAISE NOTICE 'N3_UID_NULO_BARROU';
  ELSE RAISE; END IF;
  WHEN OTHERS THEN RAISE; END $$;
SQL
)
case "$R" in *N3_UID_NULO_BARROU*) ok "N3 uid nulo barrado pelo gate (fail-closed)" ;; *) bad "N3 — veio: $R" ;; esac

# N4-N7: validação de janela (staff legítimo, 22023 = invalid_parameter_value).
valida_22023() {  # $1 rotulo  $2 chamada SQL
  R=$(P -q -tA 2>&1 <<SQL
SET test.uid='11111111-1111-1111-1111-111111111111';
SET ROLE authenticated;
DO \$\$ BEGIN
  PERFORM $2;
  RAISE EXCEPTION 'SABOTAGEM_VALIDACAO_PASSOU';
EXCEPTION WHEN invalid_parameter_value THEN RAISE NOTICE 'VAL_22023_BARROU';
  WHEN OTHERS THEN RAISE; END \$\$;
SQL
)
  case "$R" in *VAL_22023_BARROU*) ok "$1" ;; *) bad "$1 — veio: $R" ;; esac
}
valida_22023 "N4 conta invalida rejeitada (22023)"        "public.vendas_sync_semear_janela('xpto', DATE '2026-02-01', DATE '2026-02-28')"
valida_22023 "N5 date_from > date_to rejeitado (22023)"   "public.vendas_sync_semear_janela('oben', DATE '2026-03-01', DATE '2026-02-01')"
valida_22023 "N6 date_to futuro rejeitado (22023)"        "public.vendas_sync_semear_janela('oben', DATE '2026-02-01', current_date + 1)"
valida_22023 "N7 date_from < 2015 rejeitado (22023)"      "public.vendas_sync_semear_janela('oben', DATE '1920-01-01', DATE '2026-02-28')"
NV=$(Pq -c "SELECT count(*) FROM public.vendas_sync_cursor WHERE date_from IN ('2026-02-01','2026-03-01','1920-01-01');")
eq "N4-N7 nenhuma janela invalida persistida" "$NV" "0"

echo "-- integracao: janela semeada pela RPC dispara o cron REAL --"
P -q <<'SQL'
TRUNCATE net._calls;
DELETE FROM public.vendas_sync_cursor;
SQL
Pq <<'SQL' >/dev/null
SET test.uid='11111111-1111-1111-1111-111111111111';
SET ROLE authenticated;
SELECT public.vendas_sync_semear_janela('oben',    DATE '2026-01-22', DATE '2026-06-30');
SELECT public.vendas_sync_semear_janela('colacor', DATE '2026-01-22', DATE '2026-06-30');
SQL
P -q <<'SQL'
DO $exec$ DECLARE c text; BEGIN
  SELECT command INTO c FROM cron.job WHERE jobname='vendas-sync-continuacao-6min';
  EXECUTE c;
END $exec$;
SQL
NCALLS=$(Pq -c "SELECT count(*) FROM net._calls;")
BODYOK=$(Pq -c "SELECT count(*) FROM net._calls WHERE body->>'use_cursor'='true' AND body->>'date_from'='22/01/2026' AND body->>'action'='sync_pedidos';")
CONTAS=$(Pq -c "SELECT string_agg(DISTINCT body->>'account', ',' ORDER BY body->>'account') FROM net._calls;")
eq "C1 cron dispara 1 http_post por conta semeada"     "$NCALLS" "2"
eq "C2 payload com use_cursor + data DD/MM/YYYY"       "$BODYOK" "2"
eq "C3 as duas contas semeadas disparam"               "$CONTAS" "colacor,oben"

# V1: o VALIDADOR pós-apply (o mesmo arquivo que o founder cola) aprova o banco BOM.
VALIDA="$REPO_ROOT/db/valida-vendas-sync-semear-janela.sql"
V=$(Pq -f "$VALIDA")
case "$V" in "✅"*) ok "V1 validador pos-apply aprova o banco bom" ;; *) bad "V1 validador reprovou banco bom: $V" ;; esac

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICAÇÃO (Lei #3): sabota → exige a INVERSÃO do assert alvo → restaura.
# Baseline verde acima prova que os asserts rodam; aqui cada sabotagem mira UM assert.
# ══════════════════════════════════════════════════════════════════════════════
echo "-- falsificacao --"

# F1 (mira N1): remove o gate → customer teria de CONSEGUIR semear.
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.vendas_sync_semear_janela(p_account text, p_date_from date, p_date_to date)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $$
DECLARE v_semeada boolean := false;
BEGIN
  -- SABOTADO: sem gate
  INSERT INTO public.vendas_sync_cursor (account, date_from, date_to)
  VALUES (p_account, p_date_from, p_date_to)
  ON CONFLICT (account, date_from, date_to) DO NOTHING;
  v_semeada := FOUND;
  RETURN jsonb_build_object('semeada', v_semeada);
END; $$;
SQL
R=$(Pq <<'SQL'
SET test.uid='22222222-2222-2222-2222-222222222222';
SET ROLE authenticated;
SELECT public.vendas_sync_semear_janela('oben', DATE '2026-02-01', DATE '2026-02-28')->>'semeada';
SQL
)
if [ "$R" = "true" ]; then ok "F1 sem gate o customer semeia (N1 tem dente)"; else bad "F1 sabotei o gate e o customer seguiu barrado ($R) → N1 fraco"; fi
V=$(Pq -f "$VALIDA")
case "$V" in *"corpo sem o gate staff"*) ok "F1b validador reprova corpo sem gate (validador tem dente)" ;; *) bad "F1b validador aprovou corpo SABOTADO: $V" ;; esac
P -q -c "DELETE FROM public.vendas_sync_cursor WHERE date_from='2026-02-01';" >/dev/null
P -q -f "$MIG" >/dev/null   # restaura

# F2 (mira P3): ON CONFLICT que CLOBBERA o progresso → next_page 7 viraria 1.
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.vendas_sync_semear_janela(p_account text, p_date_from date, p_date_to date)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $$
DECLARE v_uid uuid := auth.uid();
BEGIN
  IF v_uid IS NULL
     OR NOT (COALESCE(public.has_role(v_uid, 'employee'::public.app_role), false)
          OR COALESCE(public.has_role(v_uid, 'master'::public.app_role),   false)) THEN
    RAISE EXCEPTION 'Acesso negado: requer perfil staff' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.vendas_sync_cursor (account, date_from, date_to)
  VALUES (p_account, p_date_from, p_date_to)
  ON CONFLICT (account, date_from, date_to) DO UPDATE SET next_page = 1;  -- SABOTADO: clobber
  RETURN jsonb_build_object('semeada', true);
END; $$;
SQL
P -q -c "INSERT INTO public.vendas_sync_cursor(account,date_from,date_to,next_page,running_since,heartbeat_at)
         VALUES ('oben','2026-04-01','2026-04-30',7,now(),now());" >/dev/null
Pq <<'SQL' >/dev/null
SET test.uid='11111111-1111-1111-1111-111111111111';
SET ROLE authenticated;
SELECT public.vendas_sync_semear_janela('oben', DATE '2026-04-01', DATE '2026-04-30');
SQL
NP=$(Pq -c "SELECT next_page FROM public.vendas_sync_cursor WHERE account='oben' AND date_from='2026-04-01';")
if [ "$NP" = "1" ]; then ok "F2 clobber rebobina next_page 7->1 (P3 tem dente)"; else bad "F2 sabotei o ON CONFLICT e o next_page seguiu $NP → P3 fraco"; fi
V=$(Pq -f "$VALIDA")
case "$V" in *"sem o ON CONFLICT DO NOTHING"*) ok "F2b validador reprova o clobber (validador tem dente)" ;; *) bad "F2b validador aprovou corpo com DO UPDATE: $V" ;; esac
P -q -c "DELETE FROM public.vendas_sync_cursor WHERE date_from='2026-04-01';" >/dev/null
P -q -f "$MIG" >/dev/null   # restaura

# F3 (mira N2): GRANT a anon → a fronteira some; anon passa a bater no GATE (msg do gate,
# nao mais 'permission denied for function').
P -q -c "GRANT EXECUTE ON FUNCTION public.vendas_sync_semear_janela(text,date,date) TO anon;" >/dev/null
R=$(P -q -tA 2>&1 <<'SQL'
SET ROLE anon;
SELECT public.vendas_sync_semear_janela('oben', DATE '2026-02-01', DATE '2026-02-28');
SQL
) || true
case "$R" in
  *"permission denied for function"*) bad "F3 concedi EXECUTE a anon e a fronteira seguiu barrando → N2 fraco" ;;
  *"requer perfil staff"*)            ok  "F3 com GRANT o anon passa a fronteira e cai no gate (N2 tem dente)" ;;
  *)                                  bad "F3 — saida inesperada: $R" ;;
esac
V=$(Pq -f "$VALIDA")
case "$V" in *"anon com EXECUTE"*) ok "F3b validador reprova grant a anon (validador tem dente)" ;; *) bad "F3b validador aprovou anon com EXECUTE: $V" ;; esac
P -q -f "$MIG" >/dev/null   # restaura (re-REVOKE de anon)

# pós-restauração: a versão REAL voltou a valer (staff semeia, customer não).
R=$(Pq <<'SQL'
SET test.uid='11111111-1111-1111-1111-111111111111';
SET ROLE authenticated;
SELECT public.vendas_sync_semear_janela('oben', DATE '2026-05-01', DATE '2026-05-31')->>'semeada';
SQL
)
eq "POS restauracao: staff volta a semear" "$R" "true"

# ── veredito ──
echo "------------------------------"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "HARNESS VERMELHO"; exit 1; }
echo "HARNESS VERDE"
