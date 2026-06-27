#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  HARNESS PG17 — Onda 1 do hardening de segurança (RLS + views + matview)       ║
# ║  Prova: trancar 5 tabelas (RLS+revoke) bloqueia anon/authenticated mas NÃO     ║
# ║  service_role; views viram security_invoker (anon não lê, staff lê); matview   ║
# ║  revoga anon (authenticated mantém). + FALSIFICAÇÃO.                           ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5461}"
SLUG="seg-onda1"
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
# deny: exige permission denied (42501) — Lei #2 (não "qualquer erro")
deny() { local out; if out=$(P -q -c "$1" 2>&1); then bad "$2 — devia NEGAR e passou"; \
         elif echo "$out" | grep -q "permission denied"; then ok "$2 (permission denied)"; \
         else bad "$2 — erro inesperado: $(echo "$out" | tail -1)"; fi; }

echo "═══ setup PG17 :$PORT ═══"

# ══ ZONA 1 — estado de PROD antes da migração ════════════════════════════════
P -q <<'SQL'
CREATE TYPE public.app_role AS ENUM ('employee','master','customer');

-- gates stub lendo GUC (modelam fin_user_can_access / has_role reais)
CREATE FUNCTION public.fin_user_can_access(_company text) RETURNS boolean
  LANGUAGE sql STABLE AS $$ SELECT current_setting('test.fin_access', true) = 'on' $$;
CREATE FUNCTION public.has_role(_uid uuid, _role public.app_role) RETURNS boolean
  LANGUAGE sql STABLE AS $$ SELECT current_setting('test.is_staff', true) = 'on' $$;

-- tabelas-base das views (com RLS, como em prod)
CREATE TABLE public.fin_contas_pagar   (company text, status_titulo text, data_vencimento date, saldo numeric);
CREATE TABLE public.fin_contas_receber (company text, status_titulo text, data_vencimento date, saldo numeric);
CREATE TABLE public.profiles      (user_id uuid, name text);
CREATE TABLE public.sales_orders  (id uuid, customer_user_id uuid);

ALTER TABLE public.fin_contas_pagar   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fin_contas_receber ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sales_orders  ENABLE ROW LEVEL SECURITY;

CREATE POLICY cp_sel ON public.fin_contas_pagar   FOR SELECT TO authenticated USING (public.fin_user_can_access(company));
CREATE POLICY cr_sel ON public.fin_contas_receber FOR SELECT TO authenticated USING (public.fin_user_can_access(company));
CREATE POLICY pr_sel ON public.profiles     FOR SELECT USING (public.has_role(auth.uid(),'master'::public.app_role) OR public.has_role(auth.uid(),'employee'::public.app_role));
CREATE POLICY so_sel ON public.sales_orders FOR SELECT USING (public.has_role(auth.uid(),'master'::public.app_role) OR public.has_role(auth.uid(),'employee'::public.app_role));

-- as 3 views como SECURITY DEFINER (default = sem security_invoker; owner=postgres BYPASSRLS)
CREATE VIEW public.fin_aging_pagar AS
  SELECT company, count(*) AS qtd, COALESCE(sum(saldo),0) AS total
  FROM public.fin_contas_pagar WHERE status_titulo <> 'PAGO' GROUP BY company;
CREATE VIEW public.fin_aging_receber AS
  SELECT company, count(*) AS qtd, COALESCE(sum(saldo),0) AS total
  FROM public.fin_contas_receber WHERE status_titulo <> 'RECEBIDO' GROUP BY company;
CREATE VIEW public.v_caca_compradores AS
  SELECT p.user_id, p.name, count(so.id) AS n_pedidos
  FROM public.profiles p LEFT JOIN public.sales_orders so ON so.customer_user_id = p.user_id
  GROUP BY p.user_id, p.name;

-- matview exposta na API
CREATE MATERIALIZED VIEW public.customer_metrics_mv AS SELECT 1 AS metric;

-- 5 tabelas de backup/preflight/log SEM RLS (estado atual: anon lê+grava)
CREATE TABLE public._backup_cost_lavados_20260620 (x int);
CREATE TABLE public._backup_cost_reset_20260622   (x int);
CREATE TABLE public._preflight_tint               (x int);
CREATE TABLE public.reposicao_param_limbo_log     (x int);
CREATE TABLE public.tint_formulas_backup_preflip  (x int);

-- grants default do Supabase (pré-migração: anon+authenticated têm tudo)
GRANT SELECT ON public.fin_contas_pagar, public.fin_contas_receber, public.profiles, public.sales_orders TO anon, authenticated, service_role;
GRANT SELECT ON public.fin_aging_pagar, public.fin_aging_receber, public.v_caca_compradores TO anon, authenticated;
GRANT SELECT ON public.customer_metrics_mv TO anon, authenticated;
GRANT SELECT, INSERT ON public._backup_cost_lavados_20260620, public._backup_cost_reset_20260622, public._preflight_tint, public.reposicao_param_limbo_log, public.tint_formulas_backup_preflip TO anon, authenticated, service_role;
SQL

# ══ ZONA 2 — aplicar a migração REAL ═════════════════════════════════════════
MIG="$REPO_ROOT/supabase/migrations/20260627180100_seg_onda1_rls_views_matview.sql"
P -q -f "$MIG"
echo "migration aplicada: $(basename "$MIG")"

# ══ ZONA 3 — seed (como postgres, ignora RLS) ════════════════════════════════
P -q <<'SQL'
INSERT INTO public.fin_contas_pagar   VALUES ('oben','ABERTO', CURRENT_DATE+5, 100);
INSERT INTO public.fin_contas_receber VALUES ('oben','ABERTO', CURRENT_DATE-5, 200);
INSERT INTO public.profiles     VALUES ('11111111-1111-1111-1111-111111111111','Cliente X');
INSERT INTO public.sales_orders VALUES ('22222222-2222-2222-2222-222222222222','11111111-1111-1111-1111-111111111111');
INSERT INTO public._backup_cost_lavados_20260620 VALUES (1);
INSERT INTO public._preflight_tint VALUES (1);
SQL

# ══ ZONA 4 — ASSERTS ═════════════════════════════════════════════════════════
echo "── asserts ──"
# Positivo: service_role (BYPASSRLS) ainda lê a tabela trancada
V=$(Pq -c "SET ROLE service_role; SELECT count(*) FROM public._backup_cost_lavados_20260620;" | tail -1)
eq "A1 service_role lê backup (engine intacta)" "$V" "1"
# Negativo: anon e authenticated NÃO leem as tabelas trancadas (grant revogado → 42501)
deny "SET ROLE anon;          SELECT 1 FROM public._backup_cost_lavados_20260620;" "A2 anon NAO le _backup_cost_lavados"
deny "SET ROLE authenticated; SELECT 1 FROM public._backup_cost_reset_20260622;"   "A3 authenticated NAO le _backup_cost_reset"
deny "SET ROLE anon;          SELECT 1 FROM public.tint_formulas_backup_preflip;"   "A3b anon NAO le tint_formulas_backup"
deny "SET ROLE anon;          INSERT INTO public._preflight_tint VALUES (9);"       "A3c anon NAO grava _preflight_tint"

# Positivo: staff lê as views via invoker
V=$(Pq -c "SET test.fin_access='on'; SET ROLE authenticated; SELECT count(*) FROM public.fin_aging_pagar;" | tail -1)
eq "A4 staff financeiro le fin_aging_pagar" "$V" "1"
V=$(Pq -c "SET test.is_staff='on'; SET test.uid='11111111-1111-1111-1111-111111111111'; SET ROLE authenticated; SELECT count(*) FROM public.v_caca_compradores;" | tail -1)
eq "A6 staff le v_caca_compradores" "$V" "1"
# Negativo: anon NÃO lê as views (invoker → RLS das bases nega → 0 linhas)
V=$(Pq -c "SET ROLE anon; SELECT count(*) FROM public.fin_aging_pagar;" | tail -1)
eq "A5 anon NAO ve fin_aging_pagar" "$V" "0"
V=$(Pq -c "SET ROLE anon; SELECT count(*) FROM public.fin_aging_receber;" | tail -1)
eq "A5b anon NAO ve fin_aging_receber" "$V" "0"
V=$(Pq -c "SET ROLE anon; SELECT count(*) FROM public.v_caca_compradores;" | tail -1)
eq "A7 anon NAO ve v_caca_compradores" "$V" "0"

# Matview: authenticated mantém, anon revogado
V=$(Pq -c "SET ROLE authenticated; SELECT count(*) FROM public.customer_metrics_mv;" | tail -1)
eq "A8 authenticated le customer_metrics_mv (3 telas seguem)" "$V" "1"
deny "SET ROLE anon; SELECT 1 FROM public.customer_metrics_mv;" "A9 anon NAO le customer_metrics_mv"

# ══ ZONA 5 — FALSIFICAÇÃO (sabota → exija o oposto → restaura) ════════════════
echo "── falsificacao ──"
# F1: sem RLS+revoke, anon VOLTA a ler a tabela → prova que A2/A3 dependem da migração
P -q -c "ALTER TABLE public._backup_cost_lavados_20260620 DISABLE ROW LEVEL SECURITY; GRANT SELECT ON public._backup_cost_lavados_20260620 TO anon;"
if P -q -c "SET ROLE anon; SELECT 1 FROM public._backup_cost_lavados_20260620;" >/dev/null 2>&1; then
  ok "F1 sabotado (sem RLS+grant) anon LE -> A2 tem dente"
else
  bad "F1 anon ainda barrado mesmo sabotado -> A2 SEM dente"
fi
P -q -c "ALTER TABLE public._backup_cost_lavados_20260620 ENABLE ROW LEVEL SECURITY; REVOKE ALL ON public._backup_cost_lavados_20260620 FROM anon;"

# F2: view de volta a DEFINER → anon VOLTA a ler agregado financeiro → prova que A5 depende do invoker
P -q -c "ALTER VIEW public.fin_aging_pagar SET (security_invoker = off);"
C=$(Pq -c "SET ROLE anon; SELECT count(*) FROM public.fin_aging_pagar;" | tail -1)
if [ "$C" -gt 0 ]; then ok "F2 sabotado (DEFINER) anon ve fin_aging_pagar ($C) -> A5 tem dente"; else bad "F2 anon nao viu nem como DEFINER -> A5 SEM dente"; fi
P -q -c "ALTER VIEW public.fin_aging_pagar SET (security_invoker = on);"

# F3: re-grant anon na matview → anon VOLTA a ler → prova que A9 depende do revoke
P -q -c "GRANT SELECT ON public.customer_metrics_mv TO anon;"
if P -q -c "SET ROLE anon; SELECT 1 FROM public.customer_metrics_mv;" >/dev/null 2>&1; then
  ok "F3 sabotado (re-grant) anon LE matview -> A9 tem dente"
else
  bad "F3 anon barrado mesmo com grant -> A9 SEM dente"
fi
P -q -c "REVOKE ALL ON public.customer_metrics_mv FROM anon;"

echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
