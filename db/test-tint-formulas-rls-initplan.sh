#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  PROVA: migration 20260627150000_tint_formulas_rls_initplan.sql               ║
# ║  Fix de RLS por-linha → InitPlan. Prova: (a) autorização IDÊNTICA old↔new     ║
# ║  (staff vê, não-staff não vê, USING e WITH CHECK) e (b) has_role passa de     ║
# ║  O(N) por-linha p/ O(1) InitPlan, no SELECT e no INSERT.                       ║
# ║  Endurecido pós Codex challenge: cobre WITH CHECK, old↔new, NULL uid,         ║
# ║  polcmd/polroles e EXPLAIN InitPlan.                                           ║
# ║  Rodar:  bash db/test-tint-formulas-rls-initplan.sh > /tmp/t.log 2>&1; echo $? ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5477}"
SLUG="tint-rls"
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

MASTER='11111111-1111-1111-1111-111111111111'
EMP='22222222-2222-2222-2222-222222222222'
CUST='33333333-3333-3333-3333-333333333333'
NOROLE='44444444-4444-4444-4444-444444444444'
# count TOTAL visível p/ um caller (mede a RLS, não o filtro do usuário)
cnt()      { Pq -c "SET test.uid='$1'; SET ROLE authenticated; SELECT count(*) FROM public.tint_formulas;" | tail -1; }
cnt_anon() { Pq -c "SET ROLE anon; SELECT count(*) FROM public.tint_formulas;" | tail -1; }

echo "═══ setup pronto (PG17 :$PORT) ═══"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — PRÉ-REQUISITOS (estado de PROD) + SEED + GRANTS
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname='app_role') THEN
    CREATE TYPE public.app_role AS ENUM ('master','employee','customer');
  END IF;
END $$;

CREATE TABLE public.user_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  role public.app_role NOT NULL,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

-- has_role VERBATIM de prod (STABLE SECURITY DEFINER) — Lei #1: a dependência é a real
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $function$;

CREATE TABLE public.tint_formulas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account text NOT NULL,
  desativada_em timestamptz
);
ALTER TABLE public.tint_formulas ENABLE ROW LEVEL SECURITY;

-- policy ANTIGA = estado de prod exato (FOR ALL, TO authenticated, has_role DIRETO/por-linha)
CREATE POLICY "Staff can manage tint_formulas" ON public.tint_formulas
  FOR ALL TO authenticated
  USING      (has_role(auth.uid(), 'master'::app_role) OR has_role(auth.uid(), 'employee'::app_role))
  WITH CHECK (has_role(auth.uid(), 'master'::app_role) OR has_role(auth.uid(), 'employee'::app_role));

INSERT INTO auth.users(id) VALUES
  ('11111111-1111-1111-1111-111111111111'),('22222222-2222-2222-2222-222222222222'),
  ('33333333-3333-3333-3333-333333333333'),('44444444-4444-4444-4444-444444444444')
  ON CONFLICT DO NOTHING;
INSERT INTO public.user_roles(user_id, role) VALUES
  ('11111111-1111-1111-1111-111111111111','master'),
  ('22222222-2222-2222-2222-222222222222','employee'),
  ('33333333-3333-3333-3333-333333333333','customer');

-- 1000 oben ativas (o que o dashboard conta) + ruído fora do filtro
INSERT INTO public.tint_formulas(account, desativada_em) SELECT 'oben', NULL    FROM generate_series(1,1000);
INSERT INTO public.tint_formulas(account, desativada_em) SELECT 'oben', now()   FROM generate_series(1,50);
INSERT INTO public.tint_formulas(account, desativada_em) SELECT 'colacor', NULL FROM generate_series(1,50);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.tint_formulas TO authenticated, anon;
GRANT EXECUTE ON FUNCTION public.has_role(uuid, app_role) TO authenticated, anon;
SQL

# ── caller matrix sob a policy ANTIGA (p/ comparar com a NOVA — equivalência) ──
O_master=$(cnt "$MASTER"); O_emp=$(cnt "$EMP"); O_cust=$(cnt "$CUST"); O_nr=$(cnt "$NOROLE"); O_null=$(cnt ''); O_anon=$(cnt_anon)

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — APLICAR A MIGRATION REAL (ALTER POLICY → wrap (SELECT ...))
# ══════════════════════════════════════════════════════════════════════════════
MIG="$REPO_ROOT/supabase/migrations/20260627150000_tint_formulas_rls_initplan.sql"
P -q -f "$MIG" >/dev/null
echo "migration aplicada: $(basename "$MIG")"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4 — ASSERTS
# ══════════════════════════════════════════════════════════════════════════════
echo "── equivalência old↔new (a RLS admite os MESMOS callers) ──"
N_master=$(cnt "$MASTER"); N_emp=$(cnt "$EMP"); N_cust=$(cnt "$CUST"); N_nr=$(cnt "$NOROLE"); N_null=$(cnt ''); N_anon=$(cnt_anon)
eq "EQ1 master   old↔new" "$N_master" "$O_master"
eq "EQ2 employee old↔new" "$N_emp"    "$O_emp"
eq "EQ3 customer old↔new" "$N_cust"   "$O_cust"
eq "EQ4 sem-role old↔new" "$N_nr"     "$O_nr"
eq "EQ5 NULL uid old↔new" "$N_null"   "$O_null"
eq "EQ6 anon     old↔new" "$N_anon"   "$O_anon"

echo "── autorização absoluta (a RLS faz o que deve) ──"
eq "A1 master vê tudo (1100)"  "$N_master" "1100"
eq "A2 employee vê tudo (1100)" "$N_emp"   "1100"
eq "A3 customer vê 0"          "$N_cust"   "0"
eq "A4 sem-role vê 0"          "$N_nr"     "0"
eq "A5 NULL uid vê 0"          "$N_null"   "0"
eq "A5b anon vê 0"             "$N_anon"   "0"
A1F=$(Pq -c "SET test.uid='$MASTER'; SET ROLE authenticated; SELECT count(*) FROM public.tint_formulas WHERE account='oben' AND desativada_em IS NULL;" | tail -1)
eq "A1f master+filtro dashboard (1000)" "$A1F" "1000"

echo "── cmd/roles preservados (anti-drift do ALTER POLICY) ──"
POLCMD=$(Pq -c "SELECT polcmd FROM pg_policy WHERE polrelid='public.tint_formulas'::regclass;")
eq "A_POL1 cmd preservado (ALL)" "$POLCMD" "*"
POLROLES=$(Pq -c "SELECT array_to_string(ARRAY(SELECT rolname FROM pg_roles WHERE oid = ANY(p.polroles) ORDER BY rolname), ',') FROM pg_policy p WHERE p.polrelid='public.tint_formulas'::regclass;")
eq "A_POL2 roles preservado (authenticated)" "$POLROLES" "authenticated"

echo "── EXPLAIN: o plano usa InitPlan (reforço do contador) ──"
EXP=$(Pq -c "SET test.uid='$MASTER'; SET ROLE authenticated; EXPLAIN (VERBOSE) SELECT count(*) FROM public.tint_formulas WHERE account='oben' AND desativada_em IS NULL;" 2>&1)
case "$EXP" in *InitPlan*) ok "A_EXP plano contém InitPlan" ;; *) bad "A_EXP plano SEM InitPlan: $(printf '%s' "$EXP" | tr '\n' ' ' | cut -c1-200)" ;; esac

echo "── WITH CHECK: autorização em INSERT (staff passa / não-staff barra) ──"
R=$(P -tA 2>&1 <<'SQL'
SET test.uid='11111111-1111-1111-1111-111111111111'; SET ROLE authenticated;
DO $$ BEGIN
  INSERT INTO public.tint_formulas(account, desativada_em) VALUES ('oben', NULL);
  RAISE NOTICE 'WC_STAFF_OK';
EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'WC_STAFF_FAIL:%', SQLERRM; END $$;
SQL
)
case "$R" in *WC_STAFF_OK*) ok "A_WC1 master consegue INSERT (WITH CHECK passa)" ;; *) bad "A_WC1 master não inseriu: $R" ;; esac
R=$(P -tA 2>&1 <<'SQL'
SET test.uid='33333333-3333-3333-3333-333333333333'; SET ROLE authenticated;
DO $$ BEGIN
  INSERT INTO public.tint_formulas(account, desativada_em) VALUES ('oben', NULL);
  RAISE EXCEPTION 'WC_NAO_BARROU';
EXCEPTION
  WHEN insufficient_privilege THEN RAISE NOTICE 'WC_DENY_OK';
  WHEN OTHERS THEN RAISE;
END $$;
SQL
)
case "$R" in *WC_DENY_OK*) ok "A_WC2 customer BARRADO no INSERT (WITH CHECK 42501)" ;; *) bad "A_WC2 customer não barrado: $R" ;; esac

echo "── InitPlan via contador (instrumenta has_role; mantém STABLE SECURITY DEFINER) ──"
P -q <<'SQL'
CREATE SEQUENCE IF NOT EXISTS public._hr_calls;
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $f$ SELECT nextval('public._hr_calls') IS NOT NULL
   AND EXISTS (SELECT 1 FROM public.user_roles WHERE user_id=_user_id AND role=_role) $f$;
SQL
# A6: USING InitPlan no SELECT de 1000 linhas
Pq -c "SELECT setval('public._hr_calls', 1, false);" >/dev/null
Pq -c "SET test.uid='$MASTER'; SET ROLE authenticated; SELECT count(*) FROM public.tint_formulas WHERE account='oben' AND desativada_em IS NULL;" >/dev/null
K_NEW=$(Pq -c "SELECT last_value FROM public._hr_calls;")
if [ "${K_NEW:-9999}" -le 4 ]; then ok "A6 USING InitPlan no SELECT (${K_NEW}× p/ 1000 linhas)"; else bad "A6 USING rodou has_role ${K_NEW}× (por-linha?)"; fi
# A_WC3: WITH CHECK InitPlan no INSERT 1000 linhas (master)
Pq -c "SELECT setval('public._hr_calls', 1, false);" >/dev/null
Pq -c "SET test.uid='$MASTER'; SET ROLE authenticated; INSERT INTO public.tint_formulas(account, desativada_em) SELECT 'oben', NULL FROM generate_series(1,1000);" >/dev/null
K_WC=$(Pq -c "SELECT last_value FROM public._hr_calls;")
if [ "${K_WC:-9999}" -le 4 ]; then ok "A_WC3 WITH CHECK InitPlan no INSERT 1000 (${K_WC}×)"; else bad "A_WC3 WITH CHECK rodou has_role ${K_WC}× no INSERT (por-linha)"; fi

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICAÇÃO (sabota → exige vermelho → restaura)
# ══════════════════════════════════════════════════════════════════════════════
echo "── falsificação ──"
# F2: USING antigo (por-linha) no SELECT → contador alto (A6 tem dente)
P -q <<'SQL'
ALTER POLICY "Staff can manage tint_formulas" ON public.tint_formulas
  USING (has_role(auth.uid(),'master'::app_role) OR has_role(auth.uid(),'employee'::app_role));
SQL
Pq -c "SELECT setval('public._hr_calls', 1, false);" >/dev/null
Pq -c "SET test.uid='$MASTER'; SET ROLE authenticated; SELECT count(*) FROM public.tint_formulas WHERE account='oben' AND desativada_em IS NULL;" >/dev/null
K_OLD=$(Pq -c "SELECT last_value FROM public._hr_calls;")
if [ "${K_OLD:-0}" -ge 500 ]; then ok "F2 USING antigo por-linha (${K_OLD}× → A6 tem dente)"; else bad "F2 sabotei USING e só rodou ${K_OLD}×"; fi
P -q -f "$MIG" >/dev/null

# F_WC: WITH CHECK antigo (por-linha) no INSERT → contador alto (A_WC3 tem dente)
P -q -c "ALTER POLICY \"Staff can manage tint_formulas\" ON public.tint_formulas WITH CHECK (has_role(auth.uid(),'master'::app_role) OR has_role(auth.uid(),'employee'::app_role));"
Pq -c "SELECT setval('public._hr_calls', 1, false);" >/dev/null
Pq -c "SET test.uid='$MASTER'; SET ROLE authenticated; INSERT INTO public.tint_formulas(account, desativada_em) SELECT 'oben', NULL FROM generate_series(1,1000);" >/dev/null
K_WC_OLD=$(Pq -c "SELECT last_value FROM public._hr_calls;")
if [ "${K_WC_OLD:-0}" -ge 500 ]; then ok "F_WC WITH CHECK antigo por-linha (${K_WC_OLD}× → A_WC3 tem dente)"; else bad "F_WC sabotei WITH CHECK e só rodou ${K_WC_OLD}×"; fi
P -q -f "$MIG" >/dev/null

# restaura has_role real (sem contador) p/ os asserts de autorização
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $f$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $f$;
SQL

# F1: USING(true) → customer (não-staff) passa a ver tudo (A3 tem dente)
P -q -c "ALTER POLICY \"Staff can manage tint_formulas\" ON public.tint_formulas USING (true) WITH CHECK (true);"
A3_SAB=$(cnt "$CUST")
if [ "${A3_SAB:-0}" != "0" ]; then ok "F1 USING(true) vazou ${A3_SAB} linhas p/ customer (A3 tem dente)"; else bad "F1 sabotei USING(true) e customer AINDA vê 0"; fi
P -q -f "$MIG" >/dev/null

# F3: USING(false) → nem o master vê (A1 tem dente)
P -q -c "ALTER POLICY \"Staff can manage tint_formulas\" ON public.tint_formulas USING (false) WITH CHECK (false);"
A1_SAB=$(cnt "$MASTER")
if [ "$A1_SAB" = "0" ]; then ok "F3 USING(false) bloqueou até o master (A1 tem dente)"; else bad "F3 sabotei USING(false) e master AINDA vê ${A1_SAB}"; fi
P -q -f "$MIG" >/dev/null

# sanity pós-restauração (inserimos linhas no meio, então master vê >0, não exato)
SAN_M=$(cnt "$MASTER"); SAN_C=$(cnt "$CUST")
if [ "${SAN_M:-0}" -gt 0 ]; then ok "A_SAN1 pós-restauração master vê linhas (${SAN_M})"; else bad "A_SAN1 master vê 0 pós-restauração"; fi
eq "A_SAN2 pós-restauração customer vê 0" "$SAN_C" "0"

echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
