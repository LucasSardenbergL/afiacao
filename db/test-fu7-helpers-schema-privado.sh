#!/usr/bin/env bash
# ╔══════════════════════════════════════════════════════════════════════════════╗
# ║  HARNESS PG17 — FU7: fechar oráculos de RLS (Fatia 0 REVOKE + Fatia 1 SCHEMA) ║
# ║      bash db/test-fu7-helpers-schema-privado.sh > /tmp/t.log 2>&1; echo $?     ║
# ║                                                                                ║
# ║  Aplica a migration REAL 20260718150000_fu7_helpers_rls_schema_privado.sql     ║
# ║  sobre a topologia medida em prod (psql-ro 2026-07-18):                        ║
# ║    · 4 helpers SECDEF search_path=public com EXECUTE p/ authenticated          ║
# ║    · policy que chama carteira_visivel_para SEM qualificar                     ║
# ║    · view security_invoker que chama SEM qualificar (v_cliente_interacoes)     ║
# ║    · caller late-bound (corpo em string) que chama SEM qualificar              ║
# ║    · pode_ver_carteira_completa (SECDEF) chamando get_commercial_role          ║
# ║                                                                                ║
# ║  O mecanismo por trás das 2 técnicas está provado em                          ║
# ║  db/test-secdef-searchpath-oraculo.sh (policy exige EXECUTE; move preserva OID)║
# ╚══════════════════════════════════════════════════════════════════════════════╝
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGVER=17
PGBIN="/opt/homebrew/opt/postgresql@${PGVER}/bin"
PORT="${PGPORT_TEST:-5472}"
SLUG="fu7"
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

MASTER="11111111-1111-1111-1111-111111111111"
OWNER="33333333-3333-3333-3333-333333333333"
CUSTOMER="22222222-2222-2222-2222-222222222222"

echo "═══ setup pronto (PG17 :$PORT) ═══"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 1 — TOPOLOGIA FIEL À PROD (default privilege do Supabase é obrigatório:
#   sem ele a função nasce sem EXECUTE p/ authenticated → REVOKE dá falso-verde)
# ══════════════════════════════════════════════════════════════════════════════
P -q <<'SQL'
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;

CREATE TYPE public.app_role AS ENUM ('customer','employee','master');
CREATE TYPE public.commercial_role AS ENUM ('gestor','vendedor');

CREATE TABLE public.user_roles (user_id uuid NOT NULL, role public.app_role NOT NULL);
CREATE TABLE public.commercial_roles (user_id uuid NOT NULL, commercial_role public.commercial_role NOT NULL);
CREATE TABLE public.carteira_assignments (
  customer_user_id uuid NOT NULL UNIQUE, owner_user_id uuid NOT NULL, eligible boolean NOT NULL DEFAULT true);
CREATE TABLE public.carteira_coverage (
  covering_user_id uuid, covered_user_id uuid, active boolean DEFAULT true, valid_until timestamptz);

CREATE FUNCTION public.has_role(_user_id uuid, _role public.app_role)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $f$ SELECT EXISTS (SELECT 1 FROM user_roles WHERE user_id = _user_id AND role = _role) $f$;

-- os 2 oráculos SEM policy (Fatia 0) — corpos idênticos aos de prod
CREATE FUNCTION public.get_user_role(_user_id uuid)
RETURNS public.app_role LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $f$ SELECT role FROM public.user_roles WHERE user_id = _user_id LIMIT 1 $f$;

CREATE FUNCTION public.get_commercial_role(_user_id uuid)
RETURNS public.commercial_role LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $f$ SELECT commercial_role FROM public.commercial_roles WHERE user_id = _user_id LIMIT 1 $f$;

-- caller SECDEF de get_commercial_role: roda como postgres, NÃO depende do grant de authenticated
CREATE FUNCTION public.pode_ver_carteira_completa(_uid uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $f$ SELECT COALESCE(has_role(_uid,'master'::public.app_role),false)
         OR get_commercial_role(_uid) = 'gestor'::public.commercial_role $f$;

-- os 2 helpers COM policy (Fatia 1) — carteira_visivel_para com o corpo pós-#1398
CREATE FUNCTION public.carteira_visivel_para(_customer_user_id uuid, _uid uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $f$
  SELECT _uid IS NOT NULL AND (
    COALESCE(public.has_role(_uid,'master'::public.app_role), false)
    OR EXISTS (SELECT 1 FROM public.carteira_assignments a
               WHERE a.customer_user_id = _customer_user_id AND a.owner_user_id = _uid
                 AND a.eligible IS TRUE));
$f$;

CREATE FUNCTION public.is_super_admin(_user_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $f$ SELECT EXISTS (SELECT 1 FROM user_roles WHERE user_id=_user_id AND role='master'::public.app_role) $f$;

-- tabela gateada por policy que chama o helper SEM qualificar (como as 8 de prod)
CREATE TABLE public.farmer_client_scores (customer_user_id uuid, score int);
ALTER TABLE public.farmer_client_scores ENABLE ROW LEVEL SECURITY;
CREATE POLICY fcs_select_carteira ON public.farmer_client_scores FOR SELECT
  USING (pode_ver_carteira_completa(auth.uid()) OR carteira_visivel_para(customer_user_id, auth.uid()));

-- tabela gateada por is_super_admin (as 2 policies de prod)
CREATE TABLE public.margin_audit_log (id int, margem numeric);
ALTER TABLE public.margin_audit_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY mal_select ON public.margin_audit_log FOR SELECT USING (is_super_admin(auth.uid()));

-- VIEW security_invoker chamando o helper SEM qualificar (v_cliente_interacoes de prod)
CREATE TABLE public.farmer_calls (customer_user_id uuid, nota text);
ALTER TABLE public.farmer_calls ENABLE ROW LEVEL SECURITY;
CREATE POLICY fc_all ON public.farmer_calls FOR SELECT USING (true);
CREATE VIEW public.v_cliente_interacoes WITH (security_invoker=true) AS
  SELECT fc.customer_user_id, fc.nota FROM public.farmer_calls fc
  WHERE fc.customer_user_id IS NOT NULL
    AND (pode_ver_carteira_completa(auth.uid()) OR carteira_visivel_para(fc.customer_user_id, auth.uid()));

-- caller LATE-BOUND (corpo em string + search_path=public) — o que a migration precisa religar
CREATE FUNCTION public.melhoria_clientes_por_produto(p_termo text)
RETURNS int LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $f$ BEGIN
  RETURN (SELECT count(*) FROM public.carteira_assignments a
          WHERE carteira_visivel_para(a.customer_user_id, auth.uid()) AND p_termo IS NOT NULL);
END $f$;

INSERT INTO auth.users(id) VALUES
  ('11111111-1111-1111-1111-111111111111'),
  ('22222222-2222-2222-2222-222222222222'),
  ('33333333-3333-3333-3333-333333333333') ON CONFLICT DO NOTHING;
INSERT INTO public.user_roles VALUES
  ('11111111-1111-1111-1111-111111111111','master'),
  ('22222222-2222-2222-2222-222222222222','customer'),
  ('33333333-3333-3333-3333-333333333333','employee');
INSERT INTO public.commercial_roles VALUES ('33333333-3333-3333-3333-333333333333','vendedor');
INSERT INTO public.carteira_assignments VALUES
  ('22222222-2222-2222-2222-222222222222','33333333-3333-3333-3333-333333333333', true);
INSERT INTO public.farmer_client_scores VALUES ('22222222-2222-2222-2222-222222222222', 42);
INSERT INTO public.farmer_calls VALUES ('22222222-2222-2222-2222-222222222222','ligacao');
INSERT INTO public.margin_audit_log VALUES (1, 0.30);
GRANT SELECT ON public.farmer_client_scores, public.margin_audit_log, public.farmer_calls,
  public.v_cliente_interacoes, public.user_roles, public.carteira_assignments TO authenticated, anon;
SQL
echo "topologia fiel aplicada"

# ── baseline PRÉ-migration: os oráculos estão ABERTOS (senão a prova não vale nada) ──
echo "── baseline pré-migration (o furo existe) ──"
B1=$(Pq -c "SET test.uid='$CUSTOMER'; SET ROLE authenticated; SELECT public.get_user_role('$MASTER');" | tail -1)
eq "P1 ORACULO ABERTO: customer le o role do master" "$B1" "master"
B2=$(Pq -c "SET test.uid='$CUSTOMER'; SET ROLE authenticated; SELECT public.carteira_visivel_para('$CUSTOMER','$OWNER');" | tail -1)
eq "P2 ORACULO ABERTO: customer descobre que o cliente e do owner" "$B2" "t"
B3=$(Pq -c "SET test.uid='$OWNER'; SET ROLE authenticated; SELECT count(*) FROM public.farmer_client_scores;" | tail -1)
eq "P3 baseline autz: owner ve o score do seu cliente" "$B3" "1"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 2 — APLICAR A MIGRATION REAL (Lei #1)
# ══════════════════════════════════════════════════════════════════════════════
MIG="$REPO_ROOT/supabase/migrations/20260718150000_fu7_helpers_rls_schema_privado.sql"
P -q -f "$MIG"
echo "migration aplicada: $(basename "$MIG")"

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 4 — ASSERTS
# ══════════════════════════════════════════════════════════════════════════════
echo "── FATIA 0: os oráculos sem dependência fecham por REVOKE ──"

neg() { # $1=rótulo  $2=uid  $3=expressão SQL  → exige 42501
  local R
  R=$(P -tA 2>&1 <<SQL
SET test.uid='$2';
DO \$\$
BEGIN
  SET LOCAL ROLE authenticated;
  PERFORM $3;
  RAISE NOTICE 'SENTINELA_SEGUE_ABERTO';
EXCEPTION
  WHEN insufficient_privilege THEN RAISE NOTICE 'SENTINELA_NEGADO_42501';
  WHEN OTHERS THEN RAISE;
END \$\$;
SQL
)
  case "$R" in
    *SENTINELA_NEGADO_42501*) ok "$1" ;;
    *SENTINELA_SEGUE_ABERTO*) bad "$1 — SEGUE ABERTO" ;;
    *)                        bad "$1 — inesperado: $R" ;;
  esac
}

neg "A1 get_user_role FECHADO p/ authenticated (42501)"       "$CUSTOMER" "public.get_user_role('$MASTER')"
neg "A2 get_commercial_role FECHADO p/ authenticated (42501)" "$CUSTOMER" "public.get_commercial_role('$OWNER')"

A3=$(Pq -c "SET ROLE service_role; SELECT public.get_user_role('$MASTER');" | tail -1)
eq "A3 service_role INTACTO (edges nao quebram)" "$A3" "master"

# o caller SECDEF de get_commercial_role tem de seguir funcionando (roda como postgres)
A4=$(Pq -c "SET test.uid='$OWNER'; SET ROLE authenticated; SELECT public.pode_ver_carteira_completa('$OWNER');" | tail -1)
eq "A4 caller SECDEF (pode_ver_carteira_completa) INTACTO apos o REVOKE" "$A4" "f"

echo "── FATIA 1: helpers com policy saem de public SEM quebrar autorização ──"

C1=$(Pq -c "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN ('carteira_visivel_para','is_super_admin');" | tail -1)
eq "C1 os 2 helpers SAIRAM de public (fora do PostgREST = oraculo HTTP fechado)" "$C1" "0"

C2=$(Pq -c "SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='private' AND p.proname IN ('carteira_visivel_para','is_super_admin');" | tail -1)
eq "C2 e chegaram em private" "$C2" "2"

C3=$(Pq -c "SET test.uid='$OWNER'; SET ROLE authenticated; SELECT count(*) FROM public.farmer_client_scores;" | tail -1)
eq "C3 DECISIVO: a policy SOBREVIVE ao move (owner ainda ve seu cliente)" "$C3" "1"

C4=$(Pq -c "SET test.uid='$CUSTOMER'; SET ROLE authenticated; SELECT count(*) FROM public.farmer_client_scores;" | tail -1)
eq "C4 a policy segue NEGANDO quem nao e owner (nao virou fail-open)" "$C4" "0"

C5=$(Pq -c "SET test.uid='$MASTER'; SET ROLE authenticated; SELECT count(*) FROM public.margin_audit_log;" | tail -1)
eq "C5 policy de is_super_admin sobrevive (master le)" "$C5" "1"

C6=$(Pq -c "SET test.uid='$CUSTOMER'; SET ROLE authenticated; SELECT count(*) FROM public.margin_audit_log;" | tail -1)
eq "C6 policy de is_super_admin segue negando nao-master" "$C6" "0"

C7=$(Pq -c "SET test.uid='$OWNER'; SET ROLE authenticated; SELECT count(*) FROM public.v_cliente_interacoes;" | tail -1)
eq "C7 a VIEW nao-qualificada SOBREVIVE ao move (resolve por OID)" "$C7" "1"

C8=$(Pq -c "SET test.uid='$OWNER'; SET ROLE authenticated; SELECT public.melhoria_clientes_por_produto('x');" | tail -1)
eq "C8 o caller LATE-BOUND sobrevive (a migration religou o search_path)" "$C8" "1"

C9=$(Pq -c "SELECT qual FROM pg_policies WHERE policyname='fcs_select_carteira';" | tail -1)
case "$C9" in
  *private.carteira_visivel_para*) ok "C9 pg_policies re-renderiza qualificado p/ private" ;;
  *)                               bad "C9 esperava 'private.carteira_visivel_para', veio: $C9" ;;
esac

# ══════════════════════════════════════════════════════════════════════════════
# ZONA 5 — FALSIFICAÇÃO (Lei #3)
# ══════════════════════════════════════════════════════════════════════════════
echo "── falsificação ──"

# F1: se a migration tivesse feito REVOKE (em vez de mover) no helper COM policy,
#     a policy morreria. Prova que a escolha de técnica por-helper não é decorativa.
P -q -c "REVOKE EXECUTE ON FUNCTION private.carteira_visivel_para(uuid,uuid) FROM authenticated, anon, PUBLIC;"
F1=$(P -tA 2>&1 <<SQL
SET test.uid='$OWNER';
DO \$\$
BEGIN
  SET LOCAL ROLE authenticated;
  PERFORM count(*) FROM public.farmer_client_scores;
  RAISE NOTICE 'SENTINELA_POLICY_VIVA';
EXCEPTION
  WHEN insufficient_privilege THEN RAISE NOTICE 'SENTINELA_POLICY_MORREU';
  WHEN OTHERS THEN RAISE;
END \$\$;
SQL
)
case "$F1" in
  *SENTINELA_POLICY_MORREU*) ok "F1 sabotagem detectada: REVOKE no helper-com-policy MATA a policy (C3 seria vermelho)" ;;
  *)                         bad "F1 falsificacao SEM DENTE: $F1" ;;
esac
P -q -c "GRANT EXECUTE ON FUNCTION private.carteira_visivel_para(uuid,uuid) TO authenticated;"

# F2: sem o ALTER do search_path, o caller late-bound quebra (42883). Prova que aquele
#     bloco da migration não é supérfluo — e que C8 tem dente.
P -q -c "ALTER FUNCTION public.melhoria_clientes_por_produto(text) SET search_path TO 'public';"
F2=$(P -tA 2>&1 <<SQL
SET test.uid='$OWNER';
DO \$\$
BEGIN
  PERFORM public.melhoria_clientes_por_produto('x');
  RAISE NOTICE 'SENTINELA_CALLER_VIVO';
EXCEPTION
  WHEN undefined_function THEN RAISE NOTICE 'SENTINELA_CALLER_QUEBROU';
  WHEN OTHERS THEN RAISE;
END \$\$;
SQL
)
case "$F2" in
  *SENTINELA_CALLER_QUEBROU*) ok "F2 sabotagem detectada: sem o ALTER search_path o caller quebra (C8 tem dente)" ;;
  *)                          bad "F2 falsificacao SEM DENTE: $F2" ;;
esac
P -q -c "ALTER FUNCTION public.melhoria_clientes_por_produto(text) SET search_path TO 'public','private';"

# F3: se o REVOKE da Fatia 0 fosse só FROM PUBLIC (erro clássico do Supabase),
#     o oráculo seguiria aberto. Prova que A1 tem dente.
P -q -c "GRANT EXECUTE ON FUNCTION public.get_user_role(uuid) TO authenticated;
         REVOKE EXECUTE ON FUNCTION public.get_user_role(uuid) FROM PUBLIC;"
F3=$(Pq -c "SET test.uid='$CUSTOMER'; SET ROLE authenticated; SELECT public.get_user_role('$MASTER');" 2>&1 | tail -1)
if [ "$F3" = "master" ]; then ok "F3 sabotagem detectada: REVOKE so-FROM-PUBLIC deixa o oraculo ABERTO (A1 tem dente)"
else bad "F3 falsificacao SEM DENTE: esperava 'master', veio [$F3]"; fi
P -q -c "REVOKE EXECUTE ON FUNCTION public.get_user_role(uuid) FROM authenticated, anon, PUBLIC;"

# F4: idempotência — re-rodar a migration inteira (o founder RE-COLA no SQL Editor) é no-op.
P -q -f "$MIG"
F4=$(Pq -c "SET test.uid='$OWNER'; SET ROLE authenticated; SELECT count(*) FROM public.farmer_client_scores;" | tail -1)
eq "F4 re-run da migration e no-op (autz intacta)" "$F4" "1"

echo "──────────────────────────────"
echo "RESULTADO: $PASS ok / $FAIL fail"
[ "$FAIL" = "0" ] || { echo "❌ HARNESS VERMELHO"; exit 1; }
echo "✅ HARNESS VERDE"
