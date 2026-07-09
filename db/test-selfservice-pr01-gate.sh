#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  HARNESS PG17 — PROVA: PR0.1 allowlist + gate selfservice_conta_atual()       ║
# ║  Migração: supabase/migrations/20260708202033_selfservice_pr01_allowlist_gate.sql
# ║  Rode:  bash db/test-selfservice-pr01-gate.sh > /tmp/t-pr01.log 2>&1; echo "exit=$?"
# ║                                                                                ║
# ║  Invariantes: gate fail-closed (flag∧approved∧NÃO-staff∧enabled); staff NUNCA  ║
# ║  entra — barrado por has_role (canônico) E is_employee (reforço); cliente sem   ║
# ║  IUD nem SELECT direto; anti-forje CONGELA enabled_by em UPDATE de linha já-on.║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5460}"
SLUG="pr01-gate"
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
-- Em PROD o Supabase concede acesso ao schema auth a authenticated/anon (auth.uid() é chamado
-- direto em triggers não-SECDEF como o anti-forje). O stub não concede → replico p/ fidelidade.
GRANT USAGE ON SCHEMA auth TO authenticated, anon, service_role;
GRANT EXECUTE ON FUNCTION auth.uid(), auth.role() TO authenticated, anon, service_role;
SQL

PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad() { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
eq()  { if [ "$2" = "$3" ]; then ok "$1 (=$2)"; else bad "$1 — esperado [$3], veio [$2]"; fi; }

echo "═══ setup pronto (PG17 :$PORT) ═══"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — PRÉ-REQUISITOS (pode_ver_carteira = corpo REAL de prod)
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
CREATE TYPE public.app_role AS ENUM ('master','employee','customer');
CREATE TABLE public.user_roles (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL, role public.app_role NOT NULL);
CREATE OR REPLACE FUNCTION public.has_role(_user_id uuid, _role app_role)
  RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $f$ SELECT EXISTS (SELECT 1 FROM public.user_roles WHERE user_id=_user_id AND role=_role) $f$;

CREATE TYPE public.commercial_role AS ENUM ('vendedor','gerencial','estrategico','super_admin');
CREATE TABLE public.commercial_roles_stub (user_id uuid PRIMARY KEY, role public.commercial_role);
CREATE OR REPLACE FUNCTION public.get_commercial_role(_uid uuid)
  RETURNS commercial_role LANGUAGE sql STABLE AS $f$ SELECT role FROM public.commercial_roles_stub WHERE user_id=_uid $f$;
CREATE OR REPLACE FUNCTION public.pode_ver_carteira_completa(_uid uuid)
  RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $f$ SELECT has_role(_uid,'master'::app_role)
       OR (has_role(_uid,'employee'::app_role)
           AND get_commercial_role(_uid) IN ('gerencial'::commercial_role,'estrategico'::commercial_role,'super_admin'::commercial_role)) $f$;

CREATE TABLE public.profiles (user_id uuid PRIMARY KEY, is_employee boolean, is_approved boolean);
CREATE TABLE public.company_config (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), key text UNIQUE NOT NULL, value text,
  created_at timestamptz DEFAULT now(), updated_at timestamptz DEFAULT now());
SQL

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — APLICAR A MIGRATION REAL (Lei #1)
# ══════════════════════════════════════════════════════════════════════════════
MIG="$REPO_ROOT/supabase/migrations/20260708202033_selfservice_pr01_allowlist_gate.sql"
P -q -f "$MIG"
echo "migration aplicada: $(basename "$MIG")"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 3 — SEED (como postgres). Dois "staff" distintos p/ dar dente às 2 barreiras:
#   aaaa = role employee MAS is_employee=false  (só has_role barra — Codex #1)
#   bbbb = is_employee=true MAS sem role         (só is_employee barra)
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
INSERT INTO auth.users(id) VALUES
  ('11111111-1111-1111-1111-111111111111'),  -- cliente_ok
  ('22222222-2222-2222-2222-222222222222'),  -- cliente_naoaprovado
  ('33333333-3333-3333-3333-333333333333'),  -- cliente_STAFF (is_employee=true + role)
  ('44444444-4444-4444-4444-444444444444'),  -- cliente_semlinha
  ('55555555-5555-5555-5555-555555555555'),  -- cliente_disabled
  ('66666666-6666-6666-6666-666666666666'),  -- gestor (employee + gerencial)
  ('77777777-7777-7777-7777-777777777777'),  -- outro_cliente
  ('88888888-8888-8888-8888-888888888888'),  -- cliente_forje
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),  -- staff_role_only (role employee, is_employee=false)
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'),  -- is_employee_only (is_employee=true, sem role)
  ('99999999-9999-9999-9999-999999999999')   -- uuid "forjado" — existe em users p/ o F4 testar forja de uuid VÁLIDO (a FK enabled_by já barra uuid inexistente)
  ON CONFLICT DO NOTHING;
INSERT INTO public.profiles(user_id, is_employee, is_approved) VALUES
  ('11111111-1111-1111-1111-111111111111', false, true),
  ('22222222-2222-2222-2222-222222222222', false, false),
  ('33333333-3333-3333-3333-333333333333', true,  true),
  ('44444444-4444-4444-4444-444444444444', false, true),
  ('55555555-5555-5555-5555-555555555555', false, true),
  ('66666666-6666-6666-6666-666666666666', true,  true),
  ('77777777-7777-7777-7777-777777777777', false, true),
  ('88888888-8888-8888-8888-888888888888', false, true),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', false, true),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', true,  true);
INSERT INTO public.user_roles(user_id, role) VALUES
  ('33333333-3333-3333-3333-333333333333','employee'),
  ('66666666-6666-6666-6666-666666666666','employee'),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','employee');
INSERT INTO public.commercial_roles_stub(user_id, role) VALUES
  ('66666666-6666-6666-6666-666666666666','gerencial');
INSERT INTO public.selfservice_cliente_allowlist(customer_user_id, account, enabled) VALUES
  ('11111111-1111-1111-1111-111111111111','oben',    true),
  ('22222222-2222-2222-2222-222222222222','oben',    true),
  ('33333333-3333-3333-3333-333333333333','oben',    true),
  ('55555555-5555-5555-5555-555555555555','oben',    false),
  ('77777777-7777-7777-7777-777777777777','colacor', true),
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','oben',    true),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','oben',    true);
UPDATE public.company_config SET value='true' WHERE key='selfservice_produto_enabled';
SQL

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4 — ASSERTS
# ══════════════════════════════════════════════════════════════════════════════
echo "── asserts ──"
GUC_OK="SET test.uid='11111111-1111-1111-1111-111111111111'; SET ROLE authenticated;"

H=$(Pq -c "$GUC_OK SELECT habilitado FROM public.selfservice_conta_atual();" | tail -1)
eq "A1 cliente ok (flag∧approved∧naostaff∧enabled) → habilitado" "$H" "t"
ACC=$(Pq -c "$GUC_OK SELECT array_to_string(accounts,',') FROM public.selfservice_conta_atual();" | tail -1)
eq "A1b accounts do cliente ok" "$ACC" "oben"

Pq -c "UPDATE public.company_config SET value='false' WHERE key='selfservice_produto_enabled';" >/dev/null
HF=$(Pq -c "$GUC_OK SELECT habilitado FROM public.selfservice_conta_atual();" | tail -1)
eq "A2 flag global OFF → habilitado=false" "$HF" "f"
Pq -c "UPDATE public.company_config SET value='true' WHERE key='selfservice_produto_enabled';" >/dev/null

HA=$(Pq -c "SET test.uid='22222222-2222-2222-2222-222222222222'; SET ROLE authenticated; SELECT habilitado FROM public.selfservice_conta_atual();" | tail -1)
eq "A3 cliente NÃO aprovado → habilitado=false" "$HA" "f"

HS=$(Pq -c "SET test.uid='33333333-3333-3333-3333-333333333333'; SET ROLE authenticated; SELECT habilitado FROM public.selfservice_conta_atual();" | tail -1)
eq "A4 STAFF (is_employee=true + role) allowlisted → habilitado=false (P0#2)" "$HS" "f"

H4=$(Pq -c "SET test.uid='44444444-4444-4444-4444-444444444444'; SET ROLE authenticated; SELECT habilitado FROM public.selfservice_conta_atual();" | tail -1)
eq "A5 cliente SEM linha → habilitado=false" "$H4" "f"
ACC4=$(Pq -c "SET test.uid='44444444-4444-4444-4444-444444444444'; SET ROLE authenticated; SELECT coalesce(array_length(accounts,1),0) FROM public.selfservice_conta_atual();" | tail -1)
eq "A5b accounts vazio p/ cliente sem linha" "$ACC4" "0"

H5=$(Pq -c "SET test.uid='55555555-5555-5555-5555-555555555555'; SET ROLE authenticated; SELECT habilitado FROM public.selfservice_conta_atual();" | tail -1)
eq "A6 cliente com linha enabled=FALSE → habilitado=false" "$H5" "f"

# A7 — cliente NÃO lê a allowlist crua (sem customer_select; usa só o gate) — Codex #2
OWN=$(Pq -c "$GUC_OK SELECT count(*) FROM public.selfservice_cliente_allowlist;" | tail -1)
eq "A7 cliente NÃO lê a tabela crua (0 linhas — só o gate)" "$OWN" "0"

# A8 — cliente NÃO consegue INSERT (RLS 42501)
R=$(P -tA 2>&1 <<'SQL'
SET test.uid='11111111-1111-1111-1111-111111111111'; SET ROLE authenticated;
DO $$ BEGIN
  INSERT INTO public.selfservice_cliente_allowlist(customer_user_id, account, enabled)
    VALUES ('11111111-1111-1111-1111-111111111111','colacor', true);
  RAISE EXCEPTION 'CLIENTE_INSERIU_NAO_DEVIA';
EXCEPTION WHEN insufficient_privilege THEN RAISE NOTICE 'IUD_NEGADO';
  WHEN OTHERS THEN RAISE; END $$;
SQL
)
case "$R" in *IUD_NEGADO*) ok "A8 cliente NÃO consegue INSERT na allowlist (RLS 42501)" ;; *) bad "A8 — veio: $R" ;; esac

AE=$(Pq -c "SELECT has_function_privilege('anon','public.selfservice_conta_atual()','EXECUTE');")
eq "A9 anon NÃO executa o gate" "$AE" "f"
UE=$(Pq -c "SELECT has_function_privilege('authenticated','public.selfservice_conta_atual()','EXECUTE');")
eq "A9b authenticated executa o gate" "$UE" "t"

# A10 — anti-forje no INSERT: gestor liga c1 com enabled_by forjado → trigger força = gestor
Pq -c "SET test.uid='66666666-6666-6666-6666-666666666666'; SET ROLE authenticated; INSERT INTO public.selfservice_cliente_allowlist(customer_user_id, account, enabled, enabled_by) VALUES ('88888888-8888-8888-8888-888888888888','oben', true, '99999999-9999-9999-9999-999999999999');" >/dev/null
FORJ=$(Pq -c "SELECT enabled_by FROM public.selfservice_cliente_allowlist WHERE customer_user_id='88888888-8888-8888-8888-888888888888' AND account='oben';" | tail -1)
eq "A10 anti-forje no INSERT força enabled_by = autor real (gestor)" "$FORJ" "66666666-6666-6666-6666-666666666666"

# A11 — linha nova sem enabled nasce DESLIGADA
Pq -c "INSERT INTO public.selfservice_cliente_allowlist(customer_user_id, account) VALUES ('44444444-4444-4444-4444-444444444444','colacor_sc');" >/dev/null
NEWDEF=$(Pq -c "SELECT enabled FROM public.selfservice_cliente_allowlist WHERE customer_user_id='44444444-4444-4444-4444-444444444444' AND account='colacor_sc';" | tail -1)
eq "A11 linha nova sem enabled nasce DESLIGADA (default false)" "$NEWDEF" "f"

# A12 — staff por HAS_ROLE (role employee, is_employee=false) → barrado (Codex #1)
H12=$(Pq -c "SET test.uid='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'; SET ROLE authenticated; SELECT habilitado FROM public.selfservice_conta_atual();" | tail -1)
eq "A12 role employee com is_employee=false → habilitado=false (barrado por has_role)" "$H12" "f"
# A12b — staff por IS_EMPLOYEE (is_employee=true, sem role) → barrado
H12B=$(Pq -c "SET test.uid='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'; SET ROLE authenticated; SELECT habilitado FROM public.selfservice_conta_atual();" | tail -1)
eq "A12b is_employee=true sem role → habilitado=false (barrado por is_employee)" "$H12B" "f"

# A13 — UPDATE de linha JÁ-enabled NÃO reescreve enabled_by (congela — Codex #4). c1 está enabled_by=gestor (A10).
Pq -c "SET test.uid='66666666-6666-6666-6666-666666666666'; SET ROLE authenticated; UPDATE public.selfservice_cliente_allowlist SET enabled_by='99999999-9999-9999-9999-999999999999', notes='forja' WHERE customer_user_id='88888888-8888-8888-8888-888888888888' AND account='oben';" >/dev/null
FROZEN=$(Pq -c "SELECT enabled_by FROM public.selfservice_cliente_allowlist WHERE customer_user_id='88888888-8888-8888-8888-888888888888' AND account='oben';" | tail -1)
eq "A13 UPDATE de linha já-on CONGELA enabled_by (não vira o forjado)" "$FROZEN" "66666666-6666-6666-6666-666666666666"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICAÇÃO (4 sabotagens → cada assert-alvo VERMELHO → restaura)
# ══════════════════════════════════════════════════════════════════════════════
echo "── falsificação ──"

# F1 — enabled DEFAULT true → linha sem enabled nasce LIGADA (dente de A11)
P -q -c "ALTER TABLE public.selfservice_cliente_allowlist ALTER COLUMN enabled SET DEFAULT true;"
P -q -c "INSERT INTO public.selfservice_cliente_allowlist(customer_user_id, account) VALUES ('77777777-7777-7777-7777-777777777777','oben');"
S1=$(Pq -c "SELECT enabled FROM public.selfservice_cliente_allowlist WHERE customer_user_id='77777777-7777-7777-7777-777777777777' AND account='oben';" | tail -1)
if [ "$S1" = "t" ]; then ok "F1 DEFAULT true → linha nasce LIGADA → A11 tem dente"; else bad "F1 sem efeito → A11 fraco"; fi
P -q -c "ALTER TABLE public.selfservice_cliente_allowlist ALTER COLUMN enabled SET DEFAULT false; DELETE FROM public.selfservice_cliente_allowlist WHERE customer_user_id='77777777-7777-7777-7777-777777777777' AND account='oben';"

# F2 — remover o is_employee IS FALSE → bbbb (is_employee=true, sem role) entra (dente de A12b)
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.selfservice_conta_atual()
RETURNS TABLE(customer_user_id uuid, accounts text[], habilitado boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT (SELECT auth.uid()),
    COALESCE((SELECT array_agg(DISTINCT a.account) FROM public.selfservice_cliente_allowlist a WHERE a.customer_user_id=(SELECT auth.uid()) AND a.enabled IS TRUE), '{}'::text[]),
    ( COALESCE((SELECT (value)::boolean FROM public.company_config WHERE key='selfservice_produto_enabled'), false)
      AND COALESCE((SELECT p.is_approved FROM public.profiles p WHERE p.user_id=(SELECT auth.uid())), false)
      -- SABOTADO: sem o is_employee IS FALSE
      AND NOT (has_role((SELECT auth.uid()),'employee'::app_role) OR has_role((SELECT auth.uid()),'master'::app_role))
      AND EXISTS (SELECT 1 FROM public.selfservice_cliente_allowlist a WHERE a.customer_user_id=(SELECT auth.uid()) AND a.enabled IS TRUE) );
$$;
SQL
S2=$(Pq -c "SET test.uid='bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'; SET ROLE authenticated; SELECT habilitado FROM public.selfservice_conta_atual();" | tail -1)
if [ "$S2" = "t" ]; then ok "F2 sem is_employee: is_employee-only entra (habilitado=true) → A12b tem dente"; else bad "F2 sem efeito → A12b fraco"; fi
P -q -f "$MIG"

# F3 — remover o NOT has_role → aaaa (role employee, is_employee=false) entra (dente de A12)
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.selfservice_conta_atual()
RETURNS TABLE(customer_user_id uuid, accounts text[], habilitado boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT (SELECT auth.uid()),
    COALESCE((SELECT array_agg(DISTINCT a.account) FROM public.selfservice_cliente_allowlist a WHERE a.customer_user_id=(SELECT auth.uid()) AND a.enabled IS TRUE), '{}'::text[]),
    ( COALESCE((SELECT (value)::boolean FROM public.company_config WHERE key='selfservice_produto_enabled'), false)
      AND COALESCE((SELECT p.is_approved FROM public.profiles p WHERE p.user_id=(SELECT auth.uid())), false)
      AND COALESCE((SELECT p.is_employee IS FALSE FROM public.profiles p WHERE p.user_id=(SELECT auth.uid())), false)
      -- SABOTADO: sem o NOT has_role
      AND EXISTS (SELECT 1 FROM public.selfservice_cliente_allowlist a WHERE a.customer_user_id=(SELECT auth.uid()) AND a.enabled IS TRUE) );
$$;
SQL
S3=$(Pq -c "SET test.uid='aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'; SET ROLE authenticated; SELECT habilitado FROM public.selfservice_conta_atual();" | tail -1)
if [ "$S3" = "t" ]; then ok "F3 sem has_role: role-employee-só entra (habilitado=true) → A12 tem dente"; else bad "F3 sem efeito → A12 fraco"; fi
P -q -f "$MIG"

# F4 — remover o congela (ELSIF) → UPDATE de linha já-on reescreve enabled_by (dente de A13)
P -q <<'SQL'
CREATE OR REPLACE FUNCTION public.ss_allowlist_forca_autor()
RETURNS trigger LANGUAGE plpgsql SET search_path=public AS $$
BEGIN
  NEW.updated_at := now();
  IF NEW.enabled IS TRUE AND (TG_OP='INSERT' OR OLD.enabled IS DISTINCT FROM true) THEN
    IF auth.uid() IS NOT NULL THEN NEW.enabled_by := auth.uid(); END IF;
    NEW.enabled_at := now();
  END IF;  -- SABOTADO: sem o ELSIF que congela
  RETURN NEW;
END; $$;
SQL
Pq -c "SET test.uid='66666666-6666-6666-6666-666666666666'; SET ROLE authenticated; UPDATE public.selfservice_cliente_allowlist SET enabled_by='99999999-9999-9999-9999-999999999999', notes='forja2' WHERE customer_user_id='88888888-8888-8888-8888-888888888888' AND account='oben';" >/dev/null
S4=$(Pq -c "SELECT enabled_by FROM public.selfservice_cliente_allowlist WHERE customer_user_id='88888888-8888-8888-8888-888888888888' AND account='oben';" | tail -1)
if [ "$S4" = "99999999-9999-9999-9999-999999999999" ]; then ok "F4 sem o congela o UPDATE forja enabled_by → A13 tem dente"; else bad "F4 sem efeito → A13 fraco"; fi
P -q -f "$MIG"

echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
