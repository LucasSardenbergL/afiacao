#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA PG17 — refresh_customer_metrics: automação + autz por identidade positiva ║
# ║  Migration: 20260717154500_refresh_customer_metrics_automacao.sql              ║
# ║  Rode: bash db/test-refresh-customer-metrics-automacao.sh > /tmp/t.log 2>&1; echo "exit=$?" ║
# ║                                                                                ║
# ║  Invariantes (money-path: autz):                                               ║
# ║   P1 service_role executa o PRIMITIVE → MV refresha (automação por identidade positiva) ║
# ║   P2 staff via WRAPPER refresha (UX do frontend preservada)                     ║
# ║   N1 authenticated NÃO alcança o primitive (fronteira de GRANT — ponto do Codex)║
# ║   N2 customer no wrapper → 42501 (gate staff)                                    ║
# ║   N3 uid NULO no wrapper → 42501 (rejeita ausência de identidade — o anti-C)     ║
# ║   N4 anon barrado em ambas                                                       ║
# ║   F2 sabota p/ o gate-C (aceita uid nulo) → N3 fica VERMELHO (nosso é melhor)    ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5461}"
SLUG="refresh-custmetrics"
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
# ZONA 1 — PRÉ-REQUISITOS (o que a migração LÊ mas não cria)
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
-- schema auth: USAGE + EXECUTE (a PROD concede; db/stubs-supabase.sql NÃO — mordeu o #1380).
-- Sem isto, um caller authenticated que resolva auth.uid() daria 42501 falso e mascararia o teste.
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.uid(), auth.role() TO anon, authenticated, service_role;

-- app_role + user_roles + has_role (fiel à prod: SQL STABLE SECDEF search_path=public)
DO $$ BEGIN CREATE TYPE public.app_role AS ENUM ('employee','master','customer'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE TABLE IF NOT EXISTS public.user_roles (user_id uuid, role public.app_role);
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
  RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
  AS $fn$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $fn$;

-- schema private + a MV customer_metrics_mv (stub topológico: índice ÚNICO p/ REFRESH CONCURRENTLY
-- + coluna calculated_at). A fonte é uma tabela simples cujo count muda p/ provar o efeito do refresh.
CREATE SCHEMA IF NOT EXISTS private;
CREATE TABLE public._src_metrics (customer_user_id uuid PRIMARY KEY, calculated_at timestamptz DEFAULT now());
INSERT INTO public._src_metrics(customer_user_id) VALUES ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');
CREATE MATERIALIZED VIEW private.customer_metrics_mv AS
  SELECT customer_user_id, calculated_at FROM public._src_metrics;
CREATE UNIQUE INDEX customer_metrics_mv_pk ON private.customer_metrics_mv(customer_user_id);
REVOKE ALL ON private.customer_metrics_mv FROM anon, authenticated;

-- stub das FUNÇÕES do pg_cron (o schema cron + cron.job já vêm de db/stubs-supabase.sql, onde
-- jobid é bigint sem default → a função gera o jobid). Prova que a migração AGENDA (idempotência
-- unschedule+schedule), não o pg_cron real.
CREATE OR REPLACE FUNCTION cron.schedule(job_name text, schedule text, command text) RETURNS bigint
  LANGUAGE sql AS $fn$
    INSERT INTO cron.job(jobid, jobname, schedule, command, active)
    VALUES ((SELECT COALESCE(max(jobid),0)+1 FROM cron.job), job_name, schedule, command, true)
    RETURNING jobid
  $fn$;
CREATE OR REPLACE FUNCTION cron.unschedule(job_name text) RETURNS boolean
  LANGUAGE sql AS $fn$ DELETE FROM cron.job WHERE jobname=job_name; SELECT true; $fn$;

-- roles/personas
INSERT INTO public.user_roles(user_id, role) VALUES
  ('33333333-3333-3333-3333-333333333333','master'),
  ('44444444-4444-4444-4444-444444444444','customer');
GRANT SELECT ON public.user_roles TO authenticated, anon;
SQL

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — APLICAR A MIGRATION REAL (Lei #1)
# ══════════════════════════════════════════════════════════════════════════════
MIG="$REPO_ROOT/supabase/migrations/20260717154500_refresh_customer_metrics_automacao.sql"
P -q -f "$MIG"
echo "migration aplicada: $(basename "$MIG")"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4 — ASSERTS
# ══════════════════════════════════════════════════════════════════════════════
echo "── grants (fronteira de autz) ──"
eq "G1 authenticated NÃO tem o primitive"      "$(Pq -c "SELECT has_function_privilege('authenticated','public.refresh_customer_metrics()','EXECUTE');")" "f"
eq "G2 service_role TEM o primitive"           "$(Pq -c "SELECT has_function_privilege('service_role','public.refresh_customer_metrics()','EXECUTE');")" "t"
eq "G3 anon NÃO tem o primitive"               "$(Pq -c "SELECT has_function_privilege('anon','public.refresh_customer_metrics()','EXECUTE');")" "f"
eq "G4 authenticated TEM o wrapper"            "$(Pq -c "SELECT has_function_privilege('authenticated','public.request_customer_metrics_refresh()','EXECUTE');")" "t"
eq "G5 anon NÃO tem o wrapper"                 "$(Pq -c "SELECT has_function_privilege('anon','public.request_customer_metrics_refresh()','EXECUTE');")" "f"

echo "── hardening search_path (Codex) ──"
SP1=$(Pq -c "SELECT coalesce(array_to_string(proconfig,'|'),'<none>') FROM pg_proc WHERE proname='refresh_customer_metrics';")
SP2=$(Pq -c "SELECT coalesce(array_to_string(proconfig,'|'),'<none>') FROM pg_proc WHERE proname='request_customer_metrics_refresh';")
case "$SP1" in *search_path=*) case "$SP1" in *public*) bad "H1 primitive search_path contém public: $SP1" ;; *) ok "H1 primitive fixa search_path vazio ([$SP1])" ;; esac ;; *) bad "H1 primitive sem search_path fixo: $SP1" ;; esac
case "$SP2" in *search_path=*) case "$SP2" in *public*) bad "H2 wrapper search_path contém public: $SP2" ;; *) ok "H2 wrapper fixa search_path vazio ([$SP2])" ;; esac ;; *) bad "H2 wrapper sem search_path fixo: $SP2" ;; esac

echo "── cron ──"
eq "C1 cron agendado"          "$(Pq -c "SELECT count(*) FROM cron.job WHERE jobname='afiacao_customer_metrics_refresh_6h';")" "1"
eq "C2 cron chama o primitive" "$(Pq -c "SELECT command FROM cron.job WHERE jobname='afiacao_customer_metrics_refresh_6h';")" "SELECT public.refresh_customer_metrics()"
eq "C3 cadência 6h"            "$(Pq -c "SELECT schedule FROM cron.job WHERE jobname='afiacao_customer_metrics_refresh_6h';")" "15 */6 * * *"

echo "── positivos (a função REAL executa — pega late-bound) ──"
# P1: service_role executa o primitive e o efeito propaga (MV passa de 1 → 2 linhas)
P -q -c "INSERT INTO public._src_metrics(customer_user_id) VALUES ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb');"
P -q <<'SQL'
SET ROLE service_role;
SELECT public.refresh_customer_metrics();
RESET ROLE;
SQL
eq "P1 service_role refresha o primitive (efeito propaga)" "$(Pq -c "SELECT count(*) FROM private.customer_metrics_mv;")" "2"

# P2: staff via wrapper refresha (MV passa de 2 → 3). Prova a UX preservada + PERFORM do primitive.
P -q -c "INSERT INTO public._src_metrics(customer_user_id) VALUES ('cccccccc-cccc-cccc-cccc-cccccccccccc');"
P -q <<'SQL'
SET test.uid='33333333-3333-3333-3333-333333333333';
SET ROLE authenticated;
SELECT public.request_customer_metrics_refresh();
RESET ROLE;
SQL
eq "P2 staff via wrapper refresha (UX do frontend)" "$(Pq -c "SELECT count(*) FROM private.customer_metrics_mv;")" "3"

echo "── negativos (a defesa morde — SQLSTATE + re-raise) ──"
# N1: authenticated (mesmo master) NÃO alcança o primitive direto → 42501 ANTES de qualquer refresh
R=$(P -tA 2>&1 <<'SQL'
SET test.uid='33333333-3333-3333-3333-333333333333';
SET ROLE authenticated;
DO $$ BEGIN
  PERFORM public.refresh_customer_metrics();
  RAISE EXCEPTION 'PRIMITIVE_NAO_BARROU';
EXCEPTION
  WHEN insufficient_privilege THEN RAISE NOTICE 'PRIMITIVE_NEGADO';
  WHEN OTHERS THEN RAISE;
END $$;
SQL
)
case "$R" in *PRIMITIVE_NEGADO*) ok "N1 authenticated/staff não alcança o primitive (fronteira de GRANT)" ;; *) bad "N1 — veio: $R" ;; esac

# N2: customer (uid≠null, não-staff) no wrapper → gate 42501
R=$(P -tA 2>&1 <<'SQL'
SET test.uid='44444444-4444-4444-4444-444444444444';
SET ROLE authenticated;
DO $$ BEGIN
  PERFORM public.request_customer_metrics_refresh();
  RAISE EXCEPTION 'WRAPPER_NAO_BARROU_CUSTOMER';
EXCEPTION
  WHEN insufficient_privilege THEN RAISE NOTICE 'WRAPPER_NEGOU_CUSTOMER';
  WHEN OTHERS THEN RAISE;
END $$;
SQL
)
case "$R" in *WRAPPER_NEGOU_CUSTOMER*) ok "N2 wrapper nega customer (gate staff 42501)" ;; *) bad "N2 — veio: $R" ;; esac

# N3: uid NULO no wrapper → 42501 (rejeita ausência de identidade — o invariante do Codex)
R=$(P -tA 2>&1 <<'SQL'
SET test.uid='';
SET ROLE authenticated;
DO $$ BEGIN
  PERFORM public.request_customer_metrics_refresh();
  RAISE EXCEPTION 'WRAPPER_ACEITOU_UID_NULO';
EXCEPTION
  WHEN insufficient_privilege THEN RAISE NOTICE 'WRAPPER_REJEITOU_UID_NULO';
  WHEN OTHERS THEN RAISE;
END $$;
SQL
)
case "$R" in *WRAPPER_REJEITOU_UID_NULO*) ok "N3 wrapper REJEITA uid nulo (anti fail-open)" ;; *) bad "N3 — veio: $R" ;; esac

# N4: anon barrado em ambas
R=$(P -tA 2>&1 <<'SQL'
SET ROLE anon;
DO $$ BEGIN PERFORM public.refresh_customer_metrics(); RAISE EXCEPTION 'X';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'ANON_NEG_PRIM'; WHEN OTHERS THEN RAISE; END $$;
SQL
)
case "$R" in *ANON_NEG_PRIM*) ok "N4a anon negado no primitive" ;; *) bad "N4a — veio: $R" ;; esac
R=$(P -tA 2>&1 <<'SQL'
SET ROLE anon;
DO $$ BEGIN PERFORM public.request_customer_metrics_refresh(); RAISE EXCEPTION 'X';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'ANON_NEG_WRAP'; WHEN OTHERS THEN RAISE; END $$;
SQL
)
case "$R" in *ANON_NEG_WRAP*) ok "N4b anon negado no wrapper" ;; *) bad "N4b — veio: $R" ;; esac

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICAÇÃO (Lei #3: sabota → exija VERMELHO → restaura)
# ══════════════════════════════════════════════════════════════════════════════
echo "── falsificação ──"

# F1 — sabota a fronteira: re-GRANT authenticated no primitive → N1 deve deixar de ver 42501
P -q -c "GRANT EXECUTE ON FUNCTION public.refresh_customer_metrics() TO authenticated;"
R=$(P -tA 2>&1 <<'SQL'
SET test.uid='33333333-3333-3333-3333-333333333333';
SET ROLE authenticated;
DO $$ BEGIN
  PERFORM public.refresh_customer_metrics();
  RAISE NOTICE 'FRONTEIRA_FURADA_PASSOU';
EXCEPTION
  WHEN insufficient_privilege THEN RAISE NOTICE 'PRIMITIVE_NEGADO';
  WHEN OTHERS THEN RAISE NOTICE 'OUTRO_ERRO_MAS_NAO_42501';
END $$;
SQL
)
case "$R" in
  *PRIMITIVE_NEGADO*) bad "F1 sabotei o grant e N1 ainda vê 42501 → N1 é fraco" ;;
  *) ok "F1 re-grant fura a fronteira (N1/G1 tinham dente)" ;;
esac
P -q -c "REVOKE EXECUTE ON FUNCTION public.refresh_customer_metrics() FROM authenticated;"

# F2 — a DECISIVA: troca o gate do wrapper pela versão-C (aceita uid nulo = fail-open) → N3 fica VERMELHO
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.request_customer_metrics_refresh()
  RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $fn$
DECLARE v_uid uuid := auth.uid();
BEGIN
  -- GATE SABOTADO (Opção C): só barra authenticated NÃO-staff; ACEITA uid nulo (fail-open que o Codex condenou)
  IF v_uid IS NOT NULL AND NOT (COALESCE(public.has_role(v_uid,'employee'::public.app_role),false)
                             OR COALESCE(public.has_role(v_uid,'master'::public.app_role),false)) THEN
    RAISE EXCEPTION 'Acesso negado' USING ERRCODE='42501';
  END IF;
  PERFORM public.refresh_customer_metrics();
END $fn$;
SQL
R=$(P -tA 2>&1 <<'SQL'
SET test.uid='';
SET ROLE authenticated;
DO $$ BEGIN
  PERFORM public.request_customer_metrics_refresh();
  RAISE NOTICE 'GATE_C_ACEITOU_UID_NULO';
EXCEPTION
  WHEN insufficient_privilege THEN RAISE NOTICE 'WRAPPER_REJEITOU_UID_NULO';
  WHEN OTHERS THEN RAISE;
END $$;
SQL
)
case "$R" in
  *GATE_C_ACEITOU_UID_NULO*) ok "F2 gate-C aceita uid nulo → N3 tinha dente; nosso desenho barra o fail-open" ;;
  *WRAPPER_REJEITOU_UID_NULO*) bad "F2 gate-C ainda rejeitou uid nulo → N3 não distingue os desenhos" ;;
  *) bad "F2 — veio: $R" ;;
esac
P -q -f "$MIG"   # restaura a versão verdadeira

# F3 — sabota o gate staff (remove) → N2 (customer) deve deixar de ser barrado
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.request_customer_metrics_refresh()
  RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $fn$ BEGIN PERFORM public.refresh_customer_metrics(); END $fn$;
SQL
R=$(P -tA 2>&1 <<'SQL'
SET test.uid='44444444-4444-4444-4444-444444444444';
SET ROLE authenticated;
DO $$ BEGIN
  PERFORM public.request_customer_metrics_refresh();
  RAISE NOTICE 'GATE_REMOVIDO_CUSTOMER_PASSOU';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'WRAPPER_NEGOU_CUSTOMER'; WHEN OTHERS THEN RAISE; END $$;
SQL
)
case "$R" in
  *GATE_REMOVIDO_CUSTOMER_PASSOU*) ok "F3 sem gate, customer passa (N2 tinha dente)" ;;
  *) bad "F3 — veio: $R" ;;
esac
P -q -f "$MIG"

# F4 — sabota a automação: REVOKE service_role do primitive → P1/G2 (automação) quebram
P -q -c "REVOKE EXECUTE ON FUNCTION public.refresh_customer_metrics() FROM service_role;"
R=$(P -tA 2>&1 <<'SQL'
SET ROLE service_role;
DO $$ BEGIN
  PERFORM public.refresh_customer_metrics();
  RAISE NOTICE 'SERVICE_AINDA_EXECUTA';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'SERVICE_PERDEU_ACESSO'; WHEN OTHERS THEN RAISE; END $$;
SQL
)
case "$R" in
  *SERVICE_PERDEU_ACESSO*) ok "F4 sem grant service_role a automação quebra (P1/G2 tinham dente)" ;;
  *) bad "F4 — veio: $R" ;;
esac
P -q -f "$MIG"

# ── veredito ──
echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
