#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  HARNESS PG17 — carteira_visivel_para / minha_carteira filtram `eligible`      ║
# ║  Prova o furo RLS de visibilidade (money-path/auth). Falsificação nas 2 funcs. ║
# ║  Spec: docs/superpowers/specs/2026-07-17-carteira-rls-eligible-visibilidade-*  ║
# ║      bash db/test-carteira-visivel-eligible.sh > /tmp/t.log 2>&1; echo exit=$? ║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5471}"
SLUG="carteira-elig"
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
# ZONA 1 — PRÉ-REQUISITOS (o que a migração LÊ mas não cria). Corpos reais de prod.
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
CREATE TYPE public.app_role AS ENUM ('master','employee','customer');
CREATE TYPE public.commercial_role AS ENUM ('operacional','gerencial','estrategico','super_admin','farmer','hunter','closer','master');

CREATE TABLE public.user_roles (user_id uuid NOT NULL, role public.app_role NOT NULL);
CREATE TABLE public.commercial_roles (user_id uuid NOT NULL, commercial_role public.commercial_role NOT NULL);

CREATE TABLE public.carteira_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_user_id uuid NOT NULL UNIQUE,
  owner_user_id uuid NOT NULL,
  source text NOT NULL,
  eligible boolean NOT NULL DEFAULT true
);
CREATE INDEX idx_carteira_owner_eligible ON public.carteira_assignments (owner_user_id) WHERE eligible;

CREATE TABLE public.carteira_coverage (
  covered_user_id uuid NOT NULL,
  covering_user_id uuid NOT NULL,
  active boolean NOT NULL DEFAULT true,
  valid_until timestamptz
);

-- artefato de cliente gateado por carteira (uma das 8 policies; SEM braço de autoria → fecha 100%)
CREATE TABLE public.farmer_client_scores (
  customer_user_id uuid NOT NULL,
  farmer_id uuid,
  priority_score numeric
);

-- helpers reais (pg_get_functiondef prod, 2026-07-17)
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $f$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $f$;

CREATE OR REPLACE FUNCTION public.get_commercial_role(_user_id uuid)
RETURNS public.commercial_role LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $f$ SELECT commercial_role FROM public.commercial_roles WHERE user_id = _user_id LIMIT 1 $f$;

CREATE OR REPLACE FUNCTION public.pode_ver_carteira_completa(_uid uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $f$
  SELECT has_role(_uid, 'master'::app_role)
    OR (has_role(_uid, 'employee'::app_role)
        AND get_commercial_role(_uid) IN ('gerencial'::commercial_role,'estrategico'::commercial_role,'super_admin'::commercial_role));
$f$;
SQL

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — APLICAR A MIGRATION REAL (Lei #1) — cria carteira_visivel_para + minha_carteira
# ══════════════════════════════════════════════════════════════════════════════
MIG="$REPO_ROOT/supabase/migrations/20260717181500_carteira_visivel_para_filtra_eligible.sql"
P -q -f "$MIG"
echo "migration aplicada: $(basename "$MIG")"

# RLS real de farmer_client_scores (fcs_select_carteira) — verbatim do pg_policies de prod.
# DEPOIS da migration: a policy referencia carteira_visivel_para, que a migration acabou de criar.
P -q <<'SQL'
ALTER TABLE public.farmer_client_scores ENABLE ROW LEVEL SECURITY;
CREATE POLICY fcs_select_carteira ON public.farmer_client_scores FOR SELECT
USING (
  ( SELECT public.pode_ver_carteira_completa(( SELECT auth.uid() AS uid)) AS pode_ver_carteira_completa)
  OR public.carteira_visivel_para(customer_user_id, ( SELECT auth.uid() AS uid))
);
SQL

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 3 — SEED + GRANTS
# ══════════════════════════════════════════════════════════════════════════════
# MASTER=333 (master) · OWNER=111 (employee/farmer, NÃO-gestor, como Regina) ·
# GESTOR=444 (employee/gerencial) · OTHER=222 (outro dono, coberto por OWNER)
# C_ELIG=aaa (dono OWNER, eligible) · C_MASK=bbb (dono OWNER, eligible=false) ·
# C_COVER_MASK=ccc (dono OTHER, eligible=false; OWNER cobre OTHER)
P -q <<'SQL'
INSERT INTO auth.users(id) VALUES
  ('11111111-1111-1111-1111-111111111111'),
  ('22222222-2222-2222-2222-222222222222'),
  ('33333333-3333-3333-3333-333333333333'),
  ('44444444-4444-4444-4444-444444444444'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'),
  ('cccccccc-cccc-cccc-cccc-cccccccccccc') ON CONFLICT DO NOTHING;

INSERT INTO public.user_roles(user_id, role) VALUES
  ('33333333-3333-3333-3333-333333333333','master'),
  ('11111111-1111-1111-1111-111111111111','employee'),
  ('44444444-4444-4444-4444-444444444444','employee'),
  ('22222222-2222-2222-2222-222222222222','employee');
INSERT INTO public.commercial_roles(user_id, commercial_role) VALUES
  ('11111111-1111-1111-1111-111111111111','farmer'),
  ('44444444-4444-4444-4444-444444444444','gerencial'),
  ('22222222-2222-2222-2222-222222222222','farmer');

INSERT INTO public.carteira_assignments(customer_user_id, owner_user_id, source, eligible) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','11111111-1111-1111-1111-111111111111','omie',          true),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','11111111-1111-1111-1111-111111111111','hunter_orphan', false),
  ('cccccccc-cccc-cccc-cccc-cccccccccccc','22222222-2222-2222-2222-222222222222','hunter_orphan', false);

INSERT INTO public.carteira_coverage(covered_user_id, covering_user_id, active, valid_until) VALUES
  ('22222222-2222-2222-2222-222222222222','11111111-1111-1111-1111-111111111111', true, NULL);

INSERT INTO public.farmer_client_scores(customer_user_id, farmer_id, priority_score) VALUES
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','11111111-1111-1111-1111-111111111111', 10),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','11111111-1111-1111-1111-111111111111', 20),
  ('cccccccc-cccc-cccc-cccc-cccccccccccc','22222222-2222-2222-2222-222222222222', 30);

GRANT SELECT ON public.farmer_client_scores TO authenticated, anon;
GRANT EXECUTE ON FUNCTION public.carteira_visivel_para(uuid,uuid),
                          public.pode_ver_carteira_completa(uuid),
                          public.minha_carteira() TO authenticated, anon;
SQL

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4 — ASSERTS
# ══════════════════════════════════════════════════════════════════════════════
M='33333333-3333-3333-3333-333333333333'   # master
O='11111111-1111-1111-1111-111111111111'   # owner não-gestor
G='44444444-4444-4444-4444-444444444444'   # gestor
CE='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'   # cliente eligible
CM='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'   # cliente mascarado (dono OWNER)
CC='cccccccc-cccc-cccc-cccc-cccccccccccc'   # cliente mascarado (dono OTHER, via cobertura)

echo "── gate direto (carteira_visivel_para) ──"
eq "A1 owner vê cliente ELIGIBLE (positivo)"          "$(Pq -c "SELECT public.carteira_visivel_para('$CE','$O');")" "t"
eq "A2 owner NÃO vê cliente MASCARADO (o fix)"        "$(Pq -c "SELECT public.carteira_visivel_para('$CM','$O');")" "f"
eq "A3 master VÊ mascarado (braço master intacto)"    "$(Pq -c "SELECT public.carteira_visivel_para('$CM','$M');")" "t"
eq "A4 _uid NULL → false (totalidade)"                "$(Pq -c "SELECT public.carteira_visivel_para('$CM',NULL);")" "f"
eq "A5 cobertura c/ mascarado → false (2º braço)"     "$(Pq -c "SELECT public.carteira_visivel_para('$CC','$O');")" "f"
eq "A6 gate NUNCA retorna NULL (mesmo uid NULL)"      "$(Pq -c "SELECT (public.carteira_visivel_para('$CE',NULL)) IS NOT NULL;")" "t"

echo "── fim-a-fim via RLS real (fcs_select_carteira) ──"
OWN=$(Pq -c "SET test.uid='$O'; SET ROLE authenticated; SELECT count(*) FROM public.farmer_client_scores;" | tail -1)
MAS=$(Pq -c "SET test.uid='$M'; SET ROLE authenticated; SELECT count(*) FROM public.farmer_client_scores;" | tail -1)
GES=$(Pq -c "SET test.uid='$G'; SET ROLE authenticated; SELECT count(*) FROM public.farmer_client_scores;" | tail -1)
ANO=$(Pq -c "SET ROLE anon; SELECT count(*) FROM public.farmer_client_scores;" | tail -1)
eq "A7 owner vê só 1 score (o eligible; masca + cobertura fecham)" "$OWN" "1"
eq "A8 master vê os 3 (pode_ver_carteira_completa)"               "$MAS" "3"
eq "A9 gestor vê os 3 (BYPASS gestor INTACTO — fix não mexe)"     "$GES" "3"
eq "A10 anon vê 0"                                                "$ANO" "0"

echo "── RPC minha_carteira ──"
MC_OWN=$(Pq -c "SET test.uid='$O'; SET ROLE authenticated; SELECT count(*) FROM public.minha_carteira();" | tail -1)
MC_HAS_MASK=$(Pq -c "SET test.uid='$O'; SET ROLE authenticated; SELECT EXISTS(SELECT 1 FROM public.minha_carteira() WHERE customer_user_id='$CM');" | tail -1)
eq "A11 minha_carteira do owner devolve só o eligible" "$MC_OWN" "1"
eq "A12 minha_carteira NÃO devolve o mascarado"        "$MC_HAS_MASK" "f"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICAÇÃO (sabota cada função → exige VERMELHO → restaura)
# ══════════════════════════════════════════════════════════════════════════════
echo "── falsificação ──"
# F1: gate SEM o filtro eligible no braço direto → A2 deve virar 't' e A7 deve virar 3
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.carteira_visivel_para(_customer_user_id uuid, _uid uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT _uid IS NOT NULL AND (
    COALESCE(public.has_role(_uid,'master'::app_role),false)
    OR EXISTS (SELECT 1 FROM public.carteira_assignments a
               WHERE a.customer_user_id=_customer_user_id AND a.owner_user_id=_uid)  -- SABOTADO: sem AND a.eligible
    OR EXISTS (SELECT 1 FROM public.carteira_assignments a
               JOIN public.carteira_coverage c ON c.covered_user_id=a.owner_user_id
               WHERE a.customer_user_id=_customer_user_id AND a.eligible IS TRUE
                 AND c.covering_user_id=_uid AND c.active AND (c.valid_until IS NULL OR c.valid_until>now())));
$$;
SQL
F_A2=$(Pq -c "SELECT public.carteira_visivel_para('$CM','$O');")
F_A7=$(Pq -c "SET test.uid='$O'; SET ROLE authenticated; SELECT count(*) FROM public.farmer_client_scores;" | tail -1)
if [ "$F_A2" = "t" ] && [ "$F_A7" != "1" ]; then ok "F1 gate furado reabre o mascarado (A2→t, A7→$F_A7) — A2/A7 têm dente"; else bad "F1 sabotei o gate e A2/A7 NÃO mudaram (A2=$F_A2 A7=$F_A7) → asserts fracos"; fi
P -q -f "$MIG"   # restaura o gate real

# F2: minha_carteira SEM o filtro eligible no braço direto → A12 deve reencontrar o mascarado
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.minha_carteira()
RETURNS TABLE(customer_user_id uuid, owner_user_id uuid, coberto_de uuid)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT a.customer_user_id, a.owner_user_id, NULL::uuid FROM public.carteira_assignments a
    WHERE a.owner_user_id=auth.uid()  -- SABOTADO: sem AND a.eligible
  UNION
  SELECT a.customer_user_id, a.owner_user_id, a.owner_user_id FROM public.carteira_assignments a
    JOIN public.carteira_coverage c ON c.covered_user_id=a.owner_user_id
    WHERE c.covering_user_id=auth.uid() AND c.active AND (c.valid_until IS NULL OR c.valid_until>now()) AND a.eligible IS TRUE;
$$;
GRANT EXECUTE ON FUNCTION public.minha_carteira() TO authenticated, anon;
SQL
F_A12=$(Pq -c "SET test.uid='$O'; SET ROLE authenticated; SELECT EXISTS(SELECT 1 FROM public.minha_carteira() WHERE customer_user_id='$CM');" | tail -1)
if [ "$F_A12" = "t" ]; then ok "F2 minha_carteira furada reencontra o mascarado (A12→t) — A12 tem dente"; else bad "F2 sabotei minha_carteira e A12 NÃO mudou (=$F_A12) → assert fraco"; fi
P -q -f "$MIG"   # restaura

# ── veredito ──
echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
