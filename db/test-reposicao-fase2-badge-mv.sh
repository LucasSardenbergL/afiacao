#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA: migration 20260627190000_reposicao_fase2_badge_oportunidade_mv.sql     ║
# ║  MV em private (count) + view-gate em public + função de refresh. Prova:       ║
# ║  (A1) gate replica a RLS (staff/service_role vê, não-staff/anon NÃO);          ║
# ║  (A2) authenticated NÃO lê a MV crua (REVOKE — anti-vazamento);                ║
# ║  (A3) paridade: oportunidade_count == count(*) da fonte por empresa;           ║
# ║  (A4) cron-context: refresh roda sob auth.uid()=NULL (NÃO dá 42501);           ║
# ║  (A5) REFRESH CONCURRENTLY funciona. Falsifica F1-F4.                          ║
# ║  Rodar:  bash db/test-reposicao-fase2-badge-mv.sh > /tmp/t.log 2>&1; echo $?   ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5480}"
SLUG="repo-f2"
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
P()  { "$PGBIN/psql" -X -p "$PORT" -h /tmp -U postgres -d prove -v ON_ERROR_STOP=1 "$@"; }
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

MASTER='11111111-1111-1111-1111-111111111111'
EMP='22222222-2222-2222-2222-222222222222'
CUST='33333333-3333-3333-3333-333333333333'
NOROLE='44444444-4444-4444-4444-444444444444'

echo "═══ setup (PG17 :$PORT) ═══"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — PRÉ-REQUISITOS: roles, has_role, schema private, stub cron, stub fonte
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname='app_role') THEN
  CREATE TYPE public.app_role AS ENUM ('master','employee','customer'); END IF; END $$;
CREATE TABLE public.user_roles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, role public.app_role NOT NULL);
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $f$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id=_user_id AND role=_role) $f$;
INSERT INTO auth.users(id) VALUES ('11111111-1111-1111-1111-111111111111'),('22222222-2222-2222-2222-222222222222'),
  ('33333333-3333-3333-3333-333333333333'),('44444444-4444-4444-4444-444444444444') ON CONFLICT DO NOTHING;
INSERT INTO public.user_roles(user_id, role) VALUES
  ('11111111-1111-1111-1111-111111111111','master'),('22222222-2222-2222-2222-222222222222','employee'),
  ('33333333-3333-3333-3333-333333333333','customer');
GRANT EXECUTE ON FUNCTION public.has_role(uuid, app_role) TO authenticated, anon;

-- schema private existe em prod; authenticated NÃO tem USAGE (defense-in-depth)
CREATE SCHEMA IF NOT EXISTS private;
REVOKE ALL ON SCHEMA private FROM PUBLIC;

-- pg_cron: o stubs-supabase.sql já cria o schema cron + tabela cron.job (jobid bigint).
-- Só faltam as funções schedule/unschedule (não no stubs) — stubadas p/ a migration aplicar.
CREATE FUNCTION cron.schedule(jobname text, schedule text, command text) RETURNS bigint
  LANGUAGE sql AS $f$ INSERT INTO cron.job(jobid, jobname, schedule, command, active)
    VALUES ((SELECT coalesce(max(jobid),0)+1 FROM cron.job), $1, $2, $3, true) RETURNING jobid $f$;
CREATE FUNCTION cron.unschedule(jobname text) RETURNS boolean
  LANGUAGE plpgsql AS $f$ BEGIN DELETE FROM cron.job j WHERE j.jobname=$1; RETURN true; END $f$;

-- FONTE FIEL (achado Codex #1): tabela base com RLS "staff vê tudo" + view security_invoker
-- (como em prod). Prova a dependência crítica: o refresh DEVE ver TODAS as linhas → roda como
-- role BYPASSRLS (postgres/superuser); sob caller não-bypass não-staff a fonte dá 0 → MV vazia.
CREATE TABLE public._oport_base (empresa text, sku_codigo_omie text);
ALTER TABLE public._oport_base ENABLE ROW LEVEL SECURITY;
CREATE POLICY staff_oport_base ON public._oport_base FOR SELECT TO authenticated
  USING (public.has_role(auth.uid(),'master'::app_role) OR public.has_role(auth.uid(),'employee'::app_role));
GRANT SELECT ON public._oport_base TO authenticated;
INSERT INTO public._oport_base SELECT 'OBEN',    'SKU'||g FROM generate_series(1,12) g;
INSERT INTO public._oport_base SELECT 'COLACOR', 'SKU'||g FROM generate_series(1,3)  g;
CREATE VIEW public.v_oportunidade_economica_hoje WITH (security_invoker=on) AS
  SELECT empresa, sku_codigo_omie FROM public._oport_base;
GRANT SELECT ON public.v_oportunidade_economica_hoje TO authenticated;
SQL
echo "fonte stub: $(Pq -c "select empresa||'='||count(*) from public.v_oportunidade_economica_hoje group by empresa order by 1" | tr '\n' ' ')"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — APLICAR A MIGRATION REAL
# ══════════════════════════════════════════════════════════════════════════════
MIG="$REPO_ROOT/supabase/migrations/20260627190000_reposicao_fase2_badge_oportunidade_mv.sql"
P -q -f "$MIG" >/dev/null
echo "migration aplicada: $(basename "$MIG")"

# ── helper: count de linhas visíveis na VIEW-GATE p/ um caller (uid + role GUC) ──
gate() { Pq -c "SET test.uid='$1'; SET test.role='$2'; SET ROLE authenticated; SELECT count(*) FROM public.v_oportunidade_economica_hoje_badge_cached;" | tail -1; }
gate_sr() { Pq -c "SET test.uid=''; SET test.role='service_role'; SET ROLE service_role; SELECT count(*) FROM public.v_oportunidade_economica_hoje_badge_cached;" | tail -1; }

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 3 — ASSERTS
# ══════════════════════════════════════════════════════════════════════════════
echo "── A1 GATE replica a RLS (2 empresas visíveis p/ staff/service_role; 0 p/ resto) ──"
eq "A1 master vê 2 empresas"   "$(gate "$MASTER" '')" "2"
eq "A1 employee vê 2 empresas" "$(gate "$EMP" '')"    "2"
eq "A1 customer vê 0"          "$(gate "$CUST" '')"   "0"
eq "A1 sem-role vê 0"          "$(gate "$NOROLE" '')" "0"
eq "A1 NULL uid vê 0"          "$(gate '' '')"        "0"
eq "A1 service_role vê 2"      "$(gate_sr)"           "2"

echo "── A2 ANTI-VAZAMENTO: authenticated NÃO lê a MV crua — pelo REVOKE da MV, não só do schema ──"
P -q -c "GRANT USAGE ON SCHEMA private TO authenticated;"   # mesmo com USAGE no schema, a MV barra
R=$(P -tA 2>&1 -c "SET test.uid='$MASTER'; SET ROLE authenticated; DO \$\$ BEGIN PERFORM 1 FROM private.mv_oportunidade_badge; RAISE EXCEPTION 'VAZOU'; EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'BLOQUEADO_OK'; WHEN OTHERS THEN RAISE; END \$\$;" || true)
case "$R" in *BLOQUEADO_OK*) ok "A2 master barrado na MV crua MESMO com USAGE no schema (prova o REVOKE da MV)";; *) bad "A2 NÃO barrou a MV crua: $R";; esac
P -q -c "REVOKE USAGE ON SCHEMA private FROM authenticated;"

echo "── A3 PARIDADE: oportunidade_count == count(*) da fonte por empresa ──"
PAR=$(Pq -c "select count(*) from private.mv_oportunidade_badge m join (select empresa, count(*)::int c from public.v_oportunidade_economica_hoje group by empresa) s on s.empresa=m.empresa where m.oportunidade_count <> s.c;")
eq "A3 zero divergências de count" "$PAR" "0"
eq "A3 OBEN=12 na MV" "$(Pq -c "select oportunidade_count from private.mv_oportunidade_badge where empresa='OBEN';")" "12"

echo "── A4 CRON-CONTEXT: refresh roda sob auth.uid()=NULL (NÃO dá 42501) ──"
R=$(P -tA 2>&1 -c "SET test.uid=''; SET test.role=''; SELECT public.refresh_oportunidade_badge();" || true)
case "$R" in *42501*|*"Acesso negado"*|*denied*) bad "A4 refresh DEU erro de acesso sob NULL: $R";; *) ok "A4 refresh rodou sob auth.uid()=NULL (cron não morre)";; esac

echo "── A5 REFRESH CONCURRENTLY funciona (muda refreshed_at) ──"
Pq -c "INSERT INTO public._oport_base VALUES ('OBEN','SKU_NOVO');" >/dev/null
Pq -c "SELECT public.refresh_oportunidade_badge();" >/dev/null
N=$(Pq -c "select oportunidade_count from private.mv_oportunidade_badge where empresa='OBEN';")
eq "A5 refresh recomputou OBEN (12→13)" "$N" "13"

echo "── A6 GRANTS do refresh: authenticated NÃO executa; service_role executa ──"
R=$(P -tA 2>&1 -c "SET test.uid=''; SET ROLE authenticated; SELECT public.refresh_oportunidade_badge();" || true)
case "$R" in *denied*|*permission*|*42501*) ok "A6 authenticated barrado de executar o refresh (REVOKE EXECUTE)";; *) bad "A6 authenticated executou o refresh? $R";; esac
R=$(P -tA 2>&1 -c "SET test.uid=''; SET ROLE service_role; SELECT public.refresh_oportunidade_badge();" || true)
case "$R" in *denied*|*permission*) bad "A6 service_role NÃO executou (grant faltando): $R";; *) ok "A6 service_role executa o refresh (GRANT EXECUTE)";; esac

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4 — FALSIFICAÇÃO
# ══════════════════════════════════════════════════════════════════════════════
restore_view() { P -q -c "DROP VIEW IF EXISTS public.v_oportunidade_economica_hoje_badge_cached;
  CREATE VIEW public.v_oportunidade_economica_hoje_badge_cached WITH (security_invoker=false, security_barrier=true) AS
    SELECT empresa, oportunidade_count, refreshed_at FROM private.mv_oportunidade_badge
    WHERE ((SELECT auth.role())='service_role' OR COALESCE((SELECT public.has_role((SELECT auth.uid()),'master'::app_role)),false) OR COALESCE((SELECT public.has_role((SELECT auth.uid()),'employee'::app_role)),false));
  GRANT SELECT ON public.v_oportunidade_economica_hoje_badge_cached TO authenticated, service_role;"; }

echo "── F1: gate USING(true) → não-staff vaza → A1 tem de morder ──"
P -q -c "DROP VIEW public.v_oportunidade_economica_hoje_badge_cached;
  CREATE VIEW public.v_oportunidade_economica_hoje_badge_cached WITH (security_invoker=false) AS SELECT empresa, oportunidade_count, refreshed_at FROM private.mv_oportunidade_badge WHERE true;
  GRANT SELECT ON public.v_oportunidade_economica_hoje_badge_cached TO authenticated, service_role;"
SAB=$(gate "$CUST" '')
if [ "$SAB" != "0" ]; then ok "F1 A1 tem dente (gate(true) vazou ${SAB} p/ customer)"; else bad "F1 customer ainda vê 0 com gate(true)"; fi
restore_view

echo "── F2: gate SEM service_role → service_role perde acesso → tem de morder ──"
P -q -c "DROP VIEW public.v_oportunidade_economica_hoje_badge_cached;
  CREATE VIEW public.v_oportunidade_economica_hoje_badge_cached WITH (security_invoker=false) AS SELECT empresa, oportunidade_count, refreshed_at FROM private.mv_oportunidade_badge WHERE (COALESCE((SELECT public.has_role((SELECT auth.uid()),'master'::app_role)),false) OR COALESCE((SELECT public.has_role((SELECT auth.uid()),'employee'::app_role)),false));
  GRANT SELECT ON public.v_oportunidade_economica_hoje_badge_cached TO authenticated, service_role;"
SAB=$(gate_sr)
if [ "$SAB" = "0" ]; then ok "F2 dente (sem disjunct service_role, service_role perde acesso: vê 0)"; else bad "F2 service_role ainda vê $SAB sem o disjunct"; fi
restore_view

echo "── F3: função COM gate auth.uid() → falha sob NULL (prova que o anti-bug seria pego) ──"
P -q -c "CREATE OR REPLACE FUNCTION public.refresh_oportunidade_badge() RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public','private' AS \$f\$
  BEGIN IF auth.uid() IS NULL OR NOT (public.has_role(auth.uid(),'employee'::app_role) OR public.has_role(auth.uid(),'master'::app_role)) THEN RAISE EXCEPTION 'Acesso negado' USING ERRCODE='42501'; END IF;
  REFRESH MATERIALIZED VIEW CONCURRENTLY private.mv_oportunidade_badge; END \$f\$;"
R=$(P -tA 2>&1 -c "SET test.uid=''; SELECT public.refresh_oportunidade_badge();" || true)
case "$R" in *42501*|*"Acesso negado"*) ok "F3 dente (gate auth.uid() mataria o cron: 42501 sob NULL)";; *) bad "F3 não pegou o gate auth.uid(): $R";; esac
P -q -f "$MIG" >/dev/null  # restaura a função real (sem gate)

echo "── F4: índice não-único → REFRESH CONCURRENTLY falha → tem de morder ──"
P -q -c "DROP INDEX private.mv_oportunidade_badge_empresa_uq;"
R=$(P -tA 2>&1 -c "SELECT public.refresh_oportunidade_badge();" || true)
case "$R" in *concurrent*|*unique*|*"could not"*|*CONCURRENTLY*) ok "F4 dente (CONCURRENTLY exige índice único: falhou sem ele)";; *) bad "F4 CONCURRENTLY não exigiu o índice: $R";; esac
P -q -c "CREATE UNIQUE INDEX mv_oportunidade_badge_empresa_uq ON private.mv_oportunidade_badge (empresa);"

echo "── F5: a FONTE security_invoker+RLS dá 0 p/ não-staff → refresh DEVE rodar como BYPASSRLS ──"
SAB=$(Pq -c "SET test.uid='$CUST'; SET ROLE authenticated; SELECT count(*) FROM public.v_oportunidade_economica_hoje;" | tail -1)
if [ "$SAB" = "0" ]; then ok "F5 não-staff vê 0 na fonte → owner não-bypass cacheria MV vazia (por isso o refresh é bypass + validação mv_status)"; else bad "F5 customer viu $SAB na fonte (RLS não barrou)"; fi

echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
