#!/usr/bin/env bash
# PROVA PG17 — triggers prevent_self_approval (bloqueio de auto-aprovação de customer via UPDATE e INSERT).
# bash db/test-profiles-prevent-self-approval.sh > /tmp/t.log 2>&1; echo "exit=$?"
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5461}"
SLUG="prevent-self-approval"
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

echo "═══ setup PG17 :$PORT ═══"

# ── ZONA 1 — pré-requisitos fiéis (app_role, has_role, user_roles, commercial_roles, profiles+RLS) ──
P -q <<'SQL'
CREATE TYPE public.app_role AS ENUM ('master','employee','customer');

CREATE TABLE public.user_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  role public.app_role NOT NULL
);
CREATE TABLE public.commercial_roles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL,
  commercial_role text NOT NULL
);
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $f$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id = _user_id AND role = _role) $f$;

CREATE TABLE public.profiles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL UNIQUE,
  name text,
  document text,
  is_employee boolean NOT NULL DEFAULT false,
  is_approved boolean NOT NULL DEFAULT false
);
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
-- Policies REAIS (UPDATE, INSERT e SELECT como em prod — nenhuma protege is_approved)
CREATE POLICY "Users can update own profile" ON public.profiles FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK ((auth.uid() = user_id) AND (is_employee = false));
CREATE POLICY "Users can insert own profile" ON public.profiles FOR INSERT
  WITH CHECK ((auth.uid() = user_id) AND (is_employee = false));
CREATE POLICY "Admins can update any profile" ON public.profiles FOR UPDATE
  USING (public.has_role(auth.uid(), 'master'::public.app_role))
  WITH CHECK (public.has_role(auth.uid(), 'master'::public.app_role));
CREATE POLICY "read own or staff" ON public.profiles FOR SELECT
  USING (auth.uid() = user_id OR public.has_role(auth.uid(), 'master'::public.app_role));
GRANT SELECT, INSERT, UPDATE ON public.profiles TO authenticated;
SQL

# ── ZONA 2 — aplicar a migration REAL ──
MIG="$REPO_ROOT/supabase/migrations/20260704120000_profiles_prevent_self_approval.sql"
P -q -f "$MIG"
echo "migration aplicada: $(basename "$MIG")"

# ── ZONA 3 — seed (como postgres/superuser: ignora RLS, tem privilégio) ──
P -q <<'SQL'
INSERT INTO auth.users(id) VALUES
 ('11111111-1111-1111-1111-111111111111'),  -- customer puro (tem profile)
 ('22222222-2222-2222-2222-222222222222'),  -- employee (role)
 ('33333333-3333-3333-3333-333333333333'),  -- master
 ('44444444-4444-4444-4444-444444444444'),  -- comercial (commercial_role)
 ('55555555-5555-5555-5555-555555555555'),  -- customerB (alvo do admin)
 ('66666666-6666-6666-6666-666666666666')   -- customerC (SEM profile — testa INSERT)
 ON CONFLICT DO NOTHING;
INSERT INTO public.user_roles(user_id, role) VALUES
 ('22222222-2222-2222-2222-222222222222','employee'),
 ('33333333-3333-3333-3333-333333333333','master');
INSERT INTO public.commercial_roles(user_id, commercial_role) VALUES
 ('44444444-4444-4444-4444-444444444444','vendedor');
INSERT INTO public.profiles(user_id, name, is_employee, is_approved) VALUES
 ('11111111-1111-1111-1111-111111111111','Customer',  false, false),
 ('22222222-2222-2222-2222-222222222222','Employee',  false, false),
 ('44444444-4444-4444-4444-444444444444','Comercial', false, false),
 ('55555555-5555-5555-5555-555555555555','CustomerB', false, false);
SQL

echo "── asserts UPDATE ──"
upd_as() { P -q -c "SELECT set_config('test.uid','$1',false); SET ROLE authenticated; UPDATE public.profiles SET $2 WHERE user_id='$3'; RESET ROLE;" >/dev/null 2>&1 || true; }
ins_as() { P -q -c "SELECT set_config('test.uid','$1',false); SET ROLE authenticated; INSERT INTO public.profiles($2) VALUES ($3); RESET ROLE;" >/dev/null 2>&1 || true; }
read_appr() { Pq -c "SELECT is_approved FROM public.profiles WHERE user_id='$1';"; }

# N1 (segurança/UPDATE): customer se auto-aprova → continua FALSE
upd_as '11111111-1111-1111-1111-111111111111' "is_approved=true" '11111111-1111-1111-1111-111111111111'
eq "N1 customer NÃO se auto-aprova (UPDATE)" "$(read_appr 11111111-1111-1111-1111-111111111111)" "f"

# A1: employee se auto-aprova → TRUE
upd_as '22222222-2222-2222-2222-222222222222' "is_approved=true" '22222222-2222-2222-2222-222222222222'
eq "A1 employee se auto-aprova" "$(read_appr 22222222-2222-2222-2222-222222222222)" "t"

# A3: comercial se auto-aprova → TRUE
upd_as '44444444-4444-4444-4444-444444444444' "is_approved=true" '44444444-4444-4444-4444-444444444444'
eq "A3 comercial se auto-aprova" "$(read_appr 44444444-4444-4444-4444-444444444444)" "t"

# A2: master aprova customerB → TRUE
upd_as '33333333-3333-3333-3333-333333333333' "is_approved=true" '55555555-5555-5555-5555-555555555555'
eq "A2 master aprova outro" "$(read_appr 55555555-5555-5555-5555-555555555555)" "t"

# A4: customer atualiza o próprio NOME (não is_approved) → sucede
upd_as '11111111-1111-1111-1111-111111111111' "name='Renomeado'" '11111111-1111-1111-1111-111111111111'
eq "A4 customer atualiza nome" "$(Pq -c "SELECT name FROM public.profiles WHERE user_id='11111111-1111-1111-1111-111111111111';")" "Renomeado"

# A5: backend (auth.uid NULL) seta is_approved → TRUE (não revertido)
P -q -c "UPDATE public.profiles SET is_approved=true WHERE user_id='11111111-1111-1111-1111-111111111111';" >/dev/null
eq "A5 backend seta is_approved" "$(read_appr 11111111-1111-1111-1111-111111111111)" "t"

echo "── asserts INSERT (achado do Codex) ──"
# N2 (segurança/INSERT): customerC se cadastra já com is_approved=true → nasce FALSE
ins_as '66666666-6666-6666-6666-666666666666' "user_id, name, is_employee, is_approved" "'66666666-6666-6666-6666-666666666666','CustomerC', false, true"
eq "N2 customer NÃO nasce aprovado (INSERT)" "$(read_appr 66666666-6666-6666-6666-666666666666)" "f"

# A6: employee (com papel) inserindo profile com is_approved=true → permanece TRUE (não quebra staff)
P -q -c "DELETE FROM public.profiles WHERE user_id='22222222-2222-2222-2222-222222222222';" >/dev/null
ins_as '22222222-2222-2222-2222-222222222222' "user_id, name, is_employee, is_approved" "'22222222-2222-2222-2222-222222222222','Employee', false, true"
eq "A6 employee INSERT mantém aprovado" "$(read_appr 22222222-2222-2222-2222-222222222222)" "t"

# ── ZONA 5 — FALSIFICAÇÃO: sem os triggers, os bypasses FUNCIONAM (provam o dente) ──
echo "── falsificação ──"
# UPDATE
P -q -c "UPDATE public.profiles SET is_approved=false WHERE user_id='11111111-1111-1111-1111-111111111111';" >/dev/null
P -q -c "DROP TRIGGER trg_prevent_self_approval_upd ON public.profiles;" >/dev/null
upd_as '11111111-1111-1111-1111-111111111111' "is_approved=true" '11111111-1111-1111-1111-111111111111'
eq "F1 sem trigger UPDATE o bypass funciona" "$(read_appr 11111111-1111-1111-1111-111111111111)" "t"
# INSERT
P -q -c "DROP TRIGGER trg_prevent_self_approval_ins ON public.profiles; DELETE FROM public.profiles WHERE user_id='66666666-6666-6666-6666-666666666666';" >/dev/null
ins_as '66666666-6666-6666-6666-666666666666' "user_id, name, is_employee, is_approved" "'66666666-6666-6666-6666-666666666666','CustomerC', false, true"
eq "F2 sem trigger INSERT o bypass funciona" "$(read_appr 66666666-6666-6666-6666-666666666666)" "t"
# restaura a versão verdadeira e reprova os dois caminhos
P -q -f "$MIG" >/dev/null
P -q -c "UPDATE public.profiles SET is_approved=false WHERE user_id='11111111-1111-1111-1111-111111111111'; DELETE FROM public.profiles WHERE user_id='66666666-6666-6666-6666-666666666666';" >/dev/null
upd_as '11111111-1111-1111-1111-111111111111' "is_approved=true" '11111111-1111-1111-1111-111111111111'
eq "F3 trigger UPDATE restaurado barra" "$(read_appr 11111111-1111-1111-1111-111111111111)" "f"
ins_as '66666666-6666-6666-6666-666666666666' "user_id, name, is_employee, is_approved" "'66666666-6666-6666-6666-666666666666','CustomerC', false, true"
eq "F4 trigger INSERT restaurado barra" "$(read_appr 66666666-6666-6666-6666-666666666666)" "f"

echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
